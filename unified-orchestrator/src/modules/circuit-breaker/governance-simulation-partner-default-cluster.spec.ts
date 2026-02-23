/**
 * Governance Simulation — Partner Default Cluster
 *
 * Validates partner-level risk isolation: when Partner A's 30-day default
 * rate exceeds the 8% threshold the breaker blocks only Partner A's
 * originations, leaves all other partners unaffected, and records a full
 * audit trail.  A time-bound admin override is then applied and verified.
 *
 * Steps:
 *   1. Generate defaults exceeding threshold for Partner A.
 *   2. Verify Partner A originations blocked; other partners unaffected;
 *      incident logged; no global freeze.
 *   3. Attempt manual override (unauthenticated → rejected).
 *   4. Apply authenticated, time-bound override; verify it is honoured and
 *      audit log is complete.
 */

import { ForbiddenException } from "@nestjs/common";
import {
  BreakerScope,
  BreakerTrigger,
  BreakerIncidentStatus,
  LoanStatus,
} from "@prisma/client";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { LoanService } from "../loan/loan.service";
import { ChainActionService } from "../chain-action/chain-action.service";

type AnyObj = Record<string, any>;

// ── In-memory Prisma mock ──────────────────────────────────────────────────────

function createMockPrisma() {
  const loans = new Map<string, AnyObj>();
  const partners = new Map<string, AnyObj>();
  const pools = new Map<string, AnyObj>();
  const breakerIncidents = new Map<string, AnyObj>();
  const breakerOverrides = new Map<string, AnyObj>();
  const breakerAuditLogs: AnyObj[] = [];
  const chainActions = new Map<string, AnyObj>();

  return {
    _loans: loans,
    _partners: partners,
    _pools: pools,
    _breakerIncidents: breakerIncidents,
    _breakerOverrides: breakerOverrides,
    _breakerAuditLogs: breakerAuditLogs,
    _chainActions: chainActions,

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
      findUnique: jest.fn(async ({ where }: AnyObj) => loans.get(where.id) ?? null),
      findMany: jest.fn(async ({ where, take, orderBy }: AnyObj) => {
        let rows = [...loans.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (orderBy?.updatedAt === "desc") rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = loans.get(where.id);
        if (!r) throw new Error(`Loan not found: ${where.id}`);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
      }),
    },

    chainAction: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = data.id ?? crypto.randomUUID();
        const row = { id, attempts: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
        chainActions.set(id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: AnyObj) => chainActions.get(where.id) ?? null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = chainActions.get(where.id);
        if (!r) throw new Error(`ChainAction not found: ${where.id}`);
        Object.assign(r, data);
        r.updatedAt = new Date();
        return r;
      }),
      count: jest.fn(async () => 0),
    },

    fiatTransfer: {
      findMany: jest.fn(async () => []),
    },

    webhookDeadLetter: {
      count: jest.fn(async () => 0),
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
        if (where?.createdAt?.lte) rows = rows.filter((r) => r.createdAt <= where.createdAt.lte);
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

    breakerOverride: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = crypto.randomUUID();
        const row = { id, liftedAt: null, liftedBy: null, createdAt: new Date(), ...data };
        breakerOverrides.set(id, row);
        return row;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: AnyObj) => {
        const r = breakerOverrides.get(where.id);
        if (!r) throw new Error(`BreakerOverride not found: ${where.id}`);
        return r;
      }),
      findMany: jest.fn(async ({ where }: AnyObj) => {
        let rows = [...breakerOverrides.values()];
        if (where?.liftedAt === null) rows = rows.filter((r) => r.liftedAt === null);
        if (where?.expiresAt?.gt) rows = rows.filter((r) => r.expiresAt > where.expiresAt.gt);
        return rows;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = breakerOverrides.get(where.id);
        if (!r) throw new Error(`BreakerOverride not found: ${where.id}`);
        Object.assign(r, data);
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

function seedPartner(prisma: ReturnType<typeof createMockPrisma>, name: string) {
  const id = crypto.randomUUID();
  prisma._partners.set(id, {
    id,
    legalName: name,
    jurisdictionCode: 840,
    registrationNumber: `REG-${name}`,
    complianceEmail: `ops@${name.toLowerCase()}.local`,
    treasuryWallet: `0xTreasury${name}`,
    status: "ACTIVE",
    maxLoanSizeUsdc: 0n,
    reserveRatioBps: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const poolId = crypto.randomUUID();
  prisma._pools.set(poolId, {
    id: poolId,
    partnerId: id,
    poolContract: `0xPool${name}`,
    chainId: 1,
    createdAt: new Date(),
  });
  return id;
}

/** Default rate that exceeds the 8% threshold. */
const ABOVE_THRESHOLD_RATE = 0.12;
/** Default rate safely below the 8% threshold. */
const BELOW_THRESHOLD_RATE = 0.04;

// ── Simulation ─────────────────────────────────────────────────────────────────

describe("Governance Simulation — Partner Default Cluster", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let partnerAId: string;
  let partnerBId: string;
  let partnerCId: string;
  let breakerSvc: CircuitBreakerService;
  let loanSvc: LoanService;
  let chainActionSvc: ChainActionService;

  beforeAll(async () => {
    prisma = createMockPrisma();
    partnerAId = seedPartner(prisma, "PartnerA");
    partnerBId = seedPartner(prisma, "PartnerB");
    partnerCId = seedPartner(prisma, "PartnerC");

    chainActionSvc = new ChainActionService(prisma as any);
    breakerSvc = new CircuitBreakerService(prisma as any);
    loanSvc = new LoanService(
      prisma as any,
      chainActionSvc,
      { enforce: jest.fn().mockResolvedValue(undefined) } as any,
      breakerSvc,
    );
  });

  // ── Step 1: Generate defaults exceeding threshold for Partner A ─────────────

  describe("Step 1 — Partner A default rate exceeds 8% threshold", () => {
    it("evaluatePartnerDefaultSpike returns null for rates below threshold", async () => {
      const result = await breakerSvc.evaluatePartnerDefaultSpike(
        partnerAId,
        BELOW_THRESHOLD_RATE,
      );
      expect(result).toBeNull();
    });

    it("evaluatePartnerDefaultSpike fires incident when rate exceeds threshold", async () => {
      const incident = await breakerSvc.evaluatePartnerDefaultSpike(
        partnerAId,
        ABOVE_THRESHOLD_RATE,
      );
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.PARTNER_DEFAULT_RATE_30D);
      expect(incident!.partnerId).toBe(partnerAId);
    });

    it("incident scope is PARTNER (not GLOBAL)", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find((i) => i.partnerId === partnerAId);
      expect(incident).toBeDefined();
      expect(incident!.scope).toBe(BreakerScope.PARTNER);
    });

    it("incident metricValue reflects the actual default rate", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find((i) => i.partnerId === partnerAId);
      expect(incident!.metricValue).toBeCloseTo(ABOVE_THRESHOLD_RATE, 4);
    });

    it("incident threshold is 0.08", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find((i) => i.partnerId === partnerAId);
      expect(incident!.threshold).toBeCloseTo(0.08, 4);
    });
  });

  // ── Step 2: Verify isolation — Partner A blocked, others unaffected ─────────

  describe("Step 2 — Partner A blocked; Partner B and C unaffected; no global freeze", () => {
    let state: Awaited<ReturnType<typeof breakerSvc.getEnforcementState>>;

    beforeAll(async () => {
      state = await breakerSvc.getEnforcementState();
    });

    it("Partner A is in blockedPartnerIds", () => {
      expect(state.blockedPartnerIds.has(partnerAId)).toBe(true);
    });

    it("Partner B is NOT in blockedPartnerIds", () => {
      expect(state.blockedPartnerIds.has(partnerBId)).toBe(false);
    });

    it("Partner C is NOT in blockedPartnerIds", () => {
      expect(state.blockedPartnerIds.has(partnerCId)).toBe(false);
    });

    it("globalBlock is false — no system-wide freeze", () => {
      expect(state.globalBlock).toBe(false);
    });

    it("globalFreeze is false", () => {
      expect(state.globalFreeze).toBe(false);
    });

    it("Partner A originations are rejected with ForbiddenException", async () => {
      await expect(
        loanSvc.createLoan(partnerAId, {
          borrowerWallet: "0xBorrowerA",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("Partner B originations succeed (unaffected)", async () => {
      await expect(
        loanSvc.createLoan(partnerBId, {
          borrowerWallet: "0xBorrowerB",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).resolves.toBeDefined();
    });

    it("Partner C originations succeed (unaffected)", async () => {
      await expect(
        loanSvc.createLoan(partnerCId, {
          borrowerWallet: "0xBorrowerC",
          principalUsdc: 1000n,
          collateralToken: "0xCollateral",
          collateralAmount: 500n,
          durationSeconds: 86400,
          interestRateBps: 500,
        }),
      ).resolves.toBeDefined();
    });

    it("incident is OPEN and auditable", async () => {
      const incidents = await breakerSvc.getOpenIncidents();
      const incident = incidents.find(
        (i) =>
          i.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          i.partnerId === partnerAId,
      );
      expect(incident).toBeDefined();
      expect(incident!.status).toBe(BreakerIncidentStatus.OPEN);
    });

    it("audit log contains an entry for the trigger", () => {
      const log = prisma._breakerAuditLogs.find(
        (l) =>
          l.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          l.partnerId === partnerAId,
      );
      expect(log).toBeDefined();
    });

    it("a second call with the same rate opens another incident (no server-side dedup — caller responsibility)", async () => {
      const countBefore = [...prisma._breakerIncidents.values()].filter(
        (i) =>
          i.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          i.partnerId === partnerAId &&
          i.status === BreakerIncidentStatus.OPEN,
      ).length;

      await breakerSvc.evaluatePartnerDefaultSpike(partnerAId, ABOVE_THRESHOLD_RATE);

      const countAfter = [...prisma._breakerIncidents.values()].filter(
        (i) =>
          i.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          i.partnerId === partnerAId &&
          i.status === BreakerIncidentStatus.OPEN,
      ).length;

      expect(countAfter).toBe(countBefore + 1);
    });
  });

  // ── Step 3: Unauthenticated override attempt is rejected ────────────────────

  describe("Step 3 — override requires admin identity and valid expiry", () => {
    it("rejects override with expiresInMinutes = 0", async () => {
      await expect(
        breakerSvc.applyOverride({
          trigger: BreakerTrigger.PARTNER_DEFAULT_RATE_30D,
          scope: BreakerScope.PARTNER,
          partnerId: partnerAId,
          reason: "no expiry",
          operator: "anon",
          expiresInMinutes: 0,
        }),
      ).rejects.toThrow("expiresInMinutes must be between 1 and 10080");
    });

    it("rejects override with expiresInMinutes > 10080 (7 days)", async () => {
      await expect(
        breakerSvc.applyOverride({
          trigger: BreakerTrigger.PARTNER_DEFAULT_RATE_30D,
          scope: BreakerScope.PARTNER,
          partnerId: partnerAId,
          reason: "too long",
          operator: "anon",
          expiresInMinutes: 10_081,
        }),
      ).rejects.toThrow("expiresInMinutes must be between 1 and 10080");
    });

    it("no override records were created by the rejected attempts", () => {
      expect(prisma._breakerOverrides.size).toBe(0);
    });
  });

  // ── Step 4: Authenticated, time-bound override ──────────────────────────────

  describe("Step 4 — authenticated admin applies time-bound override", () => {
    let overrideId: string;

    beforeAll(async () => {
      const override = await breakerSvc.applyOverride({
        trigger: BreakerTrigger.PARTNER_DEFAULT_RATE_30D,
        scope: BreakerScope.PARTNER,
        partnerId: partnerAId,
        reason: "Temporary relief — remediation plan agreed",
        operator: "admin@unified.local",
        expiresInMinutes: 120,
      });
      overrideId = override.id;
    });

    it("override record is created", () => {
      expect(prisma._breakerOverrides.size).toBe(1);
    });

    it("override is scoped to Partner A only", () => {
      const override = prisma._breakerOverrides.get(overrideId)!;
      expect(override.partnerId).toBe(partnerAId);
    });

    it("override expires within the requested window (120 min)", () => {
      const override = prisma._breakerOverrides.get(overrideId)!;
      const diffMs = override.expiresAt.getTime() - Date.now();
      expect(diffMs).toBeGreaterThan(119 * 60_000);
      expect(diffMs).toBeLessThanOrEqual(120 * 60_000 + 500);
    });

    it("override is not yet lifted", () => {
      const override = prisma._breakerOverrides.get(overrideId)!;
      expect(override.liftedAt).toBeNull();
    });

    it("audit log records the override application", () => {
      const log = prisma._breakerAuditLogs.find(
        (l) =>
          l.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          typeof l.note === "string" &&
          l.note.includes("override applied"),
      );
      expect(log).toBeDefined();
      expect(log!.operator).toBe("admin@unified.local");
    });

    it("getActiveOverrides returns the new override", async () => {
      const active = await breakerSvc.getActiveOverrides();
      expect(active.some((o) => o.id === overrideId)).toBe(true);
    });

    it("liftOverride marks the override as lifted", async () => {
      const lifted = await breakerSvc.liftOverride(overrideId, "admin@unified.local");
      expect(lifted.liftedAt).toBeDefined();
      expect(lifted.liftedBy).toBe("admin@unified.local");
    });

    it("lifted override no longer appears in getActiveOverrides", async () => {
      const active = await breakerSvc.getActiveOverrides();
      expect(active.some((o) => o.id === overrideId)).toBe(false);
    });

    it("audit log records the override lift", () => {
      const log = prisma._breakerAuditLogs.find(
        (l) =>
          l.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          typeof l.note === "string" &&
          l.note.includes("override lifted"),
      );
      expect(log).toBeDefined();
    });

    it("liftOverride throws if called a second time on the same override", async () => {
      await expect(
        breakerSvc.liftOverride(overrideId, "admin@unified.local"),
      ).rejects.toThrow("already lifted");
    });

    it("full audit trail — trigger log + override log + lift log all present", () => {
      const triggerLog = prisma._breakerAuditLogs.find(
        (l) =>
          l.trigger === BreakerTrigger.PARTNER_DEFAULT_RATE_30D &&
          l.partnerId === partnerAId &&
          !l.note?.includes("override"),
      );
      const overrideLog = prisma._breakerAuditLogs.find(
        (l) => typeof l.note === "string" && l.note.includes("override applied"),
      );
      const liftLog = prisma._breakerAuditLogs.find(
        (l) => typeof l.note === "string" && l.note.includes("override lifted"),
      );

      expect(triggerLog).toBeDefined();
      expect(overrideLog).toBeDefined();
      expect(liftLog).toBeDefined();
    });
  });
});
