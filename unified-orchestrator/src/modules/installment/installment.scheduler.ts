import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InstallmentEvaluationService } from "./installment-evaluation.service";
import { InstallmentAccrualService } from "./installment-accrual.service";
import { InstallmentBreakerFeedService } from "./installment-breaker-feed.service";
import { InstallmentReconciliationService } from "./installment-reconciliation.service";
import { InstallmentReportService } from "./installment-report.service";
import { InstallmentSettlementCheckService } from "./installment-settlement-check.service";

/**
 * InstallmentScheduler
 *
 * Cron cadences:
 *   - Hourly :05        — accrual job (penalty + delinquency classification)
 *   - Daily 01:00 UTC   — evaluate all active loan installments (status updates)
 *   - Daily 01:30 UTC   — feed delinquency/default metrics into breaker
 *   - Daily 02:00 UTC   — run balance reconciliation + accounting integrity checks
 *   - Daily 02:30 UTC   — build daily reconciliation report (per-pool + global)
 *   - Daily 03:00 UTC   — run realtime settlement integrity checks
 */
@Injectable()
export class InstallmentScheduler {
  private readonly logger = new Logger(InstallmentScheduler.name);

  constructor(
    private readonly evaluation: InstallmentEvaluationService,
    private readonly accrual: InstallmentAccrualService,
    private readonly breakerFeed: InstallmentBreakerFeedService,
    private readonly reconciliation: InstallmentReconciliationService,
    private readonly report: InstallmentReportService,
    private readonly settlementCheck: InstallmentSettlementCheckService,
  ) {}

  @Cron("5 * * * *", { name: "installment-hourly-accrual", timeZone: "UTC" })
  async runHourlyAccrual(): Promise<void> {
    this.logger.log("[installment_schedule] hourly accrual starting");
    try {
      const results = await this.accrual.runHourlyAccrual();
      const withPenalty = results.filter((r) => r.totalPenaltyDelta > 0n).length;
      this.logger.log(
        `[installment_schedule] hourly accrual complete: ` +
          `loans=${results.length} withPenalty=${withPenalty}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] hourly accrual failed: ${err.message}`,
      );
    }
  }

  @Cron("0 1 * * *", { name: "installment-daily-evaluation", timeZone: "UTC" })
  async runDailyEvaluation(): Promise<void> {
    this.logger.log("[installment_schedule] daily evaluation starting");
    try {
      const results = await this.evaluation.runDailyEvaluation();
      const delinquent = results.filter((r) => r.delinquentDays > 0).length;
      this.logger.log(
        `[installment_schedule] daily evaluation complete: ` +
          `loans=${results.length} delinquent=${delinquent}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] daily evaluation failed: ${err.message}`,
      );
    }
  }

  @Cron("30 1 * * *", { name: "installment-breaker-feed", timeZone: "UTC" })
  async runBreakerFeed(): Promise<void> {
    this.logger.log("[installment_schedule] breaker feed starting");
    try {
      const triggered = await this.breakerFeed.feedBreaker();
      if (triggered.length > 0) {
        this.logger.warn(
          `[installment_schedule] breaker triggered for ${triggered.length} partner(s): ` +
            triggered.join(", "),
        );
      } else {
        this.logger.log("[installment_schedule] breaker feed: all clear");
      }
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] breaker feed failed: ${err.message}`,
      );
    }
  }

  @Cron("0 2 * * *", { name: "installment-reconciliation", timeZone: "UTC" })
  async runReconciliation(): Promise<void> {
    this.logger.log("[installment_schedule] reconciliation starting");
    try {
      const balanceReport = await this.reconciliation.runReconciliation();
      if (balanceReport.mismatchCount > 0) {
        this.logger.error(
          `[installment_schedule] reconciliation found ${balanceReport.mismatchCount} mismatch(es) ` +
            `out of ${balanceReport.totalLoansChecked} loans`,
        );
      } else {
        this.logger.log(
          `[installment_schedule] reconciliation clean: ${balanceReport.totalLoansChecked} loans checked`,
        );
      }
      const accountingReport = await this.reconciliation.runAccountingIntegrityChecks();
      if (accountingReport.failureCount > 0) {
        this.logger.error(
          `[installment_schedule] accounting integrity: ${accountingReport.failureCount} failure(s) ` +
            `out of ${accountingReport.totalLoansChecked} schedules`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] reconciliation failed: ${err.message}`,
      );
    }
  }

  @Cron("30 2 * * *", { name: "installment-daily-report", timeZone: "UTC" })
  async runDailyReport(): Promise<void> {
    this.logger.log("[installment_schedule] daily report starting");
    try {
      const r = await this.report.buildDailyReport();
      this.logger.log(
        `[installment_schedule] daily report done: pools=${r.pools.length} ` +
          `totalLoans=${r.global.activeLoans}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] daily report failed: ${err.message}`,
      );
    }
  }

  @Cron("0 3 * * *", { name: "installment-settlement-check", timeZone: "UTC" })
  async runSettlementCheck(): Promise<void> {
    this.logger.log("[installment_schedule] settlement check starting");
    try {
      const r = await this.settlementCheck.runChecks();
      if (r.failureCount > 0) {
        this.logger.error(
          `[installment_schedule] settlement check: ${r.failureCount} failure(s) ` +
            `out of ${r.totalChecked} checks`,
        );
      } else {
        this.logger.log(
          `[installment_schedule] settlement check clean: ${r.totalChecked} checks`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[installment_schedule_error] settlement check failed: ${err.message}`,
      );
    }
  }
}
