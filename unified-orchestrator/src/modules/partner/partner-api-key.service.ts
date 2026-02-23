import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma";
import {
  generateApiKey,
  hashApiKey,
  keyLast4,
} from "../../common/utils/api-key.util";

@Injectable()
export class PartnerApiKeyService {
  private readonly logger = new Logger(PartnerApiKeyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issue a new API key for a partner.
   * Returns the plaintext key — caller must deliver it once and never store it.
   */
  async issue(partnerId: string): Promise<{
    id: string;
    plaintext: string;
    last4: string;
  }> {
    const plaintext = generateApiKey();
    const hash = hashApiKey(plaintext);
    const last4 = keyLast4(plaintext);

    const record = await this.prisma.partnerApiKey.create({
      data: {
        partnerId,
        keyHash: hash,
        last4,
      },
    });

    this.logger.log(
      `API key issued for partner ${partnerId} (id=${record.id}, last4=…${last4})`,
    );

    return { id: record.id, plaintext, last4 };
  }

  /**
   * Revoke an API key by setting revokedAt.
   */
  async revoke(keyId: string): Promise<void> {
    await this.prisma.partnerApiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`API key ${keyId} revoked`);
  }

  /**
   * Validate a plaintext key.
   * Returns the partnerId if key is valid and not revoked, else null.
   */
  async validate(plaintext: string): Promise<string | null> {
    const hash = hashApiKey(plaintext);
    const record = await this.prisma.partnerApiKey.findFirst({
      where: { keyHash: hash, revokedAt: null },
    });
    return record?.partnerId ?? null;
  }
}
