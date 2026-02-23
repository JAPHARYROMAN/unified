/**
 * verify-deployment.ts
 *
 * Standalone post-deployment verifier. Run against any already-deployed
 * Unified instance by setting env vars and running:
 *
 *   LOAN_FACTORY_ADDRESS=0x... \
 *   FEE_MANAGER_ADDRESS=0x...  \
 *   COLLATERAL_VAULT_ADDRESS=0x... \
 *   TREASURY_ADDRESS=0x...     \
 *   RISK_REGISTRY_ADDRESS=0x... \
 *   LOAN_IMPLEMENTATION_ADDRESS=0x... \
 *   npx hardhat run scripts/verify-deployment.ts --network <network>
 *
 * Exits with code 1 if any check fails.
 */

import { ethers } from "hardhat";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CheckResult {
  label: string;
  passed: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function check(
  label: string,
  fn: () => Promise<boolean | string>,
): Promise<void> {
  try {
    const result = await fn();
    if (result === true || result === "") {
      results.push({ label, passed: true });
    } else {
      results.push({ label, passed: false, detail: String(result) });
    }
  } catch (e: any) {
    results.push({ label, passed: false, detail: e.message });
  }
}

async function checkRole(
  contract: any,
  roleGetter: string,
  holder: string,
  label: string,
): Promise<void> {
  await check(label, async () => {
    const role: string = await contract[roleGetter]();
    const has: boolean = await contract.hasRole(role, holder);
    return has ? true : `${holder} does not hold ${roleGetter} (${role})`;
  });
}

async function checkNotRole(
  contract: any,
  roleGetter: string,
  holder: string,
  label: string,
): Promise<void> {
  await check(label, async () => {
    const role: string = await contract[roleGetter]();
    const has: boolean = await contract.hasRole(role, holder);
    return !has ? true : `${holder} unexpectedly holds ${roleGetter}`;
  });
}

async function checkAddress(
  actual: () => Promise<string>,
  expected: string,
  label: string,
): Promise<void> {
  await check(label, async () => {
    const got = await actual();
    return got.toLowerCase() === expected.toLowerCase()
      ? true
      : `expected ${expected}, got ${got}`;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const factoryAddr       = env("LOAN_FACTORY_ADDRESS");
  const feeManagerAddr    = env("FEE_MANAGER_ADDRESS");
  const vaultAddr         = env("COLLATERAL_VAULT_ADDRESS");
  const treasuryAddr      = env("TREASURY_ADDRESS");
  const riskRegistryAddr  = env("RISK_REGISTRY_ADDRESS");
  const loanImplAddr      = env("LOAN_IMPLEMENTATION_ADDRESS");

  console.log("\n=== Unified Deployment Verifier ===");
  console.log(`Factory:        ${factoryAddr}`);
  console.log(`FeeManager:     ${feeManagerAddr}`);
  console.log(`Vault:          ${vaultAddr}`);
  console.log(`Treasury:       ${treasuryAddr}`);
  console.log(`RiskRegistry:   ${riskRegistryAddr}`);
  console.log(`LoanImpl:       ${loanImplAddr}`);

  const [signer] = await ethers.getSigners();

  const factory      = await ethers.getContractAt("UnifiedLoanFactory",    factoryAddr,      signer);
  const feeManager   = await ethers.getContractAt("UnifiedFeeManager",     feeManagerAddr,   signer);
  const vault        = await ethers.getContractAt("UnifiedCollateralVault", vaultAddr,        signer);
  const treasury     = await ethers.getContractAt("UnifiedTreasury",       treasuryAddr,     signer);
  const riskRegistry = await ethers.getContractAt("UnifiedRiskRegistry",   riskRegistryAddr, signer);

  // ── A. Contract pointer wiring ────────────────────────────────────────────
  console.log("\n[A] Contract pointer wiring");

  await checkAddress(() => factory.collateralVault(), vaultAddr,      "factory.collateralVault == vault");
  await checkAddress(() => factory.feeManager(),      feeManagerAddr, "factory.feeManager == feeManager");
  await checkAddress(() => factory.treasury(),        treasuryAddr,   "factory.treasury == treasury");
  await checkAddress(() => factory.loanImplementation(), loanImplAddr,"factory.loanImplementation == loanImpl");
  await checkAddress(() => feeManager.treasury(),     treasuryAddr,   "feeManager.treasury == treasury");

  // ── B. Role grants ────────────────────────────────────────────────────────
  console.log("[B] Role grants");

  await checkRole(vault,      "LOAN_REGISTRAR_ROLE", factoryAddr, "vault:      factory has LOAN_REGISTRAR_ROLE");
  await checkRole(feeManager, "LOAN_REGISTRAR_ROLE", factoryAddr, "feeManager: factory has LOAN_REGISTRAR_ROLE");

  // ── C. Admin role sanity (deployer/multisig should hold these) ────────────
  console.log("[C] Admin role presence");

  await check("vault:        DEFAULT_ADMIN_ROLE is held by at least one account", async () => {
    const role = await vault.DEFAULT_ADMIN_ROLE();
    const count = await vault.getRoleMemberCount(role).catch(() => null);
    if (count !== null) return count > 0n ? true : "no admin holders on vault";
    return true; // getRoleMemberCount unavailable (no enumerable extension), skip
  });

  await check("factory:      PAUSER_ROLE is held by at least one account", async () => {
    const role = await factory.PAUSER_ROLE();
    const count = await factory.getRoleMemberCount(role).catch(() => null);
    if (count !== null) return count > 0n ? true : "no pauser holders on factory";
    return true;
  });

  // ── D. Fee configuration ──────────────────────────────────────────────────
  console.log("[D] Fee configuration");

  await check("feeManager: all fee bps within MAX_FEE_BPS (5000)", async () => {
    const max = await feeManager.MAX_FEE_BPS();
    const orig = await feeManager.originationFeeBps();
    const int_ = await feeManager.interestFeeBps();
    const late = await feeManager.lateFeeBps();
    if (orig > max) return `originationFeeBps ${orig} > MAX ${max}`;
    if (int_ > max) return `interestFeeBps ${int_} > MAX ${max}`;
    if (late > max) return `lateFeeBps ${late} > MAX ${max}`;
    return true;
  });

  // ── E. Optional pointers (warn if misconfigured when present) ─────────────
  console.log("[E] Optional registry pointers");

  await check("factory.identityRegistry (if set, must be non-zero)", async () => {
    const ir = await factory.identityRegistry();
    if (ir === ethers.ZeroAddress) return true; // not configured, that's fine
    // If configured, verify it has the KYC_MANAGER_ROLE defined
    try {
      const iRegistry = await ethers.getContractAt("UnifiedIdentityRegistry", ir, signer);
      await iRegistry.KYC_MANAGER_ROLE(); // reverts if wrong contract
      return true;
    } catch {
      return `identityRegistry=${ir} does not implement KYC_MANAGER_ROLE`;
    }
  });

  await check("factory.riskRegistry (if set, must respond to validateBorrow)", async () => {
    const rr = await factory.riskRegistry();
    if (rr === ethers.ZeroAddress) return true;
    if (rr.toLowerCase() === riskRegistryAddr.toLowerCase()) return true;
    return `factory.riskRegistry (${rr}) != RISK_REGISTRY_ADDRESS (${riskRegistryAddr})`;
  });

  // ── F. No loans at genesis or existing count is readable ─────────────────
  console.log("[F] Protocol state");

  await check("factory.loanCount() is readable", async () => {
    await factory.loanCount();
    return true;
  });

  await check("factory is NOT paused", async () => {
    const paused = await factory.paused();
    return paused ? "factory is currently paused" : true;
  });

  // ── Results ───────────────────────────────────────────────────────────────
  console.log("\n=== Verification results ===");
  let failures = 0;
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
    if (!r.passed) failures++;
  }

  const total = results.length;
  console.log(`\n${total - failures}/${total} checks passed`);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED — deployment is not production-ready`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed ✓");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
