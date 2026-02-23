import { Injectable, Logger } from "@nestjs/common";
import {
  BreakerAction,
  BreakerScope,
  BreakerTrigger,
  DriftKind,
  ReconIncidentSeverity,
  ReconIncidentStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma";
import { CircuitBreakerAlertService } from "../circuit-breaker/circuit-breaker-alert.service";
import {
  DEFAULT_DRIFT_TOLERANCES,
  DriftIncident,
  DriftTolerances,
} from "./installment.types";

/**
 * InstallmentDriftService
 *
 * Drift detection and incident management (Requirement 4).
 *
 * Tolerance rules:
 *   ROUNDING_DRIFT    — balance discrepancy ≤ roundingDriftUsdc (default 1 USDC)
 *   TIMING_DRIFT      — accrual bucket lag ≤ timingDriftSeconds (default 3600s)
 *   SCHEDULE_HASH_MISMATCH — always CRITICAL, no tolerance
 *   ACCRUAL_DOUBLE_CHARGE  — always CRITICAL, no tolerance
 *
 * Any drift beyond tolerance:
 *   1. Creates a ReconIncident record in the DB.
 *   2. Triggers a breaker alert where applicable.
 */
@Injectable()
export class InstallmentDriftService {
  private readonly logger = new Logger(InstallmentDriftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: CircuitBreakerAlertService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Evaluate a rounding drift value against the tolerance.
   * Creates an incident and fires a breaker alert if exceeded.
   */
  async evaluateRoundingDrift(params: {
    loanId: string;
    partnerId: string;
    discrepancyUsdc: bigint;
    reportId?: string;
    tolerances?: DriftTolerances;
  }): Promise<DriftIncident | null> {
    const tol = params.tolerances ?? DEFAULT_DRIFT_TOLERANCES;
    const exceeded = params.discrepancyUsdc > tol.roundingDriftUsdc;

    if (!exceeded) return null;

    return this.createIncident({
      kind: DriftKind.ROUNDING_DRIFT,
      severity: ReconIncidentSeverity.HIGH,
      loanId: params.loanId,
      partnerId: params.partnerId,
      reportId: params.reportId,
      metricValue: Number(params.discrepancyUsdc),
      tolerance: Number(tol.roundingDriftUsdc),
      detail: `Rounding drift ${params.discrepancyUsdc} USDC exceeds tolerance ${tol.roundingDriftUsdc} USDC`,
      fireBreakerAlert: true,
    });
  }

  /**
   * Evaluate a timing drift value (seconds between expected and actual accrual).
   * Creates an incident if exceeded.
   */
  async evaluateTimingDrift(params: {
    loanId: string;
    partnerId: string;
    driftSeconds: number;
    reportId?: string;
    tolerances?: DriftTolerances;
  }): Promise<DriftIncident | null> {
    const tol = params.tolerances ?? DEFAULT_DRIFT_TOLERANCES;
    const exceeded = params.driftSeconds > tol.timingDriftSeconds;

    if (!exceeded) return null;

    return this.createIncident({
      kind: DriftKind.TIMING_DRIFT,
      severity: ReconIncidentSeverity.MEDIUM,
      loanId: params.loanId,
      partnerId: params.partnerId,
      reportId: params.reportId,
      metricValue: params.driftSeconds,
      tolerance: tol.timingDriftSeconds,
      detail: `Timing drift ${params.driftSeconds}s exceeds tolerance ${tol.timingDriftSeconds}s`,
      fireBreakerAlert: false,
    });
  }

  /**
   * Record a schedule hash mismatch — always CRITICAL, no tolerance.
   */
  async recordScheduleHashMismatch(params: {
    loanId: string;
    partnerId: string;
    storedHash: string;
    recomputedHash: string;
    reportId?: string;
  }): Promise<DriftIncident> {
    return this.createIncident({
      kind: DriftKind.SCHEDULE_HASH_MISMATCH,
      severity: ReconIncidentSeverity.CRITICAL,
      loanId: params.loanId,
      partnerId: params.partnerId,
      reportId: params.reportId,
      metricValue: 1,
      tolerance: 0,
      detail:
        `Schedule hash mismatch: stored=${params.storedHash} ` +
        `recomputed=${params.recomputedHash}`,
      fireBreakerAlert: true,
    });
  }

  /**
   * Record an accrual double-charge — always CRITICAL, no tolerance.
   */
  async recordAccrualDoubleCharge(params: {
    loanId: string;
    partnerId: string;
    entryId: string;
    hourBucket: Date;
    reportId?: string;
  }): Promise<DriftIncident> {
    return this.createIncident({
      kind: DriftKind.ACCRUAL_DOUBLE_CHARGE,
      severity: ReconIncidentSeverity.CRITICAL,
      loanId: params.loanId,
      partnerId: params.partnerId,
      reportId: params.reportId,
      metricValue: 1,
      tolerance: 0,
      detail:
        `Accrual double-charge detected: entry=${params.entryId} ` +
        `hourBucket=${params.hourBucket.toISOString()}`,
      fireBreakerAlert: true,
    });
  }

  /**
   * Resolve an open incident by ID.
   */
  async resolveIncident(incidentId: string, resolvedBy = "system"): Promise<void> {
    await this.prisma.reconIncident.update({
      where: { id: incidentId },
      data: {
        status: ReconIncidentStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedBy,
      },
    });
  }

  /**
   * List all open incidents, optionally filtered by kind.
   */
  async listOpenIncidents(kind?: DriftKind): Promise<DriftIncident[]> {
    const rows = await this.prisma.reconIncident.findMany({
      where: {
        status: ReconIncidentStatus.OPEN,
        ...(kind ? { kind } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      severity: r.severity,
      loanId: r.loanId ?? undefined,
      partnerId: r.partnerId ?? undefined,
      metricValue: r.metricValue,
      tolerance: r.tolerance,
      detail: r.detail,
      breakerFired: r.breakerFired,
      createdAt: r.createdAt,
    }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async createIncident(params: {
    kind: DriftKind;
    severity: ReconIncidentSeverity;
    loanId?: string;
    partnerId?: string;
    poolId?: string;
    reportId?: string;
    metricValue: number;
    tolerance: number;
    detail: string;
    fireBreakerAlert: boolean;
  }): Promise<DriftIncident> {
    let breakerFired = false;

    if (params.fireBreakerAlert && params.partnerId) {
      try {
        await this.alerts.emit({
          severity: this.mapSeverity(params.severity),
          trigger: BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
          actions: [BreakerAction.OPEN_INCIDENT],
          scope: BreakerScope.PARTNER,
          partnerId: params.partnerId,
          metricValue: params.metricValue,
          threshold: params.tolerance,
          incidentId: `drift-${params.kind}-${params.loanId ?? "global"}`,
          firedAt: new Date(),
        });
        breakerFired = true;
      } catch (err: any) {
        this.logger.error(
          `[drift] breaker alert failed for ${params.kind}: ${err.message}`,
        );
      }
    }

    const row = await this.prisma.reconIncident.create({
      data: {
        reportId: params.reportId ?? null,
        kind: params.kind,
        severity: params.severity,
        status: ReconIncidentStatus.OPEN,
        loanId: params.loanId ?? null,
        partnerId: params.partnerId ?? null,
        poolId: params.poolId ?? null,
        metricValue: params.metricValue,
        tolerance: params.tolerance,
        detail: params.detail,
        breakerFired,
      },
    });

    this.logger.warn(
      `[drift] incident created id=${row.id} kind=${params.kind} ` +
        `severity=${params.severity} loan=${params.loanId ?? "-"} ` +
        `breakerFired=${breakerFired}`,
    );

    return {
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      loanId: row.loanId ?? undefined,
      partnerId: row.partnerId ?? undefined,
      metricValue: row.metricValue,
      tolerance: row.tolerance,
      detail: row.detail,
      breakerFired: row.breakerFired,
      createdAt: row.createdAt,
    };
  }

  private mapSeverity(
    s: ReconIncidentSeverity,
  ): "CRITICAL" | "HIGH" | "MEDIUM" {
    switch (s) {
      case ReconIncidentSeverity.CRITICAL:
        return "CRITICAL";
      case ReconIncidentSeverity.HIGH:
        return "HIGH";
      default:
        return "MEDIUM";
    }
  }
}
