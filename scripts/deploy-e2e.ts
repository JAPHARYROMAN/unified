/**
 * E2E deployment: Mock USDC → real deploy.ts → Pool + allow collateral/pool (timelock) → fund pool + borrower.
 * Writes e2e/deployment.json for the smoke runner and orchestrator.
 * Run: npx hardhat run scripts/deploy-e2e.ts --network localhost
 */
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import * as fs from "fs";
import * as path from "path";
import { main as deployMain } from "./deploy";

const TIMELOCK_DELAY = 24 * 3600;
const E2E_DIR = path.join(__dirname, "..", "e2e");

function computeTimelockId(iface: ethers.Interface, funcName: string, args: unknown[]): string {
  const fragment = iface.getFunction(funcName)!;
  const paramTypes = fragment.inputs.map((p: { type: string }) => p.type);
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes4", ...paramTypes],
    [fragment.selector, ...args],
  );
  return ethers.keccak256(encoded);
}

async function timelockExec(contract: { interface: ethers.Interface; scheduleTimelock: (id: string) => Promise<unknown>; [k: string]: unknown }, funcName: string, args: unknown[]) {
  const id = computeTimelockId(contract.interface, funcName, args);
  await contract.scheduleTimelock(id);
  await time.increase(TIMELOCK_DELAY);
  await (contract as any)[funcName](...args);
}

async function main() {
  const [deployer, , borrower] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const borrowerAddr = await borrower.getAddress();

  console.log("\n=== E2E: Deploy Mock USDC ===");
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const usdcAddr = await usdc.getAddress();
  console.log("USDC (mock):", usdcAddr);

  process.env.USDC_ADDRESS = usdcAddr;
  if (!fs.existsSync(E2E_DIR)) fs.mkdirSync(E2E_DIR, { recursive: true });
  const deployOutPath = path.join(E2E_DIR, "deployment-base.json");
  process.env.E2E_DEPLOY_OUTPUT = deployOutPath;

  console.log("\n=== E2E: Run real deploy script ===");
  await deployMain();

  const base = JSON.parse(fs.readFileSync(deployOutPath, "utf-8"));
  const factoryAddr = base.LOAN_FACTORY_ADDRESS;
  const vaultAddr = base.COLLATERAL_VAULT_ADDRESS;
  const treasuryAddr = base.TREASURY_ADDRESS;

  console.log("\n=== E2E: Deploy WETH (collateral) and Pool ===");
  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
  const wethAddr = await weth.getAddress();

  const Pool = await ethers.getContractFactory("UnifiedPool");
  const partnerIdBytes = ethers.encodeBytes32String("e2e-partner");
  const pool = await Pool.deploy(deployerAddr, usdcAddr, partnerIdBytes);
  const poolAddr = await pool.getAddress();
  console.log("Pool:", poolAddr);

  const factory = await ethers.getContractAt("UnifiedLoanFactory", factoryAddr, deployer);

  console.log("\n=== E2E: Timelock allowCollateral + setPool ===");
  await timelockExec(factory, "allowCollateral", [wethAddr]);
  await timelockExec(factory, "setPool", [poolAddr, true]);

  const loanRegistrarRole = await pool.LOAN_REGISTRAR_ROLE();
  await pool.grantRole(loanRegistrarRole, factoryAddr);
  console.log("  ✓ Pool LOAN_REGISTRAR_ROLE → factory");

  console.log("\n=== E2E: Fund pool and borrower ===");
  const DEPOSIT = 1_000_000_000n; // 1000 USDC (6 decimals)
  const COLLATERAL = ethers.parseEther("10");
  await usdc.mint(deployerAddr, DEPOSIT * 10n);
  await usdc.connect(deployer).approve(poolAddr, ethers.MaxUint256);
  await pool.connect(deployer).deposit(DEPOSIT);
  await weth.mint(borrowerAddr, COLLATERAL);
  console.log("  ✓ Pool funded, borrower has collateral");

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const deployment = {
    ...base,
    POOL_ADDRESS: poolAddr,
    COLLATERAL_TOKEN_ADDRESS: wethAddr,
    BORROWER_ADDRESS: borrowerAddr,
    DEPLOYER_ADDRESS: deployerAddr,
    CHAIN_ID: Number(chainId),
  };

  const outPath = path.join(E2E_DIR, "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2));
  console.log("\n=== E2E deployment written to", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
