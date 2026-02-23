import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ChainActionStatus, FiatTransferStatus } from "@prisma/client";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { OpsService } from "./ops.service";

const CHAIN_ACTION_STATUSES = new Set<string>(Object.values(ChainActionStatus));
const FIAT_TRANSFER_STATUSES = new Set<string>(Object.values(FiatTransferStatus));

@UseGuards(ApiKeyGuard)
@Controller("admin/ops")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get("chain-actions")
  async chainActions(
    @Query("status") status?: string,
    @Query("min_age_minutes") minAgeMinutes?: string,
    @Query("limit") limit?: string,
  ) {
    let parsedStatus: ChainActionStatus | undefined;
    if (status !== undefined) {
      if (!CHAIN_ACTION_STATUSES.has(status)) {
        throw new BadRequestException(
          `Invalid status. Valid values: ${[...CHAIN_ACTION_STATUSES].join(", ")}`,
        );
      }
      parsedStatus = status as ChainActionStatus;
    }

    return this.ops.getChainActionsQueueView({
      status: parsedStatus,
      minAgeMinutes: minAgeMinutes ? Number(minAgeMinutes) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get("fiat-transfers")
  async fiatTransfers(
    @Query("status") status?: string,
    @Query("provider") provider?: string,
    @Query("limit") limit?: string,
  ) {
    let parsedStatus: FiatTransferStatus | undefined;
    if (status !== undefined) {
      if (!FIAT_TRANSFER_STATUSES.has(status)) {
        throw new BadRequestException(
          `Invalid status. Valid values: ${[...FIAT_TRANSFER_STATUSES].join(", ")}`,
        );
      }
      parsedStatus = status as FiatTransferStatus;
    }

    return this.ops.getFiatTransfersView({
      status: parsedStatus,
      provider,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get("loans/:loanId/timeline")
  async loanTimeline(@Param("loanId", ParseUUIDPipe) loanId: string) {
    return this.ops.getLoanLifecycleTimeline(loanId);
  }

  @Get("reconciliation")
  async reconciliation() {
    return this.ops.runDailyReconciliation();
  }

  @Get("alerts")
  async alerts(
    @Query("stuck_tx_minutes") stuckTxMinutes?: string,
    @Query("webhook_lookback_minutes") webhookLookbackMinutes?: string,
    @Query("webhook_failure_threshold") webhookFailureThreshold?: string,
    @Query("mismatch_threshold") mismatchThreshold?: string,
  ) {
    return this.ops.getAlerts({
      stuckTxMinutes: stuckTxMinutes ? Number(stuckTxMinutes) : undefined,
      webhookLookbackMinutes: webhookLookbackMinutes
        ? Number(webhookLookbackMinutes)
        : undefined,
      webhookFailureThreshold: webhookFailureThreshold
        ? Number(webhookFailureThreshold)
        : undefined,
      mismatchThreshold: mismatchThreshold
        ? Number(mismatchThreshold)
        : undefined,
    });
  }

  @Post("chain-actions/:id/requeue")
  async requeueChainAction(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("min_stuck_minutes") minStuckMinutes?: string,
  ) {
    const action = await this.ops.requeueChainActionSafely(
      id,
      minStuckMinutes ? Number(minStuckMinutes) : 15,
    );
    return {
      id: action.id,
      status: action.status,
      attempts: action.attempts,
      nextRetryAt: action.nextRetryAt,
      updatedAt: action.updatedAt,
      error: action.error,
    };
  }

  @Get("dlq")
  async dlqActions(@Query("limit") limit?: string) {
    return this.ops.getDlqActions(limit ? Number(limit) : 100);
  }

  /**
   * Admin replay: move a DLQ action back to QUEUED.
   * Requires x-admin-subject header for audit trail.
   */
  @Post("chain-actions/:id/replay")
  async replayDlqAction(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("x-admin-subject") adminSubject: string,
  ) {
    if (!adminSubject?.trim()) {
      throw new BadRequestException("x-admin-subject header is required for DLQ replay");
    }
    const action = await this.ops.replayDlqAction(id, adminSubject.trim());
    return {
      id: action.id,
      status: action.status,
      attempts: action.attempts,
      nextRetryAt: action.nextRetryAt,
      error: action.error,
      updatedAt: action.updatedAt,
    };
  }

  @Get("metrics")
  getMetrics() {
    return this.ops.getMetrics();
  }
}
