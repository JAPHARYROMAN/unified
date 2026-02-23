/**
 * Accrual Job + Delinquency Metrics Tests
 *
 * Suites:
 *   CL. DelinquencyClassifier  — 5-state machine, boundary conditions
 *   AC. InstallmentAccrualService — idempotency, penalty math, hourly job
 *   BF. InstallmentBreakerFeedService — exposure_by_borrower, breaker threshold
 *   RC. InstallmentReconciliationService — principal+interest+penalty bounds
 */

import { AccrualStatus } from "@prisma/client";
import { DelinquencyClassifier } from "./installment-delinquency-classifier";
import { InstallmentAccrualService } from "./installment-accrual.service";
import { InstallmentBreakerFeedService } from "./installment-breaker-feed.service";
import { InstallmentReconciliationService } from "./installment-reconciliation.service";
import {
  DEFAULT_CANDIDATE_DAYS,
  DEFAULT_CLASSIFICATION_DAYS,
  DEFAULT_GRACE_PERIOD_SECONDS,
  DEFAULT_PENALTY_APR_BPS,
  RECONCILIATION_MISMATCH_THRESHOLD_USDC,
  SECONDS_PER_DAY,
} from "./installment.types";

type AnyObj = Record<string, any>;

const NOW_UNIX = 1_748_736_000;
const NOW = new Date(NOW_UNIX * 1000);
const GRACE = DEFAULT_GRACE_PERIOD_SECONDS;
const DUE_FUTURE = NOW_UNIX + SECONDS_PER_DAY;
const DUE_IN_GRACE = NOW_UNIX - SECONDS_PER_DAY;
const DUE_DELINQUENT = NOW_UNIX - 5 * SECONDS_PER_DAY;
const DUE_DEFAULT_CANDIDATE = NOW_UNIX - DEFAULT_CANDIDATE_DAYS * SECONDS_PER_DAY;
const DUE_DEFAULTED = NOW_UNIX - DEFAULT_CLASSIFICATION_DAYS * SECONDS_PER_DAY;

// ── CL. DelinquencyClassifier ──────────────────────────────────────────────────

