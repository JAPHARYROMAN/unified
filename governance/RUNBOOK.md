# Unified Protocol — Governance Emergency Drill Runbook

**Version:** 1.1
**Scope:** Staging governance rehearsal
**Maintainer:** Protocol governance team
**Review cadence:** Quarterly or after any production incident

---

## Overview

This runbook covers five emergency governance drills. Each drill exercises a real system capability on staging and produces a machine-readable evidence bundle.

| # | Drill | Mechanism | Scope | Reversible |
|---|-------|-----------|-------|-----------|
| 1 | Emergency Originations Halt (Soft) | Circuit-breaker incident | Global / backend | Yes — resolve incident |
| 2 | On-Chain Pause (Hard) | `pause()` + governance timelock | Factory + Pool | Yes — `unpause()` |
| 3 | Settlement Signer Rotation | `setSettlementAgent()` timelock | Factory | Yes — rotate again |
| 4 | Partner Disablement | `POST /admin/partners/:id/suspend` | Partner | Manual re-activation |
| 5 | Recovery / Unpause | Reconciliation gate + unpause | Global | N/A (recovery path) |

---

## Prerequisites

### Environment variables (all drills)

```bash
export DRILL_API_URL="https://staging.unified.internal"   # Backend base URL
export DRILL_ADMIN_KEY="<ADMIN_API_KEY from staging env>"
export DRILL_OPERATOR_ID="<your-name>"                    # Recorded in audit trail
export DRILL_ID="$(date +%Y-%m-%dT%H-%M-%S)-drill"       # Unique drill run ID
```

### On-chain scripts (Drills 2, 3)

```bash
export DEPLOYER_PRIVATE_KEY="<staging deployer key>"
export FACTORY_ADDRESS="<staging factory address>"
export POOL_ADDRESS="<staging pool address>"              # Drill 2 only
```

### Runtime

```bash
cd unified-orchestrator
node --version    # >= 18 (fetch built-in required)
npx ts-node --version
```

### Preflight (run before any drill)

```bash
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  npx ts-node governance/scripts/00-preflight.ts
```

All checks must pass before proceeding.

---

## Drill 1 — Emergency Originations Halt (SOFT)

**Objective:** Prove backend can block all originations instantly via circuit-breaker and recover cleanly.

**Time to complete:** ~10 minutes
**Roles required:** 1 operator with admin API key
**Evidence:** `governance/evidence/<DRILL_ID>/01-soft-halt.json`

### Steps

```bash
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  [DRILL_PARTNER_ID=<active-partner-uuid>] \
  npx ts-node governance/scripts/01-soft-halt.ts
```

The script executes all sub-steps automatically:

| Step | Action | Expected result |
|------|--------|----------------|
| A | Capture baseline | `globalBlock=false`, 0 open incidents |
| B | Fire `ACTIVE_WITHOUT_DISBURSEMENT_PROOF` drill trigger | Incident created, `actionsApplied=[BLOCK_ALL_ORIGINATIONS]` |
| C | Check enforcement state | `globalBlock=true` |
| D | Attempt loan origination | HTTP 403 Forbidden |
| E | Acknowledge incident | `status=ACKNOWLEDGED` |
| F | Resolve incident | `status=RESOLVED` |
| G | Check enforcement state | `globalBlock=false` |
| H | Export audit log | Last 50 entries captured |

### Acceptance criteria

- [x] Halt takes effect within 1 API round-trip of trigger fire
- [x] Origination rejected with 403 while halted
- [x] Full incident lifecycle: OPEN → ACKNOWLEDGED → RESOLVED exercised
- [x] `globalBlock` returns to `false` after resolution
- [x] Audit trail contains GOVERNANCE_DRILL entry

---

## Drill 2 — On-Chain Pause (HARD)

**Objective:** Pause new loan creation on-chain via both the emergency path (PAUSER_ROLE) and the governance path (timelock). Verify safe exits remain possible.

**Time to complete:** ~30 min (emergency path) + 24h (governance timelock path, staging may be shorter)
**Roles required:** Account with PAUSER_ROLE and DEFAULT_ADMIN_ROLE on factory
**Evidence:** `e2e/governance/pause-factory-result.json`, `governance/evidence/<DRILL_ID>/02-onchain-pause.json`

### Step 2A — Baseline

```bash
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  npx ts-node governance/scripts/02-onchain-pause.ts
```

### Step 2B — Emergency pause (immediate)

```bash
DEPLOYER_PRIVATE_KEY=... FACTORY_ADDRESS=... \
  npx hardhat run scripts/governance/pause-factory.ts --network staging
```

Record the tx hash from the output.

### Step 2C — Governance path (pool removal via timelock)

