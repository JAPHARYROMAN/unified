import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma";
import { ChainActionType, ChainActionStatus, Prisma } from "@prisma/client";
import type { ChainReceipt } from "./chain-sender.types";
import { classifyTxError, isNonceConflict } from "./tx-retry-classifier";

const MAX_RETRIES = 5;
/** Maximum number of RBF bumps before marking the action permanently FAILED. */
export const MAX_BUMP_COUNT = 3;

/**
 * Gas ceilings (in gas units) per action type.
 * Abort submission if estimated gas exceeds these values.
 * Configurable via GAS_CEILING_* env vars; these are safe defaults.
 */
export const GAS_CEILINGS: Partial<Record<ChainActionType, bigint>> = {
  CREATE_LOAN:          3_000_000n,
  FUND_LOAN:            1_000_000n,
  ACTIVATE_LOAN:        1_500_000n,
  RECORD_DISBURSEMENT:    500_000n,
  REPAY:                1_000_000n,
  RECORD_REPAYMENT:       500_000n,
};

@Injectable()
export class ChainActionService {
  private readonly logger = new Logger(ChainActionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Enqueue ──────────────────────────────────────────────────────────────

  /**
   * Enqueue a new chain action.
   *
   * Provide an `actionKey` (e.g. `${loanId}:${type}`) to make the enqueue
   * idempotent — a duplicate key will throw a unique-constraint violation
   * before creating a second record for the same logical operation.
   */
  async enqueue(
    loanId: string,
    type: ChainActionType,
    payload: Record<string, unknown>,
    actionKey?: string,
  ) {
    const action = await this.prisma.chainAction.create({
      data: {
        loanId,
        type,
        status: ChainActionStatus.QUEUED,
        payload: payload as Prisma.InputJsonValue,
        ...(actionKey ? { actionKey } : {}),
      },
    });
    this.logger.log(`Chain action ${action.id} queued (${type})`);
    return action;
  }

  // ── Queue reads ──────────────────────────────────────────────────────────

  async findQueued(limit = 10) {
    return this.prisma.chainAction.findMany({
      where: {
        status: ChainActionStatus.QUEUED,
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { loan: true },
    });
  }

  /** Find actions in SENT status, ordered by sentAt ascending (oldest first). */
  async findSent(limit = 50) {
    return this.prisma.chainAction.findMany({
      where: { status: ChainActionStatus.SENT },
      orderBy: { sentAt: "asc" },
      take: limit,
      include: { loan: true },
    });
  }

  /**
   * Find SENT actions that have been pending longer than `pendingSinceMs`
   * and have not yet hit the bump limit.
   */
  async findStuck(pendingSinceMs: number, limit = 20) {
    const threshold = new Date(Date.now() - pendingSinceMs);
    return this.prisma.chainAction.findMany({
      where: {
        status: ChainActionStatus.SENT,
        sentAt: { lte: threshold },
        bumpCount: { lt: MAX_BUMP_COUNT },
      },
      orderBy: { sentAt: "asc" },
      take: limit,
      include: { loan: true },
    });
  }

  async countByStatus(status: ChainActionStatus): Promise<number> {
    return this.prisma.chainAction.count({ where: { status } });
  }

  // ── Status transitions ───────────────────────────────────────────────────

  async markProcessing(id: string) {
    return this.prisma.chainAction.update({
      where: { id },
      data: { status: ChainActionStatus.PROCESSING },
    });
  }

  /** Record the submitted txHash and the on-chain nonce used. */
  async markSent(id: string, txHash: string, nonce: number) {
    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: ChainActionStatus.SENT,
        txHash,
        nonce,
        sentAt: new Date(),
      },
    });
  }

  /**
   * Record receipt data from a mined (or reverted) transaction.
   * Reverted transactions are stored as FAILED with a revert reason.
   */
  async markMined(id: string, receipt: ChainReceipt) {
    const terminalStatus =
      receipt.status === "success"
        ? ChainActionStatus.MINED
        : ChainActionStatus.FAILED;

    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: terminalStatus,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        revertReason: receipt.revertReason ?? null,
        minedAt: new Date(),
        ...(receipt.status === "reverted"
          ? { error: receipt.revertReason ?? "tx reverted on-chain" }
          : {}),
      },
    });
  }

  /**
   * Mark an action as RETRYING while a new bumped tx is being prepared.
   * Use `markSentAfterRetry` to move it back to SENT once the new txHash
   * has been obtained.
   */
  async markRetrying(id: string, newTxHash: string, bumpCount: number) {
    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: ChainActionStatus.RETRYING,
        txHash: newTxHash,
        bumpCount,
      },
    });
  }

  /** Move a RETRYING action back to SENT after bump is confirmed submitted. */
  async markSentAfterRetry(id: string) {
    return this.prisma.chainAction.update({
      where: { id },
      data: { status: ChainActionStatus.SENT, sentAt: new Date() },
    });
  }

  /**
   * Classify error and either schedule a retry (transient) or move to DLQ
   * (logical revert / unrecoverable).
   *
   * Retry policy:
   *   - nonce too low / replacement underpriced / timeout → RETRY with backoff
   *   - execution reverted / out of gas / unknown → DLQ immediately
   *   - exceeded MAX_RETRIES → DLQ
   */
  async markFailed(id: string, error: string) {
    const decision = classifyTxError(error);

    if (decision === "DLQ") {
      this.logger.warn(`[tx_failed] action=${id} decision=DLQ reason="${error}"`);
      return this.markDlq(id, error);
    }

    // RETRY path — atomically increment attempts
    const updated = await this.prisma.chainAction.update({
      where: { id },
      data: { attempts: { increment: 1 }, error },
      select: { attempts: true },
    });

    if (updated.attempts >= MAX_RETRIES) {
      this.logger.warn(
        `[tx_failed] action=${id} max_retries=${MAX_RETRIES} reached — moving to DLQ`,
      );
      return this.markDlq(id, `max retries exceeded: ${error}`);
    }

    // Exponential backoff: 2^attempts * 1000 ms
    const backoffMs = Math.pow(2, updated.attempts) * 1000;
    const nextRetryAt = new Date(Date.now() + backoffMs);

    this.logger.log(
      `[tx_failed] action=${id} decision=RETRY backoff=${backoffMs}ms attempt=${updated.attempts}/${MAX_RETRIES}`,
    );

    return this.prisma.chainAction.update({
      where: { id },
      data: { status: ChainActionStatus.QUEUED, nextRetryAt },
    });
  }

  /** Move an action to DLQ — no further automatic processing. */
  async markDlq(id: string, reason: string) {
    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: ChainActionStatus.DLQ,
        error: reason,
        dlqAt: new Date(),
      },
    });
  }

  /** Replay a DLQ action — admin only. Resets to QUEUED with cleared error. */
  async replayFromDlq(id: string, adminSubject: string) {
    const action = await this.prisma.chainAction.findUnique({ where: { id } });
    if (!action) throw new Error(`Chain action ${id} not found`);
    if (action.status !== ChainActionStatus.DLQ) {
      throw new Error(`Action ${id} is not in DLQ (status=${action.status})`);
    }

    this.logger.warn(
      `[dlq_replay] action=${id} replayed by admin=${adminSubject}`,
    );

    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: ChainActionStatus.QUEUED,
        attempts: 0,
        nextRetryAt: new Date(),
        dlqAt: null,
        error: `replayed by ${adminSubject} at ${new Date().toISOString()}`,
      },
    });
  }

  /** Find DLQ actions for admin review. */
  async findDlq(limit = 100) {
    return this.prisma.chainAction.findMany({
      where: { status: ChainActionStatus.DLQ },
      orderBy: { dlqAt: "desc" },
      take: limit,
      include: { loan: true },
    });
  }

  /**
   * Find MINED actions that have not yet reached the required confirmation count.
   * Used by the confirmation polling loop.
   */
  async findConfirming(limit = 50) {
    return this.prisma.chainAction.findMany({
      where: {
        status: ChainActionStatus.MINED,
        confirmationsReceived: { lt: this.prisma.chainAction.fields.confirmationsRequired as any },
      },
      orderBy: { minedAt: "asc" },
      take: limit,
      include: { loan: true },
    });
  }

  /** Update confirmation count on a MINED action. */
  async updateConfirmations(id: string, confirmationsReceived: number) {
    return this.prisma.chainAction.update({
      where: { id },
      data: { confirmationsReceived },
    });
  }

  /**
   * Check if an action has gas that exceeds the configured ceiling.
   * Returns the ceiling if exceeded, null otherwise.
   */
  checkGasCeiling(type: ChainActionType, estimatedGas: bigint): bigint | null {
    const ceiling = GAS_CEILINGS[type];
    if (ceiling !== undefined && estimatedGas > ceiling) return ceiling;
    return null;
  }

  /** Expose isNonceConflict for worker use. */
  isNonceConflict(error: string): boolean {
    return isNonceConflict(error);
  }

  // ── Recovery & admin ─────────────────────────────────────────────────────

  /**
   * On worker startup: reset any PROCESSING actions that were left orphaned
   * by a previous process crash. They re-enter the QUEUED state immediately.
   */
  async resetStuckProcessing() {
    const result = await this.prisma.chainAction.updateMany({
      where: { status: ChainActionStatus.PROCESSING },
      data: {
        status: ChainActionStatus.QUEUED,
        nextRetryAt: new Date(),
        error: "reset: worker crash during PROCESSING",
      },
    });
    return result; // { count: number }
  }

  /**
   * Idempotent requeue for admin use.
   * - Safe to call multiple times.
   * - Refuses to requeue MINED actions.
   * - Refuses to requeue SENT actions that already have a txHash (the tx
   *   may still mine — use ops.requeueChainActionSafely() for those).
   */
  async requeueAction(id: string) {
    const action = await this.prisma.chainAction.findUnique({ where: { id } });
    if (!action) throw new Error(`Chain action ${id} not found`);

    if (action.status === ChainActionStatus.MINED) {
      throw new Error("Cannot requeue a MINED action");
    }
    if (
      action.status === ChainActionStatus.SENT &&
      action.txHash
    ) {
      throw new Error(
        "Cannot requeue a SENT action with a txHash — the tx may still mine. " +
          "Use the ops /admin/ops/chain-actions/:id/requeue endpoint instead.",
      );
    }

    return this.prisma.chainAction.update({
      where: { id },
      data: {
        status: ChainActionStatus.QUEUED,
        nextRetryAt: new Date(),
        error: action.error ? `${action.error} | requeued` : "requeued",
      },
    });
  }
}