describe("CL. DelinquencyClassifier — 5-state machine", () => {
  it("CL1: future due → CURRENT, daysPastDue=0", () => {
    const r = DelinquencyClassifier.classify(DUE_FUTURE, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.CURRENT);
    expect(r.daysPastDue).toBe(0);
  });

  it("CL2: exactly at due time → CURRENT", () => {
    const r = DelinquencyClassifier.classify(NOW_UNIX, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.CURRENT);
  });

  it("CL3: 1 day overdue within grace → IN_GRACE", () => {
    const r = DelinquencyClassifier.classify(DUE_IN_GRACE, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.IN_GRACE);
    expect(r.daysPastDue).toBe(1);
  });

  it("CL4: exactly at grace boundary → IN_GRACE", () => {
    const r = DelinquencyClassifier.classify(NOW_UNIX - GRACE, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.IN_GRACE);
  });

  it("CL5: 1 second past grace → DELINQUENT", () => {
    const r = DelinquencyClassifier.classify(NOW_UNIX - GRACE - 1, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.DELINQUENT);
  });

  it("CL6: 5 days overdue → DELINQUENT, daysPastDue=5", () => {
    const r = DelinquencyClassifier.classify(DUE_DELINQUENT, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.DELINQUENT);
    expect(r.daysPastDue).toBe(5);
  });

  it("CL7: exactly DEFAULT_CANDIDATE_DAYS overdue → DEFAULT_CANDIDATE", () => {
    const r = DelinquencyClassifier.classify(DUE_DEFAULT_CANDIDATE, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.DEFAULT_CANDIDATE);
    expect(r.daysPastDue).toBe(DEFAULT_CANDIDATE_DAYS);
  });

  it("CL8: exactly DEFAULT_CLASSIFICATION_DAYS overdue → DEFAULTED", () => {
    const r = DelinquencyClassifier.classify(DUE_DEFAULTED, NOW_UNIX, GRACE);
    expect(r.accrualStatus).toBe(AccrualStatus.DEFAULTED);
    expect(r.daysPastDue).toBe(DEFAULT_CLASSIFICATION_DAYS);
  });

  it("CL9: zero grace — 1 second overdue → DELINQUENT immediately", () => {
    const r = DelinquencyClassifier.classify(NOW_UNIX - 1, NOW_UNIX, 0);
    expect(r.accrualStatus).toBe(AccrualStatus.DELINQUENT);
  });

  it("CL10: daysPastDue counts from dueTimestamp regardless of grace", () => {
    const r = DelinquencyClassifier.classify(NOW_UNIX - 2 * SECONDS_PER_DAY, NOW_UNIX, 5 * SECONDS_PER_DAY);
    expect(r.accrualStatus).toBe(AccrualStatus.IN_GRACE);
    expect(r.daysPastDue).toBe(2);
  });

  it("CL11: worst() returns CURRENT for empty list", () => {
    expect(DelinquencyClassifier.worst([])).toBe(AccrualStatus.CURRENT);
  });

  it("CL12: worst() returns most severe from mixed list", () => {
    expect(DelinquencyClassifier.worst([AccrualStatus.CURRENT, AccrualStatus.DELINQUENT, AccrualStatus.IN_GRACE]))
      .toBe(AccrualStatus.DELINQUENT);
  });

  it("CL13: worst() returns DEFAULTED when present", () => {
    expect(DelinquencyClassifier.worst([AccrualStatus.DEFAULT_CANDIDATE, AccrualStatus.DEFAULTED]))
      .toBe(AccrualStatus.DEFAULTED);
  });

  it("CL14: computeHourlyPenalty = 0 for CURRENT/IN_GRACE", () => {
    expect(DelinquencyClassifier.computeHourlyPenalty(AccrualStatus.CURRENT, 1_000_000n, 500)).toBe(0n);
    expect(DelinquencyClassifier.computeHourlyPenalty(AccrualStatus.IN_GRACE, 1_000_000n, 500)).toBe(0n);
  });

  it("CL15: computeHourlyPenalty formula: principal * bps / (10000 * 8760)", () => {
    const principal = 1_000_000_000n;
    const bps = DEFAULT_PENALTY_APR_BPS;
    const expected = (principal * BigInt(bps)) / (10_000n * 8_760n);
    expect(DelinquencyClassifier.computeHourlyPenalty(AccrualStatus.DELINQUENT, principal, bps)).toBe(expected);
  });

  it("CL16: computeHourlyPenalty = 0 for zero principal", () => {
    expect(DelinquencyClassifier.computeHourlyPenalty(AccrualStatus.DELINQUENT, 0n, 500)).toBe(0n);
  });
});

// ── AC. InstallmentAccrualService ──────────────────────────────────────────────