```bash
# Schedule (creates timelock entry — wait 24h before executing)
DEPLOYER_PRIVATE_KEY=... FACTORY_ADDRESS=... POOL_ADDRESS=... \
  npx hardhat run scripts/governance/schedule-pool-removal.ts --network staging

# Execute after TIMELOCK_DELAY (24h production, may be shorter on staging)
DEPLOYER_PRIVATE_KEY=... FACTORY_ADDRESS=... POOL_ADDRESS=... \
  npx hardhat run scripts/governance/execute-pool-removal.ts --network staging
```

### Step 2D — Verification

Verify paused state:
- `createLoan()` reverts with `Pausable: paused`
- Existing SENT actions still mine (repayments unaffected)
- Pool allows queued withdrawal processing

### Step 2E — Finalize evidence

```bash
DRILL_PAUSE_TX_HASH=<tx>  DRILL_TIMELOCK_TX_HASH=<tx> \
  DRILL_EXECUTE_TX_HASH=<tx> DRILL_UNPAUSE_TX_HASH=<tx> \
  DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  npx ts-node governance/scripts/02-onchain-pause.ts
```

### Acceptance criteria

- [x] `factory.paused()` returns `true` after pause tx
- [x] `createLoan()` call reverts
- [x] Timelock delay of ≥ 24h observed (or staging override documented)
- [x] `factory.paused()` returns `false` after unpause tx
- [x] No QUEUED chain actions were double-sent during pause window

---

## Drill 3 — Settlement Signer Rotation

**Objective:** Rotate the settlement agent (the address authorised to call `recordFiatDisbursement`/`recordFiatRepayment`) via the governance timelock, and update the backend signer key atomically.

**Time to complete:** ~30 min + 24h timelock
**Roles required:** DEFAULT_ADMIN_ROLE on factory; secrets manager access
**Evidence:** `e2e/governance/schedule-signer-rotation-result.json`, `e2e/governance/execute-signer-rotation-result.json`, `governance/evidence/<DRILL_ID>/03-signer-rotation.json`

### Steps

```bash
# Step 1 — Document compromise + baseline
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  DRILL_OLD_SIGNER_ADDRESS=<old-addr> DRILL_NEW_SIGNER_ADDRESS=<new-addr> \
  npx ts-node governance/scripts/03-signer-rotation.ts

# Step 2 — Schedule timelock
DEPLOYER_PRIVATE_KEY=... FACTORY_ADDRESS=... DRILL_NEW_SIGNER_ADDRESS=<new-addr> \
  npx hardhat run scripts/governance/schedule-signer-rotation.ts --network staging

# Step 3 — (Wait 24h) Execute timelock
DEPLOYER_PRIVATE_KEY=... FACTORY_ADDRESS=... DRILL_NEW_SIGNER_ADDRESS=<new-addr> \
  npx hardhat run scripts/governance/execute-signer-rotation.ts --network staging

# Step 4 — Rotate backend key (manual)
#   Update CHAIN_ACTION_SIGNER_PRIVATE_KEY in secrets manager
#   Rolling-restart orchestrator

# Step 5 — Finalize evidence
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  DRILL_SCHEDULE_TX_HASH=<tx> DRILL_EXECUTE_TX_HASH=<tx> \
  npx ts-node governance/scripts/03-signer-rotation.ts
```

### Acceptance criteria

- [x] Timelock delay respected before `setSettlementAgent()` executes
- [x] `factory.settlementAgent()` returns new address after execution
- [x] Old signer address cannot call `recordFiatDisbursement` (reverts with `CallerNotSettlementAgent`)
- [x] Backend worker resumes cleanly with new signer key
- [x] Sender is paused during rotation window to prevent stale-key submissions

---

## Drill 4 — Partner Disablement

**Objective:** Remove a partner's ability to originate new loans (backend). Verify other partners are unaffected.

**Time to complete:** ~10 minutes
**Roles required:** Admin API key
**Evidence:** `governance/evidence/<DRILL_ID>/04-partner-disable.json`

### Steps

```bash
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  DRILL_PARTNER_ID=<partner-uuid> \
  npx ts-node governance/scripts/04-partner-disable.ts
```

The script:

| Step | Action | Expected result |
|------|--------|----------------|
| A | Identify target partner | ACTIVE partner selected |
| B | Capture pre-suspension state | Partner detail + active loan count |
| C | `POST /admin/partners/:id/suspend` | `status=SUSPENDED` |
| D | Test partner API key | HTTP 403 (manual step) |
| E | Check circuit-breaker state | Partner not independently blocked |
| F | Check other partners | `activeCount` unchanged |
| G | Capture audit log | Suspension event recorded |

### Manual API key verification (Step D)

```bash
# Using the partner's actual API key (obtain from test fixture):
curl -X POST "${DRILL_API_URL}/api/v1/loans" \
  -H "x-api-key: <partner-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"borrowerWallet":"0x...","principalUsdc":"1000000",...}'
# Expected: HTTP 403 {"message":"Partner account is suspended"}
```

### On-chain partner pool disablement (optional, governance path)

