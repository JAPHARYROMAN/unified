import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  ChainActionStatus,
  FiatTransferDirection,
  FiatTransferStatus,
  LoanStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma";
import { ChainActionService } from "../chain-action/chain-action.service";
import { TxMetricsService } from "../chain-action/tx-metrics.service";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chainActions: ChainActionService,
    private readonly metrics: TxMetricsService,
  ) {}

  private normalizeLimit(limit?: number) {
    if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
    return Math.max(1, Math.min(limit, MAX_LIMIT));
  }

  private normalizeNonNegative(value: number | undefined, fallback: number) {
    if (value === undefined || value === null || Number.isNaN(value)) {
      return fallback;
    }
    return Math.max(0, value);
  }

  async getChainActionsQueueView(params: {
    status?: ChainActionStatus;
    minAgeMinutes?: number;
    limit?: number;
  }) {
    const limit = this.normalizeLimit(params.limit);
    const minAgeMinutes = this.normalizeNonNegative(params.minAgeMinutes, 0);
    const cutoff = new Date(Date.now() - minAgeMinutes * 60_000);

    const where: any = {
      createdAt: { lte: cutoff },
    };

    if (params.status) {
      where.status = params.status;
    }

    const rows = await this.prisma.chainAction.findMany({
      where,
      orderBy: { createdAt: "asc" },
      take: limit,
      include: {
        loan: {
          select: {
            id: true,
            status: true,
            partnerId: true,
            borrowerWallet: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      ...row,
      ageMinutes: Math.floor((Date.now() - row.createdAt.getTime()) / 60_000),
    }));
  }

  async getFiatTransfersView(params: {
    status?: FiatTransferStatus;
    provider?: string;
    limit?: number;
  }) {
    const limit = this.normalizeLimit(params.limit);

    const where: any = {};
    if (params.status) where.status = params.status;
    if (params.provider) where.provider = params.provider;

    const rows = await this.prisma.fiatTransfer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        loan: {
          select: {
            id: true,
            status: true,
            partnerId: true,
            borrowerWallet: true,
          },
        },
        chainAction: {
          select: {
            id: true,
            status: true,
            txHash: true,
            type: true,
          },
        },
      },
    });

    return rows;
  }

  async getLoanLifecycleTimeline(loanId: string) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        chainActions: {
          orderBy: { createdAt: "asc" },
        },
        fiatTransfers: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!loan) throw new NotFoundException(`Loan ${loanId} not found`);

    const webhookDeadLetters = await this.prisma.webhookDeadLetter.findMany({
      where: {
        rawBody: {
          contains: loanId,
        },
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const timeline = [
      {
        at: loan.createdAt,
        source: "LOAN",
        event: "LOAN_CREATED",
        details: {
          loanId: loan.id,
          status: loan.status,
          principalUsdc: loan.principalUsdc.toString(),
        },
      },
      ...loan.chainActions.map((a) => ({
        at: a.updatedAt,
        source: "CHAIN_ACTION",
        event: `${a.type}_${a.status}`,
        details: {
          id: a.id,
          status: a.status,
          txHash: a.txHash,
          attempts: a.attempts,
          error: a.error,
        },
      })),
      ...loan.fiatTransfers.map((t) => ({
        at: t.updatedAt,
        source: "FIAT_TRANSFER",
        event: `${t.direction}_${t.status}`,
        details: {
          id: t.id,
          provider: t.provider,
          providerRef: t.providerRef,
          amountKes: t.amountKes.toString(),
          chainActionId: t.chainActionId,
          confirmedAt: t.confirmedAt,
          appliedOnchainAt: t.appliedOnchainAt,
          failureReason: t.failureReason,
        },
      })),
      ...webhookDeadLetters.map((w) => ({
        at: w.createdAt,
        source: "WEBHOOK",
        event: "WEBHOOK_FAILED",
        details: {
          id: w.id,
          source: w.source,
          eventType: w.eventType,
          failReason: w.failReason,
        },
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return {
      loan: {
        id: loan.id,
        partnerId: loan.partnerId,
        borrowerWallet: loan.borrowerWallet,
        status: loan.status,
        chainId: loan.chainId,
        poolContract: loan.poolContract,
        createdAt: loan.createdAt,
        updatedAt: loan.updatedAt,
      },
      timeline,
    };
  }

  async reportFiatConfirmedNoChainTx(limit = 500) {
    const rows = await this.prisma.fiatTransfer.findMany({
      where: {
        status: FiatTransferStatus.CONFIRMED,
      },
      take: this.normalizeLimit(limit),
      orderBy: { confirmedAt: "asc" },
      include: {
        loan: {
          select: {
            id: true,
            status: true,
            partnerId: true,
          },
        },
        chainAction: {
          select: {
            id: true,
            status: true,
            txHash: true,
            updatedAt: true,
          },
        },
      },
    });

    const mismatches = rows.filter((row) => !row.chainAction?.txHash);

    return {
      report: "FIAT_CONFIRMED_NO_CHAIN_TX",
      severity: "CRITICAL",
      count: mismatches.length,
      rows: mismatches,
    };
  }

  async reportChainActiveNoFiatDisbursementProof(limit = 500) {
    const rows = await this.prisma.loan.findMany({
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
                ],
              },
            },
          },
        },
      },
      include: {
        chainActions: {
          orderBy: { updatedAt: "desc" },
          take: 3,
        },
      },
      take: this.normalizeLimit(limit),
      orderBy: { updatedAt: "desc" },
    });

    return {
      report: "CHAIN_ACTIVE_NO_FIAT_DISBURSEMENT_PROOF",
      severity: "CRITICAL",
      count: rows.length,
      rows,
    };
  }

  async reportRepaymentReceivedNotAppliedOnchain(limit = 500) {
    const rows = await this.prisma.fiatTransfer.findMany({
      where: {
        direction: FiatTransferDirection.INBOUND,
        status: FiatTransferStatus.CONFIRMED,
        appliedOnchainAt: null,
      },
      include: {
        loan: {
          select: {
            id: true,
            status: true,
            partnerId: true,
          },
        },
        chainAction: {
          select: {
            id: true,
            status: true,
            txHash: true,
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
      take: this.normalizeLimit(limit),
    });

    return {
      report: "REPAYMENT_RECEIVED_NOT_APPLIED_ONCHAIN",
      severity: "CRITICAL",
      count: rows.length,
      rows,
    };
  }

  async runDailyReconciliation() {
    const [a, b, c] = await Promise.all([
      this.reportFiatConfirmedNoChainTx(),
      this.reportChainActiveNoFiatDisbursementProof(),
      this.reportRepaymentReceivedNotAppliedOnchain(),
    ]);

    const criticalCount = a.count + b.count + c.count;
    const summary = {
      ranAt: new Date(),
      criticalCount,
      reports: [a, b, c],
    };

    if (criticalCount > 0) {
      this.logger.error(
        `Daily reconciliation found ${criticalCount} critical mismatches`,
      );
    } else {
      this.logger.log("Daily reconciliation clean: 0 critical mismatches");
    }

    return summary;
  }

  async getAlerts(params?: {
    stuckTxMinutes?: number;
    webhookLookbackMinutes?: number;
    webhookFailureThreshold?: number;
    mismatchThreshold?: number;
  }) {
    const stuckTxMinutes = Math.max(
      1,
      this.normalizeNonNegative(params?.stuckTxMinutes, 15),
    );
    const webhookLookbackMinutes = Math.max(
      1,
      this.normalizeNonNegative(params?.webhookLookbackMinutes, 60),
    );
    const webhookFailureThreshold = Math.max(
      1,
      this.normalizeNonNegative(params?.webhookFailureThreshold, 1),
    );
    const mismatchThreshold = Math.max(
      1,
      this.normalizeNonNegative(params?.mismatchThreshold, 1),
    );

    const stuckCutoff = new Date(Date.now() - stuckTxMinutes * 60_000);
    const webhookCutoff = new Date(
      Date.now() - webhookLookbackMinutes * 60_000,
    );

    const [stuckActions, webhookFailures, signatureFailures, reconciliation] =
      await Promise.all([
        this.prisma.chainAction.findMany({
          where: {
            status: { in: [ChainActionStatus.PROCESSING, ChainActionStatus.SENT] },
            updatedAt: { lte: stuckCutoff },
          },
          orderBy: { updatedAt: "asc" },
          take: 200,
        }),
        this.prisma.webhookDeadLetter.count({
          where: {
            createdAt: { gte: webhookCutoff },
          },
        }),
        this.prisma.webhookDeadLetter.count({
          where: {
            createdAt: { gte: webhookCutoff },
            failReason: {
              contains: "signature",
              mode: "insensitive",
            },
          },
        }),
        this.runDailyReconciliation(),
      ]);

    const alerts: Array<Record<string, unknown>> = [];

    if (stuckActions.length > 0) {
      alerts.push({
        code: "STUCK_CHAIN_TX",
        severity: "HIGH",
        count: stuckActions.length,
        threshold: 0,
        oldestUpdatedAt: stuckActions[0].updatedAt,
        hint: "Inspect tx hash and worker logs; requeue only if tx hash is empty.",
      });
    }

    if (webhookFailures >= webhookFailureThreshold) {
      alerts.push({
        code: "WEBHOOK_FAILURES",
        severity: "HIGH",
        count: webhookFailures,
        threshold: webhookFailureThreshold,
        lookbackMinutes: webhookLookbackMinutes,
      });
    }

    if (signatureFailures > 0) {
      alerts.push({
        code: "WEBHOOK_SIGNATURE_FAILURES",
        severity: "CRITICAL",
        count: signatureFailures,
        threshold: 0,
        lookbackMinutes: webhookLookbackMinutes,
      });
    }

    if (reconciliation.criticalCount >= mismatchThreshold) {
      alerts.push({
        code: "RECONCILIATION_MISMATCH_THRESHOLD",
        severity: "CRITICAL",
        count: reconciliation.criticalCount,
        threshold: mismatchThreshold,
      });
    }

    return {
      generatedAt: new Date(),
      alerts,
      telemetry: {
        stuckActions: stuckActions.length,
        webhookFailures,
        signatureFailures,
        criticalMismatches: reconciliation.criticalCount,
      },
    };
  }

  // ── DLQ management ────────────────────────────────────────────────────────

  async getDlqActions(limit = 100) {
    return this.chainActions.findDlq(limit);
  }

  /**
   * Admin replay: move a DLQ action back to QUEUED.
   * Requires an adminSubject for audit trail.
   */
  async replayDlqAction(actionId: string, adminSubject: string) {
    return this.chainActions.replayFromDlq(actionId, adminSubject);
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  getMetrics() {
    return {
      generatedAt: new Date(),
      ...this.metrics.snapshot(),
    };
  }

  // ── Requeue ───────────────────────────────────────────────────────────────

  async requeueChainActionSafely(actionId: string, minStuckMinutes = 15) {
    const minStuck = Math.max(1, this.normalizeNonNegative(minStuckMinutes, 15));
    const action = await this.prisma.chainAction.findUnique({
      where: { id: actionId },
    });

    if (!action) {
      throw new NotFoundException(`Chain action ${actionId} not found`);
    }

    const isFailed = action.status === ChainActionStatus.FAILED;
    const isStuck =
      (action.status === ChainActionStatus.PROCESSING ||
        action.status === ChainActionStatus.SENT) &&
      action.updatedAt.getTime() <= Date.now() - minStuck * 60_000;

    if (!isFailed && !isStuck) {
      throw new BadRequestException(
        "Action is not eligible for safe requeue (must be FAILED or stuck)",
      );
    }

    if (action.status === ChainActionStatus.SENT && action.txHash) {
      throw new BadRequestException(
        "Cannot safely requeue SENT action with txHash; transaction may still mine",
      );
    }

    return this.prisma.chainAction.update({
      where: { id: actionId },
      data: {
        status: ChainActionStatus.QUEUED,
        nextRetryAt: new Date(),
        error: action.error
          ? `${action.error} | manually requeued`
          : "manually requeued",
      },
    });
  }
}
