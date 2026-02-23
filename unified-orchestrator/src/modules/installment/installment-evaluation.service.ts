import { Injectable, Logger } from "@nestjs/common";
import { InstallmentStatus, LoanStatus } from "@prisma/client";
import { PrismaService } from "../prisma";
import {
  InstallmentEvaluation,
  LATE_FEE_DAILY_BPS,
  DEFAULT_CLASSIFICATION_DAYS,
  SECONDS_PER_DAY,
} from "./installment.types";

/**
 * InstallmentEvaluationService
 *
 * Daily evaluation job:
 *   - Determines current installment status for each active loan.
 *   - Calculates delinquent_days, accrued_late_fees, outstanding_balance.
 *   - Persists updated statuses to installment_entries.
 */
@Injectable()
export class InstallmentEvaluationService {
  private readonly logger = new Logger(InstallmentEvaluationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Evaluate a single loan's installment schedule as of `asOf` (default: now).
   * Updates all installment entries in-place and returns a summary.
   */
  async evaluateLoan(loanId: string, asOf?: Date): Promise<InstallmentEvaluation> {
    const now = asOf ?? new Date();

    const schedule = await this.prisma.installmentSchedule.findUnique({
      where: { loanId },
      include: {
        installments: { orderBy: { installmentIndex: "asc" } },
      },
    });

    if (!schedule) {
      return {
        loanId,
        evaluatedAt: now,
        delinquentDays: 0,
        accruedLateFees: 0n,
        outstandingBalance: 0n,
        overdueInstallments: 0,
        nextDueDate: null,
        nextDueAmount: null,
      };
    }

    let totalDelinquentDays = 0;
    let totalLateFees = 0n;
    let outstandingBalance = 0n;
    let overdueCount = 0;
    let nextDueDate: Date | null = null;
    let nextDueAmount: bigint | null = null;

    for (const entry of schedule.installments) {
      // Skip already-paid or waived entries
      if (
        entry.status === InstallmentStatus.PAID ||
        entry.status === InstallmentStatus.WAIVED
      ) {
        continue;
      }

      const remainingPrincipal = entry.principalDue - entry.principalPaid;
      const remainingInterest = entry.interestDue - entry.interestPaid;
      const remainingTotal = remainingPrincipal + remainingInterest;

      if (remainingTotal <= 0n) {
        // Fully paid but status not updated — fix it
        await this.prisma.installmentEntry.update({
          where: { id: entry.id },
          data: { status: InstallmentStatus.PAID, paidAt: now },
        });
        continue;
      }

      outstandingBalance += remainingTotal;

      if (entry.dueDate > now) {
        // Future installment — mark as DUE if not already
        if (entry.status === InstallmentStatus.PENDING) {
          // Only mark DUE within 7 days of due date
          const daysUntilDue = Math.floor(
            (entry.dueDate.getTime() - now.getTime()) / (SECONDS_PER_DAY * 1000),
          );
          if (daysUntilDue <= 7) {
            await this.prisma.installmentEntry.update({
              where: { id: entry.id },
              data: { status: InstallmentStatus.DUE },
            });
          }
        }
        if (nextDueDate === null) {
          nextDueDate = entry.dueDate;
          nextDueAmount = remainingTotal;
        }
        continue;
      }

      // Past due — calculate delinquent days
      const daysOverdue = Math.floor(
        (now.getTime() - entry.dueDate.getTime()) / (SECONDS_PER_DAY * 1000),
      );

      const newStatus =
        daysOverdue >= DEFAULT_CLASSIFICATION_DAYS
          ? InstallmentStatus.DEFAULTED
          : InstallmentStatus.DELINQUENT;

      // Late fee: LATE_FEE_DAILY_BPS per day on remaining total
      const lateFee =
        (remainingTotal * BigInt(LATE_FEE_DAILY_BPS) * BigInt(daysOverdue)) /
        10_000n;

      totalDelinquentDays += daysOverdue;
      totalLateFees += lateFee;
      overdueCount++;

      const delinquentSince = entry.delinquentSince ?? entry.dueDate;

      await this.prisma.installmentEntry.update({
        where: { id: entry.id },
        data: {
          status: newStatus,
          delinquentSince,
          delinquentDays: daysOverdue,
          lateFeeAccrued: lateFee,
        },
      });
    }

    this.logger.debug(
      `[installment_eval] loan=${loanId} overdue=${overdueCount} ` +
        `delinquentDays=${totalDelinquentDays} lateFees=${totalLateFees} ` +
        `outstanding=${outstandingBalance}`,
    );

    return {
      loanId,
      evaluatedAt: now,
      delinquentDays: totalDelinquentDays,
      accruedLateFees: totalLateFees,
      outstandingBalance,
      overdueInstallments: overdueCount,
      nextDueDate,
      nextDueAmount,
    };
  }

  /**
   * Run daily evaluation for all ACTIVE loans that have an installment schedule.
   * Returns per-loan evaluations.
   */
  async runDailyEvaluation(asOf?: Date): Promise<InstallmentEvaluation[]> {
    const now = asOf ?? new Date();

    const activeLoans = await this.prisma.loan.findMany({
      where: {
        status: LoanStatus.ACTIVE,
        installmentSchedule: { isNot: null },
      },
      select: { id: true },
    });

    this.logger.log(
      `[installment_daily] evaluating ${activeLoans.length} active loans`,
    );

    const results: InstallmentEvaluation[] = [];
    for (const loan of activeLoans) {
      try {
        const result = await this.evaluateLoan(loan.id, now);
        results.push(result);
      } catch (err: any) {
        this.logger.error(
          `[installment_eval_error] loan=${loan.id} error=${err.message}`,
        );
      }
    }

    return results;
  }

  /**
   * Get the current outstanding balance for a single loan.
   * Sum of (totalDue - principalPaid - interestPaid) for all non-paid entries.
   */
  async getOutstandingBalance(loanId: string): Promise<bigint> {
    const entries = await this.prisma.installmentEntry.findMany({
      where: {
        loanId,
        status: {
          notIn: [InstallmentStatus.PAID, InstallmentStatus.WAIVED],
        },
      },
    });

    return entries.reduce((sum, e) => {
      const remaining = e.principalDue - e.principalPaid + (e.interestDue - e.interestPaid);
      return sum + (remaining > 0n ? remaining : 0n);
    }, 0n);
  }
}
