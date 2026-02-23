import { ForbiddenException } from "@nestjs/common";
import {
  BreakerAction,
  BreakerIncidentStatus,
  BreakerScope,
  BreakerTrigger,
} from "@prisma/client";
import { CircuitBreakerService } from "./circuit-breaker.service";

type AnyObj = Record<string, any>;

function createMockPrisma() {
  const incidents = new Map<string, AnyObj>();
  const auditLogs: AnyObj[] = [];
  const overrides = new Map<string, AnyObj>();

  return {
    _incidents: incidents,
    _auditLogs: auditLogs,
    _overrides: overrides,

    breakerIncident: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = `inc-${incidents.size + 1}`;
        const row = { id, status: BreakerIncidentStatus.OPEN, createdAt: new Date(), updatedAt: new Date(), ...data };
        incidents.set(id, row);
        return row;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: AnyObj) => {
        let rows = [...incidents.values()];
        if (where?.status) {
          if (typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
          else if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        }
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
      findFirst: jest.fn(async ({ where }: AnyObj) => {
        return [...incidents.values()].find((r) => {
          if (where?.trigger && r.trigger !== where.trigger) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          if (where?.partnerId !== undefined && r.partnerId !== where.partnerId) return false;
          return true;
        }) ?? null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: AnyObj) => {
        const r = incidents.get(where.id);
        if (!r) throw new Error(`Incident not found: ${where.id}`);
        return r;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = incidents.get(where.id);
        if (!r) throw new Error(`Incident not found: ${where.id}`);
        Object.assign(r, data);
        return r;
      }),
    },

    breakerAuditLog: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const row = { id: `log-${auditLogs.length + 1}`, createdAt: new Date(), ...data };
        auditLogs.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ orderBy, take }: AnyObj) => {
        let rows = [...auditLogs];
        if (orderBy?.createdAt === "desc") rows = rows.reverse();
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows;
      }),
    },

    breakerOverride: {
      create: jest.fn(async ({ data }: AnyObj) => {
        const id = `ov-${overrides.size + 1}`;
        const row = { id, liftedAt: null, createdAt: new Date(), ...data };
        overrides.set(id, row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: AnyObj) => {
        let rows = [...overrides.values()];
        if (where?.expiresAt?.gt) rows = rows.filter((r) => r.expiresAt > where.expiresAt.gt);
        if (where?.liftedAt === null) rows = rows.filter((r) => r.liftedAt === null);
        return rows;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: AnyObj) => {
        const r = overrides.get(where.id);
        if (!r) throw new Error(`Override not found: ${where.id}`);
        return r;
      }),
      update: jest.fn(async ({ where, data }: AnyObj) => {
        const r = overrides.get(where.id);
        if (!r) throw new Error(`Override not found: ${where.id}`);
        Object.assign(r, data);
        return r;
      }),
    },
  };
}

function makeSvc(prisma: ReturnType<typeof createMockPrisma>) {
  return new CircuitBreakerService(prisma as any);
}

