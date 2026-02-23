import { Injectable, Logger, ConflictException, BadRequestException } from "@nestjs/common";
import { FiatTransferService } from "./fiat-transfer.service";
import { ChainActionService } from "../chain-action/chain-action.service";
import { MpesaAdapter } from "./adapters/mpesa.adapter";
import { FiatTransferDirection, ChainActionType } from "@prisma/client";

export interface InitiatePayoutParams {
  loanId: string;
  loanContract: string;
  phoneNumber: string;
  amountKes: bigint;
  idempotencyKey: string;
}

@Injectable()
export class FiatDisbursementService {
  private readonly logger = new Logger(FiatDisbursementService.name);

  constructor(
    private readonly fiatTransfers: FiatTransferService,
    private readonly chainActions: ChainActionService,
    private readonly mpesa: MpesaAdapter,
  ) {}

  /**
   * Initiate an outbound M-Pesa payout for a loan disbursement.
   * Idempotent: repeated calls with the same idempotencyKey return the existing record.
   * State: PENDING → PAYOUT_INITIATED
   */
  async initiatePayout(params: InitiatePayoutParams) {
    const existing = await this.fiatTransfers.findByIdempotencyKey(
      params.idempotencyKey,
    );
    if (existing) {
      this.logger.warn(
        `Payout already initiated idempotencyKey=${params.idempotencyKey}`,
      );
      return existing;
    }

    const result = await this.mpesa.initiatePayout({
      idempotencyKey: params.idempotencyKey,
      loanId: params.loanId,
      phoneNumber: params.phoneNumber,
      amountKes: params.amountKes,
      reference: params.loanContract,
    });

    const transfer = await this.fiatTransfers.create({
      loanId: params.loanId,
      direction: FiatTransferDirection.OUTBOUND,
      providerRef: result.providerRef,
      idempotencyKey: params.idempotencyKey,
      amountKes: params.amountKes,
      phoneNumber: params.phoneNumber,
    });

    // Advance state machine: PENDING → PAYOUT_INITIATED
    const initiated = await this.fiatTransfers.markPayoutInitiated(transfer.id);

    this.logger.log(
      `[payout_initiated] transferId=${initiated.id} providerRef=${result.providerRef} loan=${params.loanId}`,
    );
    return initiated;
  }

  /**
   * Handle disbursement confirmation callback from M-Pesa.
   * Idempotent: if the transfer is already past PAYOUT_INITIATED, returns it unchanged.
   * On first confirmation:
   *   PAYOUT_INITIATED → PAYOUT_CONFIRMED → CHAIN_RECORD_PENDING
   *   Enqueues RECORD_DISBURSEMENT + ACTIVATE_LOAN.
   *
   * Security: validates amount matches what was initiated.
   */
  async handleDisbursementConfirmed(
    providerRef: string,
    idempotencyKey: string,
    rawPayload: Record<string, unknown>,
    webhookAmountKes?: bigint,
    webhookTimestamp?: Date,
  ) {
    const transfer = await this.fiatTransfers.findByProviderRef(providerRef);

    if (!transfer) {
      this.logger.error(
        `No FiatTransfer found for providerRef=${providerRef}`,
      );
      throw new Error(`Unknown providerRef: ${providerRef}`);
    }

    // Idempotency: already past PAYOUT_INITIATED means we already processed this
    const terminalStatuses = new Set([
      "PAYOUT_CONFIRMED", "CHAIN_RECORD_PENDING", "CHAIN_RECORDED",
      "ACTIVATED", "CONFIRMED", "APPLIED_ONCHAIN",
    ]);
    if (terminalStatuses.has(transfer.status)) {
      this.logger.warn(
        `Disbursement already confirmed transferId=${transfer.id} status=${transfer.status} — skipping`,
      );
      return transfer;
    }

    // Amount mismatch guard
    if (webhookAmountKes !== undefined && webhookAmountKes !== transfer.amountKes) {
      const msg = `Amount mismatch transferId=${transfer.id}: expected=${transfer.amountKes} got=${webhookAmountKes}`;
      this.logger.error(`[amount_mismatch] ${msg}`);
      throw new BadRequestException(msg);
    }

    // PAYOUT_INITIATED → PAYOUT_CONFIRMED (stores proofHash)
    const confirmed = await this.fiatTransfers.markPayoutConfirmed(
      transfer.id,
      rawPayload,
      webhookTimestamp,
    );

    // Enqueue RECORD_DISBURSEMENT
    await this.chainActions.enqueue(transfer.loanId, ChainActionType.RECORD_DISBURSEMENT, {
      loanContract: rawPayload["loanContract"] ?? "",
      refHash: confirmed.refHash,
      proofHash: confirmed.proofHash,
      providerRef,
    });

    // PAYOUT_CONFIRMED → CHAIN_RECORD_PENDING
    const pending = await this.fiatTransfers.markChainRecordPending(confirmed.id);

    // Enqueue ACTIVATE_LOAN (will only execute after RECORD_DISBURSEMENT is mined)
    await this.chainActions.enqueue(transfer.loanId, ChainActionType.ACTIVATE_LOAN, {
      loanContract: rawPayload["loanContract"] ?? "",
      fiatDisbursementRef: providerRef,
      proofHash: confirmed.proofHash,
    });

    this.logger.log(
      `[payout_confirmed] transferId=${transfer.id} proofHash=${confirmed.proofHash} — RECORD_DISBURSEMENT + ACTIVATE_LOAN enqueued`,
    );
    return pending;
  }

  /**
   * Called by ChainActionWorker when RECORD_DISBURSEMENT is confirmed on-chain.
   * CHAIN_RECORD_PENDING → CHAIN_RECORDED
   */
  async onRecordDisbursementConfirmed(loanId: string) {
    const transfer = await this.fiatTransfers.findOutboundByLoan(loanId);
    if (!transfer) return;
    if (transfer.status !== "CHAIN_RECORD_PENDING") return;
    await this.fiatTransfers.markChainRecorded(transfer.id);
    this.logger.log(`[chain_recorded] transferId=${transfer.id} loan=${loanId}`);
  }

  /**
   * Called by ChainActionWorker when ACTIVATE_LOAN is confirmed on-chain.
   * CHAIN_RECORDED → ACTIVATED
   * Loan must NOT be ACTIVATED before this point.
   */
  async onActivateLoanConfirmed(loanId: string) {
    const transfer = await this.fiatTransfers.findOutboundByLoan(loanId);
    if (!transfer) return;
    if (transfer.status !== "CHAIN_RECORDED") {
      this.logger.error(
        `[activation_guard] ACTIVATE_LOAN confirmed but disbursement not CHAIN_RECORDED — transferId=${transfer.id} status=${transfer.status}`,
      );
      return;
    }
    await this.fiatTransfers.markActivated(transfer.id);
    this.logger.log(`[loan_activated] transferId=${transfer.id} loan=${loanId}`);
  }

  /**
   * Handle disbursement failure callback.
   */
  async handleDisbursementFailed(providerRef: string, reason: string) {
    const transfer = await this.fiatTransfers.findByProviderRef(providerRef);
    if (!transfer) {
      this.logger.error(`No FiatTransfer found for providerRef=${providerRef}`);
      return;
    }
    if (transfer.status === "FAILED") return;
    await this.fiatTransfers.markFailed(transfer.id, reason);
  }
}
