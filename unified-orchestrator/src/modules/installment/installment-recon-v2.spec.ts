/**
 * installment-recon-v2.spec.ts — Unified v1.1 reconciliation & drift controls
 * Suites: E (ReportService), F (SettlementCheck), G (DriftService), H (AccountingIntegrity)
 */
import { createHash } from "crypto";
import {
  AccrualStatus, DriftKind, InstallmentStatus, LoanStatus,
  ReconIncidentSeverity, ReconIncidentStatus, SettlementCheckKind,
} from "@prisma/client";
import { InstallmentReportService } from "./installment-report.service";
import { InstallmentSettlementCheckService } from "./installment-settlement-check.service";
import { InstallmentDriftService } from "./installment-drift.service";
import { InstallmentReconciliationService } from "./installment-reconciliation.service";
import { DEFAULT_DRIFT_TOLERANCES } from "./installment.types";

// ── Helpers ───────────────────────────────────────────────────────────────────
const e = (o: any = {}) => ({
  principalDue: 10_000_000n, principalPaid: 0n, interestDue: 500_000n, interestPaid: 0n,
  penaltyAccrued: 0n, daysPastDue: 0, accrualStatus: AccrualStatus.CURRENT,
  status: InstallmentStatus.PENDING, delinquentSince: null, ...o,
});
const loan = (o: any = {}) => ({
  id: "l1", partnerId: "p1", poolContract: "0xP1", principalUsdc: 100_000_000n,
  fiatTransfers: [], chainActions: [], installmentSchedule: { installments: [] }, ...o,
});
const rPrisma = (loans: any[], defaults: any[] = []) => ({
  loan: { findMany: jest.fn(async ({ where }: any) =>
    where?.status === LoanStatus.ACTIVE ? loans :
    where?.status === LoanStatus.DEFAULTED ? defaults : []) },
  reconReport: {
    upsert: jest.fn(async (a: any) => ({ id: "r1", ...a.create })),
    findFirst: jest.fn(async () => null),
  },
});
const sPrisma = (loans: any[]) => ({
  loan: { findMany: jest.fn(async () => loans) },
  settlementCheck: { createMany: jest.fn(async () => ({ count: 0 })) },
});
const dPrisma = (rows: any[] = []) => ({
  reconIncident: {
    create: jest.fn(async (a: any) => ({ id: "i1", ...a.data, createdAt: new Date(), updatedAt: new Date() })),
    update: jest.fn(async (a: any) => ({ id: a.where.id, ...a.data })),
    findMany: jest.fn(async () => rows),
  },
});
const alerts = () => ({ emit: jest.fn(async () => {}), emitMany: jest.fn(async () => {}) });
const driftSvc = () => ({
  recordScheduleHashMismatch: jest.fn(async (p: any) => ({
    id: "i1", kind: DriftKind.SCHEDULE_HASH_MISMATCH, severity: ReconIncidentSeverity.CRITICAL,
    loanId: p.loanId, partnerId: p.partnerId, metricValue: 1, tolerance: 0,
    detail: `stored=${p.storedHash}`, breakerFired: true, createdAt: new Date(),
  })),
  recordAccrualDoubleCharge: jest.fn(async (p: any) => ({
    id: "i2", kind: DriftKind.ACCRUAL_DOUBLE_CHARGE, severity: ReconIncidentSeverity.CRITICAL,
    loanId: p.loanId, partnerId: p.partnerId, metricValue: 1, tolerance: 0,
    detail: `entry=${p.entryId}`, breakerFired: true, createdAt: new Date(),
  })),
});
const accrualMock = () => ({
  getLoanAccrualSummary: jest.fn(async () => ({
    totalPrincipalRemaining: 0n, totalInterestRemaining: 0n,
    totalPenaltyAccrued: 0n, worstAccrualStatus: AccrualStatus.CURRENT,
  })),
});
const schedJson = () => JSON.stringify({
  loan_id: "l1", principal: "100000000", interest_rate_bps: 1000,
  start_ts: "1700000000", interval_seconds: 2592000, installment_count: 1,
  installments: [{ index: 0, due_ts: "1702592000", principal: "100000000", interest: "950", total: "100000950" }],
});
const reconSvc = (prisma: any, drift: any) =>
  new InstallmentReconciliationService(prisma, accrualMock() as any,
    { emitMany: jest.fn(async () => {}) } as any, null as any, drift);