const CLEAN_SUMMARY = {
  reports: [
    { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 0 },
    { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
    { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
  ],
};

describe("CircuitBreakerService — unit", () => {
  // ── Settlement integrity triggers ──────────────────────────────────────────

  describe("evaluateReconciliation", () => {
    it("fires FIAT_CONFIRMED_NO_CHAIN_RECORD when count > 0", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const alerts = await svc.evaluateReconciliation({
        reports: [
          { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 3 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].trigger).toBe(BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD);
      expect(alerts[0].severity).toBe("CRITICAL");
      expect(alerts[0].actions).toContain(BreakerAction.BLOCK_ALL_ORIGINATIONS);
      expect(prisma._incidents.size).toBe(1);
    });

    it("fires ACTIVE_WITHOUT_DISBURSEMENT_PROOF when count > 0", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const alerts = await svc.evaluateReconciliation({
        reports: [
          { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 0 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 2 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].trigger).toBe(BreakerTrigger.ACTIVE_WITHOUT_DISBURSEMENT_PROOF);
      expect(alerts[0].severity).toBe("CRITICAL");
    });

    it("fires both settlement triggers when both counts > 0", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const alerts = await svc.evaluateReconciliation({
        reports: [
          { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 1 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 1 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      });
      expect(alerts).toHaveLength(2);
      expect(prisma._incidents.size).toBe(2);
    });

    it("returns empty array on clean state — no fail-open", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const alerts = await svc.evaluateReconciliation(CLEAN_SUMMARY);
      expect(alerts).toHaveLength(0);
      expect(prisma._incidents.size).toBe(0);
    });
  });

  // ── Partner default rate ───────────────────────────────────────────────────

  describe("evaluatePartnerDefaultSpike", () => {
    it("fires when rate > 8%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const incident = await svc.evaluatePartnerDefaultSpike("p1", 0.12);
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.PARTNER_DEFAULT_RATE_30D);
      expect(incident!.partnerId).toBe("p1");
      expect(incident!.actionsApplied).toContain(BreakerAction.BLOCK_PARTNER_ORIGINATIONS);
    });

    it("does NOT fire at exactly 8%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      expect(await svc.evaluatePartnerDefaultSpike("p1", 0.08)).toBeNull();
    });

    it("scoped: risky partner blocked, healthy partner unaffected", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("risky", 0.15);
      await svc.evaluatePartnerDefaultSpike("healthy", 0.03);
      const state = await svc.getEnforcementState();
      expect(state.blockedPartnerIds.has("risky")).toBe(true);
      expect(state.blockedPartnerIds.has("healthy")).toBe(false);
      expect(state.globalBlock).toBe(false);
    });
  });

  // ── Partner delinquency ────────────────────────────────────────────────────

  describe("evaluateDelinquencySpike", () => {
    it("fires when rate > 15%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const incident = await svc.evaluateDelinquencySpike("p1", 0.20);
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.PARTNER_DELINQUENCY_14D);
      expect(incident!.actionsApplied).toContain(BreakerAction.TIGHTEN_TERMS);
    });

    it("does NOT fire at exactly 15%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      expect(await svc.evaluateDelinquencySpike("p1", 0.15)).toBeNull();
    });
  });

  // ── Pool liquidity ─────────────────────────────────────────────────────────

  describe("evaluateLiquidityRatioBreach", () => {
    it("fires when ratio < 25%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const incident = await svc.evaluateLiquidityRatioBreach(0.18);
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.POOL_LIQUIDITY_RATIO);
      expect(incident!.actionsApplied).toContain(BreakerAction.FREEZE_ORIGINATIONS);
    });

    it("does NOT fire at exactly 25% or above", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      expect(await svc.evaluateLiquidityRatioBreach(0.25)).toBeNull();
      expect(await svc.evaluateLiquidityRatioBreach(0.50)).toBeNull();
    });
  });

  // ── Pool NAV drawdown ──────────────────────────────────────────────────────

  describe("evaluateNavDrawdown", () => {
    it("fires when drawdown > 2%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const incident = await svc.evaluateNavDrawdown("0xPool", 0.035);
      expect(incident).not.toBeNull();
      expect(incident!.trigger).toBe(BreakerTrigger.POOL_NAV_DRAWDOWN_7D);
      expect(incident!.actionsApplied).toContain(BreakerAction.TIGHTEN_TERMS);
    });

    it("does NOT fire at exactly 2%", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      expect(await svc.evaluateNavDrawdown("0xPool", 0.02)).toBeNull();
    });
  });

  // ── Enforcement state ──────────────────────────────────────────────────────

  describe("getEnforcementState", () => {
    it("clean state when no incidents", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const state = await svc.getEnforcementState();
      expect(state.globalBlock).toBe(false);
      expect(state.globalFreeze).toBe(false);
      expect(state.blockedPartnerIds.size).toBe(0);
    });

    it("globalBlock set by BLOCK_ALL_ORIGINATIONS incident", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluateReconciliation({
        reports: [{ report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 1 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 }],
      });
      const state = await svc.getEnforcementState();
      expect(state.globalBlock).toBe(true);
    });

    it("globalFreeze set by FREEZE_ORIGINATIONS incident", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluateLiquidityRatioBreach(0.10);
      const state = await svc.getEnforcementState();
      expect(state.globalFreeze).toBe(true);
    });

    it("tightenedPartnerIds populated by TIGHTEN_TERMS incident", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluateDelinquencySpike("p-xyz", 0.25);
      const state = await svc.getEnforcementState();
      expect(state.tightenedPartnerIds.has("p-xyz")).toBe(true);
    });
  });

  // ── assertOriginationAllowed ───────────────────────────────────────────────

  describe("assertOriginationAllowed", () => {
    it("throws ForbiddenException on globalBlock", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluateReconciliation({
        reports: [{ report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: 1 },
          { report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF", count: 0 },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 }],
      });
      await expect(svc.assertOriginationAllowed("any")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException on globalFreeze", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluateLiquidityRatioBreach(0.10);
      await expect(svc.assertOriginationAllowed("any")).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for blocked partner", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("blocked", 0.20);
      await expect(svc.assertOriginationAllowed("blocked")).rejects.toThrow(ForbiddenException);
    });

    it("allows unblocked partner when another is blocked", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("blocked", 0.20);
      await expect(svc.assertOriginationAllowed("healthy")).resolves.toBeUndefined();
    });

    it("allows origination in clean state", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await expect(svc.assertOriginationAllowed("any")).resolves.toBeUndefined();
    });
  });

  // ── Override management ────────────────────────────────────────────────────

  describe("applyOverride / liftOverride", () => {
    it("creates override with correct expiry", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const before = Date.now();
      const override = await svc.applyOverride({
        trigger: BreakerTrigger.PARTNER_DEFAULT_RATE_30D,
        scope: BreakerScope.PARTNER,
        partnerId: "p1",
        reason: "Maintenance",
        operator: "admin",
        expiresInMinutes: 60,
      });
      expect(override.expiresAt.getTime()).toBeGreaterThan(before + 59 * 60_000);
      expect(prisma._auditLogs.length).toBeGreaterThan(0);
    });

    it("rejects expiresInMinutes > 10080", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await expect(svc.applyOverride({
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        scope: BreakerScope.POOL,
        reason: "test",
        operator: "admin",
        expiresInMinutes: 99999,
      })).rejects.toThrow("10080");
    });

    it("rejects expiresInMinutes <= 0", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await expect(svc.applyOverride({
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        scope: BreakerScope.POOL,
        reason: "test",
        operator: "admin",
        expiresInMinutes: 0,
      })).rejects.toThrow("10080");
    });

    it("liftOverride sets liftedAt and writes audit log", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const override = await svc.applyOverride({
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        scope: BreakerScope.POOL,
        reason: "test",
        operator: "admin",
        expiresInMinutes: 60,
      });
      const before = prisma._auditLogs.length;
      const lifted = await svc.liftOverride(override.id, "senior-admin");
      expect(lifted.liftedAt).not.toBeNull();
      expect(lifted.liftedBy).toBe("senior-admin");
      expect(prisma._auditLogs.length).toBeGreaterThan(before);
    });

    it("liftOverride throws if already lifted", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      const override = await svc.applyOverride({
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        scope: BreakerScope.POOL,
        reason: "test",
        operator: "admin",
        expiresInMinutes: 60,
      });
      await svc.liftOverride(override.id, "admin");
      await expect(svc.liftOverride(override.id, "admin")).rejects.toThrow("already lifted");
    });
  });

  // ── Incident management ────────────────────────────────────────────────────

  describe("acknowledgeIncident / resolveIncident", () => {
    it("acknowledgeIncident: OPEN → ACKNOWLEDGED", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("p1", 0.20);
      const [incident] = [...prisma._incidents.values()];
      const updated = await svc.acknowledgeIncident(incident.id, "ops-alice");
      expect(updated.status).toBe(BreakerIncidentStatus.ACKNOWLEDGED);
      expect(updated.acknowledgedBy).toBe("ops-alice");
    });

    it("acknowledgeIncident throws if not OPEN", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("p1", 0.20);
      const [incident] = [...prisma._incidents.values()];
      await svc.acknowledgeIncident(incident.id, "ops");
      await expect(svc.acknowledgeIncident(incident.id, "ops")).rejects.toThrow("not OPEN");
    });

    it("resolveIncident removes partner from blockedPartnerIds", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("p1", 0.20);
      const [incident] = [...prisma._incidents.values()];
      await svc.resolveIncident(incident.id, "admin");
      const state = await svc.getEnforcementState();
      expect(state.blockedPartnerIds.has("p1")).toBe(false);
    });
  });

  // ── Audit log completeness ─────────────────────────────────────────────────

  describe("audit log", () => {
    it("every trigger firing writes audit log with operator=system", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("p1", 0.20);
      expect(prisma._auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(prisma._auditLogs[0].operator).toBe("system");
    });

    it("acknowledgeIncident writes audit log with correct operator", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.evaluatePartnerDefaultSpike("p1", 0.20);
      const [incident] = [...prisma._incidents.values()];
      const before = prisma._auditLogs.length;
      await svc.acknowledgeIncident(incident.id, "ops-bob");
      expect(prisma._auditLogs.length).toBeGreaterThan(before);
      expect(prisma._auditLogs[prisma._auditLogs.length - 1].operator).toBe("ops-bob");
    });

    it("applyOverride audit log contains reason", async () => {
      const prisma = createMockPrisma();
      const svc = makeSvc(prisma);
      await svc.applyOverride({
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        scope: BreakerScope.POOL,
        reason: "Planned drain",
        operator: "admin",
        expiresInMinutes: 30,
      });
      const log = prisma._auditLogs[prisma._auditLogs.length - 1];
      expect(log.note).toContain("Planned drain");
    });
  });

  // ── Multiple triggers accumulate independently ─────────────────────────────

  it("multiple triggers accumulate independently in enforcement state", async () => {
    const prisma = createMockPrisma();
    const svc = makeSvc(prisma);

    await svc.evaluatePartnerDefaultSpike("p-risky", 0.20);
    await svc.evaluateDelinquencySpike("p-delinquent", 0.25);
    await svc.evaluateLiquidityRatioBreach(0.10);

    const state = await svc.getEnforcementState();
    expect(state.blockedPartnerIds.has("p-risky")).toBe(true);
    expect(state.tightenedPartnerIds.has("p-delinquent")).toBe(true);
    expect(state.globalFreeze).toBe(true);
    expect(state.globalBlock).toBe(false);
    expect(prisma._incidents.size).toBe(3);
  });
});
