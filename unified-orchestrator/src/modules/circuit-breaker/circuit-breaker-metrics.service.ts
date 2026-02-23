import { Injectable, Logger } from "@nestjs/common";
import {
  FiatTransferDirection,
  FiatTransferStatus,
  LoanStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma";

/**
 * CircuitBreakerMetricsService
 *
 * Computes the raw metric values for each trigger.
 * All methods are pure reads — no side effects.
 *
 * Fail-safe: any DB error propagates up so the caller can decide
 * whether to fail-open or fail-closed. The engine always fails-closed.
 */
@Injectable()
export class CircuitBreakerMetricsService {
  private readonly logger = new Logger(CircuitBreakerMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Settlement integrity ───────────────────────────────────────────────────

  /** Count of ACTIVE loans with no confirmed outbound fiat disbursement. */
  async activeWithoutDisbursementProof(): Promise<number> {
    const count = await this.prisma.loan.count({
      where: {
        status: LoanStatus.ACTIVE,
        NOT: {
          fiatTransfers: {
            some: {
              direction: FiatTransferDirection.OUTBOUND,
              status: {
                in: [
                  FiatTransferStatus.CONFIRMED,
                  FiatTransferStatus.APPLIED_ONCHAIN,
                  FiatTransferStatus.PAYOUT_CONFIRMED,
                  FiatTransferStatus.CHAIN_RECORD_PENDING,
                  FiatTransferStatus.CHAIN_RECORDED,
                  FiatTransferStatus.ACTIVATED,
                ],
              },
            },
          },
        },
      },
    });
    this.logger.debug(`[metric] activeWithoutDisbursementProof=${count}`);
    return count;
  }

  /** Count of OUTBOUND fiat transfers confirmed but with no on-chain record. */
  async fiatConfirmedNoChainRecord(): Promise<number> {
    const rows = await this.prisma.fiatTransfer.findMany({
      where: {
        direction: FiatTransferDirection.OUTBOUND,
        status: {
          in: [
            FiatTransferStatus.CONFIRMED,
            FiatTransferStatus.PAYOUT_CONFIRMED,
          ],
        },
      },
      select: {
        chainActionId: true,
        chainAction: { select: { txHash: true } },
      },
    });

    const count = rows.filter((r) => !r.chainAction?.txHash).length;
    this.logger.debug(`[metric] fiatConfirmedNoChainRecord=${count}`);
    return count;
  }

  // ── Credit triggers ────────────────────────────────────────────────────────

  /**
   * Partner 30-day default rate = defaulted / (active + repaid + defaulted)
   * within the last 30 days.
   * Returns a map of partnerId → rate (0..1).
   */
  async partnerDefaultRate30D(): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.loan.groupBy({
      by: ["partnerId", "status"],
      where: {
        updatedAt: { gte: since },
        status: {
          in: [LoanStatus.ACTIVE, LoanStatus.REPAID, LoanStatus.DEFAULTED],
        },
      },
      _count: { id: true },
    });

    const byPartner = new Map<string, { defaulted: number; total: number }>();
    for (const row of rows) {
      const entry = byPartner.get(row.partnerId) ?? { defaulted: 0, total: 0 };
      entry.total += row._count.id;
      if (row.status === LoanStatus.DEFAULTED) {
        entry.defaulted += row._count.id;
      }
      byPartner.set(row.partnerId, entry);
    }

    const result = new Map<string, number>();
    for (const [partnerId, { defaulted, total }] of byPartner) {
      const rate = total > 0 ? defaulted / total : 0;
      result.set(partnerId, rate);
      this.logger.debug(
        `[metric] partnerDefaultRate30D partnerId=${partnerId} rate=${rate.toFixed(4)}`,
      );
    }
    return result;
  }

  /**
   * Partner 14-day delinquency rate = loans past due / active loans
   * within the last 14 days.
   * "Past due" = DEFAULTED within 14 days.
   * Returns a map of partnerId → rate (0..1).
   */
  async partnerDelinquency14D(): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [delinquent, active] = await Promise.all([
      this.prisma.loan.groupBy({
        by: ["partnerId"],
        where: {
          status: LoanStatus.DEFAULTED,
          updatedAt: { gte: since },
        },
        _count: { id: true },
      }),
      this.prisma.loan.groupBy({
        by: ["partnerId"],
        where: {
          status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
          createdAt: { gte: since },
        },
        _count: { id: true },
      }),
    ]);

    const delinquentMap = new Map(
      delinquent.map((r) => [r.partnerId, r._count.id]),
    );
    const result = new Map<string, number>();

    for (const row of active) {
      const d = delinquentMap.get(row.partnerId) ?? 0;
      const rate = row._count.id > 0 ? d / row._count.id : 0;
      result.set(row.partnerId, rate);
      this.logger.debug(
        `[metric] partnerDelinquency14D partnerId=${row.partnerId} rate=${rate.toFixed(4)}`,
      );
    }
    return result;
  }

  // ── Liquidity triggers ─────────────────────────────────────────────────────

  /**
   * Pool liquidity ratio = available_usdc / total_pool_usdc.
   * v1.1: computed from loan book — (pool capacity - outstanding) / pool capacity.
   * Returns a map of poolContract → ratio (0..1).
   */
  async poolLiquidityRatio(): Promise<Map<string, number>> {
    const pools = await this.prisma.partnerPool.findMany({
      include: {
        partner: {
          select: { maxLoanSizeUsdc: true },
          include: {
            loans: {
              where: {
                status: { in: [LoanStatus.FUNDING, LoanStatus.ACTIVE] },
              },
              select: { principalUsdc: true },
            },
          } as any,
        },
      },
    });

    const result = new Map<string, number>();
    for (const pool of pools) {
      const partner = pool.partner as any;
      const capacity = Number(partner.maxLoanSizeUsdc ?? 0n);
      if (capacity === 0) {
        result.set(pool.poolContract, 1.0);
        continue;
      }
      const outstanding = (partner.loans as any[]).reduce(
        (sum: number, l: any) => sum + Number(l.principalUsdc ?? 0n),
        0,
      );
      const ratio = Math.max(0, (capacity - outstanding) / capacity);
      result.set(pool.poolContract, ratio);
      this.logger.debug(
        `[metric] poolLiquidityRatio pool=${pool.poolContract} ratio=${ratio.toFixed(4)}`,
      );
    }
    return result;
  }

  /**
   * Pool NAV 7-day drawdown = (NAV_7d_ago - NAV_now) / NAV_7d_ago.
   * v1.1: approximated from loan book changes (new defaults in 7 days / total).
   * Returns a map of poolContract → drawdown (0..1).
   */
  async poolNavDrawdown7D(): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const pools = await this.prisma.partnerPool.findMany({
      include: {
        partner: {
          select: { id: true },
        },
      },
    });

    const result = new Map<string, number>();

    for (const pool of pools) {
      const [totalActive, recentDefaults] = await Promise.all([
        this.prisma.loan.aggregate({
          where: {
            partnerId: pool.partnerId,
            status: { in: [LoanStatus.ACTIVE, LoanStatus.DEFAULTED] },
          },
          _sum: { principalUsdc: true },
        }),
        this.prisma.loan.aggregate({
          where: {
            partnerId: pool.partnerId,
            status: LoanStatus.DEFAULTED,
            updatedAt: { gte: since },
          },
          _sum: { principalUsdc: true },
        }),
      ]);

      const nav = Number(totalActive._sum.principalUsdc ?? 0n);
      const lost = Number(recentDefaults._sum.principalUsdc ?? 0n);
      const drawdown = nav > 0 ? lost / nav : 0;
      result.set(pool.poolContract, drawdown);
      this.logger.debug(
        `[metric] poolNavDrawdown7D pool=${pool.poolContract} drawdown=${drawdown.toFixed(4)}`,
      );
    }
    return result;
  }
}
