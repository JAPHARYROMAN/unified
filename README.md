# Unified Protocol (Polygon)

Production-ready Solidity smart contract repository for **Unified**, built with **Hardhat + TypeScript**.

## Stack

- Solidity `^0.8.20`
- Hardhat + TypeScript + ethers
- OpenZeppelin
  - `SafeERC20`
  - `AccessControl`
  - `Pausable`
  - `ReentrancyGuard`
  - `Clones`
  - `Initializable`

## Architecture

Unified uses a clone-based loan model:

1. `UnifiedLoanFactory` deploys minimal proxy loans (`EIP-1167`) from `UnifiedLoan` implementation.
2. Each `UnifiedLoan` tracks lifecycle state:
   - `Created -> Funded -> Active -> Repaid`
   - `Active -> Defaulted -> Claimed`
   - `Created -> Cancelled`
3. `UnifiedCollateralVault` escrows ERC-20 collateral and only allows authorized loan clones.
4. `UnifiedFeeManager` holds fee config and routes collected fees to `UnifiedTreasury`.
5. `UnifiedRiskRegistry` stores borrower attestations (`flagged`, `borrowCap`) enforced at origination and activation.
6. `UnifiedPool` provides optional pooled USDC liquidity with internal share accounting.
7. `UnifiedIdentityRegistry` provides fintech-grade KYC integration — no PII on-chain, only approval flags, provider-reference hashes, numeric jurisdiction codes, risk tiers, and expiry timestamps.

### KYC Integration

The identity system is opt-in and layered:

- **`UnifiedIdentityRegistry`**: Stores `IdentityData` per address (approved flag, kycHash, jurisdiction, riskTier, expiry). A compliance multisig holding `KYC_MANAGER_ROLE` updates records. `DEFAULT_ADMIN_ROLE` is intended for a timelock.
- **Factory enforcement** (all timelocked toggles):
  - `kycRequired` — borrower must pass `isApproved()` check (approval + non-expired).
  - `enforceJurisdiction` — borrower's jurisdiction must be on `jurisdictionAllowed` allowlist.
  - `enforceTierCaps` — per-tier borrow caps via `tierBorrowCap[tier]` (0 = no cap).
- Existing `RiskRegistry` checks continue to apply independently.

## Repository Layout

```text
contracts/
  interfaces/
  libraries/
  mocks/
  UnifiedLoan.sol
  UnifiedLoanFactory.sol
  UnifiedCollateralVault.sol
  UnifiedFeeManager.sol
  UnifiedRiskRegistry.sol
  UnifiedIdentityRegistry.sol
  UnifiedPool.sol
  UnifiedTreasury.sol
scripts/
  deploy.ts
test/
  Deployment.test.ts
  CreateLoan.test.ts
  Lifecycle.test.ts
hardhat.config.ts
.env.example
package.json
```

## Environment

Copy `.env.example` to `.env` and fill values:

```bash
AMOY_RPC_URL=https://rpc-amoy.polygon.technology
POLYGON_RPC_URL=https://polygon-rpc.com
DEPLOYER_PRIVATE_KEY=0x...
POLYGONSCAN_API_KEY=...
USDC_ADDRESS=0x...
```

## Commands

```bash
npm install
npm run compile
npm run test
npm run coverage
npm run deploy:amoy
npm run deploy:polygon
```

## Deployment Notes

- `scripts/deploy.ts` deploys the full Unified contract set.
- It grants `LOAN_REGISTRAR_ROLE` on `UnifiedCollateralVault` to `UnifiedLoanFactory`.
- `USDC_ADDRESS` must be supplied in the environment for the target network.

## Testing

Current test suite covers:

- core deployment and role wiring
- loan creation validation
- lifecycle flow (fund, activate, repay)
- default flow and collateral claim

## Security Baseline

- role-based access control for admin/oracle/fee/pauser paths
- pausability on sensitive state transitions
- reentrancy guards on token-moving operations
- custom errors for explicit revert reasons
- clone pattern for gas-efficient loan deployment

## License

MIT
