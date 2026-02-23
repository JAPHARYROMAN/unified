import { Logger } from "@nestjs/common";
import type { Provider } from "ethers";

/**
 * Serialises all nonce assignments to a single signer address.
 *
 * Guarantees monotonically-increasing, gap-free nonces even when multiple
 * actions are dispatched concurrently. Acts as the single writer for the
 * signer account.
 *
 * Safety contract:
 *   - Callers must NOT throw from `sendFn` after the tx has been broadcast.
 *     If `sendFn` throws, the nonce is rolled back (assumed not submitted).
 *   - For out-of-band RBF sends, call `resync()` afterwards so the manager
 *     re-reads the pending nonce from the chain.
 */
export class NonceManager {
  private readonly logger = new Logger(NonceManager.name);
  private nextNonce: number | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    private readonly provider: Provider,
    private readonly signerAddress: string,
  ) {}

  /**
   * Execute `sendFn` with a guaranteed-unique sequential nonce.
   *
   * - Resolves: nonce is committed (incremented for the next call).
   * - Rejects: nonce is rolled back so the next caller reuses the same value.
   */
  async withNonce<T>(sendFn: (nonce: number) => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const prev = this.mutex;
    // Chain a new promise so the next withNonce waits for this one.
    this.mutex = new Promise<void>((r) => {
      unlock = r;
    });

    try {
      await prev; // Wait for any preceding send to finish

      if (this.nextNonce === null) {
        this.nextNonce = await this.provider.getTransactionCount(
          this.signerAddress,
          "pending",
        );
        this.logger.debug(
          `NonceManager initialised at ${this.nextNonce} for ${this.signerAddress}`,
        );
      }

      const nonce = this.nextNonce;
      try {
        const result = await sendFn(nonce);
        this.nextNonce = nonce + 1; // Commit: tx was submitted
        return result;
      } catch (err) {
        // Roll back: tx was NOT submitted, reuse this nonce next time.
        this.logger.warn(
          `Send failed at nonce ${nonce} — rolling back (tx not submitted)`,
        );
        throw err;
      }
    } finally {
      unlock(); // Always release the mutex so the next withNonce can proceed
    }
  }

  /**
   * Force-reset the tracked nonce to null.
   * The next `withNonce` call will re-fetch from `getTransactionCount(pending)`.
   * Call this after any out-of-band tx (e.g. RBF) to avoid nonce gaps.
   */
  async resync(): Promise<void> {
    this.nextNonce = null;
    this.logger.log(
      `Nonce resync queued for ${this.signerAddress} — will re-fetch on next send`,
    );
  }

  /** Current locally-tracked nonce (null if not yet initialised). */
  get current(): number | null {
    return this.nextNonce;
  }
}
