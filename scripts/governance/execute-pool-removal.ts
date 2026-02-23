/**
 * scripts/governance/execute-pool-removal.ts
 *
 * GOVERNANCE DRILL 2C — Execute pool removal after timelock delay
 *
 * Must be run at least TIMELOCK_DELAY seconds after schedule-pool-removal.ts.
 *
 * Effect: pool removed from whitelist — new POOL-model loan funding reverts.
 * Existing funded loans are unaffected.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key>  \
 *   FACTORY_ADDRESS=<addr>      \
 *   POOL_ADDRESS=<pool-addr>    \
 *   npx hardhat run scripts/governance/execute-pool-removal.ts --network staging
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const schedResultPath = path.join(__dirname, "../../e2e/governance/schedule-pool-removal-result.json");

  let poolAddr    = process.env.POOL_ADDRESS;
  let factoryAddr = process.env.FACTORY_ADDRESS;

  if (fs.existsSync(schedResultPath)) {
    const sched = JSON.parse(fs.readFileSync(schedResultPath, "utf-8"));
    poolAddr    ??= sched.poolAddress;
    factoryAddr ??= sched.factoryAddress;
  }

  if (!poolAddr)    throw new Error("POOL_ADDRESS not set and schedule result not found");
  if (!factoryAddr) throw new Error("FACTORY_ADDRESS not set and schedule result not found");

  const [admin] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, admin);

  const wasWhitelisted = await factory.isPool(poolAddr);
  console.log(`\n=== GOVERNANCE DRILL: Execute pool removal (${factoryAddr}) ===`);
  console.log(`   Pool            : ${poolAddr}`);
  console.log(`   Was whitelisted : ${wasWhitelisted}`);

  const tx = await factory.setPool(poolAddr, false);
  const receipt = await tx.wait(1);

  const isWhitelistedAfter = await factory.isPool(poolAddr);
  if (isWhitelistedAfter) throw new Error("Pool is still whitelisted after setPool(addr, false)");

  const result = {
    action: "EXECUTE_POOL_REMOVAL",
    factoryAddress: factoryAddr,
    poolAddress: poolAddr,
    adminAddress: adminAddr,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    executedAt: new Date().toISOString(),
    wasWhitelisted,
    isWhitelistedAfter,
    verified: !isWhitelistedAfter,
    network: (await ethers.provider.getNetwork()).name,
  };

  console.log("\n=== POOL REMOVED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "execute-pool-removal-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/execute-pool-removal-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
