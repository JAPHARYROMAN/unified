import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma";
import { Prisma } from "@prisma/client";

export interface DeadLetterParams {
  source: string;
  eventType: string;
  rawBody: string;
  failReason: string;
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class WebhookDeadLetterService {
  private readonly logger = new Logger(WebhookDeadLetterService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(params: DeadLetterParams) {
    const entry = await this.prisma.webhookDeadLetter.create({
      data: {
        source: params.source,
        eventType: params.eventType,
        rawBody: params.rawBody,
        failReason: params.failReason,
        headers: (params.headers ?? {}) as Prisma.InputJsonValue,
      },
    });
    this.logger.warn(
      `Dead-letter recorded id=${entry.id} source=${params.source} reason=${params.failReason}`,
    );
    return entry;
  }
}
