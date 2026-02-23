# v1.1 QA — E2E on Public Testnet (Amoy)

Proves the full loop on a real network with realistic confirmations: deploy → orchestrator (staging) → partner onboard → originate loan → lock collateral → M-Pesa outbound proof → activate → repay → M-Pesa inbound proof → close.

## Single command (reproduce testnet E2E)

After a one-time deploy and 24h timelock execution:

```bash
export DATABASE_URL="postgresql://..."
export DEPLOYER_PRIVATE_KEY="0x..."
npm run e2e:testnet
```

This runs the orchestrator in staging config (real RPC, real chain sender) and the full flow; M-Pesa is simulated (sandbox/mock) but still drives proof calls (`recordFiatDisbursement`, `recordFiatRepayment`).

---

## First-time setup (once per testnet deployment)

1. **Deploy contracts** (writes `e2e/testnet-deployment.json`, schedules 24h timelock):

   ```bash
   export AMOY_RPC_URL="https://rpc-amoy.polygon.technology"
   export DEPLOYER_PRIVATE_KEY="0x..."
   npm run deploy:testnet
   ```

2. **Wait 24 hours** (timelock delay).

3. **Execute timelock and fund pool/borrower**:

   ```bash
   npm run execute-testnet-timelock
   ```

4. **Run E2E** (repeatable):

   ```bash
   export DATABASE_URL="..."
   npm run e2e:testnet
   ```

---

## Report (expected output)

Report path: **`e2e/testnet-e2e-report.json`**

| Section | Contents |
|--------|----------|
| **deploymentAddresses** | `LOAN_FACTORY_ADDRESS`, `POOL_ADDRESS`, `USDC_ADDRESS`, `COLLATERAL_TOKEN_ADDRESS`, `COLLATERAL_VAULT_ADDRESS`, `SETTLEMENT_AGENT_ADDRESS` |
| **txHashes** | `lockCollateral`, `allocateToLoan`, `recordFiatDisbursement`, `activateAndDisburse`, `repay`, `recordFiatRepayment`, `close` (createLoan is stored in orchestrator `chain_actions` table) |
| **timestamps** | `runStarted`, `partnerActive`, `lockCollateral`, `mpesaOutboundConfirmed`, `activateAndDisburse`, `repay`, `mpesaInboundConfirmed`, `close`, `runFinished` |
| **finalState** | `chain.loanStatus` (5 = CLOSED), `db.loanStatus`, `db.loanContract` |
| **error** | Set if run failed |

---

## Staging config (orchestrator)

- **Real RPC**: from `testnet-deployment.json` (`RPC_URL`) or `AMOY_RPC_URL`.
- **Real chain sender**: `E2E_MODE=1` + `CHAIN_ACTION_RPC_URL`, `CHAIN_ACTION_FACTORY_ADDRESS`, `CHAIN_ACTION_SIGNER_PRIVATE_KEY`.
- **M-Pesa**: Sandbox/mock — no live M-Pesa API; the script simulates outbound/inbound CONFIRMED and calls `recordFiatDisbursement` and `recordFiatRepayment` on the loan contract as the settlement agent.

Env: `DATABASE_URL`, `DEPLOYER_PRIVATE_KEY` (or `E2E_DEPLOYER_PRIVATE_KEY`), optional `E2E_BORROWER_PRIVATE_KEY`, `E2E_ADMIN_API_KEY`, `ORCHESTRATOR_PORT`.
