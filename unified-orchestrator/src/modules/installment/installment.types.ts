import {
  InstallmentStatus,
  AccrualStatus,
  DriftKind,
  ReconIncidentSeverity,
  ReconIncidentStatus,
  ReconReportScope,
  SettlementCheckKind,
} from "@prisma/client";

export { DriftKind, ReconIncidentSeverity, ReconIncidentStatus, ReconReportScope, SettlementCheckKind };

export { AccrualStatus };

// ── Schedule generation ────────────────────────────────────────────────────────

export interface ScheduleParams {
  loanId: string;
  principalUsdc: bigint;
  interestRateBps: number;
  /**
   * Activation-time anchor as Unix seconds (integer).
   * First installment is due at startTimestamp + intervalSeconds.
   */
  startTimestamp: number;
  /**
   * Period length in seconds (e.g. 2592000 = 30 days).
   * All due timestamps are computed as startTimestamp + (index+1) * intervalSeconds.
   */
  intervalSeconds: number;
  /** Number of installments. */
  installmentCount: number;
}

export interface InstallmentRow {
  /** 0-based index matching on-chain array position. */
  installmentIndex: number;
  /** Unix seconds — canonical timestamp used for on-chain alignment. */
  dueTimestamp: number;
  /** JS Date derived from dueTimestamp — convenience only, NOT used in hashing. */
  dueDate: Date;
  principalDue: bigint;
  interestDue: bigint;
  totalDue: bigint;
}

// ── Canonical JSON spec ────────────────────────────────────────────────────────
//
// Rules (must be followed exactly to reproduce the hash):
//   1. All bigint amounts encoded as decimal strings (no scientific notation).
//   2. All timestamps encoded as decimal strings of Unix seconds.
//   3. interestRateBps encoded as integer (number).
//   4. installmentCount encoded as integer (number).
//   5. intervalSeconds encoded as integer (number).
//   6. Field order is FIXED as declared below — no sorting.
//   7. No extra whitespace (JSON.stringify default compact form).
//   8. installments array ordered by installmentIndex ascending.
//   9. Per-installment field order: index, due_ts, principal, interest, total.

export interface CanonicalInstallmentRow {
  index: number;
  due_ts: string;       // Unix seconds as decimal string
  principal: string;    // USDC (6 decimals) as decimal string
  interest: string;     // USDC (6 decimals) as decimal string
  total: string;        // USDC (6 decimals) as decimal string
}

export interface CanonicalScheduleJson {
  loan_id: string;
  principal: string;          // USDC as decimal string
  interest_rate_bps: number;
  start_ts: string;           // Unix seconds as decimal string
  interval_seconds: number;
  installment_count: number;
  installments: CanonicalInstallmentRow[];
}

export interface GeneratedSchedule {
  loanId: string;
  scheduleHash: string;       // 64-char lowercase hex (SHA-256 of canonical JSON)
  scheduleJson: string;       // canonical JSON string — stored verbatim in DB
  totalInstallments: number;
  principalPerInstallment: bigint;
  interestRateBps: number;
  intervalSeconds: number;
  startTimestamp: number;
  installments: InstallmentRow[];
}

// ── Daily evaluation ───────────────────────────────────────────────────────────

export interface InstallmentEvaluation {
  loanId: string;
  evaluatedAt: Date;
  delinquentDays: number;
  accruedLateFees: bigint;
  outstandingBalance: bigint;
  overdueInstallments: number;
  nextDueDate: Date | null;
  nextDueAmount: bigint | null;
}

// ── Breaker metrics ────────────────────────────────────────────────────────────

export interface PartnerInstallmentMetrics {
  partnerId: string;
  /** Fraction of active loans with at least one DELINQUENT installment in the last 14 days. */
  delinquencyRate14d: number;
  /** Fraction of active loans with at least one DEFAULTED installment in the last 30 days. */
  defaultRate30d: number;
  activeLoans: number;
  delinquentLoans14d: number;
  defaultedLoans30d: number;
}

