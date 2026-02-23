import {
  Controller,
  Post,
  Req,
  Res,
  HttpCode,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";
import { Throttle } from "@nestjs/throttler";
import { MpesaAdapter } from "./adapters/mpesa.adapter";
import { FiatDisbursementService } from "./fiat-disbursement.service";
import { FiatRepaymentService } from "./fiat-repayment.service";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";
import { WebhookNonceService } from "./webhook-nonce.service";
import { LoanService } from "../loan/loan.service";

const SOURCE = "mpesa";
const TIMESTAMP_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

@Controller("webhooks/mpesa")
export class MpesaWebhookController {
  private readonly logger = new Logger(MpesaWebhookController.name);

  constructor(
    private readonly mpesa: MpesaAdapter,
    private readonly disbursement: FiatDisbursementService,
    private readonly repayment: FiatRepaymentService,
    private readonly deadLetter: WebhookDeadLetterService,
    private readonly webhookNonce: WebhookNonceService,
    private readonly loans: LoanService,
  ) {}

  /**
   * POST /webhooks/mpesa/disbursement
   * M-Pesa B2C result callback — confirms or fails a payout.
   */
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Post("disbursement")
  @HttpCode(200)
  async disbursementCallback(@Req() req: Request, @Res() res: Response) {
    const rawBody = this.extractRawBody(req);
    const headers = req.headers as Record<string, string | string[] | undefined>;

    const verified = this.mpesa.verifyWebhookSignature(rawBody, headers);

    if (!verified.valid) {
      await this.deadLetter.record({
        source: SOURCE,
        eventType: "disbursement",
        rawBody,
        failReason: "signature_invalid_or_malformed",
        headers,
      });
      return res.status(200).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }

    // Timestamp freshness check
    if (verified.webhookTimestamp) {
      const ageMs = Date.now() - verified.webhookTimestamp.getTime();
      if (ageMs > TIMESTAMP_FRESHNESS_MS) {
        this.logger.warn(
          `[disbursement] Stale webhook rejected ageMs=${ageMs} providerRef=${verified.providerRef}`,
        );
        await this.deadLetter.record({
          source: SOURCE,
          eventType: "disbursement",
          rawBody,
          failReason: `timestamp_stale_ageMs=${ageMs}`,
          headers,
        });
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }

    // Nonce replay guard
    if (verified.webhookNonce) {
      const fresh = await this.webhookNonce.claim(
        `disbursement:${verified.webhookNonce}`,
        SOURCE,
      );
      if (!fresh) {
        this.logger.warn(
          `[disbursement] Replay rejected nonce=${verified.webhookNonce}`,
        );
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }

    try {
      if (verified.eventType === "DISBURSEMENT_CONFIRMED") {
        await this.disbursement.handleDisbursementConfirmed(
          verified.providerRef,
          verified.idempotencyKey,
          verified.rawPayload,
          verified.amountKes,
          verified.webhookTimestamp,
        );
      } else if (verified.eventType === "DISBURSEMENT_FAILED") {
        await this.disbursement.handleDisbursementFailed(
          verified.providerRef,
          "Provider reported failure",
        );
      } else {
        await this.deadLetter.record({
          source: SOURCE,
          eventType: verified.eventType,
          rawBody,
          failReason: "unrecognised_event_type",
          headers,
        });
      }
    } catch (err: any) {
      this.logger.error(`Disbursement webhook processing error: ${err.message}`);
      await this.deadLetter.record({
        source: SOURCE,
        eventType: "disbursement",
        rawBody,
        failReason: err.message,
        headers,
      });
    }

    // Always ACK to M-Pesa to prevent retries on our processing errors.
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  /**
   * POST /webhooks/mpesa/repayment
   * M-Pesa C2B / Pay Bill callback — inbound repayment from borrower.
   */
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Post("repayment")
  @HttpCode(200)
  async repaymentCallback(@Req() req: Request, @Res() res: Response) {
    const rawBody = this.extractRawBody(req);
    const headers = req.headers as Record<string, string | string[] | undefined>;

    const verified = this.mpesa.verifyWebhookSignature(rawBody, headers);

    if (!verified.valid) {
      await this.deadLetter.record({
        source: SOURCE,
        eventType: "repayment",
        rawBody,
        failReason: "signature_invalid_or_malformed",
        headers,
      });
      return res.status(200).json({ ResultCode: 1, ResultDesc: "Rejected" });
    }

    if (verified.eventType !== "REPAYMENT_RECEIVED") {
      await this.deadLetter.record({
        source: SOURCE,
        eventType: verified.eventType,
        rawBody,
        failReason: "unexpected_event_type_on_repayment_endpoint",
        headers,
      });
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // Timestamp freshness check
    if (verified.webhookTimestamp) {
      const ageMs = Date.now() - verified.webhookTimestamp.getTime();
      if (ageMs > TIMESTAMP_FRESHNESS_MS) {
        this.logger.warn(
          `[repayment] Stale webhook rejected ageMs=${ageMs} providerRef=${verified.providerRef}`,
        );
        await this.deadLetter.record({
          source: SOURCE,
          eventType: "repayment",
          rawBody,
          failReason: `timestamp_stale_ageMs=${ageMs}`,
          headers,
        });
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }

    // Nonce replay guard
    if (verified.webhookNonce) {
      const fresh = await this.webhookNonce.claim(
        `repayment:${verified.webhookNonce}`,
        SOURCE,
      );
      if (!fresh) {
        this.logger.warn(
          `[repayment] Replay rejected nonce=${verified.webhookNonce}`,
        );
        return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }

    try {
      const loanId = String(verified.rawPayload["loanId"] ?? "");
      const loanContract = String(verified.rawPayload["loanContract"] ?? "");

      if (!loanId || !loanContract) {
        throw new Error("Missing loanId or loanContract in repayment payload");
      }

      await this.repayment.handleRepayment({
        loanId,
        loanContract,
        providerRef: verified.providerRef,
        idempotencyKey: verified.idempotencyKey,
        amountKes: verified.amountKes,
        phoneNumber: verified.phoneNumber,
        rawPayload: verified.rawPayload,
        webhookTimestamp: verified.webhookTimestamp,
      });
    } catch (err: any) {
      this.logger.error(`Repayment webhook processing error: ${err.message}`);
      await this.deadLetter.record({
        source: SOURCE,
        eventType: "repayment",
        rawBody,
        failReason: err.message,
        headers,
      });
    }

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  private extractRawBody(req: Request): string {
    const raw = (req as any).rawBody;
    if (typeof raw === "string") return raw;
    if (Buffer.isBuffer(raw)) return raw.toString("utf8");
    return JSON.stringify(req.body ?? {});
  }
}
