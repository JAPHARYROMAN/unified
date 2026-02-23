/**
 * Classifies transaction errors into retry categories.
 *
 * RETRYABLE errors (transient infrastructure issues):
 *   - nonce too low / nonce already used
 *   - replacement transaction underpriced
 *   - timeout / connection reset / provider unavailable
 *
 * DLQ errors (logical reverts — do NOT retry):
 *   - execution reverted (contract logic)
 *   - out of gas (caller misconfiguration)
 *   - any other unrecognised error
 */

export type RetryDecision = "RETRY" | "DLQ";

const RETRYABLE_PATTERNS = [
  /nonce too low/i,
  /nonce already used/i,
  /replacement transaction underpriced/i,
  /replacement fee too low/i,
  /transaction underpriced/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /network error/i,
  /could not detect network/i,
  /missing response/i,
  /server response \d{3}/i,
];

const DLQ_PATTERNS = [
  /execution reverted/i,
  /revert/i,
  /out of gas/i,
  /intrinsic gas too low/i,
  /gas too low/i,
  /invalid opcode/i,
  /stack overflow/i,
];

export function classifyTxError(errorMessage: string): RetryDecision {
  for (const pattern of DLQ_PATTERNS) {
    if (pattern.test(errorMessage)) return "DLQ";
  }
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(errorMessage)) return "RETRY";
  }
  // Unknown errors → DLQ (fail-safe: do not retry blindly)
  return "DLQ";
}

export function isNonceConflict(errorMessage: string): boolean {
  return (
    /nonce too low/i.test(errorMessage) ||
    /nonce already used/i.test(errorMessage)
  );
}