// ── E. InstallmentReportService ───────────────────────────────────────────────
describe("E. InstallmentReportService", () => {
  it("E1: empty portfolio → zero global", async () => {
    const r = await new InstallmentReportService(rPrisma([]) as any)
      .buildDailyReport(new Date("2025-06-01T00:00:00Z"));
    expect(r.global.activeLoans).toBe(0);
    expect(r.global.totalPrincipalUsdc).toBe(0n);
  });

  it("E2: principal/interest/penalty summed correctly", async () => {
    const loans = [loan({ poolContract: "0xP1", installmentSchedule: { installments: [
      e({ principalDue: 10_000_000n, interestDue: 500_000n, penaltyAccrued: 200_000n }),
      e({ principalDue: 10_000_000n, interestDue: 500_000n, penaltyAccrued: 100_000n }),
    ]} })];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    expect(r.pools[0].totalPrincipalUsdc).toBe(20_000_000n);
    expect(r.pools[0].totalInterestUsdc).toBe(1_000_000n);
    expect(r.pools[0].totalPenaltyUsdc).toBe(300_000n);
  });

  it("E3: PAID entries excluded from totals", async () => {
    const loans = [loan({ poolContract: "0xP1", installmentSchedule: { installments: [
      e({ status: InstallmentStatus.PAID, principalDue: 10_000_000n }),
      e({ principalDue: 5_000_000n }),
    ]} })];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    expect(r.pools[0].totalPrincipalUsdc).toBe(5_000_000n);
  });

  it("E4: delinquency distribution buckets assigned correctly", async () => {
    const loans = [loan({ poolContract: "0xP1", installmentSchedule: { installments: [
      e({ accrualStatus: AccrualStatus.IN_GRACE, daysPastDue: 2 }),
      e({ accrualStatus: AccrualStatus.DELINQUENT, daysPastDue: 10 }),
      e({ accrualStatus: AccrualStatus.DEFAULT_CANDIDATE, daysPastDue: 20 }),
      e({ accrualStatus: AccrualStatus.DEFAULTED, daysPastDue: 35 }),
    ]} })];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    const d = r.pools[0].delinquencyDistribution;
    expect(d.bucket_0_5).toBe(1);
    expect(d.bucket_6_15).toBe(1);
    expect(d.bucket_16_30).toBe(1);
    expect(d.bucket_31_plus).toBe(1);
  });

  it("E5: CURRENT entries not counted in delinquency distribution", async () => {
    const loans = [loan({ poolContract: "0xP1", installmentSchedule: { installments: [
      e({ accrualStatus: AccrualStatus.CURRENT }),
      e({ accrualStatus: AccrualStatus.CURRENT }),
    ]} })];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    const d = r.pools[0].delinquencyDistribution;
    expect(d.bucket_0_5 + d.bucket_6_15 + d.bucket_16_30 + d.bucket_31_plus).toBe(0);
  });

  it("E6: multiple pools → global rollup correct", async () => {
    const loans = [
      loan({ id: "l1", poolContract: "0xP1", installmentSchedule: { installments: [e({ principalDue: 50_000_000n })] } }),
      loan({ id: "l2", poolContract: "0xP2", installmentSchedule: { installments: [e({ principalDue: 30_000_000n })] } }),
    ];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    expect(r.pools).toHaveLength(2);
    expect(r.global.totalPrincipalUsdc).toBe(80_000_000n);
  });

  it("E7: default list populated from DEFAULTED loans", async () => {
    const defaults = [
      { id: "dl1", partnerId: "p1", updatedAt: new Date("2025-05-01") },
      { id: "dl2", partnerId: "p2", updatedAt: new Date("2025-05-15") },
    ];
    const r = await new InstallmentReportService(rPrisma([], defaults) as any).buildDailyReport();
    expect(r.global.defaults).toHaveLength(2);
    expect(r.global.defaults[0].loanId).toBe("dl1");
  });

  it("E8: fiat repayments summed from confirmed transfers", async () => {
    const loans = [loan({ poolContract: "0xP1",
      fiatTransfers: [{ amountKes: 5_000n, confirmedAt: new Date() }, { amountKes: 3_000n, confirmedAt: new Date() }],
      installmentSchedule: { installments: [] } })];
    const r = await new InstallmentReportService(rPrisma(loans) as any).buildDailyReport();
    expect(r.pools[0].totalRepaymentsFiat).toBe(8_000n);
  });

  it("E9: report persisted with valid SHA-256 checksum", async () => {
    const prisma = rPrisma([]);
    await new InstallmentReportService(prisma as any).buildDailyReport(new Date("2025-06-01"));
    const call = (prisma.reconReport.upsert as jest.Mock).mock.calls[0][0];
    expect(call.create.checksumSha256).toBe(createHash("sha256").update(call.create.reportJson).digest("hex"));
  });

  it("E10: toDateOnly truncates to midnight UTC", () => {
    const svc = new InstallmentReportService(null as any);
    expect(svc.toDateOnly(new Date("2025-06-15T14:37:22.000Z")).toISOString()).toBe("2025-06-15T00:00:00.000Z");
  });
});

