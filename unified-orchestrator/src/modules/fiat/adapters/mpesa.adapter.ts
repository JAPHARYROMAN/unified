import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import {
  IFiatProvider,
  PayoutRequest,
  PayoutResult,
  WebhookVerifyResult,
} from "../interfaces/fiat-provider.interface";

/**
 * M-Pesa B2C adapter (Safaricom Daraja API).
 * In v1.1 the outbound call is stubbed — replace with real Daraja B2C call.
 * Signature verification uses HMAC-SHA256 over the raw body with the
 * shared webhook secret configured in MPESA_WEBHOOK_SECRET.
 */
@Injectable()
export class MpesaAdapter implements IFiatProvider {
  readonly providerName = "mpesa";
  private readonly logger = new Logger(MpesaAdapter.name);
  private readonly webhookSecret: string;

  constructor(private readonly config: ConfigService) {
    this.webhookSecret = this.config.get<string>("MPESA_WEBHOOK_SECRET") ?? "";
  }

  async initiatePayout(req: PayoutRequest): Promise<PayoutResult> {
    this.logger.log(
      `[M-Pesa] Initiating payout — loan=${req.loanId} ref=${req.reference} amount=${req.amountKes} KES → ${req.phoneNumber}`,
    );

    // v1.1 stub: in production replace with Daraja B2C API call.
    // Returns a synthetic provider reference that the callback will echo back.
    const providerRef = `MPESA-${req.idempotencyKey.slice(0, 8).toUpperCase()}`;

    this.logger.log(`[M-Pesa] Payout accepted — providerRef=${providerRef}`);
    return { providerRef, status: "PENDING" };
  }

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerifyResult {
    const UNKNOWN: WebhookVerifyResult = {
      valid: false,
      eventType: "UNKNOWN",
      providerRef: "",
      idempotencyKey: "",
      amountKes: 0n,
      phoneNumber: "",
      rawPayload: {},
    };

    if (!this.webhookSecret) {
      this.logger.error("[M-Pesa] MPESA_WEBHOOK_SECRET not configured");
      return UNKNOWN;
    }

    const signature = this.extractHeader(headers, "x-mpesa-signature");
    if (!signature) {
      this.logger.warn("[M-Pesa] Missing x-mpesa-signature header");
      return UNKNOWN;
    }

    const expected = createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    if (
      sigBuf.length !== expBuf.length ||
      !timingSafeEqual(sigBuf, expBuf)
    ) {
      this.logger.warn("[M-Pesa] Signature mismatch — rejecting webhook");
      return UNKNOWN;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logger.warn("[M-Pesa] Malformed JSON body");
      return UNKNOWN;
    }

    const eventType = this.resolveEventType(payload);
    const providerRef = String(payload["TransactionID"] ?? payload["providerRef"] ?? "");
    const idempotencyKey = String(payload["OriginatorConversationID"] ?? payload["idempotencyKey"] ?? "");
    const amountKes = BigInt(Math.round(Number(payload["TransactionAmount"] ?? payload["amountKes"] ?? 0) * 100));
    const phoneNumber = String(payload["MSISDN"] ?? payload["phoneNumber"] ?? "");

    // Parse webhook timestamp (TransactionDate: "20240115143022" or ISO string)
    let webhookTimestamp: Date | undefined;
    const tsRaw = payload["TransactionDate"] ?? payload["Timestamp"] ?? payload["webhookTimestamp"];
    if (tsRaw) {
      const ts = String(tsRaw);
      // Safaricom format: YYYYMMDDHHmmss
      if (/^\d{14}$/.test(ts)) {
        webhookTimestamp = new Date(
          `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`,
        );
      } else {
        const parsed = new Date(ts);
        if (!isNaN(parsed.getTime())) webhookTimestamp = parsed;
      }
    }

    // Nonce for replay guard (OriginatorConversationID doubles as nonce)
    const webhookNonce = idempotencyKey || providerRef || undefined;

    return {
      valid: true,
      eventType,
      providerRef,
      idempotencyKey,
      amountKes,
      phoneNumber,
      rawPayload: payload,
      webhookTimestamp,
      webhookNonce,
    };
  }

  private resolveEventType(
    payload: Record<string, unknown>,
  ): WebhookVerifyResult["eventType"] {
    const resultCode = String(payload["ResultCode"] ?? payload["eventType"] ?? "");
    if (resultCode === "0" || resultCode === "DISBURSEMENT_CONFIRMED") return "DISBURSEMENT_CONFIRMED";
    if (resultCode === "DISBURSEMENT_FAILED") return "DISBURSEMENT_FAILED";
    if (resultCode === "REPAYMENT_RECEIVED" || payload["TransactionType"] === "Pay Bill") return "REPAYMENT_RECEIVED";
    return "UNKNOWN";
  }

  private extractHeader(
    headers: Record<string, string | string[] | undefined>,
    name: string,
  ): string | undefined {
    const val = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  }
}
