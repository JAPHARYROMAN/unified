import { ForbiddenException } from "@nestjs/common";
import { BreakerIncidentStatus, BreakerTrigger, LoanStatus } from "@prisma/client";
import { CircuitBreakerMetricsService } from "./circuit-breaker-metrics.service";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { LoanService } from "../loan/loan.service";
import { ChainActionService } from "../chain-action/chain-action.service";

type LoanRow = {
  id: string;
  partnerId: string;
  status: LoanStatus;
  borrowerWallet: string;
  principalUsdc: bigint;
  collateralToken: string;
  collateralAmount: bigint;
  durationSeconds: number;
  interestRateBps: number;
  poolContract?: string;
  chainId?: number;
  createdAt: Date;
  updatedAt: Date;
};

function createMockPrisma(loans: LoanRow[]) {
  const partners = new Map<string, Record<string, any>>();
  const pools = new Map<string, Record<string, any>>();
  const breakerIncidents = new Map<string, Record<string, any>>();
  const breakerAuditLogs: Record<string, any>[] = [];
  const chainActions = new Map<string, Record<string, any>>();

  return {
    _partners: partners,
    _pools: pools,
    _loans: loans,
    _breakerIncidents: breakerIncidents,
    _breakerAuditLogs: breakerAuditLogs,

    partner: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const p = partners.get(where.id);
        if (!p) return null;
        if (!include?.pools) return p;
        return { ...p, pools: [...pools.values()].filter((x) => x.partnerId === p.id) };
      }),
    },

    loan: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: crypto.randomUUID(),
          status: LoanStatus.CREATED,
          loanContract: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        loans.push(row);
        return row;
      }),
      groupBy: jest.fn(async ({ by, where, _count }: any) => {
        if (!by || !_count?.id) return [];
        let rows = [...loans];
        if (where?.updatedAt?.gte) {
          rows = rows.filter((r) => r.updatedAt >= where.updatedAt.gte);
        }
        if (where?.createdAt?.gte) {
          rows = rows.filter((r) => r.createdAt >= where.createdAt.gte);
        }
        if (where?.status?.in) {
          rows = rows.filter((r) => where.status.in.includes(r.status));
        } else if (where?.status) {
          rows = rows.filter((r) => r.status === where.status);
        }

        const keyFields: string[] = by;
        const grouped = new Map<string, { key: any; count: number }>();
        for (const r of rows) {
          const keyObj: any = {};
          for (const f of keyFields) keyObj[f] = (r as any)[f];
          const key = JSON.stringify(keyObj);
          const prev = grouped.get(key);
          if (prev) prev.count += 1;
          else grouped.set(key, { key: keyObj, count: 1 });
        }

        return [...grouped.values()].map((g) => ({ ...g.key, _count: { id: g.count } }));
      }),
    },

    chainAction: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        const row = {
          id,
          status: "QUEUED",
          attempts: 0,
          txHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        chainActions.set(id, row);
        return row;
      }),
    },

    breakerIncident: {
      create: jest.fn(async ({ data }: any) => {
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
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let rows = [...breakerIncidents.values()];
        if (where?.status) {
          if (typeof where.status === "string") rows = rows.filter((r) => r.status === where.status);
          else if (where.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
        }
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows;
      }),
    },

    breakerAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: crypto.randomUUID(), createdAt: new Date(), ...data };
        breakerAuditLogs.push(row);
        return row;
      }),
    },
  };
}

