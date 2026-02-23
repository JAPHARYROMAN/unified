import { Injectable, Logger } from "@nestjs/common";
import { LoanStatus, BreakerScope, BreakerTrigger, BreakerAction } from "@prisma/client";
import { createHash } from "crypto";
import { PrismaService } from "../prisma";
import { CircuitBreakerAlertService } from "../circuit-breaker/circuit-breaker-alert.service";
import {
  AccountingIntegrityReport,
  AccountingIntegrityResult,
  BalanceMismatch,
  InstallmentReconciliationReport,
  RECONCILIATION_MISMATCH_THRESHOLD_USDC,
} from "./installment.types";
import { InstallmentAccrualService } from "./installment-accrual.service";
import { InstallmentScheduleService } from "./installment-schedule.service";
import { InstallmentDriftService } from "./installment-drift.service";

/**
 * InstallmentReconciliationService
 *
 * Balance reconciliation (Requirement 3a):
 *   backendTotal = principalRemaining + interestRemaining + penaltyAccrued
 *   onchainProxy = loan.principalUsdc  (v1.1 proxy until chain writes back)
 *   Mismatch > RECONCILIATION_MISMATCH_THRESHOLD_USDC → CRITICAL alert.
 *
 * Accounting integrity checks (Requirement 3b):
 *   - Schedule hash: recompute from stored scheduleJson and compare to stored hash.
 *   - Accrual idempotency: detect duplicate (entryId, hourBucket) snapshots.
 */
