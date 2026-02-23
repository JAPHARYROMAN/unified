# Unified v1.1 — End-to-End Integration Harness

Full lifecycle simulation with fiat loop. Validates complete loan lifecycle and archives a JSON manifest.

## Flow (1–11)

1. **Partner onboarding** — register → submit → start-review → approve → activate (pool + API key)
2. **Pool creation** — pool already deployed; logged from deployment
3. **Loan origination** — create loan via orchestrator (partner context)
4. **Collateral lock** — via `UnifiedLoan.lockCollateral` wrapper
5. **Simulated M-Pesa payout** — log only (outbound CONFIRMED)
6. **recordFiatDisbursement** — settlement agent records disbursement proof
7. **activate** — `activateAndDisburse`
8. **Simulated repayment webhook** — log only (inbound CONFIRMED)
9. **recordFiatRepayment** — settlement agent records repayment proof (duplicate call for assertion)
10. **repay** — on-chain repay (once)
11. **close** — release collateral and finalize

## Output manifest (JSON)

Generated and archived under **`e2e/manifests/e2e-manifest-<timestamp>.json`**:

| Field | Description |
|-------|-------------|
| **loanId** | Orchestrator loan UUID |
| **loanContract** | On-chain loan address |
| **txHashes** | lockCollateral, allocateToLoan, recordFiatDisbursement, activateAndDisburse, recordFiatRepayment, repay, close |
| **fiatReferences** | disbursement (bytes32), repayment (bytes32) |
| **navBefore** | Pool `totalAssetsNAV()` before allocate |
| **navAfter** | Pool `totalAssetsNAV()` after close |
| **timestamps** | runStarted, partnerActive, poolCreation, loanOrigination, collateralLock, mpesaPayoutSimulated, recordFiatDisbursement, activate, repaymentWebhookSimulated, recordFiatRepayment, repay, close, runFinished |
| **assertions** | loanNeverActiveWithoutDisbursementProof, duplicateWebhookNoDoubleRepay, navMatchesExpectedAccrual, noQueueEntriesStuck |
| **reconciliationMismatch** | `false` when all assertions pass |

## Assertions

- **Loan never ACTIVE without disbursement proof** — `activateAndDisburse()` is called before `recordFiatDisbursement` and must revert; after proof, activation succeeds.
- **Duplicate webhook does not double repay** — `recordFiatRepayment` is called twice with the same ref; `repay()` is called once; loan reaches REPAID and debt is zero.
- **NAV matches expected accrual** — `navAfter >= navBefore` (pool NAV does not decrease incorrectly after full lifecycle).
- **No queue entries stuck** — CREATE_LOAN is processed (loan reaches FUNDING with loanContract); reconciliationMismatch is false when all pass.

## Acceptance

- **Full flow passes on Base Sepolia** — Use deployment from `deploy:testnet:base-sepolia` and `execute-testnet-timelock:base-sepolia` (after 24h).
- **Manifest archived** — Written to `e2e/manifests/e2e-manifest-<ISO-timestamp>.json`.
- **Zero reconciliation mismatch** — `reconciliationMismatch === false` and all assertion flags true.

## Single command (reproduce E2E)

After one-time deploy and 24h timelock execution on the target network:

```bash
export DATABASE_URL="postgresql://..."
export DEPLOYER_PRIVATE_KEY="0x..."
# Base Sepolia:
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"
npm run e2e:v1
```

Deployment file is read from **`e2e/testnet-deployment.json`** (or `E2E_DEPLOYMENT_PATH`). For Base Sepolia, create it by running:

```bash
export BASE_SEPOLIA_RPC_URL="https://sepolia.base.org"
export DEPLOYER_PRIVATE_KEY="0x..."
npm run deploy:testnet:base-sepolia
# Wait 24h
npm run execute-testnet-timelock:base-sepolia
# Then
export DATABASE_URL="..."
npm run e2e:v1
```
