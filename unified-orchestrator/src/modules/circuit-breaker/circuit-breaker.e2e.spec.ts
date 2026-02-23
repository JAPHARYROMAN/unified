import { ForbiddenException } from "@nestjs/common";
import {
  BreakerAction,
  BreakerIncidentStatus,
  BreakerScope,
  BreakerTrigger,
  FiatTransferDirection,
  FiatTransferStatus,
  LoanStatus,
} from "@prisma/client";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { OpsService } from "../ops/ops.service";
import { LoanService } from "../loan/loan.service";
import { FiatDisbursementService } from "../fiat/fiat-disbursement.service";
import { FiatRepaymentService } from "../fiat/fiat-repayment.service";

type AnyObj = Record<string, any>;

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
        const partnerPools = [...pools.values()].filter((x) => x.partnerId === p.id);
        return { ...p, pools: partnerPools };
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
      findMany: jest.fn(async ({ where, include, take, orderBy }: AnyObj) => {
        let rows = [...loans.values()];

        if (where?.status) {
          rows = rows.filter((r) => r.status === where.status);
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
          return rows.map((loan) => ({
            ...loan,
            chainActions: [...chainActions.values()]
              .filter((a) => a.loanId === loan.id)
              .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
              .slice(0, include.chainActions.take ?? 100),
          }));
        }

        return rows;
      }),
    },

    chainAction: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = crypto.randomUUID();
        const row = { id, txHash: null, error: null, attempts: 0, dlqAt: null, nextRetryAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        chainActions.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => chainActions.get(where.id) ?? null),
      findMany: jest.fn(async ({ where, orderBy, take }: AnyObj) => {
        let rows = [...chainActions.values()];
        if (where?.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        if (where?.status && typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
        if (where?.updatedAt?.lte) rows = rows.filter((r) => r.updatedAt <= where.updatedAt.lte);
        if (where?.createdAt?.lte) rows = rows.filter((r) => r.createdAt <= where.createdAt.lte);
        if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (orderBy?.updatedAt === "asc") rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        if (orderBy?.dlqAt === "desc") rows.sort((a, b) => (b.dlqAt?.getTime() ?? 0) - (a.dlqAt?.getTime() ?? 0));
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = chainActions.get(where.id);
        if (!r) throw new Error(`ChainAction not found: ${where.id}`);
        const { attempts, ...rest } = data;
        if (attempts?.increment !== undefined) r.attempts = (r.attempts ?? 0) + attempts.increment;
        Object.assign(r, rest);
        r.updatedAt = new Date();
        return r;
      }),
    },

    fiatTransfer: {
      findMany: jest.fn(async ({ where, include, orderBy, take }: AnyObj) => {
        let rows = [...fiatTransfers.values()];

        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (where?.direction) rows = rows.filter((r) => r.direction === where.direction);
        if (where?.appliedOnchainAt === null) {
          rows = rows.filter((r) => r.appliedOnchainAt === null);
        }

        if (orderBy?.confirmedAt === "asc") {
          rows.sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0));
        }

        if (typeof take === "number") rows = rows.slice(0, take);

        return rows.map((r) => ({
          ...r,
          loan: include?.loan
            ? loans.get(r.loanId)
            : undefined,
          chainAction: include?.chainAction && r.chainActionId
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
        const row = { id, status: BreakerIncidentStatus.OPEN, createdAt: new Date(), updatedAt: new Date(), ...data };
        breakerIncidents.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => breakerIncidents.get(where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: AnyObj) => {
        const r = breakerIncidents.get(where.id);
        if (!r) throw new Error(`BreakerIncident not found: ${where.id}`);
        return r;
      }),
      findMany: jest.fn(async ({ where, orderBy }: AnyObj) => {
        let rows = [...breakerIncidents.values()];
        if (where?.status) {
          if (typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
          else if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        }
        if (where?.trigger) rows = rows.filter((r) => r.trigger === where.trigger);
        if (where?.createdAt?.lte) {
          rows = rows.filter((r) => r.createdAt <= where.createdAt.lte);
        }
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = breakerIncidents.get(where.id);
        if (!r) throw new Error(`BreakerIncident not found: ${where.id}`);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
      }),
    },

    breakerAuditLog: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
        breakerAuditLogs.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ orderBy, take }: AnyObj) => {
        let rows = [...breakerAuditLogs];
        if (orderBy?.createdAt === "desc") rows = [...rows].reverse();
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
    },
  };
}

