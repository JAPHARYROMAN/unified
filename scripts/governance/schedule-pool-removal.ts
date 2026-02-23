/**
 * scripts/governance/schedule-pool-removal.ts
 *
 * GOVERNANCE DRILL 2B — Schedule pool removal via factory timelock
 *
 * Schedules setPool(poolAddr, false) — removing the pool from the whitelist.
 * Once executed, new POOL-model loans cannot be funded (createLoan still works
 * but funding reverts with PoolNotWhitelisted).
 *
 * Used in Drill 2 as the governance-path alternative to direct pause.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key>  \
 *   FACTORY_ADDRESS=<addr>      \
 *   POOL_ADDRESS=<pool-addr>    \
 *   npx hardhat run scripts/governance/schedule-pool-removal.ts --network staging
 *
 * Output:
 *   e2e/governance/schedule-pool-removal-result.json
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
  let poolAddr    = process.env.POOL_ADDRESS;
  let factoryAddr = process.env.FACTORY_ADDRESS;

  const deployPath = path.join(__dirname, "../../e2e/testnet-deployment.json");
  if (fs.existsSync(deployPath)) {
    const deploy = JSON.parse(fs.readFileSync(deployPath, "utf-8"));
    factoryAddr ??= deploy.LOAN_FACTORY_ADDRESS;
    poolAddr    ??= deploy.POOL_ADDRESS;
  }

  if (!poolAddr)    throw new Error("POOL_ADDRESS not set");
  if (!factoryAddr) throw new Error("FACTORY_ADDRESS not set");

  const [admin] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, admin);

  // Schedule setPool(poolAddr, false)
  const timelockId    = computeTimelockId(factory.interface, "setPool", [poolAddr, false]);
  const timelockDelay = Number(await factory.TIMELOCK_DELAY());

  const isCurrentlyWhitelisted = await factory.isPool(poolAddr);
  console.log(`\n=== GOVERNANCE DRILL: Schedule pool removal (${factoryAddr}) ===`);
  console.log(`   Pool            : ${poolAddr}`);
  console.log(`   Currently whitelisted: ${isCurrentlyWhitelisted}`);
  console.log(`   Timelock ID     : ${timelockId}`);
  console.log(`   Timelock delay  : ${timelockDelay}s (${timelockDelay / 3600}h)`);

  const tx = await factory.scheduleTimelock(timelockId);
  const receipt = await tx.wait(1);

  const scheduledAt  = new Date();
  const executeAfter = new Date(scheduledAt.getTime() + timelockDelay * 1000);

  const result = {
    action: "SCHEDULE_POOL_REMOVAL",
    factoryAddress: factoryAddr,
    poolAddress: poolAddr,
    adminAddress: adminAddr,
    timelockId,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    scheduledAt: scheduledAt.toISOString(),
    executeAfter: executeAfter.toISOString(),
    timelockDelaySeconds: timelockDelay,
    network: (await ethers.provider.getNetwork()).name,
    nextStep: `After ${executeAfter.toISOString()} run: npx hardhat run scripts/governance/execute-pool-removal.ts --network staging`,
  };

  console.log("\n=== SCHEDULED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "schedule-pool-removal-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/schedule-pool-removal-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
