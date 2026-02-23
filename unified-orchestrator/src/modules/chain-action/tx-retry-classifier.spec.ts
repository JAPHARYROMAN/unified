import { classifyTxError, isNonceConflict } from "./tx-retry-classifier";

describe("TxRetryClassifier", () => {
  describe("classifyTxError", () => {
    const retryable = [
      "nonce too low",
      "Nonce Too Low",
      "nonce already used",
      "replacement transaction underpriced",
      "replacement fee too low",
      "transaction underpriced",
      "timeout waiting for response",
      "ETIMEDOUT: connection timed out",
      "ECONNRESET: socket hang up",
      "ECONNREFUSED: connection refused",
      "network error: failed to fetch",
      "could not detect network",
      "missing response",
      "server response 503",
    ];

    const dlq = [
      "execution reverted: Unauthorized()",
      "execution reverted: InsufficientCollateral()",
      "revert: invalid state",
      "out of gas",
      "intrinsic gas too low",
      "gas too low",
      "invalid opcode",
      "stack overflow",
      "some completely unknown error",
    ];

    it.each(retryable)("classifies '%s' as RETRY", (msg) => {
      expect(classifyTxError(msg)).toBe("RETRY");
    });

    it.each(dlq)("classifies '%s' as DLQ", (msg) => {
      expect(classifyTxError(msg)).toBe("DLQ");
    });
  });

  describe("isNonceConflict", () => {
    it("detects nonce too low", () => {
      expect(isNonceConflict("nonce too low")).toBe(true);
    });
    it("detects nonce already used", () => {
      expect(isNonceConflict("Nonce already used")).toBe(true);
    });
    it("returns false for non-nonce errors", () => {
      expect(isNonceConflict("execution reverted")).toBe(false);
      expect(isNonceConflict("timeout")).toBe(false);
    });
  });
});
