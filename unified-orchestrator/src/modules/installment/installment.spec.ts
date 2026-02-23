/**
 * Unit tests for the Installment Engine
 *
 * Covers:
 *   A. InstallmentScheduleService — schedule generation + hash determinism
 *   B. InstallmentEvaluationService — delinquent_days, late_fees, outstanding_balance
 *   C. InstallmentBreakerFeedService — delinquency/default rate computation
 *   D. InstallmentReconciliationService — mismatch detection
 */

import { InstallmentScheduleService } from "./installment-schedule.service";
import { InstallmentEvaluationService } from "./installment-evaluation.service";
import { InstallmentBreakerFeedService } from "./installment-breaker-feed.service";
import { InstallmentReconciliationService } from "./installment-reconciliation.service";
import { InstallmentStatus, LoanStatus } from "@prisma/client";
import {
  LATE_FEE_DAILY_BPS,
  DEFAULT_CLASSIFICATION_DAYS,
  RECONCILIATION_MISMATCH_THRESHOLD_USDC,
} from "./installment.types";

type AnyObj = Record<string, any>;

// ── A. Schedule generation ─────────────────────────────────────────────────────

describe("A. InstallmentScheduleService — schedule generation", () => {
  const svc = new InstallmentScheduleService(
    { installmentSchedule: {} } as any,
    { enqueue: jest.fn(async () => ({ id: "action-1" })) } as any,
    { emitMany: jest.fn(async () => {}) } as any,
  );

  // 2025-01-01T00:00:00Z in Unix seconds
  const START_TS = 1_735_689_600;
  // 30-day interval in seconds
  const INTERVAL = 30 * 86_400; // 2_592_000

  const BASE_PARAMS = {
    loanId: "loan-001",
    principalUsdc: 120_000_000n, // 120 USDC (6 decimals)
    interestRateBps: 1200,       // 12% APR
    startTimestamp: START_TS,
    intervalSeconds: INTERVAL,
    installmentCount: 3,
  };

  it("A1: generates the correct number of installments", () => {
    const schedule = svc.generate(BASE_PARAMS);
    expect(schedule.totalInstallments).toBe(3);
    expect(schedule.installments).toHaveLength(3);
  });

  it("A2: equal-principal — each installment has the same principal (except last)", () => {
    const schedule = svc.generate(BASE_PARAMS);
    const first = schedule.installments[0].principalDue;
    const second = schedule.installments[1].principalDue;
    expect(first).toBe(second);
  });

  it("A3: last installment absorbs the remainder so total principal is exact", () => {
    const schedule = svc.generate(BASE_PARAMS);
    const totalPrincipal = schedule.installments.reduce(
      (sum, i) => sum + i.principalDue,
      0n,
    );
    expect(totalPrincipal).toBe(BASE_PARAMS.principalUsdc);
  });

  it("A4: due timestamps are spaced exactly intervalSeconds apart", () => {
    const schedule = svc.generate(BASE_PARAMS);
    for (let i = 1; i < schedule.installments.length; i++) {
      const gap =
        schedule.installments[i].dueTimestamp -
        schedule.installments[i - 1].dueTimestamp;
      expect(gap).toBe(INTERVAL);
    }
  });

  it("A4b: first due timestamp = startTimestamp + intervalSeconds", () => {
    const schedule = svc.generate(BASE_PARAMS);
    expect(schedule.installments[0].dueTimestamp).toBe(START_TS + INTERVAL);
  });

  it("A4c: installmentIndex is 0-based", () => {
    const schedule = svc.generate(BASE_PARAMS);
    expect(schedule.installments[0].installmentIndex).toBe(0);
    expect(schedule.installments[2].installmentIndex).toBe(2);
  });

  it("A5: interest is computed on remaining principal each period", () => {
    const schedule = svc.generate(BASE_PARAMS);
    // First installment interest > last (declining balance)
    expect(schedule.installments[0].interestDue).toBeGreaterThan(
      schedule.installments[2].interestDue,
    );
  });

  it("A6: totalDue = principalDue + interestDue for every installment", () => {
    const schedule = svc.generate(BASE_PARAMS);
    for (const inst of schedule.installments) {
      expect(inst.totalDue).toBe(inst.principalDue + inst.interestDue);
    }
  });

  it("A7: schedule hash is a 64-char hex string", () => {
    const schedule = svc.generate(BASE_PARAMS);
    expect(schedule.scheduleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("A8: hash is deterministic — same params produce same hash", () => {
    const h1 = svc.generate(BASE_PARAMS).scheduleHash;
    const h2 = svc.generate({ ...BASE_PARAMS }).scheduleHash;
    expect(h1).toBe(h2);
  });

  it("A9: hash changes when any parameter changes", () => {
    const h1 = svc.generate(BASE_PARAMS).scheduleHash;
    const h2 = svc.generate({ ...BASE_PARAMS, interestRateBps: 1300 }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("A10: verifyHash returns true for matching params", () => {
    const schedule = svc.generate(BASE_PARAMS);
    expect(svc.verifyHash(BASE_PARAMS, schedule.scheduleHash)).toBe(true);
  });

  it("A11: verifyHash returns false for tampered hash", () => {
    expect(svc.verifyHash(BASE_PARAMS, "0".repeat(64))).toBe(false);
  });

  it("A12: throws on zero principal", () => {
    expect(() =>
      svc.generate({ ...BASE_PARAMS, principalUsdc: 0n }),
    ).toThrow("principalUsdc must be > 0");
  });

  it("A13: throws on zero intervalSeconds", () => {
    expect(() =>
      svc.generate({ ...BASE_PARAMS, intervalSeconds: 0 }),
    ).toThrow("intervalSeconds must be > 0");
  });

  it("A14: throws on installmentCount < 1", () => {
    expect(() =>
      svc.generate({ ...BASE_PARAMS, installmentCount: 0 }),
    ).toThrow("installmentCount must be >= 1");
  });

  it("A15: single-installment loan has one entry with full principal", () => {
    const schedule = svc.generate({ ...BASE_PARAMS, installmentCount: 1 });
    expect(schedule.installments[0].principalDue).toBe(BASE_PARAMS.principalUsdc);
  });

  it("A16: scheduleJson is valid JSON matching CanonicalScheduleJson shape", () => {
    const schedule = svc.generate(BASE_PARAMS);
    const parsed = JSON.parse(schedule.scheduleJson);
    expect(parsed.loan_id).toBe(BASE_PARAMS.loanId);
    expect(parsed.principal).toBe(String(BASE_PARAMS.principalUsdc));
    expect(parsed.interest_rate_bps).toBe(BASE_PARAMS.interestRateBps);
    expect(parsed.start_ts).toBe(String(START_TS));
    expect(parsed.interval_seconds).toBe(INTERVAL);
    expect(parsed.installment_count).toBe(3);
    expect(parsed.installments).toHaveLength(3);
  });

  it("A17: canonical JSON has no float values — all amounts are strings", () => {
    const schedule = svc.generate(BASE_PARAMS);
    const parsed = JSON.parse(schedule.scheduleJson);
    for (const inst of parsed.installments) {
      expect(typeof inst.principal).toBe("string");
      expect(typeof inst.interest).toBe("string");
      expect(typeof inst.total).toBe("string");
      expect(typeof inst.due_ts).toBe("string");
    }
  });

  it("A18: scheduleJson field order matches spec (loan_id first, installments last)", () => {
    const schedule = svc.generate(BASE_PARAMS);
    const keys = Object.keys(JSON.parse(schedule.scheduleJson));
    expect(keys[0]).toBe("loan_id");
    expect(keys[keys.length - 1]).toBe("installments");
  });
});

// ── B. Evaluation service ──────────────────────────────────────────────────────

describe("B. InstallmentEvaluationService — delinquency metrics", () => {
  function makeEntry(overrides: Partial<AnyObj> = {}): AnyObj {
    return {
      id: "entry-1",
      installmentIndex: 0,
      dueDate: new Date("2025-01-01T00:00:00Z"),
      principalDue: 40_000_000n,
      interestDue: 1_000_000n,
      totalDue: 41_000_000n,
      principalPaid: 0n,
      interestPaid: 0n,
      lateFeeAccrued: 0n,
      status: InstallmentStatus.PENDING,
      paidAt: null,
      delinquentSince: null,
      delinquentDays: 0,
      ...overrides,
    };
  }

  function makePrisma(entries: AnyObj[]) {
    const updatedEntries: AnyObj[] = [];
    return {
      installmentSchedule: {
        findUnique: jest.fn(async () => ({
          id: "sched-1",
          loanId: "loan-1",
          installments: entries,
        })),
      },
      installmentEntry: {
        update: jest.fn(async ({ where, data }: AnyObj) => {
          const entry = entries.find((e) => e.id === where.id)!;
          Object.assign(entry, data);
          updatedEntries.push({ ...entry });
          return entry;
        }),
        findMany: jest.fn(async () => entries.filter(
          (e) => e.status !== InstallmentStatus.PAID && e.status !== InstallmentStatus.WAIVED,
        )),
      },
      loan: {
        findMany: jest.fn(async () => []),
      },
      _updatedEntries: updatedEntries,
    };
  }

  it("B1: returns zero metrics when no schedule exists", async () => {
    const prisma = {
      installmentSchedule: { findUnique: jest.fn(async () => null) },
    };
    const svc = new InstallmentEvaluationService(prisma as any);
    const result = await svc.evaluateLoan("loan-1");
    expect(result.delinquentDays).toBe(0);
    expect(result.accruedLateFees).toBe(0n);
    expect(result.outstandingBalance).toBe(0n);
  });

  it("B2: future installment is not delinquent", async () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    const prisma = makePrisma([makeEntry({ dueDate: future })]);
    const svc = new InstallmentEvaluationService(prisma as any);
    const result = await svc.evaluateLoan("loan-1");
    expect(result.delinquentDays).toBe(0);
    expect(result.overdueInstallments).toBe(0);
  });

  it("B3: past-due installment is marked DELINQUENT with correct days", async () => {
    const daysOverdue = 5;
    const pastDue = new Date(Date.now() - daysOverdue * 86_400_000);
    const entry = makeEntry({ dueDate: pastDue });
    const prisma = makePrisma([entry]);
    const svc = new InstallmentEvaluationService(prisma as any);
    const result = await svc.evaluateLoan("loan-1", new Date());
    expect(result.delinquentDays).toBe(daysOverdue);
    expect(result.overdueInstallments).toBe(1);
    expect(entry.status).toBe(InstallmentStatus.DELINQUENT);
  });

  it("B4: installment past DEFAULT_CLASSIFICATION_DAYS is marked DEFAULTED", async () => {
    const daysOverdue = DEFAULT_CLASSIFICATION_DAYS + 1;
    const pastDue = new Date(Date.now() - daysOverdue * 86_400_000);
    const entry = makeEntry({ dueDate: pastDue });
    const prisma = makePrisma([entry]);
    const svc = new InstallmentEvaluationService(prisma as any);
    await svc.evaluateLoan("loan-1");
    expect(entry.status).toBe(InstallmentStatus.DEFAULTED);
  });

  it("B5: late fee = (remainingTotal * LATE_FEE_DAILY_BPS * daysOverdue) / 10000", async () => {
    const daysOverdue = 10;
    const pastDue = new Date(Date.now() - daysOverdue * 86_400_000);
    const entry = makeEntry({ dueDate: pastDue });
    const prisma = makePrisma([entry]);
    const svc = new InstallmentEvaluationService(prisma as any);
    const result = await svc.evaluateLoan("loan-1");

    const expectedFee =
      (entry.totalDue * BigInt(LATE_FEE_DAILY_BPS) * BigInt(daysOverdue)) / 10_000n;
    expect(result.accruedLateFees).toBe(expectedFee);
  });

  it("B6: outstanding balance excludes PAID entries", async () => {
    const paidEntry = makeEntry({
      id: "entry-paid",
      status: InstallmentStatus.PAID,
      principalPaid: 40_000_000n,
      interestPaid: 1_000_000n,
    });
    const unpaidEntry = makeEntry({ id: "entry-unpaid" });
    const prisma = makePrisma([paidEntry, unpaidEntry]);
    const svc = new InstallmentEvaluationService(prisma as any);
    const balance = await svc.getOutstandingBalance("loan-1");
    expect(balance).toBe(unpaidEntry.totalDue);
  });

  it("B7: nextDueDate is the earliest future installment", async () => {
    const future1 = new Date(Date.now() + 5 * 86_400_000);
    const future2 = new Date(Date.now() + 35 * 86_400_000);
    const prisma = makePrisma([
      makeEntry({ id: "e1", installmentIndex: 0, dueDate: future1 }),
      makeEntry({ id: "e2", installmentIndex: 1, dueDate: future2 }),
    ]);
    const svc = new InstallmentEvaluationService(prisma as any);
    const result = await svc.evaluateLoan("loan-1");
    expect(result.nextDueDate?.toISOString()).toBe(future1.toISOString());
  });
});

// ── C. Breaker feed ────────────────────────────────────────────────────────────

describe("C. InstallmentBreakerFeedService — partner metrics", () => {
  it("C1: delinquency rate = delinquent loans / active loans", async () => {
    const partnerId = "partner-1";
    const since14d = new Date(Date.now() - 13 * 86_400_000); // within 14d window

    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          {
            id: "loan-A",
            partnerId,
            borrowerWallet: "0xBorrowerA",
            principalUsdc: 100_000_000n,
            installmentSchedule: {
              installments: [
                {
                  status: InstallmentStatus.DELINQUENT,
                  accrualStatus: "DELINQUENT",
                  delinquentSince: since14d,
                  updatedAt: since14d,
                },
              ],
            },
          },
          {
            id: "loan-B",
            partnerId,
            borrowerWallet: "0xBorrowerB",
            principalUsdc: 100_000_000n,
            installmentSchedule: { installments: [] },
          },
          {
            id: "loan-C",
            partnerId,
            borrowerWallet: "0xBorrowerC",
            principalUsdc: 100_000_000n,
            installmentSchedule: { installments: [] },
          },
        ]),
      },
    };

    const breakerMock = {
      evaluateDelinquencySpike: jest.fn(async () => null),
      evaluatePartnerDefaultSpike: jest.fn(async () => null),
    };

    const svc = new InstallmentBreakerFeedService(prisma as any, breakerMock as any);
    const metricsMap = await svc.computePartnerMetrics();
    const metrics = metricsMap.get(partnerId)!;

    expect(metrics.activeLoans).toBe(3);
    expect(metrics.delinquentLoans14d).toBe(1);
    expect(metrics.delinquencyRate14d).toBeCloseTo(1 / 3, 4);
  });

  it("C2: default rate = defaulted loans / active loans", async () => {
    const partnerId = "partner-2";
    const since30d = new Date(Date.now() - 20 * 86_400_000);

    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          {
            id: "loan-D",
            partnerId,
            borrowerWallet: "0xBorrowerD",
            principalUsdc: 100_000_000n,
            installmentSchedule: {
              installments: [
                {
                  status: InstallmentStatus.DEFAULTED,
                  accrualStatus: "DEFAULTED",
                  delinquentSince: since30d,
                  updatedAt: since30d,
                },
              ],
            },
          },
          {
            id: "loan-E",
            partnerId,
            borrowerWallet: "0xBorrowerE",
            principalUsdc: 100_000_000n,
            installmentSchedule: { installments: [] },
          },
        ]),
      },
    };

    const breakerMock = {
      evaluateDelinquencySpike: jest.fn(async () => null),
      evaluatePartnerDefaultSpike: jest.fn(async () => null),
    };

    const svc = new InstallmentBreakerFeedService(prisma as any, breakerMock as any);
    const metricsMap = await svc.computePartnerMetrics();
    const metrics = metricsMap.get(partnerId)!;

    expect(metrics.defaultedLoans30d).toBe(1);
    expect(metrics.defaultRate30d).toBeCloseTo(0.5, 4);
  });

  it("C3: feedBreaker calls evaluateDelinquencySpike and evaluatePartnerDefaultSpike", async () => {
    const partnerId = "partner-3";
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          {
            id: "loan-F",
            partnerId,
            borrowerWallet: "0xBorrowerF",
            principalUsdc: 100_000_000n,
            installmentSchedule: { installments: [] },
          },
        ]),
      },
    };

    const breakerMock = {
      evaluateDelinquencySpike: jest.fn(async () => null),
      evaluatePartnerDefaultSpike: jest.fn(async () => null),
    };

    const svc = new InstallmentBreakerFeedService(prisma as any, breakerMock as any);
    await svc.feedBreaker();

    expect(breakerMock.evaluateDelinquencySpike).toHaveBeenCalledWith(partnerId, 0);
    expect(breakerMock.evaluatePartnerDefaultSpike).toHaveBeenCalledWith(partnerId, 0);
  });

  it("C4: feedBreaker returns triggered partner IDs when breaker fires", async () => {
    const partnerId = "partner-4";
    const since14d = new Date(Date.now() - 5 * 86_400_000);
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          {
            id: "loan-G",
            partnerId,
            borrowerWallet: "0xBorrowerG",
            principalUsdc: 100_000_000n,
            installmentSchedule: {
              installments: [
                {
                  status: InstallmentStatus.DELINQUENT,
                  accrualStatus: "DELINQUENT",
                  delinquentSince: since14d,
                  updatedAt: since14d,
                },
              ],
            },
          },
        ]),
      },
    };

    const breakerMock = {
      evaluateDelinquencySpike: jest.fn(async () => ({ id: "incident-1" })),
      evaluatePartnerDefaultSpike: jest.fn(async () => null),
    };

    const svc = new InstallmentBreakerFeedService(prisma as any, breakerMock as any);
    const triggered = await svc.feedBreaker();
    expect(triggered).toContain(partnerId);
  });
});

