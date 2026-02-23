import { Injectable, Logger, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma";
import {
  FiatTransferDirection,
  FiatTransferStatus,
  Prisma,
} from "@prisma/client";
import { createHash } from "crypto";

/** Compute SHA-256 of the full raw provider receipt JSON. */
function computeProofHash(rawPayload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(rawPayload))
    .digest("hex");
}

/** Compute canonical refHash: SHA-256(providerRef:loanId:direction). */
function computeRefHash(
  providerRef: string,
  loanId: string,
  direction: string,
): string {
  return createHash("sha256")
    .update(`${providerRef}:${loanId}:${direction}`)
    .digest("hex");
}

export interface CreateFiatTransferParams {
  loanId: string;
  direction: FiatTransferDirection;
  providerRef: string;
  idempotencyKey: string;
  amountKes: bigint;
  phoneNumber: string;
  rawPayload?: Record<string, unknown>;
}

@Injectable()
export class FiatTransferService {
  private readonly logger = new Logger(FiatTransferService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new fiat transfer row.
   * Throws ConflictException if idempotencyKey already exists (replay guard).
   */
  async create(params: CreateFiatTransferParams) {
    const existing = await this.prisma.fiatTransfer.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });

    if (existing) {
      this.logger.warn(
        `Duplicate idempotencyKey=${params.idempotencyKey} — returning existing record`,
      );
      throw new ConflictException(
        `FiatTransfer with idempotencyKey=${params.idempotencyKey} already exists`,
      );
    }

    const transfer = await this.prisma.fiatTransfer.create({
      data: {
        loanId: params.loanId,
        direction: params.direction,
        status: FiatTransferStatus.PENDING,
        providerRef: params.providerRef,
        idempotencyKey: params.idempotencyKey,
        amountKes: params.amountKes,
        phoneNumber: params.phoneNumber,
        rawPayload: params.rawPayload as Prisma.InputJsonValue | undefined,
      },
    });

