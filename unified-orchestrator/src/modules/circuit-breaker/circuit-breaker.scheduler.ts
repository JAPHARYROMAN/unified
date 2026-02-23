import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { CircuitBreakerMetricsService } from "./circuit-breaker-metrics.service";
import { CircuitBreakerAlertService } from "./circuit-breaker-alert.service";
import { OpsService } from "../ops/ops.service";
import { BreakerAlert } from "./circuit-breaker.types";
import { BreakerTrigger, BreakerScope, BreakerAction } from "@prisma/client";

/**
 * CircuitBreakerScheduler
 *
 * Evaluation cadences:
 *   - Realtime (every 5 min): settlement integrity triggers
 *   - Hourly: credit + liquidity triggers
 *   - Daily (03:00 UTC): full reconciliation report
 */
@Injectable()
export class CircuitBreakerScheduler {
  private readonly logger = new Logger(CircuitBreakerScheduler.name);

  constructor(
    private readonly breaker: CircuitBreakerService,
    private readonly metrics: CircuitBreakerMetricsService,
    private readonly alerts: CircuitBreakerAlertService,
    private readonly ops: OpsService,
  ) {}

  // ── Realtime: settlement integrity (every 5 minutes) ──────────────────────

  @Cron("*/5 * * * *", { name: "breaker-settlement-integrity", timeZone: "UTC" })
  async runSettlementIntegrityCheck(): Promise<void> {
    this.logger.debug("[breaker_schedule] settlement integrity check");
    try {
      const [activeWithoutProof, fiatNoChain] = await Promise.all([
        this.safeMetric(() => this.metrics.activeWithoutDisbursementProof(), 0),
        this.safeMetric(() => this.metrics.fiatConfirmedNoChainRecord(), 0),
      ]);

      const summary = {
        reports: [
          { report: "FIAT_CONFIRMED_NO_CHAIN_TX", count: fiatNoChain as number },
          {
            report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF",
            count: activeWithoutProof as number,
          },
          { report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN", count: 0 },
        ],
      };

      const firedAlerts = await this.breaker.evaluateReconciliation(summary);

      if (firedAlerts.length > 0) {
        await this.alerts.emitMany(firedAlerts);
        this.logger.error(
          `[breaker_fired] settlement integrity: ${firedAlerts.length} trigger(s) fired`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[breaker_schedule_error] settlement integrity check failed: ${err.message}`,
      );
    }
  }

  // ── Hourly: credit + liquidity triggers ───────────────────────────────────

  @Cron("0 * * * *", { name: "breaker-credit-liquidity", timeZone: "UTC" })
  async runCreditAndLiquidityCheck(): Promise<void> {
    this.logger.debug("[breaker_schedule] credit + liquidity check");
    try {
      const [defaultRates, delinquencyRates, liquidityRatios, navDrawdowns] =
        await Promise.all([
          this.safeMetric(() => this.metrics.partnerDefaultRate30D(), new Map()),
          this.safeMetric(() => this.metrics.partnerDelinquency14D(), new Map()),
          this.safeMetric(() => this.metrics.poolLiquidityRatio(), new Map()),
          this.safeMetric(() => this.metrics.poolNavDrawdown7D(), new Map()),
        ]);

      const firedAlerts: BreakerAlert[] = [];

      for (const [partnerId, rate] of defaultRates as Map<string, number>) {
        const incident = await this.breaker.evaluatePartnerDefaultSpike(partnerId, rate);
        if (incident) {
          firedAlerts.push(this.buildAlert(
            BreakerTrigger.PARTNER_DEFAULT_RATE_30D, "HIGH", BreakerScope.PARTNER,
            [BreakerAction.BLOCK_PARTNER_ORIGINATIONS, BreakerAction.OPEN_INCIDENT],
            rate, 0.08, incident.id, partnerId,
          ));
        }
      }

      for (const [partnerId, rate] of delinquencyRates as Map<string, number>) {
        const incident = await this.breaker.evaluateDelinquencySpike(partnerId, rate);
        if (incident) {
          firedAlerts.push(this.buildAlert(
            BreakerTrigger.PARTNER_DELINQUENCY_14D, "MEDIUM", BreakerScope.PARTNER,
            [BreakerAction.BLOCK_PARTNER_ORIGINATIONS, BreakerAction.TIGHTEN_TERMS],
            rate, 0.15, incident.id, partnerId,
          ));
        }
      }

      for (const [, ratio] of liquidityRatios as Map<string, number>) {
        const incident = await this.breaker.evaluateLiquidityRatioBreach(ratio);
        if (incident) {
          firedAlerts.push(this.buildAlert(
            BreakerTrigger.POOL_LIQUIDITY_RATIO, "HIGH", BreakerScope.POOL,
            [BreakerAction.FREEZE_ORIGINATIONS, BreakerAction.OPEN_INCIDENT],
            ratio, 0.25, incident.id,
          ));
        }
      }

      const liquidityValues = [...(liquidityRatios as Map<string, number>).values()];
      if (liquidityValues.length > 0) {
        const minLiquidityRatio = Math.min(...liquidityValues);
        await this.breaker.autoClearLiquidityIncidentsIfStable({
          currentLiquidityRatio: minLiquidityRatio,
          stabilityWindowMinutes: 60,
        });
      }

      for (const [poolContract, drawdown] of navDrawdowns as Map<string, number>) {
        const incident = await this.breaker.evaluateNavDrawdown(poolContract, drawdown);
        if (incident) {
          firedAlerts.push(this.buildAlert(
            BreakerTrigger.POOL_NAV_DRAWDOWN_7D, "HIGH", BreakerScope.POOL,
            [BreakerAction.FREEZE_ORIGINATIONS, BreakerAction.TIGHTEN_TERMS],
            drawdown, 0.02, incident.id,
          ));
        }
      }

      if (firedAlerts.length > 0) {
        await this.alerts.emitMany(firedAlerts);
        this.logger.warn(
          `[breaker_fired] credit/liquidity: ${firedAlerts.length} trigger(s) fired`,
        );
      } else {
        this.logger.debug("[breaker_schedule] credit/liquidity: all clear");
      }
    } catch (err: any) {
      this.logger.error(
        `[breaker_schedule_error] credit/liquidity check failed: ${err.message}`,
      );
    }
  }

  // ── Daily: full reconciliation report (03:00 UTC) ─────────────────────────

  @Cron("0 3 * * *", { name: "breaker-daily-reconciliation", timeZone: "UTC" })
  async runDailyReconciliation(): Promise<void> {
    this.logger.log("[breaker_schedule] daily reconciliation report");
    try {
      const summary = await this.ops.runDailyReconciliation();
      const firedAlerts = await this.breaker.evaluateReconciliation(summary);

      if (firedAlerts.length > 0) {
        await this.alerts.emitMany(firedAlerts);
        this.logger.error(
          `[breaker_fired] daily reconciliation: ${firedAlerts.length} trigger(s) fired`,
        );
      } else {
        this.logger.log("[breaker_schedule] daily reconciliation: clean");
      }
    } catch (err: any) {
      this.logger.error(
        `[breaker_schedule_error] daily reconciliation failed: ${err.message}`,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private buildAlert(
    trigger: BreakerTrigger,
    severity: "CRITICAL" | "HIGH" | "MEDIUM",
    scope: BreakerScope,
    actions: BreakerAction[],
    metricValue: number,
    threshold: number,
    incidentId: string,
    partnerId?: string,
  ): BreakerAlert {
    return { severity, trigger, actions, scope, partnerId, metricValue, threshold, incidentId, firedAt: new Date() };
  }

  /** Fail-closed: if metric throws, return failClosedValue (triggers fire). */
  private async safeMetric<T>(fn: () => Promise<T>, failClosedValue: T): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      this.logger.error(
        `[metric_error] Metric failed — failing closed: ${err.message}`,
      );
      return failClosedValue;
    }
  }
}
