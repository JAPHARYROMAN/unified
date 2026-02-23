/**
 * tasks/timelock.ts
 *
 * Hardhat tasks for the Unified protocol 24-hour timelock governance flow.
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 * Step 1 – schedule the operation (must be done 24 h before execution):
 *
 *   npx hardhat timelock:schedule \
 *     --contract  <factory|feeManager>     \
 *     --address   <contract address>       \
 *     --func      <function name>          \
 *     --args      '<JSON array of args>'   \
 *     --network   <network>
 *
 * Step 2 – execute (after 24 h has elapsed):
 *
 *   npx hardhat timelock:execute \
 *     --contract  <factory|feeManager>     \
 *     --address   <contract address>       \
 *     --func      <function name>          \
 *     --args      '<JSON array of args>'   \
 *     --network   <network>
 *
 * Step 3 – (optional) cancel a pending operation:
 *
 *   npx hardhat timelock:cancel \
 *     --contract  <factory|feeManager>     \
 *     --address   <contract address>       \
 *     --func      <function name>          \
 *     --args      '<JSON array of args>'   \
 *     --network   <network>
 *
 * Step 4 – inspect a scheduled operation's ready timestamp:
 *
 *   npx hardhat timelock:status \
 *     --contract  <factory|feeManager>     \
 *     --address   <contract address>       \
 *     --func      <function name>          \
 *     --args      '<JSON array of args>'   \
 *     --network   <network>
 *
 * ─── Supported timelocked functions ──────────────────────────────────────────
 *
 *   UnifiedLoanFactory (factory):
 *     setLoanImplementation(address)
 *     setFeeManager(address)
 *     setCollateralVault(address)
 *     setTreasury(address)
 *     setRiskRegistry(address)
 *     setPool(address, bool)
 *     setIdentityRegistry(address)
 *     setKycRequired(bool)
 *     setEnforceJurisdiction(bool)
 *     setEnforceTierCaps(bool)
 *     setRequireFiatProofBeforeActivate(bool)
 *     setSettlementAgent(address)
 *     setAllowedCollateral(address, bool)
 *     allowCollateral(address)
 *     setMinCollateralRatioBps(address, uint256)
 *
 *   UnifiedFeeManager (feeManager):
 *     setFees(uint256, uint256, uint256)
 *     setTreasury(address)
 */

import { task, types } from "hardhat/config";
import { ethers } from "ethers";

// ─── Supported ABI fragments ─────────────────────────────────────────────────

const ABI_FRAGMENTS: Record<string, string> = {
  // Factory
  setLoanImplementation: "function setLoanImplementation(address impl)",
  setFeeManager:         "function setFeeManager(address addr)",
  setCollateralVault:    "function setCollateralVault(address addr)",
  setTreasury:           "function setTreasury(address addr)",
  setRiskRegistry:       "function setRiskRegistry(address addr)",
  setPool:               "function setPool(address pool, bool allowed)",
  setIdentityRegistry:   "function setIdentityRegistry(address ir)",
  setKycRequired:        "function setKycRequired(bool on)",
  setEnforceJurisdiction:"function setEnforceJurisdiction(bool on)",
  setEnforceTierCaps:    "function setEnforceTierCaps(bool on)",
  setRequireFiatProofBeforeActivate: "function setRequireFiatProofBeforeActivate(bool on)",
  setSettlementAgent:    "function setSettlementAgent(address agent)",
  setAllowedCollateral:  "function setAllowedCollateral(address token, bool allowed)",
  allowCollateral:       "function allowCollateral(address token)",
  setMinCollateralRatioBps: "function setMinCollateralRatioBps(address token, uint256 bps)",
  // FeeManager
  setFees: "function setFees(uint256 originationFeeBps, uint256 interestFeeBps, uint256 lateFeeBps)",
};

// ─── Timelock ABI (common to both contracts) ──────────────────────────────────

const TIMELOCK_ABI = [
  "function scheduleTimelock(bytes32 id) external",
  "function cancelTimelock(bytes32 id) external",
  "function timelockScheduled(bytes32) external view returns (uint256)",
  ...Object.values(ABI_FRAGMENTS),
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the timelock id matching Solidity's keccak256(abi.encode(selector, ...args)).
 * This must be kept in sync with _consumeTimelock() in both contracts.
 */
function computeId(funcSig: string, rawArgs: unknown[]): string {
  const iface = new ethers.Interface([`function ${funcSig}`]);
  const funcName = funcSig.split("(")[0].trim();
  const fragment = iface.getFunction(funcName)!;
  const paramTypes = fragment.inputs.map((p) => p.type);

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes4", ...paramTypes],
    [fragment.selector, ...rawArgs],
  );
  return ethers.keccak256(encoded);
}

/**
 * Parse the --func argument to find the matching ABI fragment, then compute id.
 */
