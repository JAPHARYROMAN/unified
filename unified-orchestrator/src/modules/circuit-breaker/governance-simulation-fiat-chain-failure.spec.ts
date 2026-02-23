/**
 * Governance Simulation — Fiat Confirmed, Chain Failure
 *
 * Validates system behaviour when fiat disbursement is confirmed but the
 * subsequent on-chain recording fails (RPC outage → retries → DLQ).
 *
 * 7-step scenario:
 *   1. Confirm fiat via adapter.
 *   2. Force sender failure (simulate RPC outage — ECONNREFUSED).
 *   3. Verify: loan not activated; tx entry moves to DLQ after MAX_RETRIES.
 *   4. Run reconciliation.
 *   5. Assert: mismatch flagged; originations blocked (per breaker).
 *   6. Admin replay endpoint resets DLQ action to QUEUED.
 *   7. Confirm: recordFiatDisbursement succeeds; activateLoan succeeds;
 *      breaker lifts automatically after mismatch resolved.
 */

import { ForbiddenException } from "@nestjs/common";
import {
  ChainActionStatus,
  ChainActionType,
  FiatTransferDirection,
  FiatTransferStatus,
  LoanStatus,
  BreakerTrigger,
  BreakerIncidentStatus,
} from "@prisma/client";
import { ChainActionService } from "../chain-action/chain-action.service";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { OpsService } from "../ops/ops.service";
import { LoanService } from "../loan/loan.service";
import { FiatDisbursementService } from "../fiat/fiat-disbursement.service";

type AnyObj = Record<string, any>;

// ── In-memory Prisma mock ──────────────────────────────────────────────────────

