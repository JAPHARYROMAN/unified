import { Injectable, Logger } from "@nestjs/common";
import {
  AccrualStatus,
  InstallmentStatus,
  LoanStatus,
  ReconReportScope,
} from "@prisma/client";
import { createHash } from "crypto";
import { PrismaService } from "../prisma";
import {
  DailyReconReport,
  DelinquencyDistribution,
  DefaultEntry,
  PoolReconSummary,
  ReportArchiveArtifact,
} from "./installment.types";

/**
 * InstallmentReportService
 *
 * Builds the daily reconciliation report (Requirement 1):
 *   - Per-pool summary: active loans, outstanding principal/interest/penalty,
 *     fiat vs chain repayments, delinquency distribution (0-5, 6-15, 16-30, 31+),
 *     default list with timestamps.
 *   - Global rollup across all pools.
 *   - Persists each report to recon_reports with a SHA-256 checksum.
 *   - Returns archive artifacts for downstream linking.
 *
 * Delinquency bucket assignment uses daysPastDue from InstallmentEntry.
 * Repayment totals use FiatTransfer (fiat-confirmed) and ChainAction (chain-confirmed).
 */
@Injectable()
export class InstallmentReportService {
  private readonly logger = new Logger(InstallmentReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Build and persist the daily reconciliation report.
   * Pass `asOf` to pin the report date (useful for testing / backfill).
   */
  async buildDailyReport(asOf?: Date): Promise<DailyReconReport> {
    const now = asOf ?? new Date();
    const reportDate = this.toDateOnly(now);

    this.logger.log(
      `[recon_report] building daily report for ${reportDate.toISOString().slice(0, 10)}`,
    );

    // ── Fetch all active loans with their installment data ──────────────────
    const activeLoans = await this.prisma.loan.findMany({
      where: {
        status: LoanStatus.ACTIVE,
        installmentSchedule: { isNot: null },
      },
      select: {
        id: true,
        partnerId: true,
        poolContract: true,
        principalUsdc: true,
        status: true,
        fiatTransfers: {
          select: { amountKes: true, confirmedAt: true },
          where: { confirmedAt: { not: null } },
        },
        chainActions: {
          select: { type: true, status: true },
          where: { type: "RECORD_REPAYMENT", status: "MINED" },
        },
        installmentSchedule: {
          select: {
            installments: {
              select: {
                principalDue: true,
                principalPaid: true,
                interestDue: true,
                interestPaid: true,
                penaltyAccrued: true,
                daysPastDue: true,
                accrualStatus: true,
                status: true,
                delinquentSince: true,
              },
            },
          },
        },
      },
    });

    // ── Fetch defaulted loans (status = DEFAULTED) for default list ─────────
    const defaultedLoans = await this.prisma.loan.findMany({
      where: { status: LoanStatus.DEFAULTED },
      select: { id: true, partnerId: true, updatedAt: true },
    });

    const defaultList: DefaultEntry[] = defaultedLoans.map((l) => ({
      loanId: l.id,
      partnerId: l.partnerId,
      defaultedAt: l.updatedAt,
    }));

    // ── Group loans by pool ─────────────────────────────────────────────────
    const byPool = new Map<string, typeof activeLoans>();
    for (const loan of activeLoans) {
      const key = loan.poolContract ?? "__no_pool__";
      if (!byPool.has(key)) byPool.set(key, []);
      byPool.get(key)!.push(loan);
    }

    const poolSummaries: PoolReconSummary[] = [];

    for (const [poolId, loans] of byPool) {
      const summary = await this.buildPoolSummary(poolId, loans, defaultList);
      poolSummaries.push(summary);
    }

    // ── Global rollup ───────────────────────────────────────────────────────
    const global = this.rollupGlobal(poolSummaries, defaultList);

    const report: DailyReconReport = {
      reportDate,
      generatedAt: now,
      pools: poolSummaries,
      global,
      incidentIds: [],
    };

    // ── Persist per-pool + global reports ───────────────────────────────────
    const artifacts = await this.persistReport(report);

    this.logger.log(
      `[recon_report] done — pools=${poolSummaries.length} ` +
        `totalLoans=${global.activeLoans} ` +
        `artifacts=${artifacts.length}`,
    );

    return report;
  }

  /**
   * Return the archive artifact for a given report date + scope.
   * Used by tests and downstream services.
   */
  async getArchiveArtifact(
    reportDate: Date,
    scope: ReconReportScope,
    poolId?: string,
  ): Promise<ReportArchiveArtifact | null> {
    const row = await this.prisma.reconReport.findFirst({
      where: {
        reportDate: this.toDateOnly(reportDate),
        scope,
        poolId: poolId ?? null,
      },
      select: {
        id: true,
        reportDate: true,
        scope: true,
        poolId: true,
        checksumSha256: true,
        reportJson: true,
        incidents: { select: { id: true } },
      },
    });

    if (!row) return null;

    return {
      reportId: row.id,
      reportDate: row.reportDate.toISOString().slice(0, 10),
      scope: row.scope,
      poolId: row.poolId ?? undefined,
      checksumSha256: row.checksumSha256,
      reportJson: row.reportJson,
      incidentCount: row.incidents.length,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async buildPoolSummary(
    poolId: string,
    loans: Array<{
      id: string;
      partnerId: string;
      poolContract: string | null;
      principalUsdc: bigint;
      fiatTransfers: Array<{ amountKes: bigint; confirmedAt: Date | null }>;
      chainActions: Array<{ type: string; status: string }>;
      installmentSchedule: {
        installments: Array<{
          principalDue: bigint;
          principalPaid: bigint;
          interestDue: bigint;
          interestPaid: bigint;
          penaltyAccrued: bigint;
          daysPastDue: number;
          accrualStatus: AccrualStatus;
          status: InstallmentStatus;
          delinquentSince: Date | null;
        }>;
      } | null;
    }>,
    defaultList: DefaultEntry[],
  ): Promise<PoolReconSummary> {
    let totalPrincipal = 0n;
    let totalInterest = 0n;
    let totalPenalty = 0n;
    let totalFiat = 0n;
    let totalChain = 0n;
    const dist: DelinquencyDistribution = {
      bucket_0_5: 0,
      bucket_6_15: 0,
      bucket_16_30: 0,
      bucket_31_plus: 0,
    };

    for (const loan of loans) {
      const entries = loan.installmentSchedule?.installments ?? [];

      for (const e of entries) {
        if (
          e.status === InstallmentStatus.PAID ||
          e.status === InstallmentStatus.WAIVED
        )
          continue;

        totalPrincipal += e.principalDue - e.principalPaid;
        totalInterest += e.interestDue - e.interestPaid;
        totalPenalty += e.penaltyAccrued;

        // Delinquency bucket
        if (e.accrualStatus !== AccrualStatus.CURRENT) {
          const dpd = e.daysPastDue;
          if (dpd <= 5) dist.bucket_0_5++;
          else if (dpd <= 15) dist.bucket_6_15++;
          else if (dpd <= 30) dist.bucket_16_30++;
          else dist.bucket_31_plus++;
        }
      }

      // Fiat repayments (confirmed) — amountKes is the native transfer amount
      for (const ft of loan.fiatTransfers) {
        totalFiat += ft.amountKes;
      }

      // Chain repayments (MINED RECORD_REPAYMENT actions count as 1 unit each;
      // we use principalUsdc as proxy since chain amounts aren't stored separately)
      totalChain += BigInt(loan.chainActions.length) * loan.principalUsdc;
    }

    const poolDefaults = defaultList.filter((d) =>
      loans.some((l) => l.id === d.loanId),
    );

    return {
      poolId,
      activeLoans: loans.length,
      totalPrincipalUsdc: totalPrincipal > 0n ? totalPrincipal : 0n,
      totalInterestUsdc: totalInterest > 0n ? totalInterest : 0n,
      totalPenaltyUsdc: totalPenalty,
      totalRepaymentsFiat: totalFiat,
      totalRepaymentsChain: totalChain,
      delinquencyDistribution: dist,
      defaults: poolDefaults,
    };
  }

  private rollupGlobal(
    pools: PoolReconSummary[],
    defaultList: DefaultEntry[],
  ): Omit<PoolReconSummary, "poolId"> {
    const dist: DelinquencyDistribution = {
      bucket_0_5: 0,
      bucket_6_15: 0,
      bucket_16_30: 0,
      bucket_31_plus: 0,
    };

    let activeLoans = 0;
    let totalPrincipal = 0n;
    let totalInterest = 0n;
    let totalPenalty = 0n;
    let totalFiat = 0n;
    let totalChain = 0n;

    for (const p of pools) {
      activeLoans += p.activeLoans;
      totalPrincipal += p.totalPrincipalUsdc;
      totalInterest += p.totalInterestUsdc;
      totalPenalty += p.totalPenaltyUsdc;
      totalFiat += p.totalRepaymentsFiat;
      totalChain += p.totalRepaymentsChain;
      dist.bucket_0_5 += p.delinquencyDistribution.bucket_0_5;
      dist.bucket_6_15 += p.delinquencyDistribution.bucket_6_15;
      dist.bucket_16_30 += p.delinquencyDistribution.bucket_16_30;
      dist.bucket_31_plus += p.delinquencyDistribution.bucket_31_plus;
    }

    return {
      activeLoans,
      totalPrincipalUsdc: totalPrincipal,
      totalInterestUsdc: totalInterest,
      totalPenaltyUsdc: totalPenalty,
      totalRepaymentsFiat: totalFiat,
      totalRepaymentsChain: totalChain,
      delinquencyDistribution: dist,
      defaults: defaultList,
    };
  }

  private async persistReport(
    report: DailyReconReport,
  ): Promise<ReportArchiveArtifact[]> {
    const artifacts: ReportArchiveArtifact[] = [];

    // Persist per-pool reports
    for (const pool of report.pools) {
      const artifact = await this.upsertReconReport({
        reportDate: report.reportDate,
        scope: ReconReportScope.POOL,
        poolId: pool.poolId === "__no_pool__" ? undefined : pool.poolId,
        summary: pool,
      });
      artifacts.push(artifact);
    }

    // Persist global report
    const globalArtifact = await this.upsertReconReport({
      reportDate: report.reportDate,
      scope: ReconReportScope.GLOBAL,
      poolId: undefined,
      summary: { ...report.global, poolId: "global" },
    });
    artifacts.push(globalArtifact);

    return artifacts;
  }

  private async upsertReconReport(params: {
    reportDate: Date;
    scope: ReconReportScope;
    poolId: string | undefined;
    summary: PoolReconSummary;
  }): Promise<ReportArchiveArtifact> {
    const { reportDate, scope, poolId, summary } = params;

    // Serialize with bigints as strings for JSON safety
    const reportJson = JSON.stringify(summary, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    const checksumSha256 = createHash("sha256").update(reportJson).digest("hex");

    const row = await this.prisma.reconReport.upsert({
      where: {
        reportDate_scope_poolId: {
          reportDate,
          scope,
          poolId: poolId ?? null as any,
        },
      },
      create: {
        reportDate,
        scope,
        poolId: poolId ?? null,
        totalActiveLoans: summary.activeLoans,
        totalPrincipalUsdc: summary.totalPrincipalUsdc,
        totalInterestUsdc: summary.totalInterestUsdc,
        totalPenaltyUsdc: summary.totalPenaltyUsdc,
        totalRepaymentsFiat: summary.totalRepaymentsFiat,
        totalRepaymentsChain: summary.totalRepaymentsChain,
        delinquencyDistribution: summary.delinquencyDistribution as any,
        defaultList: summary.defaults as any,
        checksumSha256,
        reportJson,
      },
      update: {
        totalActiveLoans: summary.activeLoans,
        totalPrincipalUsdc: summary.totalPrincipalUsdc,
        totalInterestUsdc: summary.totalInterestUsdc,
        totalPenaltyUsdc: summary.totalPenaltyUsdc,
        totalRepaymentsFiat: summary.totalRepaymentsFiat,
        totalRepaymentsChain: summary.totalRepaymentsChain,
        delinquencyDistribution: summary.delinquencyDistribution as any,
        defaultList: summary.defaults as any,
        checksumSha256,
        reportJson,
      },
    });

    return {
      reportId: row.id,
      reportDate: row.reportDate.toISOString().slice(0, 10),
      scope: row.scope,
      poolId: row.poolId ?? undefined,
      checksumSha256: row.checksumSha256,
      reportJson: row.reportJson,
      incidentCount: 0, // incidents linked after creation
    };
  }

  /** Truncate a Date to midnight UTC (date-only). */
  toDateOnly(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }
}