// ── F. InstallmentSettlementCheckService ──────────────────────────────────────
describe("F. InstallmentSettlementCheckService", () => {
  const confirmedFiat = [{ id: "ft1", status: "PAYOUT_CONFIRMED", confirmedAt: new Date(), direction: "OUTBOUND" }];
  const minedChain = [{ id: "ca1", type: "RECORD_DISBURSEMENT", status: "MINED" }];

  it("F1: confirmed fiat + MINED chain → all 3 checks pass", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1", fiatTransfers: confirmedFiat, chainActions: minedChain }]) as any).runChecks();
    expect(r.failureCount).toBe(0);
    expect(r.totalChecked).toBe(3);
  });

  it("F2: FIAT_CONFIRMED_NO_CHAIN", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1", fiatTransfers: confirmedFiat, chainActions: [] }]) as any).runChecks();
    expect(r.failures.find(x => x.kind === SettlementCheckKind.FIAT_CONFIRMED_NO_CHAIN)!.passed).toBe(false);
  });

  it("F3: CHAIN_RECORD_NO_FIAT", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1", fiatTransfers: [], chainActions: minedChain }]) as any).runChecks();
    expect(r.failures.find(x => x.kind === SettlementCheckKind.CHAIN_RECORD_NO_FIAT)!.passed).toBe(false);
  });

  it("F4: ACTIVE_MISSING_DISBURSEMENT — no fiat, no chain", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1", fiatTransfers: [], chainActions: [] }]) as any).runChecks();
    expect(r.failures.find(x => x.kind === SettlementCheckKind.ACTIVE_MISSING_DISBURSEMENT)!.passed).toBe(false);
  });

  it("F5: ACTIVATE_LOAN counts as disbursement proof", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1", fiatTransfers: [],
        chainActions: [{ id: "ca1", type: "ACTIVATE_LOAN", status: "MINED" }] }]) as any).runChecks();
    expect(r.failures.find(x => x.kind === SettlementCheckKind.ACTIVE_MISSING_DISBURSEMENT)).toBeUndefined();
  });

  it("F6: results persisted — 3 rows per loan", async () => {
    const prisma = sPrisma([{ id: "l1", fiatTransfers: confirmedFiat, chainActions: minedChain }]);
    await new InstallmentSettlementCheckService(prisma as any).runChecks();
    expect((prisma.settlementCheck.createMany as jest.Mock).mock.calls[0][0].data).toHaveLength(3);
  });

  it("F7: inbound fiat does not count as disbursement proof", async () => {
    const r = await new InstallmentSettlementCheckService(
      sPrisma([{ id: "l1",
        fiatTransfers: [{ id: "ft1", status: "REPAYMENT_RECEIVED", confirmedAt: new Date(), direction: "INBOUND" }],
        chainActions: [] }]) as any).runChecks();
    expect(r.failures.find(x => x.kind === SettlementCheckKind.ACTIVE_MISSING_DISBURSEMENT)!.passed).toBe(false);
  });

  it("F8: multiple loans — failures isolated per loan", async () => {
    const r = await new InstallmentSettlementCheckService(sPrisma([
      { id: "l1", fiatTransfers: [], chainActions: [] },
      { id: "l2", fiatTransfers: confirmedFiat, chainActions: minedChain },
    ]) as any).runChecks();
    expect(r.totalChecked).toBe(6);
    expect(r.failures.filter(f => f.loanId === "l2")).toHaveLength(0);
  });
});

