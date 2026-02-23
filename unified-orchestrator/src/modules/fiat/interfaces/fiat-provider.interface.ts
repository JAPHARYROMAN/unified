export interface PayoutRequest {
  idempotencyKey: string;
  loanId: string;
  phoneNumber: string;
  amountKes: bigint;
  reference: string;
}

export interface PayoutResult {
  providerRef: string;
  status: "PENDING" | "CONFIRMED" | "FAILED";
}

export interface WebhookVerifyResult {
  valid: boolean;
  eventType: "DISBURSEMENT_CONFIRMED" | "DISBURSEMENT_FAILED" | "REPAYMENT_RECEIVED" | "UNKNOWN";
  providerRef: string;
  idempotencyKey: string;
  amountKes: bigint;
  phoneNumber: string;
  rawPayload: Record<string, unknown>;
  /** Parsed timestamp from the webhook payload (used for freshness validation). */
  webhookTimestamp?: Date;
  /** Nonce from the webhook payload (used for replay guard). */
  webhookNonce?: string;
}

export interface IFiatProvider {
  readonly providerName: string;
  initiatePayout(req: PayoutRequest): Promise<PayoutResult>;
  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookVerifyResult;
}