    this.logger.log(
      `FiatTransfer created id=${transfer.id} direction=${params.direction} loan=${params.loanId}`,
    );
    return transfer;
  }

  /**
   * Find by idempotency key — used for replay detection without throwing.
   */
  async findByIdempotencyKey(key: string) {
    return this.prisma.fiatTransfer.findUnique({
      where: { idempotencyKey: key },
    });
  }

  /**
   * Find by provider reference (e.g. M-Pesa TransactionID).
   */
  async findByProviderRef(providerRef: string) {
    return this.prisma.fiatTransfer.findFirst({
      where: { providerRef },
    });
  }

  /**
   * Mark a transfer CONFIRMED and compute the canonical refHash.
   * refHash = SHA-256(providerRef + ":" + loanId + ":" + direction)
   * @deprecated Use the explicit state machine methods below.
   */
  async markConfirmed(id: string) {
    const transfer = await this.prisma.fiatTransfer.findUniqueOrThrow({
      where: { id },
    });

    const refHash = computeRefHash(
      transfer.providerRef,
      transfer.loanId,
      transfer.direction,
    );

    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.CONFIRMED,
        refHash,
        confirmedAt: new Date(),
      },
    });

    this.logger.log(`FiatTransfer id=${id} CONFIRMED refHash=${refHash}`);
    return updated;
  }

  // ── Disbursement state machine ────────────────────────────────────────────

  /** PENDING → PAYOUT_INITIATED: payout call accepted by provider. */
  async markPayoutInitiated(id: string) {
    return this.transition(id, FiatTransferStatus.PAYOUT_INITIATED);
  }

  /**
   * PAYOUT_INITIATED → PAYOUT_CONFIRMED: provider webhook confirms funds sent.
   * Computes refHash + proofHash from the raw provider receipt.
   */
  async markPayoutConfirmed(
    id: string,
    rawPayload: Record<string, unknown>,
    webhookTimestamp?: Date,
  ) {
    const transfer = await this.prisma.fiatTransfer.findUniqueOrThrow({
      where: { id },
    });

    const refHash = computeRefHash(
      transfer.providerRef,
      transfer.loanId,
      transfer.direction,
    );
    const proofHash = computeProofHash(rawPayload);

    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.PAYOUT_CONFIRMED,
        refHash,
        proofHash,
        confirmedAt: new Date(),
        webhookTimestamp: webhookTimestamp ?? new Date(),
        rawPayload: rawPayload as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `FiatTransfer id=${id} PAYOUT_CONFIRMED refHash=${refHash} proofHash=${proofHash}`,
    );
    return updated;
  }

  /** PAYOUT_CONFIRMED → CHAIN_RECORD_PENDING: RECORD_DISBURSEMENT action enqueued. */
  async markChainRecordPending(id: string) {
    return this.transition(id, FiatTransferStatus.CHAIN_RECORD_PENDING);
  }

  /** CHAIN_RECORD_PENDING → CHAIN_RECORDED: RECORD_DISBURSEMENT action confirmed on-chain. */
  async markChainRecorded(id: string) {
    return this.transition(id, FiatTransferStatus.CHAIN_RECORDED);
  }

  /** CHAIN_RECORDED → ACTIVATED: ACTIVATE_LOAN action confirmed on-chain. */
  async markActivated(id: string) {
    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.ACTIVATED,
        appliedOnchainAt: new Date(),
      },
    });
    this.logger.log(`FiatTransfer id=${id} ACTIVATED — loan is now live on-chain`);
    return updated;
  }

  // ── Repayment state machine ───────────────────────────────────────────────

  /**
   * PENDING → REPAYMENT_RECEIVED: inbound webhook accepted.
   * Computes proofHash immediately from the raw payload.
   */
  async markRepaymentReceived(
    id: string,
    rawPayload: Record<string, unknown>,
    webhookTimestamp?: Date,
  ) {
    const transfer = await this.prisma.fiatTransfer.findUniqueOrThrow({
      where: { id },
    });

    const refHash = computeRefHash(
      transfer.providerRef,
      transfer.loanId,
      transfer.direction,
    );
    const proofHash = computeProofHash(rawPayload);

    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.REPAYMENT_RECEIVED,
        refHash,
        proofHash,
        confirmedAt: new Date(),
        webhookTimestamp: webhookTimestamp ?? new Date(),
        rawPayload: rawPayload as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `FiatTransfer id=${id} REPAYMENT_RECEIVED proofHash=${proofHash}`,
    );
    return updated;
  }

  /** REPAYMENT_RECEIVED → CHAIN_REPAY_PENDING: REPAY + RECORD_REPAYMENT enqueued. */
  async markChainRepayPending(id: string) {
    return this.transition(id, FiatTransferStatus.CHAIN_REPAY_PENDING);
  }

  /** CHAIN_REPAY_PENDING → CHAIN_REPAY_CONFIRMED: REPAY action confirmed on-chain. */
  async markChainRepayConfirmed(id: string) {
    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.CHAIN_REPAY_CONFIRMED,
        appliedOnchainAt: new Date(),
      },
    });
    this.logger.log(`FiatTransfer id=${id} CHAIN_REPAY_CONFIRMED`);
    return updated;
  }

  /** Generic: mark APPLIED_ONCHAIN (legacy compat). */
  async markAppliedOnchain(id: string) {
    return this.prisma.fiatTransfer.update({
      where: { id },
      data: { appliedOnchainAt: new Date() },
    });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async transition(id: string, status: FiatTransferStatus) {
    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: { status },
    });
    this.logger.log(`FiatTransfer id=${id} → ${status}`);
    return updated;
  }

  /**
   * Mark a transfer FAILED.
   */
  async markFailed(id: string, reason: string) {
    const updated = await this.prisma.fiatTransfer.update({
      where: { id },
      data: {
        status: FiatTransferStatus.FAILED,
        failedAt: new Date(),
        failureReason: reason,
      },
    });
    this.logger.warn(`FiatTransfer id=${id} FAILED reason=${reason}`);
    return updated;
  }

  async findById(id: string) {
    return this.prisma.fiatTransfer.findUniqueOrThrow({ where: { id } });
  }

  async findByLoan(loanId: string) {
    return this.prisma.fiatTransfer.findMany({
      where: { loanId },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Find the most recent OUTBOUND transfer for a loan (disbursement). */
  async findOutboundByLoan(loanId: string) {
    return this.prisma.fiatTransfer.findFirst({
      where: { loanId, direction: FiatTransferDirection.OUTBOUND },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Find the most recent INBOUND transfer for a loan (repayment). */
  async findInboundByLoan(loanId: string) {
    return this.prisma.fiatTransfer.findFirst({
      where: { loanId, direction: FiatTransferDirection.INBOUND },
      orderBy: { createdAt: "desc" },
    });
  }
}