describe("AC. InstallmentAccrualService — idempotency + penalty accrual", () => {
  function makeEntry(id: string, dueTs: number, overrides: Partial<AnyObj> = {}): AnyObj {
    return {
      id,
      installmentIndex: 0,
      dueTimestamp: BigInt(dueTs),
      principalDue: 100_000_000n,
      principalPaid: 0n,
      penaltyAccrued: 0n,
      accrualStatus: AccrualStatus.CURRENT,
      status: "PENDING",
      ...overrides,
    };
  }

  function makeSchedule(entries: AnyObj[]) {
    return { id: "s1", loanId: "loan-1", gracePeriodSeconds: GRACE, penaltyAprBps: DEFAULT_PENALTY_APR_BPS, intervalSeconds: 2_592_000, installments: entries };
  }

  function makePrisma(schedule: AnyObj, existingSnapshots: AnyObj[] = []) {
    const snapshots = [...existingSnapshots];
    return {
      installmentSchedule: { findUnique: jest.fn(async () => schedule) },
      installmentEntry: {
        update: jest.fn(async ({ where, data }: AnyObj) => {
          const e = schedule.installments.find((x: AnyObj) => x.id === where.id)!;
          Object.assign(e, data);
          return e;
        }),
        findMany: jest.fn(async () => schedule.installments),
      },
      accrualSnapshot: {
        findUnique: jest.fn(async ({ where }: AnyObj) =>
          snapshots.find((s) => s.entryId === where.entryId_hourBucket.entryId &&
            s.hourBucket.getTime() === where.entryId_hourBucket.hourBucket.getTime()) ?? null),
        create: jest.fn(async ({ data }: AnyObj) => { snapshots.push(data); return data; }),
      },
      loan: { findMany: jest.fn(async () => [{ id: "loan-1" }]) },
      _snapshots: snapshots,
    };
  }

  it("AC1: CURRENT entry — no penalty", async () => {
    const prisma = makePrisma(makeSchedule([makeEntry("e1", DUE_FUTURE)]));
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW);
    expect(r.entries[0].penaltyDelta).toBe(0n);
    expect(r.entries[0].accrualStatus).toBe(AccrualStatus.CURRENT);
  });

  it("AC2: IN_GRACE entry — no penalty", async () => {
    const prisma = makePrisma(makeSchedule([makeEntry("e1", DUE_IN_GRACE)]));
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW);
    expect(r.entries[0].penaltyDelta).toBe(0n);
    expect(r.entries[0].accrualStatus).toBe(AccrualStatus.IN_GRACE);
  });

  it("AC3: DELINQUENT entry — positive penalty", async () => {
    const prisma = makePrisma(makeSchedule([makeEntry("e1", DUE_DELINQUENT)]));
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW);
    expect(r.entries[0].penaltyDelta).toBeGreaterThan(0n);
    expect(r.entries[0].accrualStatus).toBe(AccrualStatus.DELINQUENT);
  });

  it("AC4: idempotent — same hour bucket → skip, no DB writes", async () => {
    const svcTemp = new InstallmentAccrualService({} as any);
    const bucket = svcTemp.toHourBucket(NOW);
    const entry = makeEntry("e1", DUE_DELINQUENT);
    const prisma = makePrisma(makeSchedule([entry]), [{ entryId: "e1", hourBucket: bucket }]);
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW, bucket);
    expect(r.entries[0].skipped).toBe(true);
    expect(r.entries[0].penaltyDelta).toBe(0n);
    expect(prisma.accrualSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.installmentEntry.update).not.toHaveBeenCalled();
  });

  it("AC5: different hour bucket → accrues again", async () => {
    const svcTemp = new InstallmentAccrualService({} as any);
    const hour1 = svcTemp.toHourBucket(NOW);
    const hour2 = new Date(hour1.getTime() + 3_600_000);
    const entry = makeEntry("e1", DUE_DELINQUENT);
    const prisma = makePrisma(makeSchedule([entry]), [{ entryId: "e1", hourBucket: hour1 }]);
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", new Date(hour2.getTime() + 1), hour2);
    expect(r.entries[0].skipped).toBe(false);
    expect(r.entries[0].penaltyDelta).toBeGreaterThan(0n);
  });

  it("AC6: penaltyTotal = existing + delta", async () => {
    const existing = 50_000n;
    const entry = makeEntry("e1", DUE_DELINQUENT, { penaltyAccrued: existing });
    const prisma = makePrisma(makeSchedule([entry]));
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW);
    expect(r.entries[0].penaltyTotal).toBe(existing + r.entries[0].penaltyDelta);
  });

  it("AC7: worstStatus rolls up across entries", async () => {
    const entries = [
      makeEntry("e1", DUE_FUTURE),
      makeEntry("e2", DUE_DEFAULTED),
      makeEntry("e3", DUE_DELINQUENT),
    ];
    const prisma = makePrisma(makeSchedule(entries));
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("loan-1", NOW);
    expect(r.worstStatus).toBe(AccrualStatus.DEFAULTED);
  });

  it("AC8: toHourBucket truncates to UTC hour start", () => {
    const svc = new InstallmentAccrualService({} as any);
    const bucket = svc.toHourBucket(new Date("2025-06-01T14:37:22.500Z"));
    expect(bucket.toISOString()).toBe("2025-06-01T14:00:00.000Z");
  });

  it("AC9: snapshot written with correct fields", async () => {
    const entry = makeEntry("e1", DUE_DELINQUENT);
    const prisma = makePrisma(makeSchedule([entry]));
    const svc = new InstallmentAccrualService(prisma as any);
    const bucket = svc.toHourBucket(NOW);
    await svc.accrueForLoan("loan-1", NOW, bucket);
    const created = (prisma.accrualSnapshot.create as jest.Mock).mock.calls[0][0].data;
    expect(created.entryId).toBe("e1");
    expect(created.loanId).toBe("loan-1");
    expect(created.hourBucket).toEqual(bucket);
    expect(created.accrualStatus).toBe(AccrualStatus.DELINQUENT);
  });

  it("AC10: no schedule → empty result", async () => {
    const prisma = { installmentSchedule: { findUnique: jest.fn(async () => null) } };
    const svc = new InstallmentAccrualService(prisma as any);
    const r = await svc.accrueForLoan("no-schedule", NOW);
    expect(r.entries).toHaveLength(0);
    expect(r.worstStatus).toBe(AccrualStatus.CURRENT);
  });
});

