/**
 * scripts/governance/unpause-factory.ts
 *
 * GOVERNANCE DRILL 5A — Unpause UnifiedLoanFactory (Recovery)
 *
 * GATE: Only run after reconciliation is clean (Drill 5 script verifies this).
 *       Running this script does NOT verify reconciliation — that gate is in
 *       governance/scripts/05-recovery.ts.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key> \
 *   FACTORY_ADDRESS=<addr>     \
 *   npx hardhat run scripts/governance/unpause-factory.ts --network staging
 *
 * Output:
 *   e2e/governance/unpause-factory-result.json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const factoryAddr = process.env.FACTORY_ADDRESS
    ?? JSON.parse(fs.readFileSync(path.join(__dirname, "../../e2e/testnet-deployment.json"), "utf-8"))
        .LOAN_FACTORY_ADDRESS;

  const [pauser] = await ethers.getSigners();
  const pauserAddr = await pauser.getAddress();

  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, pauser);

  const PAUSER_ROLE = await factory.PAUSER_ROLE();
  const hasPauserRole = await factory.hasRole(PAUSER_ROLE, pauserAddr);
  if (!hasPauserRole) {
    throw new Error(`Account ${pauserAddr} does not hold PAUSER_ROLE on ${factoryAddr}`);
  }

  const isPausedBefore = await factory.paused();
  if (!isPausedBefore) {
    console.warn("Factory is not paused — no action taken");
    return;
  }

  console.log(`\n=== GOVERNANCE DRILL: Unpausing UnifiedLoanFactory (${factoryAddr}) ===`);
  console.log(`   Pauser : ${pauserAddr}`);

  const tx = await factory.unpause();
  const receipt = await tx.wait(1);

  const isPausedAfter = await factory.paused();
  if (isPausedAfter) throw new Error("Factory did not exit paused state");

  const result = {
    action: "UNPAUSE_FACTORY",
    factoryAddress: factoryAddr,
    pauserAddress: pauserAddr,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    unpausedAt: new Date().toISOString(),
    verifiedUnpaused: !isPausedAfter,
    network: (await ethers.provider.getNetwork()).name,
  };

  console.log("=== UNPAUSED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "unpause-factory-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/unpause-factory-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