// ── D. Reconciliation ──────────────────────────────────────────────────────────

describe("D. InstallmentReconciliationService — balance mismatch", () => {
  it("D1: no mismatch when backend balance equals on-chain principal", async () => {
    const principal = 100_000_000n;
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          { id: "loan-1", partnerId: "p1", principalUsdc: principal, interestRateBps: 1000 },
        ]),
      },
    };
    const accrualMock = { getLoanAccrualSummary: jest.fn(async () => ({
      totalPrincipalRemaining: principal, totalInterestRemaining: 0n, totalPenaltyAccrued: 0n,
    })) };
    const alertsMock = { emitMany: jest.fn(async () => {}) };

    const svc = new InstallmentReconciliationService(
      prisma as any,
      accrualMock as any,
      alertsMock as any,
      null as any,
      null as any,
    );
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(0);
    expect(alertsMock.emitMany).not.toHaveBeenCalled();
  });

  it("D2: mismatch below threshold does not trigger alert", async () => {
    const principal = 100_000_000n;
    const extraPrincipal = RECONCILIATION_MISMATCH_THRESHOLD_USDC - 1n;
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          { id: "loan-1", partnerId: "p1", principalUsdc: principal, interestRateBps: 1000 },
        ]),
      },
    };
    const accrualMock = { getLoanAccrualSummary: jest.fn(async () => ({
      totalPrincipalRemaining: principal + extraPrincipal, totalInterestRemaining: 0n, totalPenaltyAccrued: 0n,
    })) };
    const alertsMock = { emitMany: jest.fn(async () => {}) };

    const svc = new InstallmentReconciliationService(
      prisma as any,
      accrualMock as any,
      alertsMock as any,
      null as any,
      null as any,
    );
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(0);
    expect(alertsMock.emitMany).not.toHaveBeenCalled();
  });

  it("D3: mismatch above threshold triggers alert", async () => {
    const principal = 100_000_000n;
    const penalty = RECONCILIATION_MISMATCH_THRESHOLD_USDC + 1n;
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          { id: "loan-1", partnerId: "p1", principalUsdc: principal, interestRateBps: 1000 },
        ]),
      },
    };
    const accrualMock = { getLoanAccrualSummary: jest.fn(async () => ({
      totalPrincipalRemaining: principal, totalInterestRemaining: 0n, totalPenaltyAccrued: penalty,
    })) };
    const alertsMock = { emitMany: jest.fn(async () => {}) };

    const svc = new InstallmentReconciliationService(
      prisma as any,
      accrualMock as any,
      alertsMock as any,
      null as any,
      null as any,
    );
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].loanId).toBe("loan-1");
    expect(report.mismatches[0].discrepancyUsdc).toBe(penalty);
    expect(alertsMock.emitMany).toHaveBeenCalledTimes(1);
  });

  it("D4: multiple mismatches are all reported", async () => {
    const principal = 100_000_000n;
    const bigPenalty = RECONCILIATION_MISMATCH_THRESHOLD_USDC + 1_000_000n;
    const prisma = {
      loan: {
        findMany: jest.fn(async () => [
          { id: "loan-1", partnerId: "p1", principalUsdc: principal, interestRateBps: 1000 },
          { id: "loan-2", partnerId: "p1", principalUsdc: principal, interestRateBps: 1000 },
          { id: "loan-3", partnerId: "p2", principalUsdc: principal, interestRateBps: 1000 },
        ]),
      },
    };
    const accrualMock = {
      getLoanAccrualSummary: jest.fn(async (loanId: string) => {
        if (loanId === "loan-3") return { totalPrincipalRemaining: principal, totalInterestRemaining: 0n, totalPenaltyAccrued: 0n };
        return { totalPrincipalRemaining: principal, totalInterestRemaining: 0n, totalPenaltyAccrued: bigPenalty };
      }),
    };
    const alertsMock = { emitMany: jest.fn(async () => {}) };

    const svc = new InstallmentReconciliationService(
      prisma as any,
      accrualMock as any,
      alertsMock as any,
      null as any,
      null as any,
    );
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(2);
    expect(report.totalLoansChecked).toBe(3);
  });
});