// ── BF. InstallmentBreakerFeedService ─────────────────────────────────────────

describe("BF. InstallmentBreakerFeedService — exposure_by_borrower + breaker", () => {
  function makeLoan(id: string, partnerId: string, bw: string, principal: bigint, insts: AnyObj[] = []) {
    return { id, partnerId, borrowerWallet: bw, principalUsdc: principal, installmentSchedule: { installments: insts } };
  }

  it("BF1: exposure aggregates across loans for same borrower", async () => {
    const prisma = { loan: { findMany: jest.fn(async () => [
      makeLoan("l1", "pA", "0xB1", 100_000_000n),
      makeLoan("l2", "pA", "0xB1", 200_000_000n),
      makeLoan("l3", "pA", "0xB2", 50_000_000n),
    ]) } };
    const breaker = { evaluateDelinquencySpike: jest.fn(async () => null), evaluatePartnerDefaultSpike: jest.fn(async () => null) };
    const svc = new InstallmentBreakerFeedService(prisma as any, breaker as any);
    const map = await svc.computePartnerMetrics();
    const m = map.get("pA")!;
    const b1 = m.exposureByBorrower.find((e) => e.borrowerWallet === "0xB1")!;
    expect(b1.totalOutstandingUsdc).toBe(300_000_000n);
    expect(b1.loanCount).toBe(2);
  });

  it("BF2: feedBreaker returns triggered partners", async () => {
    const prisma = { loan: { findMany: jest.fn(async () => [makeLoan("l1", "pB", "0xB1", 100_000_000n)]) } };
    const breaker = {
      evaluateDelinquencySpike: jest.fn(async () => ({ id: "inc-1" })),
      evaluatePartnerDefaultSpike: jest.fn(async () => null),
    };
    const svc = new InstallmentBreakerFeedService(prisma as any, breaker as any);
    const triggered = await svc.feedBreaker();
    expect(triggered).toContain("pB");
  });
});

// ── RC. InstallmentReconciliationService ──────────────────────────────────────

