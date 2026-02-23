import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma";

const NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class WebhookNonceService {
  private readonly logger = new Logger(WebhookNonceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempt to claim a nonce. Returns true if the nonce is fresh (first use).
   * Returns false if the nonce was already seen (replay attack).
   *
   * Nonces older than NONCE_TTL_MS are considered expired and are not checked.
   */
  async claim(nonce: string, source: string): Promise<boolean> {
    try {
      await this.prisma.webhookNonce.create({
        data: { nonce, source },
      });
      return true;
    } catch {
      // Unique constraint violation — nonce already seen
      this.logger.warn(
        `[WebhookNonce] Replay detected nonce=${nonce} source=${source}`,
      );
      return false;
    }
  }

  /**
   * Purge nonces older than TTL (call from a scheduled job).
   */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - NONCE_TTL_MS);
    const { count } = await this.prisma.webhookNonce.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    if (count > 0) {
      this.logger.log(`[WebhookNonce] Purged ${count} expired nonces`);
    }
    return count;
  }
}
