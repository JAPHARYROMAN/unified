import { ForbiddenException } from "@nestjs/common";
import {
  BreakerIncidentStatus,
  BreakerTrigger,
  ChainActionStatus,
  ChainActionType,
  FiatTransferDirection,
  FiatTransferStatus,
  LoanStatus,
} from "@prisma/client";
import { ChainActionService } from "../chain-action/chain-action.service";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { LoanService } from "../loan/loan.service";
import { OpsService } from "../ops/ops.service";
import { FiatDisbursementService } from "../fiat/fiat-disbursement.service";
import { createHash } from "crypto";

type AnyObj = Record<string, any>;

type CohortName = "COHORT_1_CORRECTNESS" | "COHORT_2_BEHAVIOR" | "COHORT_3_STRESS";
type ScenarioName =
  | "ON_TIME"
  | "GRACE"
  | "LATE_AFTER_GRACE"
  | "PARTIAL_MULTI"
  | "OVERPAY_ATTEMPT"
  | "DEFAULT_CLAIM"
  | "CONCENTRATION_HEAVY"
  | "WEBHOOK_DELAY"
  | "SENDER_DLQ_RECOVERY"
  | "MANUAL_REPLAY_RECOVERY";

type BreakerState =
  | "NORMAL"
  | "PARTNER_BLOCKED"
  | "POOL_FROZEN"
  | "GLOBAL_HARD_STOP"
  | "RECOVERY_MONITOR"
  | "CLEARED";

interface LoanManifest {
  cohort: CohortName;
  partnerId: string;
  poolId: string;
  loanId: string;
  schedule_hash: string;
  activation_timestamps: {
    requestedAt: string;
    proofRecordedAt?: string;
    activatedAt?: string;
  };
  repayment_schedule_timestamps: Array<{ dueAt: string; paidAt?: string; amount: string }>;
  tx_hashes: string[];
  delinquency_state_timeline: Array<{
    at: string;
    installmentsDue: number;
    installmentsPaid: number;
    delinquent: boolean;
    lateFeeAccrued: string;
  }>;
  breaker_events_timeline: Array<{
    at: string;
    trigger: BreakerTrigger;
    incidentId: string;
  }>;
  reconciliation_report_ids: string[];
  scenarios: ScenarioName[];
}

interface SimLoanState {
  principalOutstanding: bigint;
  interestAccrued: bigint;
  lateFeeAccrued: bigint;
  repaidTotal: bigint;
  installmentAmount: bigint;
  installmentIntervalSec: number;
  graceSec: number;
  totalInstallments: number;
  installmentsPaid: number;
  startSec: number;
  lastAccrualSec: number;
  delinquentSinceSec: number;
  status: LoanStatus;
}

