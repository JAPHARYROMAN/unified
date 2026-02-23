# Unified — Deployment Parity Report
Generated: 2026-02-23T12:14:40.498Z
Deployed by: scripts/deploy.ts (not test fixtures)

## A. Role grants

| # | Check | Status |
|---|---|---|
| ✓ | vault: factory has LOAN_REGISTRAR_ROLE | PASS |
| ✓ | feeManager: factory has LOAN_REGISTRAR_ROLE | PASS |
| ✓ | vault: deployer has DEFAULT_ADMIN_ROLE | PASS |
| ✓ | feeManager: deployer has DEFAULT_ADMIN_ROLE | PASS |
| ✓ | feeManager: deployer has FEE_ROLE | PASS |
| ✓ | factory: deployer has DEFAULT_ADMIN_ROLE | PASS |
| ✓ | factory: deployer has PAUSER_ROLE | PASS |
| ✓ | treasury: deployer has DEFAULT_ADMIN_ROLE | PASS |
| ✓ | treasury: deployer has WITHDRAWER_ROLE | PASS |
| ✓ | riskRegistry: deployer has DEFAULT_ADMIN_ROLE | PASS |
| ✓ | riskRegistry: deployer has RISK_ORACLE_ROLE | PASS |

## B. Contract pointer wiring

| # | Check | Status |
|---|---|---|
| ✓ | factory.usdc == USDC_ADDRESS | PASS |
| ✓ | factory.collateralVault == vault | PASS |
| ✓ | factory.feeManager == feeManager | PASS |
| ✓ | factory.treasury == treasury | PASS |
| ✓ | factory.loanImplementation == loanImpl | PASS |
| ✓ | feeManager.treasury == treasury | PASS |
| ✓ | factory.identityRegistry == 0x0 (unconfigured at deploy) | PASS |
| ✓ | factory.riskRegistry == 0x0 (unconfigured at deploy) | PASS |
| ✓ | factory.loanCount == 0 at genesis | PASS |
| ✓ | factory is not paused at genesis | PASS |

## C. Timelock coverage

| # | Check | Status |
|---|---|---|
| ✓ | factory.setLoanImplementation timelocked | PASS |
| ✓ | factory.setFeeManager timelocked | PASS |
| ✓ | factory.setCollateralVault timelocked | PASS |
| ✓ | factory.setTreasury timelocked | PASS |
| ✓ | factory.setRiskRegistry timelocked | PASS |
| ✓ | factory.setPool timelocked | PASS |
| ✓ | factory.setIdentityRegistry timelocked | PASS |
| ✓ | factory.setKycRequired timelocked | PASS |
| ✓ | factory.setEnforceJurisdiction timelocked | PASS |
| ✓ | factory.setEnforceTierCaps timelocked | PASS |
| ✓ | factory.setRequireFiatProofBeforeActivate timelocked | PASS |
| ✓ | factory.setSettlementAgent timelocked | PASS |
| ✓ | factory.allowCollateral timelocked | PASS |
| ✓ | factory.setMinCollateralRatioBps timelocked | PASS |
| ✓ | feeManager.setFees timelocked | PASS |
| ✓ | feeManager.setTreasury timelocked | PASS |
| ✓ | factory.setJurisdictionAllowed NOT timelocked (immediate) | PASS |
| ✓ | factory.setTierBorrowCap NOT timelocked (immediate) | PASS |

## D. E2E createLoan (fee + vault wiring)

| # | Check | Status |
|---|---|---|
| ✓ | factory.isLoan(loanClone) == true | PASS |
| ✓ | vault: clone has LOAN_ROLE after createLoan | PASS |
| ✓ | feeManager: clone has LOAN_ROLE after createLoan | PASS |
| ✓ | E2E fund→lock→activate succeeds (fees=0) | PASS |
| ✓ | fee collection: treasury received 50000 (expected 50000) | PASS |

## E. POOL loan LOAN_ROLE wiring

| # | Check | Status |
|---|---|---|
| ✓ | factory.isPool == true after timelocked setPool | PASS |
| ✓ | pool: POOL loan clone has LOAN_ROLE after createLoan | PASS |

## Missing invariants / Findings

None — all checks passed.

## Timelocked setters (full list)

### UnifiedLoanFactory
- `setLoanImplementation(address)`
- `setFeeManager(address)`
- `setCollateralVault(address)`
- `setTreasury(address)`
- `setRiskRegistry(address)`
- `setPool(address,bool)`
- `setIdentityRegistry(address)`
- `setKycRequired(bool)`
- `setEnforceJurisdiction(bool)`
- `setEnforceTierCaps(bool)`
- `setRequireFiatProofBeforeActivate(bool)`
- `setSettlementAgent(address)`
- `allowCollateral(address)`
- `setAllowedCollateral(address,bool)`
- `setMinCollateralRatioBps(address,uint256)`

### UnifiedFeeManager
- `setFees(uint256,uint256,uint256)`
- `setTreasury(address)`

### Immediate (no timelock)
- `factory.setJurisdictionAllowed(uint256,bool)`
- `factory.setTierBorrowCap(uint8,uint256)`
- `identityRegistry.setIdentity(...)` (KYC_MANAGER_ROLE)
- `riskRegistry.setRisk(...)` (RISK_ORACLE_ROLE)
- `pause()` / `unpause()` on factory, pool, loan
