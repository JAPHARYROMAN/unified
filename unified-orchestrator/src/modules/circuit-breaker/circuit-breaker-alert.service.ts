import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BreakerAlert } from "./circuit-breaker.types";

/**
 * CircuitBreakerAlertService
 *
 * Emits structured alerts to configured channels.
 * v1.1: structured log emission (stdout/stderr) — consumed by log aggregator.
 * Extend with email/Slack/PagerDuty adapters by injecting channel providers.
 *
 * Severity routing:
 *   CRITICAL → logger.error  (settlement integrity)
 *   HIGH     → logger.warn   (liquidity breach)
 *   MEDIUM   → logger.warn   (credit triggers)
 *
 * Fail-safe: alert emission never throws — failures are logged internally.
 */
@Injectable()
export class CircuitBreakerAlertService {
  private readonly logger = new Logger(CircuitBreakerAlertService.name);
  private readonly env: string;

  constructor(private readonly config: ConfigService) {
    this.env = this.config.get<string>("NODE_ENV") ?? "production";
  }

  async emit(alert: BreakerAlert): Promise<void> {
    try {
      const payload = {
        env: this.env,
        severity: alert.severity,
        trigger: alert.trigger,
        actions: alert.actions,
        scope: alert.scope,
        partnerId: alert.partnerId ?? null,
        metricValue: alert.metricValue,
        threshold: alert.threshold,
        incidentId: alert.incidentId,
        firedAt: alert.firedAt.toISOString(),
      };

      const message = `[BREAKER_ALERT] ${JSON.stringify(payload)}`;

      switch (alert.severity) {
        case "CRITICAL":
          this.logger.error(message);
          break;
        case "HIGH":
        case "MEDIUM":
          this.logger.warn(message);
          break;
        default:
          this.logger.log(message);
      }
    } catch (err: any) {
      this.logger.error(
        `[alert_emit_failed] Failed to emit alert: ${err.message}`,
      );
    }
  }

  async emitMany(alerts: BreakerAlert[]): Promise<void> {
    for (const alert of alerts) {
      await this.emit(alert);
    }
  }
}
