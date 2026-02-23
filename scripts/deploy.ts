import { ethers } from "hardhat";

// ─── helpers ──────────────────────────────────────────────────────────────────

function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) {
    throw new Error(`[DEPLOY ASSERTION FAILED] ${msg}`);
  }
}

async function assertRole(
  contract: any,
  roleGetter: string,
  holder: string,
  label: string,
): Promise<void> {
  const role: string = await contract[roleGetter]();
  const has: boolean = await contract.hasRole(role, holder);
  assert(has, `${label}: ${holder} does not hold ${roleGetter}`);
  console.log(`  ✓ ${label}`);
}

async function assertAddress(
  actual: string,
  expected: string,
  label: string,
): Promise<void> {
  assert(
    actual.toLowerCase() === expected.toLowerCase(),
    `${label}: expected ${expected}, got ${actual}`,
  );
  console.log(`  ✓ ${label}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying Unified with ${deployer.address}`);

  const usdcAddress = process.env.USDC_ADDRESS;
  if (!usdcAddress) {
    throw new Error("Missing USDC_ADDRESS in environment");
  }

  // ── 1. UnifiedTreasury ─────────────────────────────────────────────────────
  const Treasury = await ethers.getContractFactory("UnifiedTreasury");
  const treasury = await Treasury.deploy(deployer.address);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log(`Treasury:           ${treasuryAddr}`);

  // ── 2. UnifiedFeeManager ───────────────────────────────────────────────────
  const FeeManager = await ethers.getContractFactory("UnifiedFeeManager");
  const feeManager = await FeeManager.deploy(deployer.address, treasuryAddr);
  await feeManager.waitForDeployment();
  const feeManagerAddr = await feeManager.getAddress();
  console.log(`FeeManager:         ${feeManagerAddr}`);

  // ── 3. UnifiedRiskRegistry ─────────────────────────────────────────────────
  const RiskRegistry = await ethers.getContractFactory("UnifiedRiskRegistry");
  const riskRegistry = await RiskRegistry.deploy(deployer.address);
  await riskRegistry.waitForDeployment();
  const riskRegistryAddr = await riskRegistry.getAddress();
  console.log(`RiskRegistry:       ${riskRegistryAddr}`);

  // ── 4. UnifiedCollateralVault ──────────────────────────────────────────────
  const CollateralVault = await ethers.getContractFactory("UnifiedCollateralVault");
  const collateralVault = await CollateralVault.deploy(deployer.address);
  await collateralVault.waitForDeployment();
  const collateralVaultAddr = await collateralVault.getAddress();
  console.log(`CollateralVault:    ${collateralVaultAddr}`);

  // ── 5. UnifiedLoan (implementation) ───────────────────────────────────────
  const Loan = await ethers.getContractFactory("UnifiedLoan");
  const loanImplementation = await Loan.deploy();
  await loanImplementation.waitForDeployment();
  const loanImplAddr = await loanImplementation.getAddress();
  console.log(`LoanImplementation: ${loanImplAddr}`);

  // ── 6. UnifiedLoanFactory ──────────────────────────────────────────────────
  const Factory = await ethers.getContractFactory("UnifiedLoanFactory");
  const factory = await Factory.deploy(
    deployer.address,
    usdcAddress,
    collateralVaultAddr,
    feeManagerAddr,
    treasuryAddr,
    loanImplAddr,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`LoanFactory:        ${factoryAddr}`);

  // ── 7. Role grants ─────────────────────────────────────────────────────────
  console.log("\nGranting roles...");

  // 7a. CollateralVault: factory holds LOAN_REGISTRAR_ROLE
  const vaultRegistrarRole = await collateralVault.LOAN_REGISTRAR_ROLE();
  await (
    await collateralVault.grantRole(vaultRegistrarRole, factoryAddr)
  ).wait();
  console.log("  ✓ collateralVault.LOAN_REGISTRAR_ROLE → factory");

  // 7b. FeeManager: factory holds LOAN_REGISTRAR_ROLE
  //     Without this grant, createLoan() reverts when calling feeManager.registerLoan().
  const feeRegistrarRole = await feeManager.LOAN_REGISTRAR_ROLE();
  await (
    await feeManager.grantRole(feeRegistrarRole, factoryAddr)
  ).wait();
  console.log("  ✓ feeManager.LOAN_REGISTRAR_ROLE    → factory");

  // ── 8. Post-deploy assertions ──────────────────────────────────────────────
  console.log("\nRunning post-deploy assertions...");

  // Factory pointer checks
  await assertAddress(await factory.usdc(), usdcAddress, "factory.usdc == USDC_ADDRESS");
  await assertAddress(await factory.collateralVault(), collateralVaultAddr, "factory.collateralVault");
  await assertAddress(await factory.feeManager(), feeManagerAddr, "factory.feeManager");
  await assertAddress(await factory.treasury(), treasuryAddr, "factory.treasury");
  await assertAddress(await factory.loanImplementation(), loanImplAddr, "factory.loanImplementation");

  // FeeManager pointer check
  await assertAddress(await feeManager.treasury(), treasuryAddr, "feeManager.treasury");

  // Role assertions
  await assertRole(collateralVault, "LOAN_REGISTRAR_ROLE", factoryAddr, "collateralVault: factory has LOAN_REGISTRAR_ROLE");
  await assertRole(feeManager, "LOAN_REGISTRAR_ROLE", factoryAddr, "feeManager: factory has LOAN_REGISTRAR_ROLE");
  await assertRole(collateralVault, "DEFAULT_ADMIN_ROLE", deployer.address, "collateralVault: deployer has DEFAULT_ADMIN_ROLE");
  await assertRole(feeManager, "DEFAULT_ADMIN_ROLE", deployer.address, "feeManager: deployer has DEFAULT_ADMIN_ROLE");
  await assertRole(feeManager, "FEE_ROLE", deployer.address, "feeManager: deployer has FEE_ROLE");
  await assertRole(factory, "DEFAULT_ADMIN_ROLE", deployer.address, "factory: deployer has DEFAULT_ADMIN_ROLE");
  await assertRole(factory, "PAUSER_ROLE", deployer.address, "factory: deployer has PAUSER_ROLE");
  await assertRole(treasury, "DEFAULT_ADMIN_ROLE", deployer.address, "treasury: deployer has DEFAULT_ADMIN_ROLE");
  await assertRole(treasury, "WITHDRAWER_ROLE", deployer.address, "treasury: deployer has WITHDRAWER_ROLE");
  await assertRole(riskRegistry, "DEFAULT_ADMIN_ROLE", deployer.address, "riskRegistry: deployer has DEFAULT_ADMIN_ROLE");
  await assertRole(riskRegistry, "RISK_ORACLE_ROLE", deployer.address, "riskRegistry: deployer has RISK_ORACLE_ROLE");

  // Sanity: factory has zero loans at genesis
  const loanCount = await factory.loanCount();
  assert(loanCount === 0n, `Expected factory.loanCount == 0, got ${loanCount}`);
  console.log("  ✓ factory.loanCount == 0");

  // ── 9. Summary ─────────────────────────────────────────────────────────────
  console.log("\n=== Unified deployment complete ===");
  console.log(`TREASURY_ADDRESS=${treasuryAddr}`);
  console.log(`FEE_MANAGER_ADDRESS=${feeManagerAddr}`);
  console.log(`RISK_REGISTRY_ADDRESS=${riskRegistryAddr}`);
  console.log(`COLLATERAL_VAULT_ADDRESS=${collateralVaultAddr}`);
  console.log(`LOAN_IMPLEMENTATION_ADDRESS=${loanImplAddr}`);
  console.log(`LOAN_FACTORY_ADDRESS=${factoryAddr}`);
  console.log("\nNext steps (all require 24 h timelock via tasks/timelock.ts):");
  console.log("  • Allow initial collateral tokens: scheduleTimelock + allowCollateral");
  console.log("  • Set fees if non-zero:            scheduleTimelock + setFees");
  console.log("  • Wire risk registry (optional):   scheduleTimelock + setRiskRegistry");
  console.log("  • Wire identity registry (optional):scheduleTimelock + setIdentityRegistry");

  // E2E: write addresses for smoke test runner
  const outPath = process.env.E2E_DEPLOY_OUTPUT;
  if (outPath) {
    const fs = await import("fs");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          TREASURY_ADDRESS: treasuryAddr,
          FEE_MANAGER_ADDRESS: feeManagerAddr,
          RISK_REGISTRY_ADDRESS: riskRegistryAddr,
          COLLATERAL_VAULT_ADDRESS: collateralVaultAddr,
          LOAN_IMPLEMENTATION_ADDRESS: loanImplAddr,
          LOAN_FACTORY_ADDRESS: factoryAddr,
          USDC_ADDRESS: usdcAddress,
        },
        null,
        2,
      ),
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };
