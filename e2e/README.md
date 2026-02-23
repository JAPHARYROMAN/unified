# E2E Smoke Test

Runs the full happy path against **main** using real deploy scripts: deploy → orchestrator (test mode) → partner onboarding → create loan → lock collateral → [fiat proof if enabled] → activateAndDisburse → repay → close. Validates on-chain status progression, DB/chain alignment, and role wiring (no silent skips).

## Single command

From repo root:

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/unified_e2e"
npm run e2e
```

Prerequisites: Node 18+, PostgreSQL. Exit code 0 = pass, 1 = fail (node and orchestrator are stopped on exit).

---

## Expected output summary

On success you should see this sequence (order may vary slightly):

| Step | Phase        | Output summary |
|------|--------------|----------------|
| 1    | —            | `RPC ready at http://127.0.0.1:8545` |
| 2    | DEPLOY       | `Deploy (real deploy + E2E pool/collateral)` → script completes |
| 3    | ROLE_WIRING  | `FeeManager/CollateralVault/Pool registrar grants OK` |
| 4    | BACKEND      | `DB migrations` → `Orchestrator ready at http://localhost:3001` |
| 5    | BACKEND      | `Partner onboarding` → `Registered partner: <uuid>` → `Partner activated, API key issued` |
| 6    | BACKEND      | `Create loan (POOL) via orchestrator` → `Loan created: <uuid>` |
| 7    | BACKEND      | `Wait for worker → FUNDING + loanContract` → `Pool LOAN_ROLE granted to loan` |
| 8    | CHAIN_ACTIONS| `lockCollateral` → allocate → optional `Fiat disbursement proof recorded` → `Loan active (chain status ACTIVE)` |
| 9    | CHAIN_ACTIONS| `Repay and close` → `Repaid (chain status REPAID)` → `Closed (chain status CLOSED)` |
| 10   | CHAIN_ACTIONS| `DB status FUNDING with correct loanContract` |
| —    | —            | `E2E smoke PASSED` |

Final checks:

- **On-chain progression**: FUNDING → ACTIVE (after activateAndDisburse) → REPAID (after repay) → CLOSED (after close).
- **DB**: Loan in FUNDING with correct `loanContract` (orchestrator does not sync post-funding).
- **Role wiring**: Factory has LOAN_REGISTRAR on vault/feeManager/pool; loan has LOAN_ROLE on pool.

---

## Failure diagnostics

If the run fails, the error message is prefixed with **where** it broke. Use that to narrow down the cause:

| Prefix / Phase     | Where it broke        | What to check |
|--------------------|------------------------|---------------|
| `[E2E FAILED @ DEPLOY]` | Deploy scripts (node, deploy-e2e) | Hardhat node running; `scripts/deploy-e2e.ts` and `scripts/deploy.ts`; USDC/env; timelock steps; `e2e/deployment.json` written. |
| `[E2E FAILED @ BACKEND]` | Orchestrator or API   | DB: `DATABASE_URL`, migrations (`npx prisma migrate deploy` in unified-orchestrator). Orchestrator: ADMIN_API_KEY, CORS_ORIGINS, E2E_MODE=1 and CHAIN_ACTION_* env. Partner flow: register → submit → start-review → approve → activate. Loan create and worker: loan reaches FUNDING and gets `loanContract`. |
| `[E2E FAILED @ CHAIN_ACTIONS]` | On-chain flow        | RPC reachable; borrower/deployer keys; collateral approve + lockCollateral; pool allocateToLoan; if fiat-proof on: settlementAgent set and recordFiatDisbursement; activateAndDisburse; repay (borrower has USDC); close. Status progression: ACTIVE → REPAID → CLOSED. |
| `[E2E FAILED @ ROLE_WIRING]` | Role/pointer checks  | Factory has LOAN_REGISTRAR on vault and feeManager; factory has LOAN_REGISTRAR on pool; after createLoan, pool has LOAN_ROLE for the loan. No silent skips: assertions fail loudly with contract/label. |

Optional env: `E2E_DEPLOYER_PRIVATE_KEY`, `E2E_BORROWER_PRIVATE_KEY`, `E2E_ADMIN_API_KEY`, `E2E_SETTLEMENT_AGENT_PRIVATE_KEY`, `ORCHESTRATOR_PORT`.