// ── Reconciliation ─────────────────────────────────────────────────────────────

export interface BalanceMismatch {
  loanId: string;
  partnerId: string;
  backendOutstandingUsdc: bigint;
  onchainPrincipalUsdc: bigint;
  /** Absolute difference in USDC (6 decimals). */
  discrepancyUsdc: bigint;
}

export interface InstallmentReconciliationReport {
  ranAt: Date;
  totalLoansChecked: number;
  mismatchCount: number;
  mismatches: BalanceMismatch[];
}

// ── Accrual job ────────────────────────────────────────────────────────────────

/** Configuration sourced from InstallmentSchedule row. */
export interface AccrualConfig {
  gracePeriodSeconds: number;
  penaltyAprBps: number;
  intervalSeconds: number;
}

/** Result of evaluating one InstallmentEntry in the accrual job. */
export interface EntryAccrualResult {
  entryId: string;
  installmentIndex: number;
  accrualStatus: AccrualStatus;
  daysPastDue: number;
  penaltyDelta: bigint;   // penalty accrued THIS hour (0 if idempotent skip)
  penaltyTotal: bigint;   // cumulative penalty on the entry after this run
  skipped: boolean;       // true when hourBucket already exists (idempotent)
}

/** Aggregated result for one loan's accrual run. */
export interface LoanAccrualResult {
  loanId: string;
  evaluatedAt: Date;
  hourBucket: Date;
  entries: EntryAccrualResult[];
  worstStatus: AccrualStatus;
  totalPenaltyDelta: bigint;
}

/** Per-borrower exposure summary for breaker metrics. */
export interface BorrowerExposure {
  borrowerWallet: string;
  partnerId: string;
  totalOutstandingUsdc: bigint;
  loanCount: number;
  worstAccrualStatus: AccrualStatus;
}

// ── Breaker metrics (extended) ─────────────────────────────────────────────────

export interface PartnerInstallmentMetrics {
  partnerId: string;
  /** Fraction of active loans with at least one DELINQUENT installment in the last 14 days. */
  delinquencyRate14d: number;
  /** Fraction of active loans with at least one DEFAULTED installment in the last 30 days. */
  defaultRate30d: number;
  activeLoans: number;
  delinquentLoans14d: number;
  defaultedLoans30d: number;
  /** Per-borrower exposure within this partner. */
  exposureByBorrower: BorrowerExposure[];
}

// ── Reconciliation (extended) ──────────────────────────────────────────────────

export interface BalanceMismatch {
  loanId: string;
  partnerId: string;
  backendOutstandingUsdc: bigint;
  onchainPrincipalUsdc: bigint;
  /** Absolute difference in USDC (6 decimals). */
  discrepancyUsdc: bigint;
  /** Breakdown for diagnostics. */
  backendPrincipalRemaining: bigint;
  backendInterestRemaining: bigint;
  backendPenaltyAccrued: bigint;
}