// ── G. InstallmentDriftService ────────────────────────────────────────────────
describe("G. InstallmentDriftService", () => {
  it("G1: rounding drift within tolerance → null", async () => {
    const r = await new InstallmentDriftService(dPrisma() as any, alerts() as any)
      .evaluateRoundingDrift({ loanId: "l1", partnerId: "p1",
        discrepancyUsdc: DEFAULT_DRIFT_TOLERANCES.roundingDriftUsdc - 1n });
    expect(r).toBeNull();
  });

  it("G2: rounding drift exceeds → HIGH incident + breaker", async () => {
    const a = alerts();
    const r = await new InstallmentDriftService(dPrisma() as any, a as any)
      .evaluateRoundingDrift({ loanId: "l1", partnerId: "p1",
        discrepancyUsdc: DEFAULT_DRIFT_TOLERANCES.roundingDriftUsdc + 1n });
    expect(r!.kind).toBe(DriftKind.ROUNDING_DRIFT);
    expect(r!.severity).toBe(ReconIncidentSeverity.HIGH);
    expect(r!.breakerFired).toBe(true);
    expect(a.emit).toHaveBeenCalledTimes(1);
  });

  it("G3: timing drift within tolerance → null", async () => {
    const r = await new InstallmentDriftService(dPrisma() as any, alerts() as any)
      .evaluateTimingDrift({ loanId: "l1", partnerId: "p1",
        driftSeconds: DEFAULT_DRIFT_TOLERANCES.timingDriftSeconds - 1 });
    expect(r).toBeNull();
  });

  it("G4: timing drift exceeds → MEDIUM, no breaker", async () => {
    const a = alerts();
    const r = await new InstallmentDriftService(dPrisma() as any, a as any)
      .evaluateTimingDrift({ loanId: "l1", partnerId: "p1",
        driftSeconds: DEFAULT_DRIFT_TOLERANCES.timingDriftSeconds + 1 });
    expect(r!.kind).toBe(DriftKind.TIMING_DRIFT);
    expect(r!.severity).toBe(ReconIncidentSeverity.MEDIUM);
    expect(r!.breakerFired).toBe(false);
    expect(a.emit).not.toHaveBeenCalled();
  });

  it("G5: schedule hash mismatch → CRITICAL + breaker", async () => {
    const a = alerts();
    const r = await new InstallmentDriftService(dPrisma() as any, a as any)
      .recordScheduleHashMismatch({ loanId: "l1", partnerId: "p1", storedHash: "aaa", recomputedHash: "bbb" });
    expect(r.kind).toBe(DriftKind.SCHEDULE_HASH_MISMATCH);
    expect(r.severity).toBe(ReconIncidentSeverity.CRITICAL);
    expect(r.breakerFired).toBe(true);
    expect((a.emit as jest.Mock).mock.calls[0][0].severity).toBe("CRITICAL");
  });

  it("G6: accrual double-charge → CRITICAL + breaker", async () => {
    const r = await new InstallmentDriftService(dPrisma() as any, alerts() as any)
      .recordAccrualDoubleCharge({ loanId: "l1", partnerId: "p1",
        entryId: "e1", hourBucket: new Date("2025-06-01T10:00:00Z") });
    expect(r.kind).toBe(DriftKind.ACCRUAL_DOUBLE_CHARGE);
    expect(r.severity).toBe(ReconIncidentSeverity.CRITICAL);
  });

  it("G7: custom tolerance overrides default", async () => {
    const r = await new InstallmentDriftService(dPrisma() as any, alerts() as any)
      .evaluateRoundingDrift({ loanId: "l1", partnerId: "p1", discrepancyUsdc: 1n,
        tolerances: { roundingDriftUsdc: 0n, timingDriftSeconds: 3600 } });
    expect(r).not.toBeNull();
    expect(r!.tolerance).toBe(0);
  });

  it("G8: resolveIncident sets RESOLVED", async () => {
    const p = dPrisma();
    await new InstallmentDriftService(p as any, alerts() as any).resolveIncident("i1", "ops");
    expect(p.reconIncident.update).toHaveBeenCalledWith({
      where: { id: "i1" },
      data: expect.objectContaining({ status: ReconIncidentStatus.RESOLVED, resolvedBy: "ops" }),
    });
  });

  it("G9: detail contains hash values for SCHEDULE_HASH_MISMATCH", async () => {
    const r = await new InstallmentDriftService(dPrisma() as any, alerts() as any)
      .recordScheduleHashMismatch({ loanId: "l1", partnerId: "p1",
        storedHash: "stored-abc", recomputedHash: "computed-xyz" });
    expect(r.detail).toContain("stored-abc");
    expect(r.detail).toContain("computed-xyz");
  });

  it("G10: listOpenIncidents returns rows", async () => {
    const rows = [{ id: "i1", kind: DriftKind.ROUNDING_DRIFT, severity: ReconIncidentSeverity.HIGH,
      status: ReconIncidentStatus.OPEN, loanId: "l1", partnerId: "p1",
      metricValue: 2_000_000, tolerance: 1_000_000, detail: "t", breakerFired: true, createdAt: new Date() }];
    const incidents = await new InstallmentDriftService(dPrisma(rows) as any, alerts() as any)
      .listOpenIncidents(DriftKind.ROUNDING_DRIFT);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe(DriftKind.ROUNDING_DRIFT);
  });
});

