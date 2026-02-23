import { Injectable, Logger } from "@nestjs/common";
import { ChainActionService } from "./chain-action.service";
import { LoanService } from "../loan/loan.service";
import { ChainActionType } from "@prisma/client";
import type { IChainSender } from "./chain-sender.types";
import { TxMetricsService } from "./tx-metrics.service";
import { SignerNonceService } from "./signer-nonce.service";

export type { IChainSender };

/**
 * ChainActionWorker
 *
 * Three independent polling loops run concurrently:
 *
 *  1. Sender loop   (default 2 s)   QUEUED → SENT
 *     Picks queued actions, sends on-chain, stores txHash + nonce.
 *     Idempotency guard: skips re-sending if txHash already exists.
 *
 *  2. Receipt loop  (default 5 s)   SENT → MINED / FAILED
 *     Non-blocking poll of every SENT action; records blockNumber, gasUsed,
 *     revertReason, and triggers downstream transitions (loan → FUNDING).
 *
 *  3. Stuck-tx loop (default 60 s)  SENT (old) → RETRYING → SENT (new hash)
 *     Detects txns pending > STUCK_TX_THRESHOLD_MS and replaces via RBF (30%
 *     fee bump). Actions exceeding MAX_BUMP_COUNT are permanently FAILED.
 *
 * Startup recovery: PROCESSING actions orphaned by a prior crash are reset to
 * QUEUED before loops begin.
 *
 * Observability: structured log lines include pending age, gasUsed, nonce,
 * bumpCount, and per-batch failure counts.
 */
@Injectable()
export class ChainActionWorker {
  private readonly logger = new Logger(ChainActionWorker.name);

  private running = false;
  private paused = false;
  private sender: IChainSender | null = null;

  private readonly STUCK_TX_THRESHOLD_MS = 5 * 60_000; // 5 min
  private readonly STUCK_CHECK_INTERVAL_MS = 60_000;
  private readonly CONFIRMATION_INTERVAL_MS = 10_000;

  constructor(
    private readonly chainActions: ChainActionService,
    private readonly loans: LoanService,
    private readonly metrics: TxMetricsService,
    private readonly signerNonce: SignerNonceService,
  ) {}

  // ── Sender injection ──────────────────────────────────────────────────────

  setSender(sender: IChainSender): void {
    this.sender = sender;
  }

  // ── Pause / resume ────────────────────────────────────────────────────────

  pauseSender(): void {
    this.paused = true;
    this.logger.warn("Chain action sender PAUSED by admin");
  }