export interface InstallmentReconciliationReport {
  ranAt: Date;
  totalLoansChecked: number;
  mismatchCount: number;
  mismatches: BalanceMismatch[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

export const SECONDS_PER_DAY = 86_400;
export const DAYS_PER_INSTALLMENT_PERIOD = 30;
export const SECONDS_PER_PERIOD = SECONDS_PER_DAY * DAYS_PER_INSTALLMENT_PERIOD;

/** Daily late-fee rate: 0.1% per day (10 bps). */
export const LATE_FEE_DAILY_BPS = 10;

/** Default grace period: 3 days (configurable per schedule). */
export const DEFAULT_GRACE_PERIOD_SECONDS = 3 * SECONDS_PER_DAY;

/** Default penalty APR in bps: 5% (500 bps). Applied on overdue principal only. */
export const DEFAULT_PENALTY_APR_BPS = 500;

/** Days past due to enter DEFAULT_CANDIDATE state. */
export const DEFAULT_CANDIDATE_DAYS = 14;

/** Days past due to enter DEFAULTED state. */
export const DEFAULT_CLASSIFICATION_DAYS = 30;

/** Mismatch threshold in USDC (6 decimals) — 1 USDC. */
export const RECONCILIATION_MISMATCH_THRESHOLD_USDC = 1_000_000n;

export const DELINQUENT_STATUSES: InstallmentStatus[] = [
  InstallmentStatus.DELINQUENT,
  InstallmentStatus.DEFAULTED,
];

// ── Delinquency distribution buckets ──────────────────────────────────────────

export interface DelinquencyDistribution {
  /** 0–5 days past due */
  bucket_0_5: number;
  /** 6–15 days past due */
  bucket_6_15: number;
  /** 16–30 days past due */
  bucket_16_30: number;
  /** 31+ days past due */
  bucket_31_plus: number;
}

export interface DefaultEntry {
  loanId: string;
  partnerId: string;
  defaultedAt: Date;
}

// ── Daily reconciliation report ───────────────────────────────────────────────

export interface PoolReconSummary {
  poolId: string;
  activeLoans: number;
  totalPrincipalUsdc: bigint;
  totalInterestUsdc: bigint;
  totalPenaltyUsdc: bigint;
  totalRepaymentsFiat: bigint;
  totalRepaymentsChain: bigint;
  delinquencyDistribution: DelinquencyDistribution;
  defaults: DefaultEntry[];
}

export interface DailyReconReport {
  reportDate: Date;
  generatedAt: Date;
  /** Per-pool summaries */
  pools: PoolReconSummary[];
  /** Rolled-up global totals */
  global: Omit<PoolReconSummary, "poolId">;
  /** Incidents created during this report run */
  incidentIds: string[];
}

// ── Settlement integrity checks ───────────────────────────────────────────────

export interface SettlementIntegrityResult {
  loanId: string;
  kind: SettlementCheckKind;
  passed: boolean;
  detail: string;
}

export interface SettlementIntegrityReport {
  checkedAt: Date;
  totalChecked: number;
  failureCount: number;
  failures: SettlementIntegrityResult[];
}

// ── Accounting integrity checks ───────────────────────────────────────────────

export interface AccountingIntegrityResult {
  loanId: string;
  /** true = hash matches regenerated schedule */
  scheduleHashOk: boolean;
  /** true = no double-charge detected in accrual snapshots */
  accrualIdempotencyOk: boolean;
  /** Discrepancy in USDC (0 if within tolerance) */
  balanceDiscrepancyUsdc: bigint;
  detail: string;
}

export interface AccountingIntegrityReport {
  ranAt: Date;
  totalLoansChecked: number;
  failureCount: number;
  failures: AccountingIntegrityResult[];
}

// ── Drift incidents ───────────────────────────────────────────────────────────

/** Tolerance thresholds for drift detection */
export interface DriftTolerances {
  /** Max allowed rounding drift in USDC (6 dec). Default: 1 USDC */
  roundingDriftUsdc: bigint;
  /** Max allowed timing drift in seconds. Default: 3600 (1 hour) */
  timingDriftSeconds: number;
}

export const DEFAULT_DRIFT_TOLERANCES: DriftTolerances = {
  roundingDriftUsdc: 1_000_000n,   // 1 USDC
  timingDriftSeconds: 3_600,        // 1 hour
};

export interface DriftIncident {
  id: string;
  kind: DriftKind;
  severity: ReconIncidentSeverity;
  loanId?: string;
  partnerId?: string;
  metricValue: number;
  tolerance: number;
  detail: string;
  breakerFired: boolean;
  createdAt: Date;
}

// ── Report archive artifact ───────────────────────────────────────────────────

export interface ReportArchiveArtifact {
  reportId: string;
  reportDate: string;   // ISO date string YYYY-MM-DD
  scope: ReconReportScope;
  poolId?: string;
  checksumSha256: string;
  reportJson: string;
  incidentCount: number;
}
