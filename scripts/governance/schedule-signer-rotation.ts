/**
 * scripts/governance/schedule-signer-rotation.ts
 *
 * GOVERNANCE DRILL 3A — Schedule setSettlementAgent via factory timelock
 *
 * Computes the timelock ID for setSettlementAgent(newSignerAddr) and schedules it.
 * The actual execution must happen after TIMELOCK_DELAY (24 hours on mainnet;
 * may be shorter on staging if the contract was deployed with a reduced delay).
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key>           \
 *   FACTORY_ADDRESS=<addr>               \
 *   DRILL_NEW_SIGNER_ADDRESS=<new-addr>  \
 *   npx hardhat run scripts/governance/schedule-signer-rotation.ts --network staging
 *
 * Output:
 *   e2e/governance/schedule-signer-rotation-result.json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

function computeTimelockId(iface: ethers.Interface, funcName: string, args: unknown[]): string {
  const fragment = iface.getFunction(funcName)!;
  const paramTypes = fragment.inputs.map((p: { type: string }) => p.type);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes4", ...paramTypes],
    [fragment.selector, ...args],
  );
  return ethers.keccak256(encoded);
}

async function main() {
  const newSignerAddr = process.env.DRILL_NEW_SIGNER_ADDRESS;
  if (!newSignerAddr) throw new Error("DRILL_NEW_SIGNER_ADDRESS environment variable is required");

  const factoryAddr = process.env.FACTORY_ADDRESS
    ?? JSON.parse(fs.readFileSync(path.join(__dirname, "../../e2e/testnet-deployment.json"), "utf-8"))
        .LOAN_FACTORY_ADDRESS;

  const [admin] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, admin);

  const timelockId = computeTimelockId(factory.interface, "setSettlementAgent", [newSignerAddr]);
  const timelockDelay = Number(await factory.TIMELOCK_DELAY());

  console.log(`\n=== GOVERNANCE DRILL: Schedule signer rotation (${factoryAddr}) ===`);
  console.log(`   Admin           : ${adminAddr}`);
  console.log(`   New signer      : ${newSignerAddr}`);
  console.log(`   Timelock ID     : ${timelockId}`);
  console.log(`   Timelock delay  : ${timelockDelay}s (${timelockDelay / 3600}h)`);

  const tx = await factory.scheduleTimelock(timelockId);
  const receipt = await tx.wait(1);

  const scheduledAt  = new Date();
  const executeAfter = new Date(scheduledAt.getTime() + timelockDelay * 1000);

  const result = {
    action: "SCHEDULE_SIGNER_ROTATION",
    factoryAddress: factoryAddr,
    adminAddress: adminAddr,
    newSignerAddress: newSignerAddr,
    timelockId,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    scheduledAt: scheduledAt.toISOString(),
    executeAfter: executeAfter.toISOString(),
    timelockDelaySeconds: timelockDelay,
    network: (await ethers.provider.getNetwork()).name,
    nextStep: `After ${executeAfter.toISOString()} run: DRILL_NEW_SIGNER_ADDRESS=${newSignerAddr} npx hardhat run scripts/governance/execute-signer-rotation.ts --network staging`,
  };

  console.log("\n=== SCHEDULED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "schedule-signer-rotation-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/schedule-signer-rotation-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
