import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { FiatTransferService } from "./fiat-transfer.service";
import { ChainActionService } from "../chain-action/chain-action.service";
import { FiatTransferDirection, ChainActionType } from "@prisma/client";

export interface HandleRepaymentParams {
  loanId: string;
  loanContract: string;
  providerRef: string;
  idempotencyKey: string;
  amountKes: bigint;
  phoneNumber: string;
  rawPayload: Record<string, unknown>;
  webhookTimestamp?: Date;
  /** Expected amount from the loan record — used for mismatch guard. */
  expectedAmountKes?: bigint;
}

@Injectable()
export class FiatRepaymentService {
  private readonly logger = new Logger(FiatRepaymentService.name);

  constructor(
    private readonly fiatTransfers: FiatTransferService,
    private readonly chainActions: ChainActionService,
  ) {}

  /**
   * Handle an inbound M-Pesa repayment confirmation.
   * Idempotent: repeated webhooks with the same idempotencyKey are ignored.
   *
   * State machine:
   *   PENDING → REPAYMENT_RECEIVED → CHAIN_REPAY_PENDING
   *
   * Security: validates amount matches expected if provided.
   */
  async handleRepayment(params: HandleRepaymentParams) {
    const existing = await this.fiatTransfers.findByIdempotencyKey(
      params.idempotencyKey,
    );

    if (existing) {
      this.logger.warn(
        `Repayment already processed idempotencyKey=${params.idempotencyKey} transferId=${existing.id} — skipping`,
      );
      return { transfer: existing, duplicate: true };
    }

    // Amount mismatch guard
    if (
      params.expectedAmountKes !== undefined &&
      params.amountKes !== params.expectedAmountKes
    ) {
      const msg = `Amount mismatch loan=${params.loanId}: expected=${params.expectedAmountKes} got=${params.amountKes}`;
      this.logger.error(`[amount_mismatch] ${msg}`);
      throw new BadRequestException(msg);
    }

    // Create INBOUND/PENDING
    const transfer = await this.fiatTransfers.create({
      loanId: params.loanId,
      direction: FiatTransferDirection.INBOUND,
      providerRef: params.providerRef,
      idempotencyKey: params.idempotencyKey,
      amountKes: params.amountKes,
      phoneNumber: params.phoneNumber,
    });

    // PENDING → REPAYMENT_RECEIVED (stores proofHash + refHash)
    const received = await this.fiatTransfers.markRepaymentReceived(
      transfer.id,
      params.rawPayload,
      params.webhookTimestamp,
    );

    // Ledger entry (v1.1: desk-based conversion record in payload)
    const conversionRecord = {
      amountKes: params.amountKes.toString(),
      providerRef: params.providerRef,
      loanId: params.loanId,
      recordedAt: new Date().toISOString(),
      note: "v1.1-desk-conversion",
    };

    await this.chainActions.enqueue(params.loanId, ChainActionType.REPAY, {
      loanContract: params.loanContract,
      providerRef: params.providerRef,
      amountKes: params.amountKes.toString(),
      proofHash: received.proofHash,
      conversionRecord,
    });

    await this.chainActions.enqueue(params.loanId, ChainActionType.RECORD_REPAYMENT, {
      loanContract: params.loanContract,
      refHash: received.refHash,
      proofHash: received.proofHash,
      providerRef: params.providerRef,
    });

    // REPAYMENT_RECEIVED → CHAIN_REPAY_PENDING
    const pending = await this.fiatTransfers.markChainRepayPending(received.id);

    this.logger.log(
      `[repayment_received] transferId=${transfer.id} proofHash=${received.proofHash} — REPAY + RECORD_REPAYMENT enqueued`,
    );
    return { transfer: pending, duplicate: false };
  }

  /**
   * Called by ChainActionWorker when REPAY action is confirmed on-chain.
   * CHAIN_REPAY_PENDING → CHAIN_REPAY_CONFIRMED
   */
  async onRepayConfirmed(loanId: string) {
    const transfer = await this.fiatTransfers.findInboundByLoan(loanId);
    if (!transfer) return;
    if (transfer.status !== "CHAIN_REPAY_PENDING") return;
    await this.fiatTransfers.markChainRepayConfirmed(transfer.id);
    this.logger.log(`[repay_confirmed] transferId=${transfer.id} loan=${loanId}`);
  }
}