// ── H. InstallmentReconciliationService — accounting integrity ─────────────────
describe("H. Accounting integrity checks", () => {
  const aPrisma = (scheds: any[]) => ({
    installmentSchedule: { findMany: jest.fn(async () => scheds) },
    loan: { findMany: jest.fn(async () => []) },
  });

  it("H1: matching hash → no failure", async () => {
    const json = schedJson();
    const hash = createHash("sha256").update(json).digest("hex");
    const scheds = [{ loanId: "l1", scheduleHash: hash, scheduleJson: json,
      loan: { partnerId: "p1" }, installments: [{ id: "e1", accrualSnapshots: [] }] }];
    const ds = driftSvc();
    const r = await reconSvc(aPrisma(scheds) as any, ds as any).runAccountingIntegrityChecks();
    expect(r.failureCount).toBe(0);
    expect(ds.recordScheduleHashMismatch).not.toHaveBeenCalled();
  });

  it("H2: tampered scheduleJson → hash mismatch + incident", async () => {
    const json = schedJson();
    const hash = createHash("sha256").update(json).digest("hex");
    const scheds = [{ loanId: "l1", scheduleHash: hash, scheduleJson: json + " ",
      loan: { partnerId: "p1" }, installments: [{ id: "e1", accrualSnapshots: [] }] }];
    const ds = driftSvc();
    const r = await reconSvc(aPrisma(scheds) as any, ds as any).runAccountingIntegrityChecks();
    expect(r.failureCount).toBe(1);
    expect(r.failures[0].scheduleHashOk).toBe(false);
    expect(ds.recordScheduleHashMismatch).toHaveBeenCalledWith(
      expect.objectContaining({ loanId: "l1", storedHash: hash }));
  });

  it("H3: duplicate (entryId, hourBucket) → double-charge + incident", async () => {
    const json = schedJson();
    const hash = createHash("sha256").update(json).digest("hex");
    const bucket = new Date("2025-06-01T10:00:00Z");
    const scheds = [{ loanId: "l1", scheduleHash: hash, scheduleJson: json,
      loan: { partnerId: "p1" },
      installments: [{ id: "e1", accrualSnapshots: [{ hourBucket: bucket }, { hourBucket: bucket }] }] }];
    const ds = driftSvc();
    const r = await reconSvc(aPrisma(scheds) as any, ds as any).runAccountingIntegrityChecks();
    expect(r.failureCount).toBe(1);
    expect(r.failures[0].accrualIdempotencyOk).toBe(false);
    expect(ds.recordAccrualDoubleCharge).toHaveBeenCalledWith(
      expect.objectContaining({ loanId: "l1", entryId: "e1" }));
  });

  it("H4: unique snapshots per bucket → no double-charge", async () => {
    const json = schedJson();
    const hash = createHash("sha256").update(json).digest("hex");
    const scheds = [{ loanId: "l1", scheduleHash: hash, scheduleJson: json,
      loan: { partnerId: "p1" },
      installments: [{ id: "e1", accrualSnapshots: [
        { hourBucket: new Date("2025-06-01T10:00:00Z") },
        { hourBucket: new Date("2025-06-01T11:00:00Z") },
      ]}] }];
    const ds = driftSvc();
    const r = await reconSvc(aPrisma(scheds) as any, ds as any).runAccountingIntegrityChecks();
    expect(r.failureCount).toBe(0);
    expect(ds.recordAccrualDoubleCharge).not.toHaveBeenCalled();
  });

  it("H5: multiple schedules — only failing ones counted", async () => {
    const goodJson = schedJson();
    const goodHash = createHash("sha256").update(goodJson).digest("hex");
    const badJson = goodJson + " ";
    const scheds = [
      { loanId: "l1", scheduleHash: goodHash, scheduleJson: goodJson,
        loan: { partnerId: "p1" }, installments: [] },
      { loanId: "l2", scheduleHash: goodHash, scheduleJson: badJson,
        loan: { partnerId: "p1" }, installments: [] },
    ];
    const ds = driftSvc();
    const r = await reconSvc(aPrisma(scheds) as any, ds as any).runAccountingIntegrityChecks();
    expect(r.totalLoansChecked).toBe(2);
    expect(r.failureCount).toBe(1);
    expect(r.failures[0].loanId).toBe("l2");
  });

  it("H6: report includes ranAt timestamp", async () => {
    const before = new Date();
    const r = await reconSvc(aPrisma([]) as any, driftSvc() as any).runAccountingIntegrityChecks();
    expect(r.ranAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});
