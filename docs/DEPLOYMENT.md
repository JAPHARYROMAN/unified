# Unified Protocol — Deployment Guide & Post-Deployment Checklist

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| `USDC_ADDRESS` | On-chain USDC (or test stablecoin) |
| `DEPLOYER_PRIVATE_KEY` | EOA with sufficient MATIC for gas |
| `AMOY_RPC_URL` / `POLYGON_RPC_URL` | RPC endpoint |
| `POLYGONSCAN_API_KEY` | For contract verification |

Copy `.env.example` → `.env` and fill in the values.

---

## 2. Deployment steps

### 2.1 Compile

```bash
npm run compile
```

### 2.2 Run tests (must all pass before deploying)

```bash
npm test
```

### 2.3 Deploy to testnet (Amoy)

```bash
npm run deploy:amoy
```

### 2.4 Deploy to mainnet (Polygon)

```bash
npm run deploy:polygon
```

The script prints all deployed addresses as `KEY=value` lines at the end.
Copy these into your `.env` / secrets store.

---

## 3. Immediate post-deployment checklist

Run the automated verifier immediately after deployment:

```bash
LOAN_FACTORY_ADDRESS=0x...        \
FEE_MANAGER_ADDRESS=0x...         \
COLLATERAL_VAULT_ADDRESS=0x...    \
TREASURY_ADDRESS=0x...            \
RISK_REGISTRY_ADDRESS=0x...       \
LOAN_IMPLEMENTATION_ADDRESS=0x... \
npx hardhat run scripts/verify-deployment.ts --network polygon
```

Expected output: **All checks passed ✓**

### 3.1 Manual role checks

| Check | Command / expectation |
|---|---|
| `collateralVault.LOAN_REGISTRAR_ROLE` → factory | `vault.hasRole(LOAN_REGISTRAR_ROLE, factoryAddr) == true` |
| `feeManager.LOAN_REGISTRAR_ROLE` → factory | `feeManager.hasRole(LOAN_REGISTRAR_ROLE, factoryAddr) == true` |
| `factory.DEFAULT_ADMIN_ROLE` → deployer/multisig | `factory.hasRole(DEFAULT_ADMIN_ROLE, admin) == true` |
| `factory.PAUSER_ROLE` → deployer/multisig | `factory.hasRole(PAUSER_ROLE, pauser) == true` |
| `treasury.WITHDRAWER_ROLE` → multisig | `treasury.hasRole(WITHDRAWER_ROLE, multisig) == true` |
| `riskRegistry.RISK_ORACLE_ROLE` → oracle | `riskRegistry.hasRole(RISK_ORACLE_ROLE, oracle) == true` |

### 3.2 Manual pointer checks

| Check | Expected value |
|---|---|
| `factory.usdc()` | USDC contract address |
| `factory.collateralVault()` | Deployed vault address |
| `factory.feeManager()` | Deployed fee manager address |
| `factory.treasury()` | Deployed treasury address |
| `factory.loanImplementation()` | Deployed loan impl address |
| `feeManager.treasury()` | Deployed treasury address |

---

## 4. Post-deployment configuration (all require 24 h timelock)

All of the following operations must be scheduled first, then executed 24 h later.
Use the Hardhat governance tasks:

```bash
# Step 1 — Schedule (run now)
npx hardhat timelock:schedule \
  --address <contract> \
  --func    <function> \
  --args    '<JSON array>' \
  --network polygon

# Step 2 — Check readiness
npx hardhat timelock:status \
  --address <contract> \
  --func    <function> \
  --args    '<JSON array>' \
  --network polygon

# Step 3 — Execute (after 24 h)
npx hardhat timelock:execute \
  --address <contract> \
  --func    <function> \
  --args    '<JSON array>' \
  --network polygon
```

### 4.1 Allow initial collateral token(s)

```bash
# Schedule
npx hardhat timelock:schedule \
  --address $LOAN_FACTORY_ADDRESS \
  --func    allowCollateral \
  --args    '["<WETH_ADDRESS>"]' \
  --network polygon

# Execute (24 h later)
npx hardhat timelock:execute \
  --address $LOAN_FACTORY_ADDRESS \
  --func    allowCollateral \
  --args    '["<WETH_ADDRESS>"]' \
  --network polygon
```

### 4.2 Set non-zero protocol fees (if applicable)

```bash
# Schedule  — example: 50 bps origination, 0 interest, 0 late
npx hardhat timelock:schedule \
  --address $FEE_MANAGER_ADDRESS \
  --func    setFees \
  --args    '[50, 0, 0]' \
  --network polygon

# Execute (24 h later)
npx hardhat timelock:execute \
  --address $FEE_MANAGER_ADDRESS \
  --func    setFees \
  --args    '[50, 0, 0]' \
  --network polygon
```

### 4.3 Wire risk registry (optional)

