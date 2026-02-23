import { Injectable, Logger } from "@nestjs/common";
import { AccrualStatus, InstallmentStatus, LoanStatus } from "@prisma/client";
import { PrismaService } from "../prisma";
import { CircuitBreakerService } from "../circuit-breaker/circuit-breaker.service";
import {
  BorrowerExposure,
  PartnerInstallmentMetrics,
} from "./installment.types";
import { DelinquencyClassifier } from "./installment-delinquency-classifier";

/**
 * InstallmentBreakerFeedService
 *
 * Computes partner-level delinquency (14D) and default (30D) rates from
 * installment data and feeds them into the circuit breaker engine.
 *
 * This supplements the existing loan-status-based metrics in
 * CircuitBreakerMetricsService with installment-granular signals.
 */
@Injectable()
export class InstallmentBreakerFeedService {
  private readonly logger = new Logger(InstallmentBreakerFeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  // ── Metrics computation ────────────────────────────────────────────────────

  /**
   * Compute per-partner installment delinquency (14D) and default (30D) rates.
   * Returns a map of partnerId → metrics.
   */
  async computePartnerMetrics(): Promise<Map<string, PartnerInstallmentMetrics>> {
    const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const activeLoans = await this.prisma.loan.findMany({
      where: { status: LoanStatus.ACTIVE },
      select: {
        id: true,
        partnerId: true,
        borrowerWallet: true,
        principalUsdc: true,
        installmentSchedule: {
          select: {
            installments: {
              where: {
                status: {
                  in: [
                    InstallmentStatus.DELINQUENT,
                    InstallmentStatus.DEFAULTED,
                  ],
                },
              },
              select: {
                status: true,
                accrualStatus: true,
                delinquentSince: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    const byPartner = new Map<
      string,
      {
        activeLoans: number;
        delinquentLoans14d: Set<string>;
        defaultedLoans30d: Set<string>;
        borrowerMap: Map<string, { outstanding: bigint; loanCount: number; worstStatus: AccrualStatus }>;
      }
    >();

    for (const loan of activeLoans) {
      const entry = byPartner.get(loan.partnerId) ?? {
        activeLoans: 0,
        delinquentLoans14d: new Set<string>(),
        defaultedLoans30d: new Set<string>(),
        borrowerMap: new Map<string, { outstanding: bigint; loanCount: number; worstStatus: AccrualStatus }>(),
      };
      entry.activeLoans++;

      const installments = (loan.installmentSchedule as any)?.installments ?? [];
      let loanWorstStatus: string = AccrualStatus.CURRENT;

      for (const inst of installments) {
        const since = inst.delinquentSince ?? inst.updatedAt;
        if (inst.status === InstallmentStatus.DELINQUENT && since >= since14d) {
          entry.delinquentLoans14d.add(loan.id);
        }
        if (inst.status === InstallmentStatus.DEFAULTED && since >= since30d) {
          entry.defaultedLoans30d.add(loan.id);
        }
        if (inst.accrualStatus) {
          loanWorstStatus = DelinquencyClassifier.worst([loanWorstStatus, inst.accrualStatus]);
        }
      }

      // Accumulate borrower exposure
      const bw = (loan as any).borrowerWallet as string;
      const existing = entry.borrowerMap.get(bw) ?? { outstanding: 0n, loanCount: 0, worstStatus: AccrualStatus.CURRENT };
      existing.outstanding += BigInt((loan as any).principalUsdc ?? 0);
      existing.loanCount++;
      existing.worstStatus = DelinquencyClassifier.worst([existing.worstStatus, loanWorstStatus]);
      entry.borrowerMap.set(bw, existing);

      byPartner.set(loan.partnerId, entry);
    }

    const result = new Map<string, PartnerInstallmentMetrics>();

    for (const [partnerId, data] of byPartner) {
      const delinquencyRate14d =
        data.activeLoans > 0
          ? data.delinquentLoans14d.size / data.activeLoans
          : 0;
      const defaultRate30d =
        data.activeLoans > 0
          ? data.defaultedLoans30d.size / data.activeLoans
          : 0;

      const exposureByBorrower: BorrowerExposure[] = Array.from(
        data.borrowerMap.entries(),
      ).map(([borrowerWallet, exp]) => ({
        borrowerWallet,
        partnerId,
        totalOutstandingUsdc: exp.outstanding,
        loanCount: exp.loanCount,
        worstAccrualStatus: exp.worstStatus,
      }));

      const metrics: PartnerInstallmentMetrics = {
        partnerId,
        delinquencyRate14d,
        defaultRate30d,
        activeLoans: data.activeLoans,
        delinquentLoans14d: data.delinquentLoans14d.size,
        defaultedLoans30d: data.defaultedLoans30d.size,
        exposureByBorrower,
      };

      result.set(partnerId, metrics);

      this.logger.debug(
        `[installment_metrics] partner=${partnerId} ` +
          `delinquency14d=${delinquencyRate14d.toFixed(4)} ` +
          `default30d=${defaultRate30d.toFixed(4)} ` +
          `activeLoans=${data.activeLoans}`,
      );
    }

    return result;
  }

  // ── Breaker feed ───────────────────────────────────────────────────────────

  /**
   * Compute metrics and feed them into the circuit breaker.
   * Fires PARTNER_DELINQUENCY_14D and/or PARTNER_DEFAULT_RATE_30D incidents
   * when thresholds are exceeded.
   *
   * Returns the list of partners for which a breaker was triggered.
   */
  async feedBreaker(): Promise<string[]> {
    const metricsMap = await this.computePartnerMetrics();
    const triggered: string[] = [];

    for (const [partnerId, metrics] of metricsMap) {
      const [delinquencyIncident, defaultIncident] = await Promise.all([
        this.breaker.evaluateDelinquencySpike(
          partnerId,
          metrics.delinquencyRate14d,
        ),
        this.breaker.evaluatePartnerDefaultSpike(
          partnerId,
          metrics.defaultRate30d,
        ),
      ]);

      if (delinquencyIncident || defaultIncident) {
        triggered.push(partnerId);
        this.logger.warn(
          `[installment_breaker_feed] partner=${partnerId} ` +
            `delinquency14d=${metrics.delinquencyRate14d.toFixed(4)} ` +
            `default30d=${metrics.defaultRate30d.toFixed(4)} ` +
            `delinquencyFired=${!!delinquencyIncident} ` +
            `defaultFired=${!!defaultIncident}`,
        );
      }
    }

    this.logger.log(
      `[installment_breaker_feed] evaluated ${metricsMap.size} partners, ` +
        `triggered=${triggered.length}`,
    );

    return triggered;
  }
}