  resumeSender(): void {
    this.paused = false;
    this.logger.log("Chain action sender RESUMED by admin");
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ── Loop 1: sender ────────────────────────────────────────────────────────

  async processBatch(): Promise<number> {
    if (!this.sender) {
      this.logger.warn("No chain sender configured — skipping batch");
      return 0;
    }
    if (this.paused) {
      this.logger.debug("Sender paused — skipping batch");
      return 0;
    }

    const queued = await this.chainActions.findQueued(10);
    let sent = 0;
    let failed = 0;

    for (const action of queued) {
      try {
        await this.chainActions.markProcessing(action.id);
        const payload = action.payload as Record<string, unknown>;

        // Idempotency: action has a txHash from a prior run; let receipt loop
        // handle it instead of submitting a duplicate transaction.
        if (action.txHash) {
          this.logger.warn(
            `[SKIP_SEND] action=${action.id} already has txHash=${action.txHash} — deferring to receipt loop`,
          );
          await this.chainActions.markSent(
            action.id,
            action.txHash,
            action.nonce ?? 0,
          );
          sent++;
          continue;
        }

        const { txHash, nonce } = await this.sender.sendAction({
          id: action.id,
          type: action.type,
          payload,
        });

        await this.chainActions.markSent(action.id, txHash, nonce);
        await this.signerNonce.commit(
          (payload["signerAddress"] as string | undefined) ?? "",
          nonce,
        );
        this.metrics.incSubmitted();
        this.logger.log(
          `[tx_submitted] action=${action.id} type=${action.type} txHash=${txHash} nonce=${nonce}`,
        );
        sent++;
      } catch (err: any) {
        failed++;
        const msg = err.message ?? String(err);
        if (this.chainActions.isNonceConflict(msg)) {
          this.metrics.incNonceConflict();
          this.logger.warn(
            `[nonce_conflict] action=${action.id} type=${action.type} error="${msg}" — resyncing nonce`,
          );
        } else {
          this.logger.error(
            `[tx_failed] action=${action.id} type=${action.type} error="${msg}"`,
          );
        }
        this.metrics.incFailed();
        const updated = await this.chainActions.markFailed(action.id, msg);
        if (updated.status === "DLQ") this.metrics.incDlq();
      }
    }

    if (queued.length > 0) {
      this.logger.log(
        `Sender batch: picked=${queued.length} sent=${sent} failed=${failed}`,
      );
    }

    return sent;
  }

  // ── Loop 2: receipt ───────────────────────────────────────────────────────

  async pollReceipts(): Promise<number> {
    if (!this.sender) return 0;

    const sentActions = await this.chainActions.findSent(20);
    let resolved = 0;

    for (const action of sentActions) {
      if (!action.txHash) continue;
      try {
        const receipt = await this.sender.getReceipt(action.txHash);
        if (!receipt) continue; // Still pending

        const pendingSec = action.sentAt
          ? Math.round((Date.now() - action.sentAt.getTime()) / 1000)
          : "?";

        await this.chainActions.markMined(action.id, receipt);

        if (receipt.status === "success") {
          this.metrics.incConfirmed();
          this.logger.log(
            `[tx_confirmed] action=${action.id} type=${action.type} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed} pendingSec=${pendingSec}`,
          );
          if (
            action.type === ChainActionType.CREATE_LOAN &&
            receipt.loanContract
          ) {
            await this.loans.transitionToFunding(
              action.loanId,
              receipt.loanContract,
            );
            this.logger.log(
              `Loan ${action.loanId} → FUNDING contract=${receipt.loanContract}`,
            );
          }
        } else {
          this.metrics.incFailed();
          const updated = await this.chainActions.markFailed(
            action.id,
            receipt.revertReason ?? "tx reverted on-chain",
          );
          if (updated.status === "DLQ") this.metrics.incDlq();
          this.logger.error(
            `[tx_failed] action=${action.id} type=${action.type} reason="${receipt.revertReason ?? "unknown"}" pendingSec=${pendingSec} → ${updated.status}`,
          );
        }

        resolved++;
      } catch (err: any) {
        this.logger.error(
          `[RECEIPT_POLL_ERROR] action=${action.id} error="${err.message}"`,
        );
      }
    }

    return resolved;
  }

  // ── Loop 3: stuck-tx / RBF ───────────────────────────────────────────────

  async handleStuckTxs(): Promise<void> {
    if (!this.sender) return;

    const stuck = await this.chainActions.findStuck(
      this.STUCK_TX_THRESHOLD_MS,
      10,
    );

    for (const action of stuck) {
      const ageMin = action.sentAt
        ? Math.round((Date.now() - action.sentAt.getTime()) / 60_000)
        : "?";

      this.logger.warn(
        `[STUCK_TX] action=${action.id} type=${action.type} pendingMin=${ageMin} bumpCount=${action.bumpCount} txHash=${action.txHash}`,
      );

      try {
        const { txHash: newTxHash } = await this.sender.bumpAndReplace({
          type: action.type,
          payload: action.payload as Record<string, unknown>,
          nonce: action.nonce!,
        });

        const newBumpCount = action.bumpCount + 1;
        await this.chainActions.markRetrying(action.id, newTxHash, newBumpCount);
        await this.chainActions.markSentAfterRetry(action.id);
        this.metrics.incRbfBump();
        this.logger.log(
          `[RBF_SENT] action=${action.id} newTxHash=${newTxHash} bumpCount=${newBumpCount}`,
        );
      } catch (err: any) {
        this.logger.error(
          `[RBF_FAILED] action=${action.id} bumpCount=${action.bumpCount} error="${err.message}"`,
        );
        const updated = await this.chainActions.markFailed(
          action.id,
          `RBF failed after ${action.bumpCount} bump(s): ${err.message}`,
        );
      }
    }
  }

  // ── Polling orchestration ─────────────────────────────────────────────────

  async startPolling(
    senderIntervalMs = 2_000,
    receiptIntervalMs = 5_000,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;

    const { count: recovered } =
      await this.chainActions.resetStuckProcessing();
    if (recovered > 0) {
      this.logger.warn(
        `Startup recovery: reset ${recovered} orphaned PROCESSING action(s) → QUEUED`,
      );
    }

    this.logger.log(
      `Worker started — sender=${senderIntervalMs}ms receipt=${receiptIntervalMs}ms stuck=${this.STUCK_CHECK_INTERVAL_MS}ms`,
    );

    const senderLoop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.processBatch();
      } catch (err: any) {
        this.logger.error(`Sender loop error: ${err.message}`);
      }
      if (this.running) setTimeout(senderLoop, senderIntervalMs);
    };

    const receiptLoop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.pollReceipts();
      } catch (err: any) {
        this.logger.error(`Receipt loop error: ${err.message}`);
      }
      if (this.running) setTimeout(receiptLoop, receiptIntervalMs);
    };

    const stuckLoop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.handleStuckTxs();
      } catch (err: any) {
        this.logger.error(`Stuck-tx loop error: ${err.message}`);
      }
      if (this.running) setTimeout(stuckLoop, this.STUCK_CHECK_INTERVAL_MS);
    };

    senderLoop();
    receiptLoop();
    stuckLoop();
  }

  stopPolling(): void {
    this.running = false;
    this.logger.log("Chain action worker stopped");
  }
}
