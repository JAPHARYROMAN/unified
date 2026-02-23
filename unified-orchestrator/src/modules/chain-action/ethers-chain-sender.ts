import { ethers } from "ethers";
import { Logger } from "@nestjs/common";
import type { ChainActionType } from "@prisma/client";
import { NonceManager } from "./nonce-manager";
import { GasStrategy } from "./gas-strategy";
import type {
  IChainSender,
  SendResult,
  ChainReceipt,
} from "./chain-sender.types";

// ─── ABI fragments ────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  "function createLoan((uint8 fundingModel, uint8 repaymentModel, address borrower, address collateralToken, uint256 collateralAmount, uint256 principalAmount, uint256 interestRateBps, uint256 durationSeconds, uint256 gracePeriodSeconds, uint256 fundingDeadline, address pool)) returns (uint256 loanId, address loan)",
  "event LoanCreated(uint256 indexed loanId, address indexed loanAddress, address indexed borrower, uint8 fundingModel, uint256 principal, address collateralToken, uint256 collateralAmount)",
];

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a production IChainSender backed by ethers.js.
 *
 * Features:
 *  - Deterministic nonce management via NonceManager (single writer, no gaps).
 *  - EIP-1559 fee estimation with 20% gas-limit buffer (GasStrategy).
 *  - Replace-by-fee (RBF) via bumpAndReplace() — 30% fee bump.
 *  - Non-blocking receipt polling with revert-reason extraction.
 *  - Fails fast if any required config value is missing.
 */
export function createEthersChainSender(config: {
  rpcUrl: string;
  factoryAddress: string;
  privateKey: string;
}): IChainSender {
  // Fail-fast: missing config crashes the service at startup rather than
  // silently producing a non-functional sender.
  if (!config.rpcUrl) throw new Error("CHAIN_ACTION_RPC_URL is required");
  if (!config.factoryAddress)
    throw new Error("CHAIN_ACTION_FACTORY_ADDRESS is required");
  if (!config.privateKey)
    throw new Error("CHAIN_ACTION_SIGNER_PRIVATE_KEY is required");

  const logger = new Logger("EthersChainSender");
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const signer = new ethers.Wallet(config.privateKey, provider);
  const nonceManager = new NonceManager(provider, signer.address);
  const gasStrategy = new GasStrategy(provider);
  const factoryIface = new ethers.Interface(FACTORY_ABI);

  // ── Calldata builders per action type ─────────────────────────────────────

  function buildCalldata(
    type: ChainActionType,
    payload: Record<string, unknown>,
  ): { to: string; data: string } {
    switch (type) {
      case "CREATE_LOAN": {
        const params = {
          fundingModel: Number(payload.fundingModel ?? 2),
          repaymentModel: Number(payload.repaymentModel ?? 0),
          borrower: payload.borrower as string,
          collateralToken: payload.collateralToken as string,
          collateralAmount: BigInt(
            (payload.collateralAmount as string) ?? "0",
          ),
          principalAmount: BigInt((payload.principal as string) ?? "0"),
          interestRateBps: Number(payload.interestRateBps ?? 0),
          durationSeconds: Number(payload.duration ?? 0),
          gracePeriodSeconds: Number(payload.gracePeriodSeconds ?? 0),
          fundingDeadline: Number(payload.fundingDeadline ?? 0),
          pool: (payload.pool as string) ?? ethers.ZeroAddress,
        };
        return {
          to: config.factoryAddress,
          data: factoryIface.encodeFunctionData("createLoan", [params]),
        };
      }
      // Additional action types will be added here as their loan contract
      // ABI fragments are finalised (FUND_LOAN, ACTIVATE_LOAN, REPAY, etc.).
      default:
        throw new Error(`Unsupported action type: ${type}`);
    }
  }

  // ── Receipt helpers ────────────────────────────────────────────────────────

  async function parseLoanContract(
    receipt: ethers.TransactionReceipt,
  ): Promise<string | undefined> {
    const factoryLog = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === config.factoryAddress.toLowerCase(),
    );
    if (!factoryLog) return undefined;
    try {
      const parsed = factoryIface.parseLog({
        topics: factoryLog.topics as string[],
        data: factoryLog.data,
      });
      if (parsed?.name === "LoanCreated") return parsed.args[1] as string;
    } catch {
      /* non-matching log — ignore */
    }
    return undefined;
  }

  async function tryDecodeRevertReason(
    txHash: string,
    blockNumber: number,
  ): Promise<string | undefined> {
    try {
      const tx = await provider.getTransaction(txHash);
      if (tx) await provider.call({ ...tx, blockTag: blockNumber });
    } catch (e: any) {
      return e?.shortMessage ?? e?.revert?.name ?? e?.message ?? "reverted";
    }
    return undefined;
  }

  // ── IChainSender implementation ────────────────────────────────────────────

  return {
    async sendAction(action: {
      id: string;
      type: ChainActionType;
      payload: Record<string, unknown>;
    }): Promise<SendResult> {
      const { to, data } = buildCalldata(action.type, action.payload);
      const fees = await gasStrategy.estimateFees();
      const txBase = {
        to,
        data,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        type: 2 as const,
      };
      const gasLimit = await gasStrategy.estimateGasLimit(txBase);

      return nonceManager.withNonce(async (nonce) => {
        const tx = await signer.sendTransaction({ ...txBase, gasLimit, nonce });
        logger.log(
          `Action ${action.id} submitted — type=${action.type} txHash=${tx.hash} nonce=${nonce} gasLimit=${gasLimit}`,
        );
        return { txHash: tx.hash, nonce };
      });
    },

    async bumpAndReplace(action: {
      type: ChainActionType;
      payload: Record<string, unknown>;
      nonce: number;
    }): Promise<{ txHash: string }> {
      const { to, data } = buildCalldata(action.type, action.payload);
      const fees = await gasStrategy.estimateFees();
      const bumped = gasStrategy.bumpFees(fees);

      const tx = await signer.sendTransaction({
        to,
        data,
        nonce: action.nonce, // Same nonce — evicts the stuck tx
        maxFeePerGas: bumped.maxFeePerGas,
        maxPriorityFeePerGas: bumped.maxPriorityFeePerGas,
        type: 2,
      });

      logger.log(
        `RBF submitted — type=${action.type} nonce=${action.nonce} newTxHash=${tx.hash} maxFee=${bumped.maxFeePerGas}`,
      );

      // Re-sync so NonceManager stays consistent after out-of-band send.
      await nonceManager.resync();
      return { txHash: tx.hash };
    },

    async getReceipt(txHash: string): Promise<ChainReceipt | null> {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) return null; // Still pending

      const status = receipt.status === 1 ? "success" : "reverted";
      const result: ChainReceipt = {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        status,
      };

      if (status === "reverted") {
        result.revertReason = await tryDecodeRevertReason(
          txHash,
          receipt.blockNumber,
        );
      } else {
        result.loanContract = await parseLoanContract(receipt);
      }

      return result;
    },

    async isHealthy(): Promise<boolean> {
      try {
        await provider.getBlockNumber();
        return true;
      } catch {
        return false;
      }
    },
  };
}
