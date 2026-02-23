import type { ChainActionType } from "@prisma/client";

/** Returned by a successful `sendAction` call. */
export interface SendResult {
  txHash: string;
  /** On-chain nonce used; stored in ChainAction for RBF. */
  nonce: number;
}

/** Parsed on-chain receipt. */
export interface ChainReceipt {
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
  status: "success" | "reverted";
  revertReason?: string;
  /** For CREATE_LOAN: address of the deployed loan clone. */
  loanContract?: string;
}

/**
 * Abstraction over the on-chain transaction layer.
 *
 * The production implementation (`createEthersChainSender`) uses ethers.js
 * with a deterministic NonceManager and EIP-1559 GasStrategy.
 * Tests supply a mock.
 */
export interface IChainSender {
  /**
   * Send a chain action for the first time.
   * Internally acquires the next sequential nonce.
   * MUST NOT be called when the action already has a txHash.
   */
  sendAction(action: {
    id: string;
    type: ChainActionType;
    payload: Record<string, unknown>;
  }): Promise<SendResult>;

  /**
   * Replace a stuck pending transaction via replace-by-fee (RBF).
   * Sends a new tx with the same calldata, same nonce, and bumped fees.
   * Bypasses the NonceManager; caller must pass the stored nonce.
   */
  bumpAndReplace(action: {
    type: ChainActionType;
    payload: Record<string, unknown>;
    nonce: number;
  }): Promise<{ txHash: string }>;

  /**
   * Non-blocking receipt poll.
   * Returns null when the transaction is still pending in the mempool.
   */
  getReceipt(txHash: string): Promise<ChainReceipt | null>;

  /** Confirms the RPC provider is reachable. Fails startup if false. */
  isHealthy(): Promise<boolean>;
}