function hashHex(input: string) {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

function isoFromSec(sec: number) {
  return new Date(sec * 1000).toISOString();
}

function createMockPrisma() {
  const partners = new Map<string, AnyObj>();
  const pools = new Map<string, AnyObj>();
  const loans = new Map<string, AnyObj>();
  const chainActions = new Map<string, AnyObj>();
  const fiatTransfers = new Map<string, AnyObj>();
  const breakerIncidents = new Map<string, AnyObj>();
  const breakerAuditLogs: AnyObj[] = [];

  return {
    _partners: partners,
    _pools: pools,
    _loans: loans,
    _chainActions: chainActions,
    _fiatTransfers: fiatTransfers,
    _breakerIncidents: breakerIncidents,
    _breakerAuditLogs: breakerAuditLogs,

    partner: {
      findUnique: jest.fn(async ({ where, include }: AnyObj) => {
        const p = partners.get(where.id);
        if (!p) return null;
        if (!include?.pools) return p;
        return { ...p, pools: [...pools.values()].filter((x) => x.partnerId === p.id) };
      }),
    },

    loan: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = crypto.randomUUID();
        const row = {
          id,
          status: LoanStatus.CREATED,
          loanContract: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        loans.set(id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const row = loans.get(where.id);
        if (!row) throw new Error(`Loan ${where.id} not found`);
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      }),
      findMany: jest.fn(async ({ where, include, orderBy, take }: AnyObj) => {
        let rows = [...loans.values()];

        if (where?.status) {
          if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
          else rows = rows.filter((r) => r.status === where.status);
        }

        if (where?.NOT?.fiatTransfers?.some) {
          const cond = where.NOT.fiatTransfers.some;
          rows = rows.filter((loan) => {
            const any = [...fiatTransfers.values()].some((ft) => {
              if (ft.loanId !== loan.id) return false;
              if (cond.direction && ft.direction !== cond.direction) return false;
              if (cond.status?.in && !cond.status.in.includes(ft.status)) return false;
              return true;
            });
            return !any;
          });
        }

        if (orderBy?.updatedAt === "desc") {
          rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        }
        if (typeof take === "number") rows = rows.slice(0, take);

        if (include?.chainActions) {
          return rows.map((r) => ({
            ...r,
            chainActions: [...chainActions.values()]
              .filter((ca) => ca.loanId === r.id)
              .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
              .slice(0, include.chainActions.take ?? 3),
          }));
        }
        return rows;
      }),
      groupBy: jest.fn(async ({ by, where, _count }: AnyObj) => {
        if (!by || !_count?.id) return [];
        let rows = [...loans.values()];
        if (where?.updatedAt?.gte) rows = rows.filter((r) => r.updatedAt >= where.updatedAt.gte);
        if (where?.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= where.createdAt.gte);
        if (where?.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        else if (where?.status) rows = rows.filter((r) => r.status === where.status);

        const keys: string[] = by;
        const grouped = new Map<string, { keyObj: AnyObj; count: number }>();
        for (const r of rows) {
          const keyObj: AnyObj = {};
          for (const k of keys) keyObj[k] = r[k];
          const key = JSON.stringify(keyObj);
          const prev = grouped.get(key);
          if (prev) prev.count += 1;
          else grouped.set(key, { keyObj, count: 1 });
        }
        return [...grouped.values()].map((g) => ({ ...g.keyObj, _count: { id: g.count } }));
      }),
    },

    chainAction: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = data.id ?? crypto.randomUUID();
        const row = {
          id,
          txHash: null,
          error: null,
          attempts: 0,
          dlqAt: null,
          nextRetryAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        chainActions.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => chainActions.get(where.id) ?? null),
      update: jest.fn(async ({ where, data, select }: AnyObj) => {
        const row = chainActions.get(where.id);
        if (!row) throw new Error(`ChainAction ${where.id} not found`);
        const { attempts, ...rest } = data;
        if (attempts !== undefined) {
          if (typeof attempts === "object" && attempts.increment !== undefined) {
            row.attempts = (row.attempts ?? 0) + attempts.increment;
          } else {
            row.attempts = attempts;
          }
        }
        Object.assign(row, rest);
        row.updatedAt = new Date();
        if (select) {
          return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
        }
        return row;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: AnyObj) => {
        let rows = [...chainActions.values()];
        if (where?.status) {
          if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
          else rows = rows.filter((r) => r.status === where.status);
        }
        if (where?.updatedAt?.lte) rows = rows.filter((r) => r.updatedAt <= where.updatedAt.lte);
        if (where?.createdAt?.lte) rows = rows.filter((r) => r.createdAt <= where.createdAt.lte);
        if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (orderBy?.updatedAt === "asc") rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        if (orderBy?.dlqAt === "desc") rows.sort((a, b) => (b.dlqAt?.getTime() ?? 0) - (a.dlqAt?.getTime() ?? 0));
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
      count: jest.fn(async ({ where }: AnyObj) => {
        let rows = [...chainActions.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        return rows.length;
      }),
      fields: {
        confirmationsRequired: 1,
      },
    },

    fiatTransfer: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = data.id ?? crypto.randomUUID();
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        fiatTransfers.set(id, row);
        return row;
      }),
      findMany: jest.fn(async ({ where, include, orderBy, take }: AnyObj) => {
        let rows = [...fiatTransfers.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (where?.direction) rows = rows.filter((r) => r.direction === where.direction);
        if (where?.appliedOnchainAt === null) rows = rows.filter((r) => r.appliedOnchainAt === null);
        if (orderBy?.confirmedAt === "asc") rows.sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0));
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((r) => ({
          ...r,
          loan: include?.loan ? loans.get(r.loanId) : undefined,
          chainAction:
            include?.chainAction && r.chainActionId
              ? chainActions.get(r.chainActionId) ?? null
              : null,
        }));
      }),
    },

    webhookDeadLetter: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },

    breakerIncident: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = crypto.randomUUID();
        const row = {
          id,
          status: BreakerIncidentStatus.OPEN,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        breakerIncidents.set(id, row);
        return row;
      }),
      findMany: jest.fn(async ({ where, orderBy }: AnyObj) => {
        let rows = [...breakerIncidents.values()];
        if (where?.status) {
          if (typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
          else if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        }
        if (where?.trigger) rows = rows.filter((r) => r.trigger === where.trigger);
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: AnyObj) => {
        const row = breakerIncidents.get(where.id);
        if (!row) throw new Error(`Breaker incident ${where.id} not found`);
        return row;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const row = breakerIncidents.get(where.id);
        if (!row) throw new Error(`Breaker incident ${where.id} not found`);
        Object.assign(row, data);
        row.updatedAt = new Date();
        return row;
      }),
    },

    breakerAuditLog: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
        breakerAuditLogs.push(row);
        return row;
      }),
    },
  };
}