```bash
npx hardhat timelock:schedule \
  --address $LOAN_FACTORY_ADDRESS \
  --func    setRiskRegistry \
  --args    '["<RISK_REGISTRY_ADDRESS>"]' \
  --network polygon

npx hardhat timelock:execute \
  --address $LOAN_FACTORY_ADDRESS \
  --func    setRiskRegistry \
  --args    '["<RISK_REGISTRY_ADDRESS>"]' \
  --network polygon
```

### 4.4 Wire identity/KYC registry (optional)

```bash
npx hardhat timelock:schedule \
  --address $LOAN_FACTORY_ADDRESS \
  --func    setIdentityRegistry \
  --args    '["<IDENTITY_REGISTRY_ADDRESS>"]' \
  --network polygon

npx hardhat timelock:execute \
  --address $LOAN_FACTORY_ADDRESS \
  --func    setIdentityRegistry \
  --args    '["<IDENTITY_REGISTRY_ADDRESS>"]' \
  --network polygon
```

---

## 5. Timelocked operations reference

The following admin operations **require a 24-hour timelock** on both contracts.
Any attempt to execute them without first scheduling will revert with `TimelockNotScheduled`.

### UnifiedLoanFactory

| Function | When to use |
|---|---|
| `setLoanImplementation(address)` | Upgrade to new loan logic |
| `setFeeManager(address)` | Replace fee manager contract |
| `setCollateralVault(address)` | Replace collateral vault contract |
| `setTreasury(address)` | Redirect protocol fees |
| `setRiskRegistry(address)` | Wire or change risk oracle |
| `setPool(address, bool)` | Whitelist or remove a liquidity pool |
| `setIdentityRegistry(address)` | Wire or change KYC registry |
| `setKycRequired(bool)` | Enable/disable KYC gate |
| `setEnforceJurisdiction(bool)` | Enable/disable jurisdiction check |
| `setEnforceTierCaps(bool)` | Enable/disable tier borrow caps |
| `setRequireFiatProofBeforeActivate(bool)` | Enable/disable fiat proof gate |
| `setSettlementAgent(address)` | Set fiat settlement agent |
| `allowCollateral(address)` | Add a new collateral token |
| `setAllowedCollateral(address, bool)` | Allow or revoke collateral token |
| `setMinCollateralRatioBps(address, uint256)` | Set collateral ratio floor |

### UnifiedFeeManager

| Function | When to use |
|---|---|
| `setFees(uint256, uint256, uint256)` | Change protocol fee rates |
| `setTreasury(address)` | Redirect fee receipts |

### Immediate (no timelock)

| Function | Contract | Notes |
|---|---|---|
| `setJurisdictionAllowed(uint256, bool)` | Factory | Jurisdiction allowlist (fast-path for compliance) |
| `setTierBorrowCap(uint8, uint256)` | Factory | Per-tier cap adjustment |
| `setIdentity(...)` | IdentityRegistry | KYC manager updates individual records |
| `setRisk(...)` | RiskRegistry | Risk oracle updates borrower profiles |
| `pause()` / `unpause()` | Factory, Pool | Emergency circuit breaker |
| `setLoanPaused(address, bool)` | Factory | Pause individual loan |

---

## 6. Emergency procedures

### 6.1 Pause the factory (stops all new loan creation)

```bash
npx hardhat run --network polygon --no-compile - <<'EOF'
const factory = await ethers.getContractAt("UnifiedLoanFactory", process.env.LOAN_FACTORY_ADDRESS);
await factory.pause();
console.log("Factory paused");
EOF
```

### 6.2 Cancel a mistakenly scheduled timelock

```bash
npx hardhat timelock:cancel \
  --address <contract> \
  --func    <function> \
  --args    '<JSON args>' \
  --network polygon
```

### 6.3 Revoke a compromised admin key

Use `DEFAULT_ADMIN_ROLE` to `revokeRole` on every contract, then grant to the replacement key:

```solidity
// On every contract:
contract.revokeRole(DEFAULT_ADMIN_ROLE, compromisedKey);
contract.grantRole(DEFAULT_ADMIN_ROLE, newKey);
```

---

## 7. Final sign-off checklist

Before going live, confirm all items are checked:

- [ ] `npm test` passes with 0 failures
- [ ] `scripts/verify-deployment.ts` shows "All checks passed"
- [ ] `factory.loanCount() == 0` (fresh deployment)
- [ ] `collateralVault.LOAN_REGISTRAR_ROLE` held by factory
- [ ] `feeManager.LOAN_REGISTRAR_ROLE` held by factory
- [ ] `treasury.WITHDRAWER_ROLE` held by **multisig** (not the deployer EOA)
- [ ] `factory.DEFAULT_ADMIN_ROLE` held by **multisig** (not the deployer EOA)
- [ ] Deployer EOA `DEFAULT_ADMIN_ROLE` revoked after multisig takes over
- [ ] At least one collateral token allowed (via timelocked `allowCollateral`)
- [ ] Fee rates set to intended values (via timelocked `setFees`)
- [ ] Risk registry wired if KYC enforcement is required
- [ ] Identity registry wired if KYC enforcement is required
- [ ] Polygonscan contract verification complete for all six contracts
