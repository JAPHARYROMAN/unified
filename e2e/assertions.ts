/**
 * E2E assertions: role/pointer checks and DB vs on-chain state.
 * Fails loudly on missing grants (FeeManager registrar, pool LOAN_ROLE, etc.).
 */
import { ethers } from "ethers";

const LOAN_STATUS = ["CREATED", "FUNDING", "ACTIVE", "REPAID", "DEFAULTED", "CLOSED"] as const;

export function assertRole(
  hasRole: boolean,
  label: string,
  holder: string,
  roleName: string,
): void {
  if (!hasRole) {
    throw new Error(`[E2E ASSERT] ${label}: ${holder} does not hold ${roleName}`);
  }
}

export function assertAddress(actual: string, expected: string, label: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`[E2E ASSERT] ${label}: expected ${expected}, got ${actual}`);
  }
}

export function assertDbMatchesChain(
  dbStatus: string,
  chainStatus: number,
  loanId: string,
): void {
  const chainStatusName = LOAN_STATUS[chainStatus] ?? `unknown(${chainStatus})`;
  if (dbStatus !== chainStatusName) {
    throw new Error(
      `[E2E ASSERT] Loan ${loanId}: DB status ${dbStatus} does not match chain status ${chainStatusName}`,
    );
  }
}

/**
 * Run role/pointer assertions after deployment (and optionally after loan creation).
 * Uses real contract reads — fails loudly if grants are missing.
 */
export async function assertDeployRoles(
  provider: ethers.Provider,
  deployment: {
    LOAN_FACTORY_ADDRESS: string;
    FEE_MANAGER_ADDRESS: string;
    COLLATERAL_VAULT_ADDRESS: string;
    POOL_ADDRESS?: string;
  },
): Promise<void> {
  const factoryAddr = deployment.LOAN_FACTORY_ADDRESS;
  const feeManagerAddr = deployment.FEE_MANAGER_ADDRESS;
  const vaultAddr = deployment.COLLATERAL_VAULT_ADDRESS;

  const factory = new ethers.Contract(factoryAddr as string, [
    "function usdc() view returns (address)",
    "function collateralVault() view returns (address)",
    "function feeManager() view returns (address)",
    "function treasury() view returns (address)",
  ], provider);

  const feeManager = new ethers.Contract(feeManagerAddr, [
    "function LOAN_REGISTRAR_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);

  const vault = new ethers.Contract(vaultAddr, [
    "function LOAN_REGISTRAR_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);

  const regRoleVault = await vault.LOAN_REGISTRAR_ROLE();
  const hasVault = await vault.hasRole(regRoleVault, factoryAddr);
  assertRole(hasVault, "CollateralVault", factoryAddr, "LOAN_REGISTRAR_ROLE");

  const regRoleFee = await feeManager.LOAN_REGISTRAR_ROLE();
  const hasFee = await feeManager.hasRole(regRoleFee, factoryAddr);
  assertRole(hasFee, "FeeManager", factoryAddr, "LOAN_REGISTRAR_ROLE");

  if (deployment.POOL_ADDRESS) {
    const pool = new ethers.Contract(deployment.POOL_ADDRESS, [
      "function LOAN_REGISTRAR_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
    ], provider);
    const regRolePool = await pool.LOAN_REGISTRAR_ROLE();
    const hasPool = await pool.hasRole(regRolePool, factoryAddr);
    assertRole(hasPool, "Pool", factoryAddr, "LOAN_REGISTRAR_ROLE");
  }
}

/**
 * Assert that the given loan contract has LOAN_ROLE on the pool (POOL loans).
 */
export async function assertPoolLoanRole(
  provider: ethers.Provider,
  poolAddress: string,
  loanAddress: string,
): Promise<void> {
  const pool = new ethers.Contract(poolAddress, [
    "function LOAN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
  ], provider);
  const loanRole = await pool.LOAN_ROLE();
  const has = await pool.hasRole(loanRole, loanAddress);
  assertRole(has, "Pool", loanAddress, "LOAN_ROLE");
}
