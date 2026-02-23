/**
 * scripts/governance/execute-signer-rotation.ts
 *
 * GOVERNANCE DRILL 3B — Execute setSettlementAgent after timelock delay
 *
 * Must be run at least TIMELOCK_DELAY seconds after schedule-signer-rotation.ts.
 * Reads the schedule result from e2e/governance/schedule-signer-rotation-result.json
 * or uses DRILL_NEW_SIGNER_ADDRESS env var.
 *
 * After execution:
 *   - factory.settlementAgent() returns newSignerAddress
 *   - Old signer can no longer submit recordFiatDisbursement / recordFiatRepayment
 *
 * Usage:
 *   DEPLOYER_PRIVATE_KEY=<key>           \
 *   FACTORY_ADDRESS=<addr>               \
 *   DRILL_NEW_SIGNER_ADDRESS=<new-addr>  \
 *   npx hardhat run scripts/governance/execute-signer-rotation.ts --network staging
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const scheduleResultPath = path.join(__dirname, "../../e2e/governance/schedule-signer-rotation-result.json");

  let newSignerAddr = process.env.DRILL_NEW_SIGNER_ADDRESS;
  let factoryAddr   = process.env.FACTORY_ADDRESS;

  if (fs.existsSync(scheduleResultPath)) {
    const sched = JSON.parse(fs.readFileSync(scheduleResultPath, "utf-8"));
    newSignerAddr ??= sched.newSignerAddress;
    factoryAddr   ??= sched.factoryAddress;
  }

  if (!newSignerAddr) throw new Error("DRILL_NEW_SIGNER_ADDRESS not set and schedule result not found");
  factoryAddr ??= JSON.parse(fs.readFileSync(
    path.join(__dirname, "../../e2e/testnet-deployment.json"), "utf-8",
  )).LOAN_FACTORY_ADDRESS;

  const [admin] = await ethers.getSigners();
  const adminAddr = await admin.getAddress();
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, admin);

  const currentAgent  = await factory.settlementAgent();
  const TIMELOCK_DELAY = Number(await factory.TIMELOCK_DELAY());

  console.log(`\n=== GOVERNANCE DRILL: Execute signer rotation (${factoryAddr}) ===`);
  console.log(`   Admin           : ${adminAddr}`);
  console.log(`   Current agent   : ${currentAgent}`);
  console.log(`   New agent       : ${newSignerAddr}`);

  const tx = await factory.setSettlementAgent(newSignerAddr);
  const receipt = await tx.wait(1);

  const newAgent = await factory.settlementAgent();
  if (newAgent.toLowerCase() !== newSignerAddr.toLowerCase()) {
    throw new Error(`setSettlementAgent did not update: expected ${newSignerAddr}, got ${newAgent}`);
  }

  const result = {
    action: "EXECUTE_SIGNER_ROTATION",
    factoryAddress: factoryAddr,
    adminAddress: adminAddr,
    oldSettlementAgent: currentAgent,
    newSettlementAgent: newAgent,
    txHash: receipt!.hash,
    blockNumber: receipt!.blockNumber,
    executedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
    verified: newAgent.toLowerCase() === newSignerAddr.toLowerCase(),
  };

  console.log("\n=== SIGNER ROTATION EXECUTED ===");
  console.log(JSON.stringify(result, null, 2));

  const outDir = path.join(__dirname, "../../e2e/governance");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "execute-signer-rotation-result.json"), JSON.stringify(result, null, 2));
  console.log(`\nEvidence written to e2e/governance/execute-signer-rotation-result.json`);
  console.log(`\nNext: Update CHAIN_ACTION_SIGNER_PRIVATE_KEY in secrets manager and restart orchestrator.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
