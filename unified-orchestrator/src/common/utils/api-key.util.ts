import { createHash, randomBytes } from "crypto";

/**
 * Generate a random API key with prefix.
 * Format: pk_<32 hex chars>  (128-bit entropy)
 */
export function generateApiKey(): string {
  return `pk_${randomBytes(16).toString("hex")}`;
}

/**
 * SHA-256 hash of the plaintext key — this is what we store.
 */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Extract the last 4 characters for safe display.
 */
export function keyLast4(plaintext: string): string {
  return plaintext.slice(-4);
}
