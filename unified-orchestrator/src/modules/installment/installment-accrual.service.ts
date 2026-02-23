import { Injectable, Logger } from "@nestjs/common";
import { AccrualStatus, InstallmentStatus, LoanStatus } from "@prisma/client";
import { PrismaService } from "../prisma";
import {
  EntryAccrualResult,
  LoanAccrualResult,
  SECONDS_PER_DAY,
} from "./installment.types";
import { DelinquencyClassifier } from "./installment-delinquency-classifier";

/**
 * InstallmentAccrualService
 *
 * Hourly accrual job:
 *   1. For each ACTIVE loan with an installment schedule:
 *      a. Classify each unpaid entry using the 5-state machine.
 *      b. Compute hourly penalty on overdue principal.
 *      c. Write an AccrualSnapshot keyed on (entryId, hourBucket) — idempotent.
 *      d. Update InstallmentEntry.penaltyAccrued, accrualStatus, daysPastDue.
 *
 * Idempotency guarantee:
 *   The hourBucket is truncated to the start of the current UTC hour.
 *   A unique constraint on (entryId, hourBucket) ensures that a second run
 *   within the same hour is a no-op (snapshot already exists → skip).
 */
@Injectable()
export class InstallmentAccrualService {
  private readonly logger = new Logger(InstallmentAccrualService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run the accrual job for all ACTIVE loans.
   * Pass `asOf` to pin the evaluation time (useful for testing).
   */
  async runHourlyAccrual(asOf?: Date): Promise<LoanAccrualResult[]> {
    const now = asOf ?? new Date();
    const hourBucket = this.toHourBucket(now);

    const activeLoans = await this.prisma.loan.findMany({
      where: {
        status: LoanStatus.ACTIVE,
        installmentSchedule: { isNot: null },
      },
      select: { id: true },
    });

    this.logger.log(
      `[accrual_hourly] evaluating ${activeLoans.length} loans ` +
        `bucket=${hourBucket.toISOString()}`,
    );

    const results: LoanAccrualResult[] = [];
    for (const loan of activeLoans) {
      try {
        const result = await this.accrueForLoan(loan.id, now, hourBucket);
        results.push(result);
      } catch (err: any) {
        this.logger.error(
          `[accrual_error] loan=${loan.id} error=${err.message}`,
        );
      }
    }

    const totalPenalty = results.reduce((s, r) => s + r.totalPenaltyDelta, 0n);
    this.logger.log(
      `[accrual_hourly] done loans=${results.length} ` +
        `totalPenaltyDelta=${totalPenalty}`,
    );

    return results;
  }

  /**
   * Accrue penalties for a single loan.
   * Returns a full LoanAccrualResult including per-entry details.
   */
  async accrueForLoan(
    loanId: string,
    asOf: Date,
    hourBucket?: Date,
  ): Promise<LoanAccrualResult> {
    const now = asOf;
    const bucket = hourBucket ?? this.toHourBucket(now);
    const nowUnix = Math.floor(now.getTime() / 1000);

    const schedule = await this.prisma.installmentSchedule.findUnique({
      where: { loanId },
      include: {
        installments: {
          where: {
            status: {
              notIn: [InstallmentStatus.PAID, InstallmentStatus.WAIVED],
            },
          },
          orderBy: { installmentIndex: "asc" },
        },
      },
    });

    if (!schedule) {
      return {
        loanId,
        evaluatedAt: now,
        hourBucket: bucket,
        entries: [],
        worstStatus: AccrualStatus.CURRENT,
        totalPenaltyDelta: 0n,
      };
    }

    const gracePeriodSeconds = schedule.gracePeriodSeconds;
    const penaltyAprBps = schedule.penaltyAprBps;

    const entryResults: EntryAccrualResult[] = [];

    for (const entry of schedule.installments) {
      const result = await this.accrueEntry({
        entry,
        nowUnix,
        bucket,
        gracePeriodSeconds,
        penaltyAprBps,
        loanId,
      });
      entryResults.push(result);
    }

    const worstStatus = DelinquencyClassifier.worst(
      entryResults.map((e) => e.accrualStatus),
    );
    const totalPenaltyDelta = entryResults.reduce(
      (s, e) => s + e.penaltyDelta,
      0n,
    );

    this.logger.debug(
      `[accrual] loan=${loanId} bucket=${bucket.toISOString()} ` +
        `entries=${entryResults.length} worst=${worstStatus} ` +
        `penaltyDelta=${totalPenaltyDelta}`,
    );

    return {
      loanId,
      evaluatedAt: now,
      hourBucket: bucket,
      entries: entryResults,
      worstStatus,
      totalPenaltyDelta,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async accrueEntry(params: {
    entry: {
      id: string;
      installmentIndex: number;
      dueTimestamp: bigint;
      principalDue: bigint;
      principalPaid: bigint;
      penaltyAccrued: bigint;
      accrualStatus: AccrualStatus;
    };
    nowUnix: number;
    bucket: Date;
    gracePeriodSeconds: number;
    penaltyAprBps: number;
    loanId: string;
  }): Promise<EntryAccrualResult> {
    const { entry, nowUnix, bucket, gracePeriodSeconds, penaltyAprBps, loanId } = params;

    // ── Classify ──────────────────────────────────────────────────────────────
    const { accrualStatus, daysPastDue } = DelinquencyClassifier.classify(
      Number(entry.dueTimestamp),
      nowUnix,
      gracePeriodSeconds,
    );

    // ── Idempotency check ─────────────────────────────────────────────────────
    const existingSnapshot = await this.prisma.accrualSnapshot.findUnique({
      where: { entryId_hourBucket: { entryId: entry.id, hourBucket: bucket } },
    });

    if (existingSnapshot) {
      return {
        entryId: entry.id,
        installmentIndex: entry.installmentIndex,
        accrualStatus,
        daysPastDue,
        penaltyDelta: 0n,
        penaltyTotal: entry.penaltyAccrued,
        skipped: true,
      };
    }

    // ── Compute penalty ───────────────────────────────────────────────────────
    const overduePrincipal = entry.principalDue - entry.principalPaid;
    const penaltyDelta = DelinquencyClassifier.computeHourlyPenalty(
      accrualStatus,
      overduePrincipal > 0n ? overduePrincipal : 0n,
      penaltyAprBps,
    );

    const penaltyTotal = entry.penaltyAccrued + penaltyDelta;

    // ── Write snapshot (idempotency record) ───────────────────────────────────
    await this.prisma.accrualSnapshot.create({
      data: {
        entryId: entry.id,
        loanId,
        hourBucket: bucket,
        daysPastDue,
        penaltyDelta,
        accrualStatus,
      },
    });

    // ── Update entry ──────────────────────────────────────────────────────────
    await this.prisma.installmentEntry.update({
      where: { id: entry.id },
      data: {
        accrualStatus,
        daysPastDue,
        penaltyAccrued: penaltyTotal,
        delinquentSince:
          accrualStatus !== AccrualStatus.CURRENT &&
          accrualStatus !== AccrualStatus.IN_GRACE
            ? (entry.accrualStatus === AccrualStatus.CURRENT ||
               entry.accrualStatus === AccrualStatus.IN_GRACE
                ? new Date(nowUnix * 1000)
                : undefined)
            : null,
      },
    });

    return {
      entryId: entry.id,
      installmentIndex: entry.installmentIndex,
      accrualStatus,
      daysPastDue,
      penaltyDelta,
      penaltyTotal,
      skipped: false,
    };
  }

  /**
   * Truncate a Date to the start of its UTC hour.
   * e.g. 2025-06-01T14:37:22Z → 2025-06-01T14:00:00.000Z
   */
  toHourBucket(d: Date): Date {
    return new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        d.getUTCHours(),
        0,
        0,
        0,
      ),
    );
  }

  /**
   * Return the accrual summary for a loan without writing anything.
   * Used by the reconciliation service.
   */
  async getLoanAccrualSummary(loanId: string): Promise<{
    totalPenaltyAccrued: bigint;
    totalPrincipalRemaining: bigint;
    totalInterestRemaining: bigint;
    worstAccrualStatus: AccrualStatus;
  }> {
    const entries = await this.prisma.installmentEntry.findMany({
      where: {
        loanId,
        status: { notIn: [InstallmentStatus.PAID, InstallmentStatus.WAIVED] },
      },
    });

    let totalPenalty = 0n;
    let totalPrincipal = 0n;
    let totalInterest = 0n;
    const statuses: AccrualStatus[] = [];

    for (const e of entries) {
      totalPenalty += e.penaltyAccrued;
      totalPrincipal += e.principalDue - e.principalPaid;
      totalInterest += e.interestDue - e.interestPaid;
      statuses.push(e.accrualStatus);
    }

    return {
      totalPenaltyAccrued: totalPenalty,
      totalPrincipalRemaining: totalPrincipal > 0n ? totalPrincipal : 0n,
      totalInterestRemaining: totalInterest > 0n ? totalInterest : 0n,
      worstAccrualStatus: DelinquencyClassifier.worst(
        statuses.length > 0 ? statuses : [AccrualStatus.CURRENT],
      ),
    };
  }
}
