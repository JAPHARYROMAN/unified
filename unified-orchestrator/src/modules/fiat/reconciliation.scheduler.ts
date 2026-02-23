import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OpsService } from "../ops/ops.service";

/**
 * ReconciliationScheduler
 *
 * Runs the daily fiat ↔ chain reconciliation job.
 * Raises a log-level alert if any critical mismatches are found.
 *
 * Schedule: 02:00 UTC every day.
 */
@Injectable()
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(private readonly ops: OpsService) {}

  @Cron("0 2 * * *", { name: "daily-reconciliation", timeZone: "UTC" })
  async runDailyReconciliation(): Promise<void> {
    this.logger.log("[reconciliation] Starting daily fiat ↔ chain reconciliation");

    try {
      const summary = await this.ops.runDailyReconciliation();

      if (summary.criticalCount > 0) {
        this.logger.error(
          `[reconciliation] CRITICAL: ${summary.criticalCount} mismatch(es) found — manual review required`,
        );
        for (const report of summary.reports) {
          if (report.count > 0) {
            this.logger.error(
              `[reconciliation] ${report.report}: ${report.count} item(s)`,
            );
          }
        }
      } else {
        this.logger.log(
          `[reconciliation] Clean — 0 critical mismatches across ${summary.reports.length} checks`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[reconciliation] Job failed with error: ${err.message}`,
      );
    }
  }
}