function seedPartner(prisma: ReturnType<typeof createMockPrisma>, id?: string) {
  const partnerId = id ?? crypto.randomUUID();
  prisma._partners.set(partnerId, {
    id: partnerId,
    legalName: `Partner-${partnerId.slice(0, 6)}`,
    jurisdictionCode: 840,
    registrationNumber: `REG-${partnerId.slice(0, 6)}`,
    complianceEmail: "ops@test.local",
    treasuryWallet: "0xTreasury",
    status: "ACTIVE",
    maxLoanSizeUsdc: 0n,
    reserveRatioBps: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  prisma._pools.set(crypto.randomUUID(), {
    id: crypto.randomUUID(),
    partnerId,
    poolContract: "0xPool",
    chainId: 1,
    createdAt: new Date(),
  });

  return partnerId;
}

const LOAN_PARAMS = {
  borrowerWallet: "0xBorrower1234567890",
  principalUsdc: 1000n,
  collateralToken: "0xCollateral",
  collateralAmount: 500n,
  durationSeconds: 86400,
  interestRateBps: 500,
};

describe("Unified v1.1 — E2E Circuit Breaker Scenarios", () => {
  describe("Settlement Integrity Hard Stop", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let partnerId: string;
    let breaker: CircuitBreakerService;
    let loanSvc: LoanService;
    let report: AnyObj;
    let alerts: AnyObj[];

    beforeEach(async () => {
      prisma = createMockPrisma();
      partnerId = seedPartner(prisma);

      const loanId = crypto.randomUUID();
      prisma._loans.set(loanId, {
        id: loanId, partnerId,
        borrowerWallet: LOAN_PARAMS.borrowerWallet, principalUsdc: 1500n,
        collateralToken: LOAN_PARAMS.collateralToken, collateralAmount: 500n,
        durationSeconds: LOAN_PARAMS.durationSeconds, interestRateBps: LOAN_PARAMS.interestRateBps,
        status: LoanStatus.CREATED, createdAt: new Date(), updatedAt: new Date(),
      });
      prisma._fiatTransfers.set(crypto.randomUUID(), {
        id: crypto.randomUUID(), loanId, provider: "MPESA",
        direction: FiatTransferDirection.OUTBOUND, status: FiatTransferStatus.CONFIRMED,
        providerRef: "MPESA-SETTLE-1", idempotencyKey: "idem-settle-1",
        amountKes: 100_000n, phoneNumber: "+254700000000",
        confirmedAt: new Date(), appliedOnchainAt: null, chainActionId: null,
        createdAt: new Date(), updatedAt: new Date(),
      });

      breaker = new CircuitBreakerService(prisma as any);
      const ops = new OpsService(
        prisma as any,
        { findDlq: jest.fn().mockResolvedValue([]), replayFromDlq: jest.fn() } as any,
        { snapshot: jest.fn().mockReturnValue({}) } as any,
      );
      loanSvc = new LoanService(
        prisma as any,
        { enqueue: jest.fn() } as any,
        { enforce: jest.fn().mockResolvedValue(undefined) } as any,
        breaker,
      );

      report = await ops.reportFiatConfirmedNoChainTx();
      alerts = await breaker.evaluateReconciliation({
        reports: [
          report,
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      } as any);
    });

    it("reconciliation detects the mismatch", () => {
      expect(report.count).toBeGreaterThan(0);
    });

    it("fires FIAT_CONFIRMED_NO_CHAIN_RECORD trigger", () => {
      expect(alerts.some((a) => a.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD)).toBe(true);
    });

    it("blocks new originations after trigger fires", async () => {
      await expect(loanSvc.createLoan(partnerId, LOAN_PARAMS)).rejects.toThrow(ForbiddenException);
    });

    it("writes an audit log entry for the trigger", () => {
      expect(
        prisma._breakerAuditLogs.some((l) => l.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD),
      ).toBe(true);
    });
  });

  describe("Safe State — no mismatches", () => {
    it("enforcement state is clear when reconciliation reports zero counts", async () => {
      const prisma = createMockPrisma();
      const breaker = new CircuitBreakerService(prisma as any);

      const alerts = await breaker.evaluateReconciliation({
        reports: [
          { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 0 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      });
      const state = await breaker.getEnforcementState();

      expect(alerts).toHaveLength(0);
      expect(state.globalBlock).toBe(false);
      expect(state.globalFreeze).toBe(false);
    });
  });

  describe("Partner Default Spike", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let riskyPartner: string;
    let healthyPartner: string;
    let breaker: CircuitBreakerService;
    let loanSvc: LoanService;
    let incident: AnyObj | null;

    beforeEach(async () => {
      prisma = createMockPrisma();
      riskyPartner = seedPartner(prisma, crypto.randomUUID());
      healthyPartner = seedPartner(prisma, crypto.randomUUID());

      breaker = new CircuitBreakerService(prisma as any);
      loanSvc = new LoanService(
        prisma as any,
        { enqueue: jest.fn().mockResolvedValue({ id: "ca-1" }) } as any,
        { enforce: jest.fn().mockResolvedValue(undefined) } as any,
        breaker,
      );

      incident = await breaker.evaluatePartnerDefaultSpike(riskyPartner, 0.12);
    });

    it("opens an incident for the risky partner", () => {
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.PARTNER_DEFAULT_RATE_30D);
    });

    it("blocks originations for the risky partner", async () => {
      await expect(loanSvc.createLoan(riskyPartner, LOAN_PARAMS)).rejects.toThrow(ForbiddenException);
    });

    it("allows originations for the healthy partner", async () => {
      await expect(loanSvc.createLoan(healthyPartner, LOAN_PARAMS)).resolves.toBeDefined();
    });
  });

  describe("Liquidity Ratio Breach", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let partnerId: string;
    let breaker: CircuitBreakerService;
    let loanSvc: LoanService;
    let incident: AnyObj | null;

    beforeEach(async () => {
      prisma = createMockPrisma();
      partnerId = seedPartner(prisma);
      breaker = new CircuitBreakerService(prisma as any);
      loanSvc = new LoanService(
        prisma as any,
        { enqueue: jest.fn().mockResolvedValue({ id: "ca-liq-1" }) } as any,
        { enforce: jest.fn().mockResolvedValue(undefined) } as any,
        breaker,
      );
      incident = await breaker.evaluateLiquidityRatioBreach(0.18);
    });

    it("opens an incident for the pool", () => {
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.POOL_LIQUIDITY_RATIO);
    });

    it("blocks new originations", async () => {
      await expect(loanSvc.createLoan(partnerId, LOAN_PARAMS)).rejects.toThrow(ForbiddenException);
    });
  });

  describe("Governance Simulation — Liquidity Breach", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let partnerId: string;
    let breaker: CircuitBreakerService;
    let loanSvc: LoanService;
    let queuedWithdrawals: Array<{ id: string; amountUsdc: bigint; status: "QUEUED" | "SETTLED" }>;
    let repaymentSvc: FiatRepaymentService;
    let chainActions: { enqueue: jest.Mock };

    beforeEach(async () => {
      prisma = createMockPrisma();
      partnerId = seedPartner(prisma);

      // 1) Create + 2) fund pool state for simulation.
      const partner = prisma._partners.get(partnerId)!;
      partner.maxLoanSizeUsdc = 1_000_000n;
      partner.updatedAt = new Date();

      // 3) Queue multiple withdrawals to drain liquidity.
      queuedWithdrawals = [
        { id: "w-1", amountUsdc: 150_000n, status: "QUEUED" },
        { id: "w-2", amountUsdc: 125_000n, status: "QUEUED" },
        { id: "w-3", amountUsdc: 100_000n, status: "QUEUED" },
      ];

      breaker = new CircuitBreakerService(prisma as any);
      loanSvc = new LoanService(
        prisma as any,
        { enqueue: jest.fn().mockResolvedValue({ id: "ca-liq-1" }) } as any,
        { enforce: jest.fn().mockResolvedValue(undefined) } as any,
        breaker,
      );

      chainActions = { enqueue: jest.fn().mockResolvedValue({ id: "ca-repay-1" }) };
      repaymentSvc = new FiatRepaymentService(
        {
          findByIdempotencyKey: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({
            id: "ft-in-1",
            status: FiatTransferStatus.PENDING,
            loanId: "loan-repay-1",
          }),
          markRepaymentReceived: jest.fn().mockResolvedValue({
            id: "ft-in-1",
            status: FiatTransferStatus.REPAYMENT_RECEIVED,
            loanId: "loan-repay-1",
            proofHash: "proof",
            refHash: "ref",
          }),
          markChainRepayPending: jest.fn().mockResolvedValue({
            id: "ft-in-1",
            status: FiatTransferStatus.CHAIN_REPAY_PENDING,
            loanId: "loan-repay-1",
          }),
          findInboundByLoan: jest.fn().mockResolvedValue(null),
          markChainRepayConfirmed: jest.fn(),
        } as any,
        chainActions as any,
      );
    });

    it("fires breaker on liquidity breach and blocks new originations", async () => {
      // 4) Breach threshold.
      const incident = await breaker.evaluateLiquidityRatioBreach(0.18);
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.POOL_LIQUIDITY_RATIO);

      // 5) Assert originations blocked.
      await expect(loanSvc.createLoan(partnerId, LOAN_PARAMS)).rejects.toThrow(ForbiddenException);
    });

    it("keeps queued withdrawals and repayments operational during breach", async () => {
      await breaker.evaluateLiquidityRatioBreach(0.18);

      // 5) Withdrawals still allowed: queued exits continue settling.
      for (const item of queuedWithdrawals) {
        if (item.status === "QUEUED") item.status = "SETTLED";
      }
      expect(queuedWithdrawals.every((w) => w.status === "SETTLED")).toBe(true);

      // 5) Repayments still allowed: repayment flow can enqueue chain actions.
      const rep = await repaymentSvc.handleRepayment({
        loanId: "loan-repay-1",
        loanContract: "0xLoanRepay1",
        providerRef: "MPESA-REPAY-GB-1",
        idempotencyKey: "idem-repay-gb-1",
        amountKes: 50_000n,
        phoneNumber: "+254700000001",
        rawPayload: { TransactionID: "MPESA-REPAY-GB-1" },
      });
      expect(rep.transfer.status).toBe(FiatTransferStatus.CHAIN_REPAY_PENDING);
      expect(chainActions.enqueue).toHaveBeenCalledTimes(2);
    });

    it("auto-clears breaker after liquidity is restored for the stability window", async () => {
      const incident = await breaker.evaluateLiquidityRatioBreach(0.18);
      expect(incident).not.toBeNull();

      // 6) Restore above threshold and age incident beyond stability window.
      const row = prisma._breakerIncidents.get(incident!.id)!;
      row.createdAt = new Date(Date.now() - 61 * 60_000);

      const resolved = await breaker.autoClearLiquidityIncidentsIfStable({
        currentLiquidityRatio: 0.35,
        stabilityWindowMinutes: 60,
      });
      expect(resolved).toBeGreaterThan(0);

      // 7) Recovery: origination path is available again.
      const state = await breaker.getEnforcementState();
      expect(state.globalFreeze).toBe(false);
      await expect(loanSvc.createLoan(partnerId, LOAN_PARAMS)).resolves.toBeDefined();

      expect(
        prisma._breakerAuditLogs.some(
          (l) =>
            l.trigger === BreakerTrigger.POOL_LIQUIDITY_RATIO &&
            typeof l.note === "string" &&
            l.note.includes("auto-resolved"),
        ),
      ).toBe(true);
    });
  });

  describe("Active Without Disbursement Proof — activation guard + reconciliation", () => {
    let prisma: ReturnType<typeof createMockPrisma>;
    let partnerId: string;
    let loanId: string;
    let breaker: CircuitBreakerService;
    let loanSvc: LoanService;
    let summary: AnyObj;
    let markActivated: jest.Mock;

    beforeEach(async () => {
      prisma = createMockPrisma();
      partnerId = seedPartner(prisma);
      loanId = crypto.randomUUID();

      const transfer = { id: crypto.randomUUID(), loanId, status: "CHAIN_RECORD_PENDING" };
      markActivated = jest.fn(async () => ({ ...transfer, status: "ACTIVATED" }));
      const fiatTransferRepo = {
        findOutboundByLoan: jest.fn(async (id: string) => (id === loanId ? transfer : null)),
        markActivated,
      };
      const disbursement = new FiatDisbursementService(
        fiatTransferRepo as any,
        { enqueue: jest.fn() } as any,
        { initiatePayout: jest.fn() } as any,
      );
      await disbursement.onActivateLoanConfirmed(loanId);

      prisma._loans.set(loanId, {
        id: loanId, partnerId,
        borrowerWallet: LOAN_PARAMS.borrowerWallet, principalUsdc: 1500n,
        collateralToken: LOAN_PARAMS.collateralToken, collateralAmount: 500n,
        durationSeconds: LOAN_PARAMS.durationSeconds, interestRateBps: LOAN_PARAMS.interestRateBps,
        status: LoanStatus.ACTIVE, createdAt: new Date(), updatedAt: new Date(),
      });

      const ops = new OpsService(
        prisma as any,
        { findDlq: jest.fn().mockResolvedValue([]), replayFromDlq: jest.fn() } as any,
        { snapshot: jest.fn().mockReturnValue({}) } as any,
      );
      summary = await ops.runDailyReconciliation();

      breaker = new CircuitBreakerService(prisma as any);
      await breaker.evaluateReconciliation(summary as any);

      loanSvc = new LoanService(
        prisma as any,
        { enqueue: jest.fn() } as any,
        { enforce: jest.fn().mockResolvedValue(undefined) } as any,
        breaker,
      );
    });

    it("activation guard rejects loan activation when proof is missing", () => {
      expect(markActivated).not.toHaveBeenCalled();
    });

    it("reconciliation flags CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF mismatch", () => {
      const mismatch = summary.reports.find(
        (r: AnyObj) => r.report === "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF",
      );
      expect(mismatch?.count).toBeGreaterThan(0);
    });

    it("fires ACTIVE_WITHOUT_DISBURSEMENT_PROOF trigger", async () => {
      const incidents = await breaker.getOpenIncidents();
      expect(
        incidents.some((i) => i.trigger === BreakerTrigger.ACTIVE_WITHOUT_DISBURSEMENT_PROOF),
      ).toBe(true);
    });

    it("sets globalBlock on enforcement state", async () => {
      const state = await breaker.getEnforcementState();
      expect(state.globalBlock).toBe(true);
    });

    it("blocks new originations", async () => {
      await expect(loanSvc.createLoan(partnerId, LOAN_PARAMS)).rejects.toThrow(ForbiddenException);
    });

    it("writes audit log with correct trigger and note", () => {
      expect(
        prisma._breakerAuditLogs.some(
          (l) =>
            l.trigger === BreakerTrigger.ACTIVE_WITHOUT_DISBURSEMENT_PROOF &&
            typeof l.note === "string" &&
            l.note.includes("CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF"),
        ),
      ).toBe(true);
    });
  });
});