describe("RC. InstallmentReconciliationService — principal+interest+penalty bounds", () => {
  function makeAccrualSummary(principal: bigint, interest: bigint, penalty: bigint) {
    return { totalPrincipalRemaining: principal, totalInterestRemaining: interest, totalPenaltyAccrued: penalty, worstAccrualStatus: AccrualStatus.CURRENT };
  }

  it("RC1: no mismatch when backend total = on-chain principal", async () => {
    const p = 100_000_000n;
    const prisma = { loan: { findMany: jest.fn(async () => [{ id: "l1", partnerId: "p1", principalUsdc: p, interestRateBps: 1000 }]) } };
    const accrual = { getLoanAccrualSummary: jest.fn(async () => makeAccrualSummary(p, 0n, 0n)) };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svc = new InstallmentReconciliationService(prisma as any, accrual as any, alerts as any, null as any, null as any);
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(0);
    expect(alerts.emitMany).not.toHaveBeenCalled();
  });

  it("RC2: mismatch includes interest + penalty in backend total", async () => {
    const principal = 100_000_000n;
    const interest = 5_000_000n;
    const penalty = 2_000_000n;
    const backendTotal = principal + interest + penalty;
    const onchain = principal; // on-chain only tracks principal
    const discrepancy = backendTotal - onchain;
    const prisma = { loan: { findMany: jest.fn(async () => [{ id: "l1", partnerId: "p1", principalUsdc: onchain, interestRateBps: 1000 }]) } };
    const accrual = { getLoanAccrualSummary: jest.fn(async () => makeAccrualSummary(principal, interest, penalty)) };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svc = new InstallmentReconciliationService(prisma as any, accrual as any, alerts as any, null as any, null as any);
    const report = await svc.runReconciliation();
    if (discrepancy > RECONCILIATION_MISMATCH_THRESHOLD_USDC) {
      expect(report.mismatchCount).toBe(1);
      expect(report.mismatches[0].backendPenaltyAccrued).toBe(penalty);
      expect(report.mismatches[0].backendInterestRemaining).toBe(interest);
    }
  });

  it("RC3: mismatch above threshold triggers CRITICAL alert", async () => {
    const p = 100_000_000n;
    const bigPenalty = RECONCILIATION_MISMATCH_THRESHOLD_USDC + 1_000_000n;
    const prisma = { loan: { findMany: jest.fn(async () => [{ id: "l1", partnerId: "p1", principalUsdc: p, interestRateBps: 1000 }]) } };
    const accrual = { getLoanAccrualSummary: jest.fn(async () => makeAccrualSummary(p, 0n, bigPenalty)) };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svc = new InstallmentReconciliationService(prisma as any, accrual as any, alerts as any, null as any, null as any);
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(1);
    expect(alerts.emitMany).toHaveBeenCalledTimes(1);
    const alert = (alerts.emitMany as jest.Mock).mock.calls[0][0][0];
    expect(alert.severity).toBe("CRITICAL");
  });

  it("RC4: below threshold — no alert", async () => {
    const p = 100_000_000n;
    const tinyPenalty = RECONCILIATION_MISMATCH_THRESHOLD_USDC - 1n;
    const prisma = { loan: { findMany: jest.fn(async () => [{ id: "l1", partnerId: "p1", principalUsdc: p, interestRateBps: 1000 }]) } };
    const accrual = { getLoanAccrualSummary: jest.fn(async () => makeAccrualSummary(p, 0n, tinyPenalty)) };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svc = new InstallmentReconciliationService(prisma as any, accrual as any, alerts as any, null as any, null as any);
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(0);
    expect(alerts.emitMany).not.toHaveBeenCalled();
  });

  it("RC5: mismatch breakdown fields populated correctly", async () => {
    const p = 100_000_000n;
    const interest = 3_000_000n;
    const penalty = RECONCILIATION_MISMATCH_THRESHOLD_USDC + 500_000n;
    const prisma = { loan: { findMany: jest.fn(async () => [{ id: "l1", partnerId: "p1", principalUsdc: p, interestRateBps: 1000 }]) } };
    const accrual = { getLoanAccrualSummary: jest.fn(async () => makeAccrualSummary(p, interest, penalty)) };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svc = new InstallmentReconciliationService(prisma as any, accrual as any, alerts as any, null as any, null as any);
    const report = await svc.runReconciliation();
    expect(report.mismatchCount).toBe(1);
    const m = report.mismatches[0];
    expect(m.backendPrincipalRemaining).toBe(p);
    expect(m.backendInterestRemaining).toBe(interest);
    expect(m.backendPenaltyAccrued).toBe(penalty);
    expect(m.backendOutstandingUsdc).toBe(p + interest + penalty);
  });
});