function seedPartner(prisma: ReturnType<typeof createMockPrisma>, idx: number) {
  const partnerId = `partner-${idx}`;
  const poolId = `pool-${idx}`;
  prisma._partners.set(partnerId, {
    id: partnerId,
    legalName: `Partner ${idx}`,
    jurisdictionCode: 840,
    registrationNumber: `REG-${idx}`,
    complianceEmail: `ops-${idx}@test.local`,
    treasuryWallet: `0xTreasury${idx}`,
    status: "ACTIVE",
    maxLoanSizeUsdc: 0n,
    reserveRatioBps: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prisma._pools.set(poolId, {
    id: poolId,
    partnerId,
    poolContract: `0xPool${idx}`,
    chainId: 1,
    createdAt: new Date(),
  });
  return { partnerId, poolId };
}

function accrueSimple(state: SimLoanState, nowSec: number, aprBps = 1200n) {
  if (nowSec <= state.lastAccrualSec) return 0n;
  const dt = BigInt(nowSec - state.lastAccrualSec);
  const accrued = (state.principalOutstanding * aprBps * dt) / (365n * 24n * 3600n * 10_000n);
  state.interestAccrued += accrued;
  state.lastAccrualSec = nowSec;
  return accrued;
}

function accrueLateFee(state: SimLoanState, nowSec: number, penaltyBps = 1800n) {
  if (!state.delinquentSinceSec) return 0n;
  const from = Math.max(state.delinquentSinceSec, state.lastAccrualSec);
  if (nowSec <= from) return 0n;
  const dt = BigInt(nowSec - from);
  const accrued = (state.principalOutstanding * penaltyBps * dt) / (365n * 24n * 3600n * 10_000n);
  state.lateFeeAccrued += accrued;
  return accrued;
}

function applyRepayment(state: SimLoanState, amount: bigint) {
  const debt = state.principalOutstanding + state.interestAccrued + state.lateFeeAccrued;
  if (amount > debt) throw new Error("RepaymentExceedsDebt");

  let remaining = amount;
  const lateFeePaid = remaining > state.lateFeeAccrued ? state.lateFeeAccrued : remaining;
  state.lateFeeAccrued -= lateFeePaid;
  remaining -= lateFeePaid;

  const interestPaid = remaining > state.interestAccrued ? state.interestAccrued : remaining;
  state.interestAccrued -= interestPaid;
  remaining -= interestPaid;

  const principalPaid = remaining;
  state.principalOutstanding -= principalPaid;
  state.repaidTotal += amount;

  const newPaidByPrincipal = Number(state.repaidTotal / state.installmentAmount);
  if (newPaidByPrincipal > state.installmentsPaid) {
    state.installmentsPaid = Math.min(newPaidByPrincipal, state.totalInstallments);
  }
  return { lateFeePaid, interestPaid, principalPaid };
}

function applyWaterfallLoss(
  juniorNav: bigint,
  seniorNav: bigint,
  loss: bigint,
): {
  juniorNav: bigint;
  seniorNav: bigint;
  juniorAbsorbed: bigint;
  seniorAbsorbed: bigint;
  residual: bigint;
} {
  let remaining = loss;
  const juniorAbsorbed = remaining > juniorNav ? juniorNav : remaining;
  remaining -= juniorAbsorbed;
  const seniorAbsorbed = remaining > seniorNav ? seniorNav : remaining;
  remaining -= seniorAbsorbed;
  return {
    juniorNav: juniorNav - juniorAbsorbed,
    seniorNav: seniorNav - seniorAbsorbed,
    juniorAbsorbed,
    seniorAbsorbed,
    residual: remaining,
  };
}

function applyRecoveryReverseImpairment(
  juniorNav: bigint,
  seniorNav: bigint,
  juniorLossAbsorbed: bigint,
  seniorLossAbsorbed: bigint,
  recovery: bigint,
): {
  juniorNav: bigint;
  seniorNav: bigint;
  juniorRecovered: bigint;
  seniorRecovered: bigint;
  juniorLossAbsorbed: bigint;
  seniorLossAbsorbed: bigint;
  residual: bigint;
} {
  let remaining = recovery;
  // Reverse-impairment order: senior first, then junior.
  const seniorRecovered = remaining > seniorLossAbsorbed ? seniorLossAbsorbed : remaining;
  remaining -= seniorRecovered;
  const juniorRecovered = remaining > juniorLossAbsorbed ? juniorLossAbsorbed : remaining;
  remaining -= juniorRecovered;
  return {
    juniorNav: juniorNav + juniorRecovered,
    seniorNav: seniorNav + seniorRecovered,
    juniorRecovered,
    seniorRecovered,
    juniorLossAbsorbed: juniorLossAbsorbed - juniorRecovered,
    seniorLossAbsorbed: seniorLossAbsorbed - seniorRecovered,
    residual: remaining,
  };
}

describe("Unified v1.1 — 100-Loan Pilot Harness (Installments)", () => {
  it("executes deterministic 100-loan pilot and emits audit manifest", async () => {
    const prisma = createMockPrisma();
    const partners = Array.from({ length: 8 }, (_, i) => seedPartner(prisma, i + 1));

    const chainActionSvc = new ChainActionService(prisma as any);
    const breakerSvc = new CircuitBreakerService(prisma as any);
    const opsSvc = new OpsService(
      prisma as any,
      chainActionSvc,
      { snapshot: jest.fn().mockReturnValue({}) } as any,
    );
    const loanSvc = new LoanService(
      prisma as any,
      chainActionSvc,
      { enforce: jest.fn().mockResolvedValue(undefined) } as any,
      breakerSvc,
    );

    const manifest: {
      runId: string;
      generatedAt: string;
      cohorts: Array<{ cohort: CohortName; size: number }>;
      loans: LoanManifest[];
      assertions: Record<string, boolean>;
      summary: AnyObj;
    } = {
      runId: `pilot-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      cohorts: [
        { cohort: "COHORT_1_CORRECTNESS", size: 20 },
        { cohort: "COHORT_2_BEHAVIOR", size: 40 },
        { cohort: "COHORT_3_STRESS", size: 40 },
      ],
      loans: [],
      assertions: {
        activeWithoutProofImpossible: true,
        overpayReverts: true,
        accrualIdempotent: true,
        waterfallSumInvariant: true,
        breakerThresholdsExceeded: false,
        recoveryClearsIncidents: false,
      },
      summary: {},
    };

    const partnerDelinquencyCounters = new Map<string, { total: number; delinquent: number; defaulted: number }>();
    const partnerExposureUsdc = new Map<string, bigint>();
    let reconciliationSeq = 0;
    let replayedDlqCount = 0;
    let breakerState: BreakerState = "NORMAL";
    const breakerStateTimeline: Array<{ at: string; state: BreakerState; reason: string }> = [
      { at: isoFromSec(1_900_000_000), state: "NORMAL", reason: "initial" },
    ];
    const concentratedPartners = new Set<string>([partners[0].partnerId, partners[1].partnerId]);
    let concentrationLoanCount = 0;
    let concentrationDefaultCount = 0;
    let juniorNav = 30_000n;
    let seniorNav = 70_000n;
    let juniorLossAbsorbed = 0n;
    let seniorLossAbsorbed = 0n;
    let totalCreditLoss = 0n;
    let totalRecovery = 0n;
    let waterfallLossResidual = 0n;
    let waterfallRecoveryResidual = 0n;
    let liquidityRatioBps = 2200;
    let queuePressureBps = 0;
    const seniorWithdrawalBaselineBps = 300;
    let seniorWithdrawalStressedMaxBps = seniorWithdrawalBaselineBps;
    let stabilityWindowCounter = 0;

    const setBreakerState = (state: BreakerState, atSec: number, reason: string) => {
      if (breakerState === state) return;
      breakerState = state;
      breakerStateTimeline.push({ at: isoFromSec(atSec), state, reason });
    };

    for (let i = 0; i < 100; i++) {
      const cohort: CohortName =
        i < 20 ? "COHORT_1_CORRECTNESS" : i < 60 ? "COHORT_2_BEHAVIOR" : "COHORT_3_STRESS";
      let partner = cohort === "COHORT_1_CORRECTNESS" ? partners[0] : partners[i % partners.length];

      const baseSec = 1_900_000_000 + i * 60;
      const scheduleHash = hashHex(`schedule:${cohort}:${i}:3:10d:3d`);
      const txHashes: string[] = [];
      const repaymentSchedule: Array<{ dueAt: string; paidAt?: string; amount: string }> = [];
      const delinquencyTimeline: LoanManifest["delinquency_state_timeline"] = [];
      const breakerTimeline: LoanManifest["breaker_events_timeline"] = [];
      const reconciliationIds: string[] = [];

      const scenarios: ScenarioName[] = [];
      if (cohort === "COHORT_1_CORRECTNESS") {
        scenarios.push(i % 2 === 0 ? "ON_TIME" : "GRACE");
        if (i % 5 === 0) scenarios.push("OVERPAY_ATTEMPT");
      } else if (cohort === "COHORT_2_BEHAVIOR") {
        scenarios.push(i % 3 === 0 ? "PARTIAL_MULTI" : "ON_TIME");
        if (i % 7 === 0) scenarios.push("GRACE");
      } else {
        scenarios.push("PARTIAL_MULTI", "LATE_AFTER_GRACE");
        if (i % 2 === 0) scenarios.push("WEBHOOK_DELAY");
        if (i % 3 === 0) scenarios.push("SENDER_DLQ_RECOVERY", "MANUAL_REPLAY_RECOVERY");
        if (i % 5 === 0) scenarios.push("DEFAULT_CLAIM");
        if (i % 4 === 0) {
          scenarios.push("CONCENTRATION_HEAVY");
          partner = partners[i % 2];
        }
      }
      const poolId = partner.poolId;
      const partnerId = partner.partnerId;
      if (scenarios.includes("CONCENTRATION_HEAVY")) concentrationLoanCount += 1;

      const { loan } = await loanSvc.createLoan(partnerId, {
        borrowerWallet: `0xBorrower${(i + 1).toString().padStart(4, "0")}`,
        principalUsdc: 1_000n + BigInt(i),
        collateralToken: "0xCollateral",
        collateralAmount: 500n,
        durationSeconds: 90 * 24 * 3600,
        interestRateBps: 1200,
      });

      const sim: SimLoanState = {
        principalOutstanding: 1_000n + BigInt(i),
        interestAccrued: 0n,
        lateFeeAccrued: 0n,
        repaidTotal: 0n,
        installmentAmount: (1_000n + BigInt(i)) / 3n,
        installmentIntervalSec: 10 * 24 * 3600,
        graceSec: 3 * 24 * 3600,
        totalInstallments: 3,
        installmentsPaid: 0,
        startSec: baseSec,
        lastAccrualSec: baseSec,
        delinquentSinceSec: 0,
        status: LoanStatus.ACTIVE,
      };

      prisma._loans.set(loan.id, {
        ...(prisma._loans.get(loan.id) ?? {}),
        id: loan.id,
        partnerId,
        status: LoanStatus.ACTIVE,
        createdAt: new Date(baseSec * 1000),
        updatedAt: new Date(baseSec * 1000),
      });

      const activation = {
        requestedAt: isoFromSec(baseSec + 5),
        proofRecordedAt: undefined as string | undefined,
        activatedAt: undefined as string | undefined,
      };

      // Active without proof guard simulation (webhook delay path)
      if (scenarios.includes("WEBHOOK_DELAY")) {
        const transfer = {
          id: `ft-${loan.id}`,
          loanId: loan.id,
          status: "CHAIN_RECORD_PENDING",
        };
        const repo = {
          findOutboundByLoan: jest.fn(async (id: string) => (id === loan.id ? transfer : null)),
          markActivated: jest.fn(),
        };
        const disbursement = new FiatDisbursementService(
          repo as any,
          { enqueue: jest.fn() } as any,
          { initiatePayout: jest.fn() } as any,
        );
        await disbursement.onActivateLoanConfirmed(loan.id);
        if (repo.markActivated.mock.calls.length > 0) {
          manifest.assertions.activeWithoutProofImpossible = false;
        }

        // delayed proof arrives later
        activation.proofRecordedAt = isoFromSec(baseSec + 600);
        activation.activatedAt = isoFromSec(baseSec + 660);

        prisma._fiatTransfers.set(`ft-${loan.id}`, {
          id: `ft-${loan.id}`,
          loanId: loan.id,
          provider: "MPESA",
          direction: FiatTransferDirection.OUTBOUND,
          status: FiatTransferStatus.CONFIRMED,
          providerRef: `provider-${loan.id}`,
          idempotencyKey: `idem-${loan.id}`,
          amountKes: 100_000n,
          phoneNumber: "+254700000000",
          confirmedAt: new Date((baseSec + 600) * 1000),
          appliedOnchainAt: null,
          chainActionId: null,
          createdAt: new Date((baseSec + 600) * 1000),
          updatedAt: new Date((baseSec + 600) * 1000),
        });
      } else {
        activation.proofRecordedAt = isoFromSec(baseSec + 30);
        activation.activatedAt = isoFromSec(baseSec + 35);
      }

      // Cohort 3 sender failure -> DLQ -> manual replay
      if (scenarios.includes("SENDER_DLQ_RECOVERY")) {
        const ca = await chainActionSvc.enqueue(
          loan.id,
          ChainActionType.RECORD_DISBURSEMENT,
          { loanId: loan.id, providerRef: `provider-${loan.id}` },
        );
        txHashes.push(hashHex(`tx:${loan.id}:enqueue:${ca.id}`));

        for (let k = 0; k < 5; k++) {
          await chainActionSvc.markFailed(ca.id, "ECONNREFUSED: simulated outage");
        }
        const after = prisma._chainActions.get(ca.id)!;
        expect(after.status).toBe(ChainActionStatus.DLQ);

        const replayed = await chainActionSvc.replayFromDlq(ca.id, "pilot-admin@unified.local");
        expect(replayed.status).toBe(ChainActionStatus.QUEUED);
        replayedDlqCount += 1;
        txHashes.push(hashHex(`tx:${loan.id}:replay:${ca.id}`));

        // Post-replay: simulate mined and applied
        prisma._chainActions.set(ca.id, {
          ...prisma._chainActions.get(ca.id),
          status: ChainActionStatus.MINED,
          txHash: hashHex(`mined:${ca.id}`),
          updatedAt: new Date((baseSec + 900) * 1000),
        });
      }

      // Repayment schedule simulation (3 installments)
      for (let s = 1; s <= 3; s++) {
        const dueSec = baseSec + s * sim.installmentIntervalSec;
        let paySec = dueSec - 3600; // on-time default

        if (scenarios.includes("GRACE") && s === 1) {
          paySec = dueSec + 3600; // within grace
        }
        if (scenarios.includes("LATE_AFTER_GRACE") && s === 1) {
          paySec = dueSec + sim.graceSec + 4 * 24 * 3600; // late
        }
        if (scenarios.includes("PARTIAL_MULTI")) {
          paySec = dueSec + (s === 1 ? sim.graceSec + 2 * 24 * 3600 : 0);
        }

        // Idempotent accrual assertion: same timestamp accrual should not change twice.
        const a1 = accrueSimple(sim, paySec);
        const a2 = accrueSimple(sim, paySec);
        if (a2 !== 0n) manifest.assertions.accrualIdempotent = false;
        void a1;

        const dueCount = Math.min(
          Math.floor((paySec - baseSec) / sim.installmentIntervalSec),
          sim.totalInstallments,
        );
        if (sim.installmentsPaid < dueCount && paySec > dueSec + sim.graceSec) {
          if (!sim.delinquentSinceSec) sim.delinquentSinceSec = dueSec + sim.graceSec;
          accrueLateFee(sim, paySec);
        }

        const debtNow = sim.principalOutstanding + sim.interestAccrued + sim.lateFeeAccrued;
        if (scenarios.includes("OVERPAY_ATTEMPT") && s === 1) {
          try {
            applyRepayment(sim, debtNow + 1n);
            manifest.assertions.overpayReverts = false;
          } catch {
            // expected
          }
        }

        let payAmount = sim.installmentAmount;
        if (scenarios.includes("PARTIAL_MULTI")) {
          payAmount = sim.installmentAmount / 2n;
        }
        if (payAmount > debtNow) payAmount = debtNow;
        const applied = applyRepayment(sim, payAmount);
        void applied;

        repaymentSchedule.push({
          dueAt: isoFromSec(dueSec),
          paidAt: isoFromSec(paySec),
          amount: payAmount.toString(),
        });

        delinquencyTimeline.push({
          at: isoFromSec(paySec),
          installmentsDue: dueCount,
          installmentsPaid: sim.installmentsPaid,
          delinquent: sim.delinquentSinceSec > 0,
          lateFeeAccrued: sim.lateFeeAccrued.toString(),
        });
      }

      if (scenarios.includes("DEFAULT_CLAIM")) {
        sim.status = LoanStatus.DEFAULTED;
        prisma._loans.set(loan.id, {
          ...prisma._loans.get(loan.id),
          status: LoanStatus.DEFAULTED,
          updatedAt: new Date((baseSec + 70 * 24 * 3600) * 1000),
        });
      } else if (sim.principalOutstanding === 0n) {
        sim.status = LoanStatus.REPAID;
        prisma._loans.set(loan.id, {
          ...prisma._loans.get(loan.id),
          status: LoanStatus.REPAID,
          updatedAt: new Date((baseSec + 40 * 24 * 3600) * 1000),
        });
      } else {
        prisma._loans.set(loan.id, {
          ...prisma._loans.get(loan.id),
          status: LoanStatus.ACTIVE,
          updatedAt: new Date((baseSec + 40 * 24 * 3600) * 1000),
        });
      }

      // Tranche waterfall + liquidity feedback loop + partial recovery simulation.
      let loanLoss = 0n;
      if (sim.status === LoanStatus.DEFAULTED) {
        loanLoss = sim.principalOutstanding + sim.interestAccrued + sim.lateFeeAccrued;
        if (scenarios.includes("LATE_AFTER_GRACE")) {
          loanLoss += (loanLoss * 400n) / 10_000n;
        }
        if (scenarios.includes("CONCENTRATION_HEAVY")) {
          loanLoss += (loanLoss * 1500n) / 10_000n;
          concentrationDefaultCount += 1;
        }
        if (queuePressureBps > 0) {
          loanLoss += (loanLoss * BigInt(queuePressureBps)) / 100_000n;
        }
      }
      if (loanLoss > 0n) {
        totalCreditLoss += loanLoss;
        const wf = applyWaterfallLoss(juniorNav, seniorNav, loanLoss);
        if (wf.juniorAbsorbed + wf.seniorAbsorbed + wf.residual !== loanLoss) {
          manifest.assertions.waterfallSumInvariant = false;
        }
        juniorNav = wf.juniorNav;
        seniorNav = wf.seniorNav;
        juniorLossAbsorbed += wf.juniorAbsorbed;
        seniorLossAbsorbed += wf.seniorAbsorbed;
        waterfallLossResidual += wf.residual;

        // Feedback loop: loss events increase queue pressure and accelerate senior withdrawals.
        queuePressureBps = Math.min(
          8000,
          queuePressureBps + 350 + (scenarios.includes("CONCENTRATION_HEAVY") ? 250 : 0),
        );
        liquidityRatioBps = Math.max(500, liquidityRatioBps - 90 - (scenarios.includes("CONCENTRATION_HEAVY") ? 60 : 0));
      } else {
        // Partial stabilization on non-loss loans.
        queuePressureBps = Math.max(0, queuePressureBps - 120);
        liquidityRatioBps = Math.min(2600, liquidityRatioBps + 15);
      }
      seniorWithdrawalStressedMaxBps = Math.max(
        seniorWithdrawalStressedMaxBps,
        seniorWithdrawalBaselineBps + Math.floor(queuePressureBps / 5),
      );

      if (sim.status === LoanStatus.DEFAULTED) {
        let recovery = loanLoss / 3n;
        if (scenarios.includes("MANUAL_REPLAY_RECOVERY")) {
          recovery += loanLoss / 10n;
        }
        const rec = applyRecoveryReverseImpairment(
          juniorNav,
          seniorNav,
          juniorLossAbsorbed,
          seniorLossAbsorbed,
          recovery,
        );
        if (rec.juniorRecovered + rec.seniorRecovered + rec.residual !== recovery) {
          manifest.assertions.waterfallSumInvariant = false;
        }
        juniorNav = rec.juniorNav;
        seniorNav = rec.seniorNav;
        juniorLossAbsorbed = rec.juniorLossAbsorbed;
        seniorLossAbsorbed = rec.seniorLossAbsorbed;
        totalRecovery += rec.juniorRecovered + rec.seniorRecovered;
        waterfallRecoveryResidual += rec.residual;
        if (rec.juniorRecovered + rec.seniorRecovered > 0n) {
          liquidityRatioBps = Math.min(2600, liquidityRatioBps + 35);
          queuePressureBps = Math.max(0, queuePressureBps - 180);
        }
      }

      // Reconciliation report IDs for this loan
      reconciliationSeq += 1;
      const reconId = `recon-${reconciliationSeq.toString().padStart(4, "0")}`;
      reconciliationIds.push(reconId);
      const report = await opsSvc.runDailyReconciliation();
      if (report.criticalCount > 0) {
        // tie report id to loan manifest for audit traceability
        reconciliationIds.push(`${reconId}-critical`);
      }

      // Aggregate delinquency/default counters by partner for breaker threshold evaluation.
      const ctr = partnerDelinquencyCounters.get(partnerId) ?? {
        total: 0,
        delinquent: 0,
        defaulted: 0,
      };
      ctr.total += 1;
      if (sim.delinquentSinceSec > 0) ctr.delinquent += 1;
      if (sim.status === LoanStatus.DEFAULTED) ctr.defaulted += 1;
      partnerDelinquencyCounters.set(partnerId, ctr);
      partnerExposureUsdc.set(partnerId, (partnerExposureUsdc.get(partnerId) ?? 0n) + (1_000n + BigInt(i)));

      // Breaker state machine simulation.
      const partnerDefaultRate = ctr.total > 0 ? ctr.defaulted / ctr.total : 0;
      if (partnerDefaultRate >= 0.25) {
        setBreakerState("PARTNER_BLOCKED", baseSec + 2_400, `partner default spike:${partnerId}`);
      }
      if (liquidityRatioBps < 1400) {
        setBreakerState("POOL_FROZEN", baseSec + 2_700, "liquidity ratio breach");
      }
      if (liquidityRatioBps < 950 || queuePressureBps > 3_500) {
        setBreakerState("GLOBAL_HARD_STOP", baseSec + 3_000, "liquidity spiral escalation");
      }
      const stableNow = liquidityRatioBps >= 1700 && queuePressureBps < 1300;
      if (stableNow) {
        stabilityWindowCounter += 1;
        if (stabilityWindowCounter >= 6 && (breakerState as BreakerState) === "GLOBAL_HARD_STOP") {
          setBreakerState("RECOVERY_MONITOR", baseSec + 3_300, "stability window reached");
        }
        if (stabilityWindowCounter >= 10 && (breakerState as BreakerState) === "RECOVERY_MONITOR") {
          setBreakerState("CLEARED", baseSec + 3_600, "auto-clear");
        }
      } else {
        stabilityWindowCounter = 0;
      }

      manifest.loans.push({
        cohort,
        partnerId,
        poolId,
        loanId: loan.id,
        schedule_hash: scheduleHash,
        activation_timestamps: activation,
        repayment_schedule_timestamps: repaymentSchedule,
        tx_hashes: txHashes,
        delinquency_state_timeline: delinquencyTimeline,
        breaker_events_timeline: breakerTimeline,
        reconciliation_report_ids: reconciliationIds,
        scenarios,
      });
    }

    // Breaker trigger evaluation from pilot metrics.
    for (const [partnerId, ctr] of partnerDelinquencyCounters) {
      const delinquencyRate = ctr.total > 0 ? ctr.delinquent / ctr.total : 0;
      const defaultRate = ctr.total > 0 ? ctr.defaulted / ctr.total : 0;

      const delinquencyIncident = await breakerSvc.evaluateDelinquencySpike(
        partnerId,
        delinquencyRate,
      );
      const defaultIncident = await breakerSvc.evaluatePartnerDefaultSpike(
        partnerId,
        defaultRate,
      );

      for (const loan of manifest.loans.filter((l) => l.partnerId === partnerId)) {
        if (delinquencyIncident) {
          loan.breaker_events_timeline.push({
            at: new Date().toISOString(),
            trigger: delinquencyIncident.trigger,
            incidentId: delinquencyIncident.id,
          });
        }
        if (defaultIncident) {
          loan.breaker_events_timeline.push({
            at: new Date().toISOString(),
            trigger: defaultIncident.trigger,
            incidentId: defaultIncident.id,
          });
        }
      }
    }

    const openIncidents = await breakerSvc.getOpenIncidents();
    manifest.assertions.breakerThresholdsExceeded = openIncidents.length > 0;
    manifest.assertions.waterfallSumInvariant =
      manifest.assertions.waterfallSumInvariant &&
      waterfallLossResidual === 0n &&
      waterfallRecoveryResidual === 0n;

    // Partner block assertion on at least one incidented partner.
    const blockedPartner = openIncidents.find((i) => i.partnerId)?.partnerId;
    if (blockedPartner) {
      await expect(
        loanSvc.createLoan(blockedPartner, {
          borrowerWallet: "0xBlockedBorrower",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).rejects.toThrow(ForbiddenException);
    }

    // Recovery: resolve all open incidents and verify origination is unblocked.
    for (const incident of openIncidents) {
      await breakerSvc.resolveIncident(incident.id, "pilot-admin@unified.local");
    }
    const stateAfterRecovery = await breakerSvc.getEnforcementState();
    manifest.assertions.recoveryClearsIncidents =
      !stateAfterRecovery.globalBlock &&
      !stateAfterRecovery.globalFreeze &&
      stateAfterRecovery.blockedPartnerIds.size === 0;

    if (blockedPartner) {
      await expect(
        loanSvc.createLoan(blockedPartner, {
          borrowerWallet: "0xRecoveredBorrower",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).resolves.toBeDefined();
    }

    manifest.summary = {
      totalLoans: manifest.loans.length,
      cohorts: {
        cohort1: manifest.loans.filter((l) => l.cohort === "COHORT_1_CORRECTNESS").length,
        cohort2: manifest.loans.filter((l) => l.cohort === "COHORT_2_BEHAVIOR").length,
        cohort3: manifest.loans.filter((l) => l.cohort === "COHORT_3_STRESS").length,
      },
      stressMix: {
        lateAfterGrace: manifest.loans.filter((l) => l.scenarios.includes("LATE_AFTER_GRACE")).length,
        partialMulti: manifest.loans.filter((l) => l.scenarios.includes("PARTIAL_MULTI")).length,
        webhookDelay: manifest.loans.filter((l) => l.scenarios.includes("WEBHOOK_DELAY")).length,
        senderDlq: manifest.loans.filter((l) => l.scenarios.includes("SENDER_DLQ_RECOVERY")).length,
        manualReplay: manifest.loans.filter((l) => l.scenarios.includes("MANUAL_REPLAY_RECOVERY")).length,
        concentrationHeavy: manifest.loans.filter((l) => l.scenarios.includes("CONCENTRATION_HEAVY")).length,
      },
      trancheNav: {
        juniorNav: juniorNav.toString(),
        seniorNav: seniorNav.toString(),
        juniorLossAbsorbed: juniorLossAbsorbed.toString(),
        seniorLossAbsorbed: seniorLossAbsorbed.toString(),
        totalCreditLoss: totalCreditLoss.toString(),
        totalRecovery: totalRecovery.toString(),
      },
      breakerStateMachine: {
        finalState: breakerState,
        timeline: breakerStateTimeline,
      },
      liquiditySpiral: {
        liquidityRatioBps,
        queuePressureBps,
      },
      concentration: {
        concentratedPartners: [...concentratedPartners],
        concentrationLoanCount,
        concentrationDefaultCount,
      },
      waterfallInvariant: {
        lossResidual: waterfallLossResidual.toString(),
        recoveryResidual: waterfallRecoveryResidual.toString(),
        passed: manifest.assertions.waterfallSumInvariant,
      },
      seniorWithdrawalAcceleration: {
        baselineBps: seniorWithdrawalBaselineBps,
        stressedMaxBps: seniorWithdrawalStressedMaxBps,
        accelerationBps: seniorWithdrawalStressedMaxBps - seniorWithdrawalBaselineBps,
      },
      partnerExposureUsdc: Object.fromEntries(
        [...partnerExposureUsdc.entries()].map(([k, v]) => [k, v.toString()]),
      ),
      replayedDlqCount,
      openIncidentsBeforeRecovery: openIncidents.length,
      assertions: manifest.assertions,
    };

    // eslint-disable-next-line no-console
    console.log(
      "INSTALLMENT_100_LOAN_PILOT_MANIFEST",
      JSON.stringify(
        {
          ...manifest,
          sample_loans: manifest.loans.slice(0, 3),
        },
        null,
        2,
      ),
    );

    expect(manifest.loans).toHaveLength(100);
    expect(manifest.summary.cohorts.cohort1).toBe(20);
    expect(manifest.summary.cohorts.cohort2).toBe(40);
    expect(manifest.summary.cohorts.cohort3).toBe(40);

    expect(manifest.assertions.activeWithoutProofImpossible).toBe(true);
    expect(manifest.assertions.overpayReverts).toBe(true);
    expect(manifest.assertions.accrualIdempotent).toBe(true);
    expect(manifest.assertions.waterfallSumInvariant).toBe(true);
    expect(manifest.assertions.breakerThresholdsExceeded).toBe(true);
    expect(manifest.assertions.recoveryClearsIncidents).toBe(true);
  });
});
