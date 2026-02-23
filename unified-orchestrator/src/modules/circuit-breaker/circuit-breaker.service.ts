import { Injectable, Logger, ForbiddenException } from "@nestjs/common";
import {
  BreakerAction,
  BreakerIncidentStatus,
  BreakerScope,
  BreakerTrigger,
} from "@prisma/client";
import { PrismaService } from "../prisma";
import {
  BreakerAlert,
  EnforcementState,
  TRIGGER_CATALOGUE,
} from "./circuit-breaker.types";

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private triggerConfig(trigger: BreakerTrigger) {
    return TRIGGER_CATALOGUE.find((t) => t.trigger === trigger);
  }

  private async openIncident(params: {
    trigger: BreakerTrigger;
    scope: BreakerScope;
    partnerId?: string;
    metricValue: number;
    threshold: number;
    actionsApplied: BreakerAction[];
    note?: string;
  }) {
    const incident = await this.prisma.breakerIncident.create({
      data: {
        trigger: params.trigger,
        scope: params.scope,
        partnerId: params.partnerId,
        metricValue: params.metricValue,
        threshold: params.threshold,
        actionsApplied: params.actionsApplied,
        status: BreakerIncidentStatus.OPEN,
      },
    });

    await this.prisma.breakerAuditLog.create({
      data: {
        incidentId: incident.id,
        trigger: params.trigger,
        scope: params.scope,
        partnerId: params.partnerId ?? null,
        metricValue: params.metricValue,
        threshold: params.threshold,
        action: params.actionsApplied[0] ?? null,
        operator: "system",
        note: params.note ?? null,
      },
    });

    return incident;
  }

  async evaluateReconciliation(summary: {
    reports: Array<{ report: string; count: number }>;
  }): Promise<BreakerAlert[]> {
    const REPORT_TRIGGER_MAP: Array<{ reportKey: string; trigger: BreakerTrigger; note: string }> = [
      {
        reportKey: "FIAT_CONFIRMED_NO_CHAIN_TX",
        trigger: BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
        note: "Triggered by reconciliation report FIAT_CONFIRMED_NO_CHAIN_TX",
      },
      {
        reportKey: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF",
        trigger: BreakerTrigger.ACTIVE_WITHOUT_DISBURSEMENT_PROOF,
        note: "Triggered by reconciliation report CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF",
      },
    ];

    const alerts: BreakerAlert[] = [];

    for (const report of summary.reports) {
      const mapping = REPORT_TRIGGER_MAP.find((m) => m.reportKey === report.report);
      if (mapping && report.count > 0) {
        const alert = await this.fireSettlementTrigger(mapping.trigger, report.count, mapping.note);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  async evaluatePartnerDefaultSpike(partnerId: string, defaultRate30d: number) {
    const cfg = this.triggerConfig(BreakerTrigger.PARTNER_DEFAULT_RATE_30D)!;
    if (defaultRate30d <= cfg.threshold) return null;
    return this.openIncident({
      trigger: cfg.trigger,
      scope: BreakerScope.PARTNER,
      partnerId,
      metricValue: defaultRate30d,
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note: "Partner default spike threshold breached",
    });
  }

  async evaluateLiquidityRatioBreach(liquidityRatio: number) {
    const cfg = this.triggerConfig(BreakerTrigger.POOL_LIQUIDITY_RATIO)!;
    if (liquidityRatio >= cfg.threshold) return null;
    return this.openIncident({
      trigger: cfg.trigger,
      scope: BreakerScope.POOL,
      metricValue: liquidityRatio,
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note: "Pool liquidity ratio threshold breached",
    });
  }

  /**
   * Auto-clear open liquidity incidents when ratio has remained healthy for
   * a full stability window.
   */
  async autoClearLiquidityIncidentsIfStable(params: {
    currentLiquidityRatio: number;
    stabilityWindowMinutes?: number;
    operator?: string;
  }) {
    const cfg = this.triggerConfig(BreakerTrigger.POOL_LIQUIDITY_RATIO)!;
    if (params.currentLiquidityRatio < cfg.threshold) return 0;

    const stabilityWindowMinutes = params.stabilityWindowMinutes ?? 60;
    const cutoff = new Date(Date.now() - stabilityWindowMinutes * 60_000);
    const operator = params.operator ?? "system:auto-liquidity-recovery";

    const openIncidents = await this.prisma.breakerIncident.findMany({
      where: {
        status: BreakerIncidentStatus.OPEN,
        trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
        createdAt: { lte: cutoff },
      },
      orderBy: { createdAt: "desc" },
    });

    for (const incident of openIncidents) {
      await this.prisma.breakerIncident.update({
        where: { id: incident.id },
        data: {
          status: BreakerIncidentStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedBy: operator,
        },
      });

      await this.prisma.breakerAuditLog.create({
        data: {
          incidentId: incident.id,
          trigger: incident.trigger,
          scope: incident.scope,
          partnerId: incident.partnerId,
          metricValue: incident.metricValue,
          threshold: incident.threshold,
          operator,
          note:
            `incident auto-resolved after liquidity stability window; ` +
            `ratio=${params.currentLiquidityRatio.toFixed(4)} windowMin=${stabilityWindowMinutes}`,
        },
      });
    }

    if (openIncidents.length > 0) {
      this.logger.log(
        `[incident_auto_resolved] trigger=${BreakerTrigger.POOL_LIQUIDITY_RATIO} count=${openIncidents.length} ratio=${params.currentLiquidityRatio.toFixed(4)}`,
      );
    }

    return openIncidents.length;
  }

  async getEnforcementState(): Promise<EnforcementState> {
    const incidents = await this.prisma.breakerIncident.findMany({
      where: { status: BreakerIncidentStatus.OPEN },
      orderBy: { createdAt: "desc" },
    });

    const blockedPartnerIds = new Set<string>();
    const tightenedPartnerIds = new Set<string>();

    let globalBlock = false;
    let globalFreeze = false;
    let requireManualApproval = false;

    for (const incident of incidents) {
      for (const action of incident.actionsApplied) {
        if (action === BreakerAction.BLOCK_ALL_ORIGINATIONS) {
          globalBlock = true;
        }

        if (action === BreakerAction.FREEZE_ORIGINATIONS) {
          globalFreeze = true;
        }

        if (action === BreakerAction.REQUIRE_MANUAL_APPROVAL) {
          requireManualApproval = true;
        }

        if (
          action === BreakerAction.BLOCK_PARTNER_ORIGINATIONS &&
          incident.partnerId
        ) {
          blockedPartnerIds.add(incident.partnerId);
        }

        if (action === BreakerAction.TIGHTEN_TERMS && incident.partnerId) {
          tightenedPartnerIds.add(incident.partnerId);
        }
      }
    }

    return {
      globalBlock,
      globalFreeze,
      requireManualApproval,
      blockedPartnerIds,
      tightenedPartnerIds,
      evaluatedAt: new Date(),
    };
  }

  async assertOriginationAllowed(partnerId: string): Promise<void> {
    const state = await this.getEnforcementState();

    if (state.globalBlock || state.globalFreeze) {
      this.logger.warn(
        `[breaker_block] global state blocks origination partner=${partnerId}`,
      );
      throw new ForbiddenException(
        "Origination is blocked by circuit breaker policy",
      );
    }

    if (state.blockedPartnerIds.has(partnerId)) {
      this.logger.warn(`[breaker_block] partner-level block partner=${partnerId}`);
      throw new ForbiddenException(
        "Origination is blocked for this partner by circuit breaker policy",
      );
    }
  }

  // ── Credit triggers (direct evaluation) ───────────────────────────────────

  async evaluateDelinquencySpike(partnerId: string, delinquencyRate14d: number) {
    const cfg = this.triggerConfig(BreakerTrigger.PARTNER_DELINQUENCY_14D)!;
    if (delinquencyRate14d <= cfg.threshold) return null;
    return this.openIncident({
      trigger: cfg.trigger,
      scope: BreakerScope.PARTNER,
      partnerId,
      metricValue: delinquencyRate14d,
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note: "Partner delinquency spike threshold breached",
    });
  }

  async evaluateNavDrawdown(poolContract: string, drawdown7d: number) {
    const cfg = this.triggerConfig(BreakerTrigger.POOL_NAV_DRAWDOWN_7D)!;
    if (drawdown7d <= cfg.threshold) return null;
    return this.openIncident({
      trigger: cfg.trigger,
      scope: BreakerScope.POOL,
      metricValue: drawdown7d,
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note: `Pool NAV drawdown threshold breached pool=${poolContract}`,
    });
  }

  // ── Incident management ────────────────────────────────────────────────────

  async getOpenIncidents() {
    return this.prisma.breakerIncident.findMany({
      where: { status: BreakerIncidentStatus.OPEN },
      orderBy: { createdAt: "desc" },
    });
  }

  async getAllIncidents(limit = 100) {
    return this.prisma.breakerIncident.findMany({
      where: {
        status: { in: [BreakerIncidentStatus.OPEN, BreakerIncidentStatus.ACKNOWLEDGED] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  async acknowledgeIncident(incidentId: string, operator: string) {
    const incident = await this.prisma.breakerIncident.findUniqueOrThrow({
      where: { id: incidentId },
    });

    if (incident.status !== BreakerIncidentStatus.OPEN) {
      throw new Error(`Incident ${incidentId} is not OPEN (status=${incident.status})`);
    }

    const updated = await this.prisma.breakerIncident.update({
      where: { id: incidentId },
      data: {
        status: BreakerIncidentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedBy: operator,
      },
    });

    await this.prisma.breakerAuditLog.create({
      data: {
        incidentId,
        trigger: incident.trigger,
        scope: incident.scope,
        partnerId: incident.partnerId,
        metricValue: incident.metricValue,
        threshold: incident.threshold,
        operator,
        note: "incident acknowledged",
      },
    });

    this.logger.log(`[incident_ack] id=${incidentId} operator=${operator}`);
    return updated;
  }

  async resolveIncident(incidentId: string, operator: string) {
    const incident = await this.prisma.breakerIncident.findUniqueOrThrow({
      where: { id: incidentId },
    });

    const updated = await this.prisma.breakerIncident.update({
      where: { id: incidentId },
      data: {
        status: BreakerIncidentStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy: operator,
      },
    });

    await this.prisma.breakerAuditLog.create({
      data: {
        incidentId,
        trigger: incident.trigger,
        scope: incident.scope,
        partnerId: incident.partnerId,
        metricValue: incident.metricValue,
        threshold: incident.threshold,
        operator,
        note: "incident resolved by admin",
      },
    });

    this.logger.log(`[incident_resolved] id=${incidentId} operator=${operator}`);
    return updated;
  }

  // ── Override management ────────────────────────────────────────────────────

  async applyOverride(params: {
    trigger: BreakerTrigger;
    scope: BreakerScope;
    partnerId?: string;
    reason: string;
    operator: string;
    expiresInMinutes: number;
  }) {
    if (params.expiresInMinutes <= 0 || params.expiresInMinutes > 10_080) {
      throw new Error("expiresInMinutes must be between 1 and 10080 (7 days)");
    }

    const expiresAt = new Date(Date.now() + params.expiresInMinutes * 60_000);

    const override = await this.prisma.breakerOverride.create({
      data: {
        trigger: params.trigger,
        scope: params.scope,
        partnerId: params.partnerId ?? null,
        reason: params.reason,
        operator: params.operator,
        expiresAt,
      },
    });

    await this.prisma.breakerAuditLog.create({
      data: {
        trigger: params.trigger,
        scope: params.scope,
        partnerId: params.partnerId ?? null,
        operator: params.operator,
        note: `override applied: expiresAt=${expiresAt.toISOString()} reason=${params.reason}`,
      },
    });

    this.logger.warn(
      `[override_applied] trigger=${params.trigger} operator=${params.operator} expiresAt=${expiresAt.toISOString()}`,
    );
    return override;
  }

  async liftOverride(overrideId: string, operator: string) {
    const override = await this.prisma.breakerOverride.findUniqueOrThrow({
      where: { id: overrideId },
    });

    if (override.liftedAt) {
      throw new Error(`Override ${overrideId} already lifted`);
    }

    const updated = await this.prisma.breakerOverride.update({
      where: { id: overrideId },
      data: { liftedAt: new Date(), liftedBy: operator },
    });

    await this.prisma.breakerAuditLog.create({
      data: {
        trigger: override.trigger,
        scope: override.scope,
        partnerId: override.partnerId ?? null,
        operator,
        note: `override lifted early: id=${overrideId}`,
      },
    });

    this.logger.warn(`[override_lifted] id=${overrideId} operator=${operator}`);
    return updated;
  }

  async getActiveOverrides() {
    return this.prisma.breakerOverride.findMany({
      where: { expiresAt: { gt: new Date() }, liftedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async getAuditLog(limit = 200) {
    return this.prisma.breakerAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // ── Governance drill ───────────────────────────────────────────────────────

  /**
   * Manually fire a trigger for governance drill / tabletop rehearsal.
   *
   * Creates a real BreakerIncident so the full incident workflow can be
   * exercised end-to-end. The audit trail note is prefixed with
   * GOVERNANCE_DRILL so drill events are distinguishable from production ones.
   *
   * Access: admin-only (enforced by the calling controller).
   * Safe to run in production — the drill incident is resolved after the drill.
   */
  async fireDrillTrigger(
    trigger: BreakerTrigger,
    operator: string,
  ): Promise<{
    incidentId: string;
    trigger: BreakerTrigger;
    actionsApplied: BreakerAction[];
    firedAt: string;
  }> {
    const cfg = this.triggerConfig(trigger);
    if (!cfg) throw new Error(`Unknown trigger: ${trigger}`);

    const firedAt = new Date();
    const incident = await this.openIncident({
      trigger: cfg.trigger,
      scope: cfg.scope,
      metricValue: 999,          // synthetic drill value — not a real metric
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note: `GOVERNANCE_DRILL operator=${operator} firedAt=${firedAt.toISOString()}`,
    });

    this.logger.warn(
      `[governance_drill] DRILL trigger=${trigger} operator=${operator} incidentId=${incident.id}`,
    );

    return {
      incidentId: incident.id,
      trigger,
      actionsApplied: incident.actionsApplied,
      firedAt: firedAt.toISOString(),
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Open an incident for a settlement-integrity trigger and return the
   * corresponding BreakerAlert. Used by evaluateReconciliation.
   */
  private async fireSettlementTrigger(
    trigger: BreakerTrigger,
    count: number,
    note: string,
  ): Promise<BreakerAlert> {
    const cfg = this.triggerConfig(trigger)!;
    const incident = await this.openIncident({
      trigger: cfg.trigger,
      scope: cfg.scope,
      metricValue: count,
      threshold: cfg.threshold,
      actionsApplied: cfg.actions,
      note,
    });
    return {
      severity: cfg.severity,
      trigger: cfg.trigger,
      actions: cfg.actions,
      scope: cfg.scope,
      metricValue: count,
      threshold: cfg.threshold,
      incidentId: incident.id,
      firedAt: new Date(),
    };
  }
}
