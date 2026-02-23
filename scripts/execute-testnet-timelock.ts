/**
 * Execute scheduled timelock on testnet (run 24h after deploy-testnet.ts).
 * Then fund pool and borrower for E2E.
 *
 * Usage: npx hardhat run scripts/execute-testnet-timelock.ts --network amoy
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E2E_DIR = path.join(__dirname, "..", "e2e");
const DEPLOY_PATH = path.join(E2E_DIR, "testnet-deployment.json");

async function main() {
  if (!fs.existsSync(DEPLOY_PATH)) {
    throw new Error(`Missing ${DEPLOY_PATH}. Run deploy-testnet.ts first.`);
  }
  const deployment = JSON.parse(fs.readFileSync(DEPLOY_PATH, "utf-8"));
  const [deployer] = await ethers.getSigners();
  const factoryAddr = deployment.LOAN_FACTORY_ADDRESS;
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, deployer);
  const wethAddr = deployment.COLLATERAL_TOKEN_ADDRESS;
  const poolAddr = deployment.POOL_ADDRESS;
  const deployerAddr = deployment.DEPLOYER_ADDRESS;

  console.log("\n=== Execute timelock: allowCollateral, setPool, setSettlementAgent, setRequireFiatProof ===");
  await factory.allowCollateral(wethAddr);
  await factory.setPool(poolAddr, true);
  await factory.setSettlementAgent(deployerAddr);
  await factory.setRequireFiatProofBeforeActivate(true);

  console.log("\n=== Fund pool and borrower ===");
  const usdc = await ethers.getContractAt(
    "MockERC20",
    deployment.USDC_ADDRESS,
    deployer,
  );
  const weth = await ethers.getContractAt("MockERC20", wethAddr, deployer);
  const pool = await ethers.getContractAt("UnifiedPool", poolAddr, deployer);
  const DEPOSIT = 1_000_000_000n;
  const COLLATERAL = ethers.parseEther("10");
  await usdc.mint(deployerAddr, DEPOSIT * 10n);
  await usdc.approve(poolAddr, ethers.MaxUint256);
  await pool.deposit(DEPOSIT);
  await weth.mint(deployment.BORROWER_ADDRESS, COLLATERAL);

  deployment.timelockExecutedAt = new Date().toISOString();
  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(deployment, null, 2));
  console.log("   Pool funded, borrower has collateral. Updated", DEPLOY_PATH);
  console.log("   Run E2E: npm run e2e:testnet");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