function resolveId(funcName: string, args: unknown[]): { id: string; sig: string } {
  const frag = ABI_FRAGMENTS[funcName];
  if (!frag) {
    throw new Error(
      `Unknown function "${funcName}". Supported: ${Object.keys(ABI_FRAGMENTS).join(", ")}`,
    );
  }
  // Strip "function " prefix for computeId
  const sig = frag.replace(/^function\s+/, "");
  return { id: computeId(sig, args), sig };
}

/**
 * Parse the --args JSON string into an array.
 */
function parseArgs(raw: string): unknown[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("args must be a JSON array");
    return parsed;
  } catch (e: any) {
    throw new Error(`Failed to parse --args JSON: ${e.message}`);
  }
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

task("timelock:schedule", "Schedule a timelocked admin action (24 h before execution)")
  .addParam("address", "Address of the target contract", undefined, types.string)
  .addParam("func",    "Function name (e.g. setFeeManager)",  undefined, types.string)
  .addOptionalParam("args", "JSON array of call arguments (e.g. '[\"0x...\"]')", "[]", types.string)
  .setAction(async (taskArgs, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const args = parseArgs(taskArgs.args);
    const { id, sig } = resolveId(taskArgs.func, args);

    console.log(`Scheduling: ${sig} with args ${JSON.stringify(args)}`);
    console.log(`Timelock ID: ${id}`);

    const contract = new hre.ethers.Contract(taskArgs.address, TIMELOCK_ABI, signer);
    const tx = await contract.scheduleTimelock(id);
    const receipt = await tx.wait();

    console.log(`Scheduled in tx ${receipt?.hash}`);
    console.log(`Execution available after: ${new Date(Date.now() + 24 * 3600 * 1000).toISOString()}`);
  });

task("timelock:execute", "Execute a previously scheduled timelocked admin action")
  .addParam("address", "Address of the target contract", undefined, types.string)
  .addParam("func",    "Function name (e.g. setFeeManager)",  undefined, types.string)
  .addOptionalParam("args", "JSON array of call arguments", "[]", types.string)
  .setAction(async (taskArgs, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const rawArgs = parseArgs(taskArgs.args);
    const { id } = resolveId(taskArgs.func, rawArgs);

    const contract = new hre.ethers.Contract(taskArgs.address, TIMELOCK_ABI, signer);

    // Pre-flight: confirm the timelock is ready
    const readyAt: bigint = await contract.timelockScheduled(id);
    if (readyAt === 0n) {
      throw new Error(`Timelock ${id} has not been scheduled`);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < readyAt) {
      const remaining = Number(readyAt - now);
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      throw new Error(`Timelock not ready yet — ${h}h ${m}m remaining (ready at ${new Date(Number(readyAt) * 1000).toISOString()})`);
    }

    console.log(`Executing: ${taskArgs.func}(${rawArgs.join(", ")})`);

    const tx = await contract[taskArgs.func](...rawArgs);
    const receipt = await tx.wait();

    console.log(`Executed in tx ${receipt?.hash}`);
  });

task("timelock:cancel", "Cancel a pending timelocked operation")
  .addParam("address", "Address of the target contract", undefined, types.string)
  .addParam("func",    "Function name",                  undefined, types.string)
  .addOptionalParam("args", "JSON array of call arguments", "[]", types.string)
  .setAction(async (taskArgs, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const args = parseArgs(taskArgs.args);
    const { id } = resolveId(taskArgs.func, args);

    const contract = new hre.ethers.Contract(taskArgs.address, TIMELOCK_ABI, signer);
    const tx = await contract.cancelTimelock(id);
    const receipt = await tx.wait();

    console.log(`Cancelled timelock ${id} in tx ${receipt?.hash}`);
  });

task("timelock:status", "Check the status of a scheduled timelocked operation")
  .addParam("address", "Address of the target contract", undefined, types.string)
  .addParam("func",    "Function name",                  undefined, types.string)
  .addOptionalParam("args", "JSON array of call arguments", "[]", types.string)
  .setAction(async (taskArgs, hre) => {
    const [signer] = await hre.ethers.getSigners();
    const args = parseArgs(taskArgs.args);
    const { id, sig } = resolveId(taskArgs.func, args);

    console.log(`Function:   ${sig}`);
    console.log(`Args:       ${JSON.stringify(args)}`);
    console.log(`Timelock ID: ${id}`);

    const contract = new hre.ethers.Contract(taskArgs.address, TIMELOCK_ABI, signer);
    const readyAt: bigint = await contract.timelockScheduled(id);

    if (readyAt === 0n) {
      console.log("Status: NOT SCHEDULED");
    } else {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const readyDate = new Date(Number(readyAt) * 1000).toISOString();
      if (now >= readyAt) {
        console.log(`Status: READY (was scheduled for ${readyDate})`);
      } else {
        const remaining = Number(readyAt - now);
        const h = Math.floor(remaining / 3600);
        const m = Math.floor((remaining % 3600) / 60);
        console.log(`Status: PENDING — ready at ${readyDate} (${h}h ${m}m remaining)`);
      }
    }
  });