describe("Unified v1.1 — Installment Metrics E2E", () => {
  it("produces delinquency spike and blocks partner originations (manifested)", async () => {
    const partnerA = "partner-A";
    const partnerB = "partner-B";
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    const loans: LoanRow[] = [
      {
        id: "a1",
        partnerId: partnerA,
        status: LoanStatus.ACTIVE,
        borrowerWallet: "0xBorrowerA1",
        principalUsdc: 1000n,
        collateralToken: "0xCol",
        collateralAmount: 500n,
        durationSeconds: 86400,
        interestRateBps: 500,
        poolContract: "0xPoolA",
        chainId: 1,
        createdAt: daysAgo(5),
        updatedAt: daysAgo(1),
      },
      {
        id: "a2",
        partnerId: partnerA,
        status: LoanStatus.REPAID,
        borrowerWallet: "0xBorrowerA2",
        principalUsdc: 1000n,
        collateralToken: "0xCol",
        collateralAmount: 500n,
        durationSeconds: 86400,
        interestRateBps: 500,
        poolContract: "0xPoolA",
        chainId: 1,
        createdAt: daysAgo(20),
        updatedAt: daysAgo(2),
      },
      {
        id: "a3",
        partnerId: partnerA,
        status: LoanStatus.ACTIVE,
        borrowerWallet: "0xBorrowerA3",
        principalUsdc: 1000n,
        collateralToken: "0xCol",
        collateralAmount: 500n,
        durationSeconds: 86400,
        interestRateBps: 500,
        poolContract: "0xPoolA",
        chainId: 1,
        createdAt: daysAgo(10),
        updatedAt: daysAgo(1),
      },
    ];

    const prisma = createMockPrisma(loans);
    prisma._partners.set(partnerA, {
      id: partnerA,
      legalName: "Partner A",
      jurisdictionCode: 840,
      registrationNumber: "REG-A",
      complianceEmail: "ops-a@test.local",
      treasuryWallet: "0xTreasuryA",
      status: "ACTIVE",
      maxLoanSizeUsdc: 0n,
      reserveRatioBps: 0,
      createdAt: now,
      updatedAt: now,
    });
    prisma._partners.set(partnerB, {
      id: partnerB,
      legalName: "Partner B",
      jurisdictionCode: 840,
      registrationNumber: "REG-B",
      complianceEmail: "ops-b@test.local",
      treasuryWallet: "0xTreasuryB",
      status: "ACTIVE",
      maxLoanSizeUsdc: 0n,
      reserveRatioBps: 0,
      createdAt: now,
      updatedAt: now,
    });
    prisma._pools.set("pool-A", {
      id: "pool-A",
      partnerId: partnerA,
      poolContract: "0xPoolA",
      chainId: 1,
      createdAt: now,
    });
    prisma._pools.set("pool-B", {
      id: "pool-B",
      partnerId: partnerB,
      poolContract: "0xPoolB",
      chainId: 1,
      createdAt: now,
    });

    const metrics = new CircuitBreakerMetricsService(prisma as any);

    const defaultBefore = await metrics.partnerDefaultRate30D();
    const delinquencyBefore = await metrics.partnerDelinquency14D();
    expect(defaultBefore.get(partnerA)).toBe(0);
    expect(delinquencyBefore.get(partnerA)).toBe(0);

    // Installment falls 31+ days late and transitions to default.
    loans.push({
      id: "a4",
      partnerId: partnerA,
      status: LoanStatus.DEFAULTED,
      borrowerWallet: "0xBorrowerA4",
      principalUsdc: 1000n,
      collateralToken: "0xCol",
      collateralAmount: 500n,
      durationSeconds: 86400,
      interestRateBps: 500,
      poolContract: "0xPoolA",
      chainId: 1,
      createdAt: daysAgo(12),
      updatedAt: now,
    });

    const defaultAfter = await metrics.partnerDefaultRate30D();
    const delinquencyAfter = await metrics.partnerDelinquency14D();

    const defaultRate = defaultAfter.get(partnerA) ?? 0;
    const delinquencyRate = delinquencyAfter.get(partnerA) ?? 0;
    expect(defaultRate).toBeGreaterThan(0);
    expect(delinquencyRate).toBeGreaterThan(0);

    const breaker = new CircuitBreakerService(prisma as any);
    const chainActions = new ChainActionService(prisma as any);
    const loanSvc = new LoanService(
      prisma as any,
      chainActions,
      { enforce: jest.fn().mockResolvedValue(undefined) } as any,
      breaker,
    );

    const incident = await breaker.evaluateDelinquencySpike(partnerA, delinquencyRate);
    expect(incident).not.toBeNull();
    expect(incident!.trigger).toBe(BreakerTrigger.PARTNER_DELINQUENCY_14D);

    await expect(
      loanSvc.createLoan(partnerA, {
        borrowerWallet: "0xRiskyBorrower",
        principalUsdc: 1000n,
        collateralToken: "0xCol",
        collateralAmount: 500n,
        durationSeconds: 86400,
        interestRateBps: 500,
      }),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      loanSvc.createLoan(partnerB, {
        borrowerWallet: "0xHealthyBorrower",
        principalUsdc: 1000n,
        collateralToken: "0xCol",
        collateralAmount: 500n,
        durationSeconds: 86400,
        interestRateBps: 500,
      }),
    ).resolves.toBeDefined();

    const manifest = {
      scenario: "BREAKER_METRIC_VALIDATION",
      loanId: loans[0].id,
      schedule_hash: "orchestrator_metric_projection",
      tx_hashes: [] as string[],
      installment_states_over_time: [
        { phase: "before_default", defaultRate: defaultBefore.get(partnerA) ?? 0, delinquencyRate: delinquencyBefore.get(partnerA) ?? 0 },
        { phase: "after_default", defaultRate, delinquencyRate },
      ],
      delinquency_metrics: {
        partnerId: partnerA,
        defaultRate30d: defaultRate,
        delinquencyRate14d: delinquencyRate,
      },
      breaker_events: [
        {
          trigger: incident?.trigger,
          actionsApplied: incident?.actionsApplied,
          partnerId: incident?.partnerId,
        },
      ],
    };

    // eslint-disable-next-line no-console
    console.log("INSTALLMENT_BREAKER_MANIFEST", JSON.stringify(manifest, null, 2));
  });
});