If the partner's pool should also be removed from the factory whitelist:

```bash
# Schedule (24h delay)
POOL_ADDRESS=<partner-pool-addr> \
  npx hardhat run scripts/governance/schedule-pool-removal.ts --network staging

# Execute after delay
POOL_ADDRESS=<partner-pool-addr> \
  npx hardhat run scripts/governance/execute-pool-removal.ts --network staging
```

### Acceptance criteria

- [x] `partner.status = SUSPENDED` immediately after API call
- [x] Partner API key rejected (403) on loan origination
- [x] All other ACTIVE partners unaffected
- [x] Suspension event visible in audit log

---

## Drill 5 — Recovery / Unpause

**Objective:** Verify that recovery requires a clean reconciliation report and that the full governance path to restore operations is exercised.

**Time to complete:** ~20 minutes (after Drills 1–4 are resolved)
**Roles required:** Admin API key; PAUSER_ROLE (if factory paused)
**Evidence:** `governance/evidence/<DRILL_ID>/05-recovery.json`, `e2e/governance/unpause-factory-result.json`

### Recovery gate — REQUIRED before unpause

```bash
# 1. Run reconciliation and verify clean
DRILL_ADMIN_KEY=... DRILL_OPERATOR_ID=... \
  [DRILL_UNPAUSE_TX_HASH=<tx>] [DRILL_PARTNER_ID=<uuid>] \
  npx ts-node governance/scripts/05-recovery.ts
```

**The script will EXIT with code 1 if reconciliation has critical mismatches.** This is the proof gate.

### Recovery sequence

| Order | Action | Command / Endpoint |
|-------|--------|-------------------|
| 1 | Resolve all open incidents | `POST /admin/breaker/incidents/:id/resolve` |
| 2 | Verify reconciliation clean | `GET /admin/ops/reconciliation` |
| 3 | Unpause factory (if paused) | `npx hardhat run scripts/governance/unpause-factory.ts` |
| 4 | Re-add pool (if removed) | `npx hardhat run scripts/governance/execute-pool-removal.ts` with `isPool=true` (re-whitelist via schedule → execute) |
| 5 | Re-activate partner (if suspended) | Admin manual review → status update |
| 6 | Verify enforcement state clean | `GET /admin/breaker/status` |
| 7 | Run recovery script | `npx ts-node governance/scripts/05-recovery.ts` |

### Acceptance criteria

- [x] Reconciliation reports 0 critical mismatches
- [x] All incidents RESOLVED before recovery proceeds
- [x] `factory.paused() = false` after unpause
- [x] `globalBlock = false`, `globalFreeze = false` in enforcement state
- [x] New loan origination attempt succeeds (smoke test)
- [x] Recovery decision record saved with operator signature

---

## Evidence Bundle

All scripts write to `governance/evidence/<DRILL_ID>/`. See `governance/evidence/README.md` for the expected structure.

```
governance/evidence/
└── 2026-02-23T10-00-00-000Z-drill/
    ├── 00-preflight.json
    ├── 01-soft-halt.json
    ├── 02-onchain-pause.json
    ├── 03-signer-rotation.json
    ├── 04-partner-disable.json
    └── 05-recovery.json

e2e/governance/
    ├── pause-factory-result.json
    ├── unpause-factory-result.json
    ├── schedule-pool-removal-result.json
    ├── execute-pool-removal-result.json
    ├── schedule-signer-rotation-result.json
    └── execute-signer-rotation-result.json
```

---

## Common Issues

| Symptom | Likely cause | Resolution |
|---------|-------------|-----------|
| Preflight fails with 403 | Wrong `DRILL_ADMIN_KEY` | Verify against `ADMIN_API_KEY` in staging env |
| Drill 1: 200 instead of 403 on origination | `assertOriginationAllowed` not wired to LoanController | Check `LoanController.create()` calls `breaker.assertOriginationAllowed()` |
| Drill 2: Timelock reverts `TimelockNotReady` | Executed before delay expired | Check `TIMELOCK_DELAY` constant; on staging may differ |
| Drill 2: `pause()` reverts | Caller lacks `PAUSER_ROLE` | Grant role or use deployer account |
| Drill 3: `setSettlementAgent` reverts | Timelock not scheduled or expired | Re-schedule and wait |
| Drill 5: Recovery gate blocks | Reconciliation mismatches exist | Resolve mismatch, then re-run |

---

## Post-Drill Cleanup

After completing all drills on staging:

1. Ensure all incidents are `RESOLVED`
2. Ensure factory is unpaused (`factory.paused() = false`)
3. Ensure all pools are re-whitelisted
4. Ensure all partners are back in intended state
5. Archive evidence bundle to secure storage
6. Fill in `governance/templates/DRILL_LOG.md`
7. If any step failed, file a post-mortem using `governance/templates/POSTMORTEM_TEMPLATE.md`
