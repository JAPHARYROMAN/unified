import type { Provider, TransactionRequest } from "ethers";

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

// 30% bump — well above the EIP-1559 minimum of 10% for RBF.
const BUMP_NUM = 13n;
const BUMP_DEN = 10n;

// 20% gas-limit buffer on top of the estimateGas result.
const GAS_BUFFER_NUM = 12n;
const GAS_BUFFER_DEN = 10n;

/**
 * Gas fee estimation and replace-by-fee (RBF) bump strategy.
 *
 * Prefers EIP-1559 (type-2) transactions. Falls back to legacy gasPrice
 * when the network reports no baseFee.
 */
export class GasStrategy {
  constructor(private readonly provider: Provider) {}

  /** Estimate current network fees for a new transaction. */
  async estimateFees(): Promise<FeeEstimate> {
    const feeData = await this.provider.getFeeData();

    if (
      feeData.maxFeePerGas !== null &&
      feeData.maxPriorityFeePerGas !== null
    ) {
      // EIP-1559 network (Polygon PoS, Ethereum mainnet, etc.)
      return {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
    }

    // Legacy network (e.g. private geth without EIP-1559)
    const gasPrice = feeData.gasPrice ?? 1_000_000_000n;
    return {
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
    };
  }

  /**
   * Bump fees by 30% for replace-by-fee.
   * The returned values always satisfy the EIP-1559 minimum replacement rule
   * (>= old * 1.1).
   */
  bumpFees(original: FeeEstimate): FeeEstimate {
    return {
      maxFeePerGas: (original.maxFeePerGas * BUMP_NUM) / BUMP_DEN,
      maxPriorityFeePerGas:
        (original.maxPriorityFeePerGas * BUMP_NUM) / BUMP_DEN,
    };
  }

  /** Estimate gas for a transaction and add a 20% safety buffer. */
  async estimateGasLimit(tx: TransactionRequest): Promise<bigint> {
    const estimated = await this.provider.estimateGas(tx);
    return (estimated * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
  }
}