@Injectable()
export class InstallmentReconciliationService {
  private readonly logger = new Logger(InstallmentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accrual: InstallmentAccrualService,
    private readonly alerts: CircuitBreakerAlertService,
    private readonly scheduleService: InstallmentScheduleService,
    private readonly drift: InstallmentDriftService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run balance reconciliation for all ACTIVE loans with an installment schedule.
   * Emits an alert for each loan whose discrepancy exceeds the threshold.
   */
  async runReconciliation(): Promise<InstallmentReconciliationReport> {
    const now = new Date();

    const activeLoans = await this.prisma.loan.findMany({
      where: {
        status: LoanStatus.ACTIVE,
        installmentSchedule: { isNot: null },
      },
      select: {
        id: true,
        partnerId: true,
        principalUsdc: true,
        interestRateBps: true,
      },
    });

    const mismatches: BalanceMismatch[] = [];

    for (const loan of activeLoans) {
      const summary = await this.accrual.getLoanAccrualSummary(loan.id);

      const backendTotal =
        summary.totalPrincipalRemaining +
        summary.totalInterestRemaining +
        summary.totalPenaltyAccrued;

      // On-chain proxy: loan.principalUsdc (v1.1 — replaced by chain read in v1.2)
      const onchainPrincipal = loan.principalUsdc;

      const discrepancy =
        backendTotal > onchainPrincipal
          ? backendTotal - onchainPrincipal
          : onchainPrincipal - backendTotal;

      if (discrepancy > RECONCILIATION_MISMATCH_THRESHOLD_USDC) {
        mismatches.push({
          loanId: loan.id,
          partnerId: loan.partnerId,
          backendOutstandingUsdc: backendTotal,
          onchainPrincipalUsdc: onchainPrincipal,
          discrepancyUsdc: discrepancy,
          backendPrincipalRemaining: summary.totalPrincipalRemaining,
          backendInterestRemaining: summary.totalInterestRemaining,
          backendPenaltyAccrued: summary.totalPenaltyAccrued,
        });

        this.logger.warn(
          `[installment_recon] MISMATCH loan=${loan.id} ` +
            `backendTotal=${backendTotal} onchain=${onchainPrincipal} ` +
            `discrepancy=${discrepancy} ` +
            `(principal=${summary.totalPrincipalRemaining} ` +
            `interest=${summary.totalInterestRemaining} ` +
            `penalty=${summary.totalPenaltyAccrued})`,
        );
      }
    }

    const report: InstallmentReconciliationReport = {
      ranAt: now,
      totalLoansChecked: activeLoans.length,
      mismatchCount: mismatches.length,
      mismatches,
    };

    if (mismatches.length > 0) {
      await this.emitMismatchAlerts(mismatches);
      this.logger.error(
        `[installment_recon] ${mismatches.length} balance mismatch(es) found ` +
          `out of ${activeLoans.length} loans checked`,
      );
    } else {
      this.logger.log(
        `[installment_recon] clean — ${activeLoans.length} loans checked, 0 mismatches`,
      );
    }

    return report;
  }

  /**
   * Accounting integrity checks (Requirement 3):
   *   1. Recompute SHA-256 of stored scheduleJson and compare to stored hash.
   *   2. Detect accrual double-charges: any (entryId, hourBucket) with >1 snapshot.
   *
   * Failures create ReconIncidents via InstallmentDriftService.
   */
  async runAccountingIntegrityChecks(
    reportId?: string,
  ): Promise<AccountingIntegrityReport> {
    const ranAt = new Date();

    const schedules = await this.prisma.installmentSchedule.findMany({
      select: {
        loanId: true,
        scheduleHash: true,
        scheduleJson: true,
        loan: { select: { partnerId: true } },
        installments: {
          select: {
            id: true,
            accrualSnapshots: {
              select: { hourBucket: true },
            },
          },
        },
      },
    });

    const failures: AccountingIntegrityResult[] = [];

    for (const sched of schedules) {
      const partnerId = sched.loan.partnerId;
      let scheduleHashOk = true;
      let accrualIdempotencyOk = true;
      let balanceDiscrepancyUsdc = 0n;
      const details: string[] = [];

      // ── 1. Schedule hash check ─────────────────────────────────────────────
      const recomputedHash = createHash("sha256")
        .update(sched.scheduleJson)
        .digest("hex");

      if (recomputedHash !== sched.scheduleHash) {
        scheduleHashOk = false;
        details.push(
          `hash mismatch: stored=${sched.scheduleHash} recomputed=${recomputedHash}`,
        );
        await this.drift.recordScheduleHashMismatch({
          loanId: sched.loanId,
          partnerId,
          storedHash: sched.scheduleHash,
          recomputedHash,
          reportId,
        });
      }

      // ── 2. Accrual idempotency check ───────────────────────────────────────
      for (const entry of sched.installments) {
        const bucketCounts = new Map<string, number>();
        for (const snap of entry.accrualSnapshots) {
          const key = snap.hourBucket.toISOString();
          bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1);
        }
        for (const [bucket, count] of bucketCounts) {
          if (count > 1) {
            accrualIdempotencyOk = false;
            details.push(
              `double-charge: entry=${entry.id} bucket=${bucket} count=${count}`,
            );
            await this.drift.recordAccrualDoubleCharge({
              loanId: sched.loanId,
              partnerId,
              entryId: entry.id,
              hourBucket: new Date(bucket),
              reportId,
            });
          }
        }
      }

      if (!scheduleHashOk || !accrualIdempotencyOk) {
        failures.push({
          loanId: sched.loanId,
          scheduleHashOk,
          accrualIdempotencyOk,
          balanceDiscrepancyUsdc,
          detail: details.join("; "),
        });
      }
    }

    const report: AccountingIntegrityReport = {
      ranAt,
      totalLoansChecked: schedules.length,
      failureCount: failures.length,
      failures,
    };

    if (failures.length > 0) {
      this.logger.error(
        `[installment_accounting] ${failures.length} integrity failure(s) ` +
          `out of ${schedules.length} schedules checked`,
      );
    } else {
      this.logger.log(
        `[installment_accounting] clean — ${schedules.length} schedules checked`,
      );
    }

    return report;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async emitMismatchAlerts(mismatches: BalanceMismatch[]) {
    const alerts = mismatches.map((m) => ({
      severity: "CRITICAL" as const,
      trigger: BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
      actions: [BreakerAction.BLOCK_ALL_ORIGINATIONS, BreakerAction.OPEN_INCIDENT],
      scope: BreakerScope.PARTNER,
      partnerId: m.partnerId,
      metricValue: Number(m.discrepancyUsdc),
      threshold: Number(RECONCILIATION_MISMATCH_THRESHOLD_USDC),
      incidentId: `recon-${m.loanId}`,
      firedAt: new Date(),
    }));

    await this.alerts.emitMany(alerts);
  }
}
