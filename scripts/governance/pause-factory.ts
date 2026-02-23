/**
 * scripts/governance/pause-factory.ts
 *
 * GOVERNANCE DRILL 2A — Pause UnifiedLoanFactory
 *
 * Caller must hold PAUSER_ROLE on the factory. On staging the deployer account
 * is granted PAUSER_ROLE in deploy.ts.
 *
 * Effect: blocks createLoan() — new loan originations fail with Pausable: paused.
 * Safe exits: repayments, collateral release, pool withdrawals are unaffected.
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key> \
 *   FACTORY_ADDRESS=<addr>     \
 *   npx hardhat run scripts/governance/pause-factory.ts --network staging
 *
 * Output:
 *   e2e/governance/pause-factory-result.json
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
  if (isPausedBefore) {
    console.warn("Factory is already paused — no action taken");
    return;
  }

  console.log(`\n=== GOVERNANCE DRILL: Pausing UnifiedLoanFactory (${factoryAddr}) ===`);
  console.log(`   Pauser : ${pauserAddr}`);

  const tx = await factory.pause();
  const receipt = await tx.wait(1);

  const isPausedAfter = await factory.paused();
  if (!isPausedAfter) throw new Error("Factory did not enter paused state");

  const result = {
    action: "PAUSE_FACTORY",
    factoryAddress: factoryAddr,
    pauserAddress: pauserAddr,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    pausedAt: new Date().toISOString(),
    verifiedPaused: isPausedAfter,
    network: (await ethers.provider.getNetwork()).name,
  };

  console.log("=== PAUSED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "pause-factory-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/pause-factory-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
