/**
 * Deploy Unified to public testnet (Amoy). Uses real deploy.ts.
 * Deploys mock USDC, core contracts, pool + collateral token, then schedules (does not execute) timelock.
 * After 24h run execute-testnet-timelock.ts, then run e2e:testnet.
 *
 * Usage: AMOY_RPC_URL=... DEPLOYER_PRIVATE_KEY=... npx hardhat run scripts/deploy-testnet.ts --network amoy
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { main as deployMain } from "./deploy";

const E2E_DIR = path.join(__dirname, "..", "e2e");
const DEPLOY_OUT = path.join(E2E_DIR, "testnet-deployment.json");

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
  const [deployer, , borrower] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const borrowerAddr = await borrower.getAddress();

  console.log("\n=== Testnet: Deploy Mock USDC ===");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const usdcAddr = await usdc.getAddress();

  process.env.USDC_ADDRESS = usdcAddr;
  if (!fs.existsSync(E2E_DIR)) fs.mkdirSync(E2E_DIR, { recursive: true });
  const basePath = path.join(E2E_DIR, "testnet-deployment-base.json");
  process.env.E2E_DEPLOY_OUTPUT = basePath;

  console.log("\n=== Testnet: Run real deploy script ===");
  await deployMain();

  const base = JSON.parse(fs.readFileSync(basePath, "utf-8"));
  const factoryAddr = base.LOAN_FACTORY_ADDRESS;
  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, deployer);

  console.log("\n=== Testnet: Deploy WETH and Pool ===");
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();
  const Pool = await ethers.getContractFactory("UnifiedPool");
  const pool = await Pool.deploy(deployerAddr, usdcAddr, ethers.encodeBytes32String("testnet-qa"));
  const poolAddr = await pool.getAddress();

  console.log("\n=== Testnet: Schedule timelock (allowCollateral, setPool, settlementAgent, requireFiatProof) ===");
  await factory.scheduleTimelock(computeTimelockId(factory.interface, "allowCollateral", [wethAddr]));
  await factory.scheduleTimelock(computeTimelockId(factory.interface, "setPool", [poolAddr, true]));
  await factory.scheduleTimelock(computeTimelockId(factory.interface, "setSettlementAgent", [deployerAddr]));
  await factory.scheduleTimelock(computeTimelockId(factory.interface, "setRequireFiatProofBeforeActivate", [true]));

  const loanRegistrarRole = await pool.LOAN_REGISTRAR_ROLE();
  await pool.grantRole(loanRegistrarRole, factoryAddr);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const timelockScheduledAt = new Date().toISOString();

  const deployment = {
    ...base,
    POOL_ADDRESS: poolAddr,
    COLLATERAL_TOKEN_ADDRESS: wethAddr,
    BORROWER_ADDRESS: borrowerAddr,
    DEPLOYER_ADDRESS: deployerAddr,
    SETTLEMENT_AGENT_ADDRESS: deployerAddr,
    CHAIN_ID: chainId,
    RPC_URL: process.env.BASE_SEPOLIA_RPC_URL || process.env.AMOY_RPC_URL || "",
    timelockScheduledAt,
    timelockDelayHours: 24,
    nextStep: "After 24h run: npx hardhat run scripts/execute-testnet-timelock.ts --network amoy",
  };

  fs.writeFileSync(DEPLOY_OUT, JSON.stringify(deployment, null, 2));
  console.log("\n=== Testnet deployment written to", DEPLOY_OUT);
  console.log("   Wait 24h then run: npx hardhat run scripts/execute-testnet-timelock.ts --network amoy");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
