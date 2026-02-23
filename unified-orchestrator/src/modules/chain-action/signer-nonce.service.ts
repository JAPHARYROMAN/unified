import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma";
import type { Provider } from "ethers";

const NONCE_DRIFT_ABORT_THRESHOLD = 5;

/**
 * Persists the signer nonce in the database so it survives process restarts.
 *
 * On startup (`reconcile`):
 *  1. Fetch pending nonce from RPC.
 *  2. Compare to DB-stored nonce.
 *  3. If drift > NONCE_DRIFT_ABORT_THRESHOLD → throw (abort startup).
 *  4. Otherwise adopt the higher of the two values (RPC wins on forward drift).
 *
 * During operation, `commit(nonce)` persists each successfully submitted nonce.
 * The in-memory `NonceManager` still serialises concurrent sends; this service
 * provides the durable backing store and startup recovery.
 */
@Injectable()
export class SignerNonceService {
  private readonly logger = new Logger(SignerNonceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Reconcile DB nonce against RPC pending nonce.
   * Must be called at worker startup before any transactions are sent.
   *
   * @returns The reconciled nonce to seed the in-memory NonceManager with.
   * @throws If drift is unresolvable (> threshold).
   */
  async reconcile(
    provider: Provider,
    signerAddress: string,
    chainId: number,
  ): Promise<number> {
    const rpcNonce = await provider.getTransactionCount(
      signerAddress,
      "pending",
    );

    const record = await this.prisma.signerNonce.findUnique({
      where: { signerAddress },
    });

    if (!record) {
      this.logger.log(
        `[NonceReconcile] No DB record for ${signerAddress} — seeding from RPC nonce=${rpcNonce}`,
      );
      await this.prisma.signerNonce.create({
        data: { signerAddress, chainId, nonce: rpcNonce },
      });
      return rpcNonce;
    }

    const drift = Math.abs(rpcNonce - record.nonce);

    if (drift > NONCE_DRIFT_ABORT_THRESHOLD) {
      const msg =
        `[NonceReconcile] ABORT: nonce drift=${drift} exceeds threshold=${NONCE_DRIFT_ABORT_THRESHOLD} ` +
        `(db=${record.nonce} rpc=${rpcNonce}) for ${signerAddress}. ` +
        `Manual intervention required — check for stuck/pending transactions.`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // RPC is authoritative: adopt the higher value to avoid nonce-too-low errors.
    const resolved = Math.max(rpcNonce, record.nonce);

    if (resolved !== record.nonce) {
      await this.prisma.signerNonce.update({
        where: { signerAddress },
        data: { nonce: resolved },
      });
      this.logger.warn(
        `[NonceReconcile] Drift=${drift} resolved — adopting nonce=${resolved} (db=${record.nonce} rpc=${rpcNonce})`,
      );
    } else {
      this.logger.log(
        `[NonceReconcile] OK — nonce=${resolved} (db=${record.nonce} rpc=${rpcNonce})`,
      );
    }

    return resolved;
  }

  /**
   * Persist the nonce that was successfully submitted.
   * Called by the NonceManager after each successful send.
   */
  async commit(signerAddress: string, nonce: number): Promise<void> {
    await this.prisma.signerNonce.upsert({
      where: { signerAddress },
      update: { nonce: nonce + 1 },
      create: { signerAddress, chainId: 0, nonce: nonce + 1 },
    });
  }

  /** Read the current DB nonce (for diagnostics). */
  async getCurrent(signerAddress: string): Promise<number | null> {
    const record = await this.prisma.signerNonce.findUnique({
      where: { signerAddress },
    });
    return record?.nonce ?? null;
  }
}