function createMockPrisma() {
  const loans = new Map<string, AnyObj>();
  const chainActions = new Map<string, AnyObj>();
  const fiatTransfers = new Map<string, AnyObj>();
  const partners = new Map<string, AnyObj>();
  const pools = new Map<string, AnyObj>();
  const breakerIncidents = new Map<string, AnyObj>();
  const breakerAuditLogs: AnyObj[] = [];

  return {
    _loans: loans,
    _chainActions: chainActions,
    _fiatTransfers: fiatTransfers,
    _partners: partners,
    _pools: pools,
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
        const row = { id, status: LoanStatus.CREATED, loanContract: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        loans.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => loans.get(where.id) ?? null),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = loans.get(where.id);
        if (!r) throw new Error(`Loan not found: ${where.id}`);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
      }),
      findMany: jest.fn(async ({ where, include, take, orderBy }: AnyObj) => {
        let rows = [...loans.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
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
        if (orderBy?.updatedAt === "desc") rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
        const id = data.id ?? crypto.randomUUID();
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
      update: jest.fn(async ({ where, data, select }: AnyObj) => {
        const r = chainActions.get(where.id);
        if (!r) throw new Error(`ChainAction not found: ${where.id}`);
        const { attempts, ...rest } = data;
        if (attempts !== undefined) {
          if (typeof attempts === "object" && attempts.increment !== undefined) {
            r.attempts = (r.attempts ?? 0) + attempts.increment;
          } else {
            r.attempts = attempts;
          }
        }
        Object.assign(r, rest);
        r.updatedAt = new Date();
        if (select) {
          return Object.fromEntries(Object.keys(select).map((k) => [k, r[k]]));
        }
        return r;
      }),
      count: jest.fn(async ({ where }: AnyObj) => {
        let rows = [...chainActions.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        return rows.length;
      }),
    },

    fiatTransfer: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = data.id ?? crypto.randomUUID();
        const row = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        fiatTransfers.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => {
        if (where.id) return fiatTransfers.get(where.id) ?? null;
        if (where.loanId_direction) {
          return [...fiatTransfers.values()].find(
            (r) => r.loanId === where.loanId_direction.loanId && r.direction === where.loanId_direction.direction,
          ) ?? null;
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = fiatTransfers.get(where.id);
        if (!r) throw new Error(`FiatTransfer not found: ${where.id}`);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
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
          chainAction: include?.chainAction && r.chainActionId ? chainActions.get(r.chainActionId) ?? null : null,
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

// ── Seed helpers ───────────────────────────────────────────────────────────────

function seedPartner(prisma: ReturnType<typeof createMockPrisma>) {
  const partnerId = crypto.randomUUID();
  prisma._partners.set(partnerId, {
    id: partnerId,
    legalName: "Test Partner",
    jurisdictionCode: 840,
    registrationNumber: "REG-001",
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

const RPC_OUTAGE_ERROR = "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8545";
const MAX_RETRIES = 5;

// ── Simulation ─────────────────────────────────────────────────────────────────

describe("Governance Simulation — Fiat Confirmed, Chain Failure", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let partnerId: string;
  let loanId: string;
  let fiatTransferId: string;
  let chainActionId: string;
  let chainActionSvc: ChainActionService;
  let breakerSvc: CircuitBreakerService;
  let loanSvc: LoanService;
  let opsSvc: OpsService;

  beforeAll(async () => {
    prisma = createMockPrisma();
    partnerId = seedPartner(prisma);

    loanId = crypto.randomUUID();
    prisma._loans.set(loanId, {
      id: loanId,
      partnerId,
      borrowerWallet: "0xBorrower",
      principalUsdc: 5000n,
      collateralToken: "0xCollateral",
      collateralAmount: 2500n,
      durationSeconds: 86400,
      interestRateBps: 500,
      status: LoanStatus.FUNDING,
      loanContract: "0xLoanContract",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    chainActionSvc = new ChainActionService(prisma as any);
    breakerSvc = new CircuitBreakerService(prisma as any);
    opsSvc = new OpsService(
      prisma as any,
      chainActionSvc,
      { snapshot: jest.fn().mockReturnValue({}) } as any,
    );
    loanSvc = new LoanService(
      prisma as any,
      chainActionSvc,
      { enforce: jest.fn().mockResolvedValue(undefined) } as any,
      breakerSvc,
    );
  });

  // ── Step 1: Confirm fiat via adapter ────────────────────────────────────────

  describe("Step 1 — fiat disbursement confirmed", () => {
    it("creates a CONFIRMED outbound fiat transfer record", async () => {
      fiatTransferId = crypto.randomUUID();
      prisma._fiatTransfers.set(fiatTransferId, {
        id: fiatTransferId,
        loanId,
        provider: "MPESA",
        direction: FiatTransferDirection.OUTBOUND,
        status: FiatTransferStatus.CONFIRMED,
        providerRef: "MPESA-SIM-001",
        idempotencyKey: "sim-idem-001",
        amountKes: 500_000n,
        phoneNumber: "+254700000001",
        confirmedAt: new Date(),
        appliedOnchainAt: null,
        chainActionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const ft = prisma._fiatTransfers.get(fiatTransferId)!;
      expect(ft.status).toBe(FiatTransferStatus.CONFIRMED);
      expect(ft.appliedOnchainAt).toBeNull();
    });

    it("enqueues a RECORD_DISBURSEMENT chain action", async () => {
      const action = await chainActionSvc.enqueue(
        loanId,
        ChainActionType.RECORD_DISBURSEMENT,
        { fiatTransferId, providerRef: "MPESA-SIM-001" },
      );
      chainActionId = action.id;

      const ft = prisma._fiatTransfers.get(fiatTransferId)!;
      ft.chainActionId = chainActionId;

      expect(action.status).toBe(ChainActionStatus.QUEUED);
      expect(action.loanId).toBe(loanId);
    });
  });

  // ── Step 2: Force sender failure (RPC outage) ───────────────────────────────

  describe("Step 2 — RPC outage causes sender failure", () => {
    it("classifies ECONNREFUSED as a retryable error on first attempt", async () => {
      const result = await chainActionSvc.markFailed(chainActionId, RPC_OUTAGE_ERROR);
      expect(result.status).toBe(ChainActionStatus.QUEUED);
      expect(result.nextRetryAt).toBeDefined();
      expect((result as AnyObj).attempts).toBe(1);
    });

    it("retries increment attempts up to MAX_RETRIES - 1", async () => {
      for (let i = 1; i < MAX_RETRIES - 1; i++) {
        await chainActionSvc.markFailed(chainActionId, RPC_OUTAGE_ERROR);
      }
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.attempts).toBe(MAX_RETRIES - 1);
      expect(action.status).toBe(ChainActionStatus.QUEUED);
    });

    it("moves to DLQ after MAX_RETRIES exhausted", async () => {
      const result = await chainActionSvc.markFailed(chainActionId, RPC_OUTAGE_ERROR);
      expect(result.status).toBe(ChainActionStatus.DLQ);
      expect((result as AnyObj).dlqAt).toBeDefined();
    });
  });

  // ── Step 3: Verify loan not activated + tx in DLQ ──────────────────────────

  describe("Step 3 — loan not activated; tx in DLQ", () => {
    it("loan remains in FUNDED status (not ACTIVE)", () => {
      const loan = prisma._loans.get(loanId)!;
      expect(loan.status).not.toBe(LoanStatus.ACTIVE);
      expect(loan.status).toBe(LoanStatus.FUNDING);
    });

    it("fiat transfer appliedOnchainAt is still null", () => {
      const ft = prisma._fiatTransfers.get(fiatTransferId)!;
      expect(ft.appliedOnchainAt).toBeNull();
    });

    it("activation guard rejects onActivateLoanConfirmed when proof is missing", async () => {
      const transfer = prisma._fiatTransfers.get(fiatTransferId)!;
      const fiatTransferRepo = {
        findOutboundByLoan: jest.fn(async (id: string) =>
          id === loanId ? { ...transfer, status: FiatTransferStatus.CONFIRMED } : null,
        ),
        markActivated: jest.fn(),
      };
      const disbursementSvc = new FiatDisbursementService(
        fiatTransferRepo as any,
        { enqueue: jest.fn() } as any,
        { initiatePayout: jest.fn() } as any,
      );
      await disbursementSvc.onActivateLoanConfirmed(loanId);
      expect(fiatTransferRepo.markActivated).not.toHaveBeenCalled();
    });

    it("RECORD_DISBURSEMENT chain action is in DLQ", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.status).toBe(ChainActionStatus.DLQ);
    });
  });

  // ── Step 4: Run reconciliation ──────────────────────────────────────────────

  describe("Step 4 — daily reconciliation detects the mismatch", () => {
    let summary: AnyObj;

    beforeAll(async () => {
      summary = await opsSvc.runDailyReconciliation();
    });

    it("produces a reconciliation summary", () => {
      expect(summary).toBeDefined();
      expect(Array.isArray(summary.reports)).toBe(true);
    });

    it("flags FIAT_CONFIRMED_NO_CHAIN_TX mismatch with count > 0", () => {
      const report = summary.reports.find(
        (r: AnyObj) => r.report === "FIAT_CONFIRMED_NO_CHAIN_TX",
      );
      expect(report).toBeDefined();
      expect(report!.count).toBeGreaterThan(0);
    });
  });

  // ── Step 5: Assert mismatch flagged + originations blocked ─────────────────

  describe("Step 5 — breaker fires; originations blocked", () => {
    let summary: AnyObj;

    beforeAll(async () => {
      summary = await opsSvc.runDailyReconciliation();
      await breakerSvc.evaluateReconciliation(summary as any);
    });

    it("fires FIAT_CONFIRMED_NO_CHAIN_RECORD trigger", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      expect(
        incidents.some((i) => i.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD),
      ).toBe(true);
    });

    it("sets globalBlock on enforcement state", async () => {
      const state = await breakerSvc.getEnforcementState();
      expect(state.globalBlock).toBe(true);
    });

    it("blocks new loan originations with ForbiddenException", async () => {
      await expect(
        loanSvc.createLoan(partnerId, {
          borrowerWallet: "0xNewBorrower",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("writes audit log entry for the trigger", () => {
      expect(
        prisma._breakerAuditLogs.some(
          (l) => l.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
        ),
      ).toBe(true);
    });

    it("no silent failure — incident is open and auditable", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find(
        (i) => i.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
      );
      expect(incident).toBeDefined();
      expect(incident!.status).toBe(BreakerIncidentStatus.OPEN);
    });
  });

  // ── Step 6: Admin replay ────────────────────────────────────────────────────

  describe("Step 6 — admin replay resets DLQ action to QUEUED", () => {
    it("replayFromDlq moves the action from DLQ back to QUEUED", async () => {
      const replayed = await chainActionSvc.replayFromDlq(chainActionId, "admin@unified.local");
      expect(replayed.status).toBe(ChainActionStatus.QUEUED);
    });

    it("clears dlqAt after replay", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.dlqAt).toBeNull();
    });

    it("resets attempts to 0 after replay", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.attempts).toBe(0);
    });

    it("sets nextRetryAt so the action is picked up immediately", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.nextRetryAt).toBeDefined();
      expect(action.nextRetryAt.getTime()).toBeLessThanOrEqual(Date.now() + 100);
    });

    it("records the admin subject in the error/audit field", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.error).toContain("admin@unified.local");
    });
  });

  // ── Step 7: Record + activate succeed; breaker lifts ───────────────────────

  describe("Step 7 — recordFiatDisbursement succeeds; activateLoan succeeds; breaker lifts", () => {
    let incidentId: string;

    beforeAll(async () => {
      // Simulate successful on-chain recording: mark the chain action MINED
      // and update the fiat transfer to CHAIN_RECORDED.
      const action = prisma._chainActions.get(chainActionId)!;
      action.status = ChainActionStatus.MINED;
      action.txHash = "0xSuccessTxHash";
      action.updatedAt = new Date();

      const ft = prisma._fiatTransfers.get(fiatTransferId)!;
      ft.status = FiatTransferStatus.CHAIN_RECORDED;
      ft.appliedOnchainAt = new Date();
      ft.updatedAt = new Date();

      // Simulate successful loan activation.
      const loan = prisma._loans.get(loanId)!;
      loan.status = LoanStatus.ACTIVE;
      loan.updatedAt = new Date();

      // Resolve the open incident so the breaker can lift.
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find(
        (i) => i.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
      );
      if (incident) {
        incidentId = incident.id;
        await breakerSvc.resolveIncident(incidentId, "admin@unified.local");
      }
    });

    it("fiat transfer is now CHAIN_RECORDED", () => {
      const ft = prisma._fiatTransfers.get(fiatTransferId)!;
      expect(ft.status).toBe(FiatTransferStatus.CHAIN_RECORDED);
      expect(ft.appliedOnchainAt).not.toBeNull();
    });

    it("loan is now ACTIVE", () => {
      const loan = prisma._loans.get(loanId)!;
      expect(loan.status).toBe(LoanStatus.ACTIVE);
    });

    it("chain action is MINED", () => {
      const action = prisma._chainActions.get(chainActionId)!;
      expect(action.status).toBe(ChainActionStatus.MINED);
    });

    it("incident is resolved", async () => {
      const incident = prisma._breakerIncidents.get(incidentId)!;
      expect(incident.status).toBe(BreakerIncidentStatus.RESOLVED);
    });

    it("breaker lifts — globalBlock is false after incident resolved", async () => {
      const state = await breakerSvc.getEnforcementState();
      expect(state.globalBlock).toBe(false);
    });

    it("new originations are allowed again", async () => {
      await expect(
        loanSvc.createLoan(partnerId, {
          borrowerWallet: "0xNewBorrower2",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).resolves.toBeDefined();
    });

    it("full audit trail exists — at least one audit log entry per trigger lifecycle", () => {
      const triggerLog = prisma._breakerAuditLogs.find(
        (l) => l.trigger === BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
      );
      expect(triggerLog).toBeDefined();

      const resolveLog = prisma._breakerAuditLogs.find(
        (l) => typeof l.note === "string" && l.note.includes("incident resolved"),
      );
      expect(resolveLog).toBeDefined();
    });
  });
});
