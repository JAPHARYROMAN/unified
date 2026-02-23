# Governance Drill Log

**Drill ID:** ___________________________  *(format: DRILL-YYYYMMDD-NNN)*
**Date (UTC):** ___________________________
**Incident Commander:** ___________________________
**Environment:** STAGING / TESTNET / MAINNET-SHADOW
**Participants:**

| Name | Role | Present (Y/N) |
|------|------|---------------|
| | Incident Commander | |
| | Technical Lead | |
| | Backend Operator | |
| | On-chain Operator | |
| | Risk / Compliance Observer | |

---

## Pre-Drill Checklist

| Item | Status | Notes |
|------|--------|-------|
| Staging environment healthy | ☐ PASS  ☐ FAIL | |
| All participants confirmed available | ☐ YES  ☐ NO | |
| Previous drill action items resolved | ☐ YES  ☐ NO  ☐ N/A | |
| Evidence directory created (`governance/evidence/<DRILL_ID>/`) | ☐ YES | |
| Admin API key available | ☐ YES | |
| Hardhat node / testnet funded | ☐ YES  ☐ N/A | |
| Factory + Pool addresses noted | ☐ YES  ☐ N/A | |
| 00-preflight script passed | ☐ YES  ☐ NO | |

---

## Drill Execution Summary

### Drill 1 — Emergency Originations Halt (Soft)

| Step | Result | Time (UTC) | Notes |
|------|--------|------------|-------|
| Fire `ACTIVE_WITHOUT_DISBURSEMENT_PROOF` trigger | ☐ PASS  ☐ FAIL  ☐ SKIP | | Incident ID: ___ |
| `globalBlock = true` confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Origination attempt returns 403 | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Incident acknowledged | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Incident resolved | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `globalBlock = false` confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Audit log exported | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| **Drill 1 overall** | ☐ PASS  ☐ FAIL  ☐ PARTIAL | | |

Time taken: _____ min  |  Evidence file: `01-soft-halt.json`

---

### Drill 2 — On-Chain Pause (Hard)

| Step | Result | Time (UTC) | Notes |
|------|--------|------------|-------|
| Backend pre-pause state captured | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `pause-factory.ts` executed | ☐ PASS  ☐ FAIL  ☐ SKIP | | Tx: ___ |
| `factory.paused() = true` verified | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Finalize phase run | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| **Drill 2 overall** | ☐ PASS  ☐ FAIL  ☐ PARTIAL | | |

Time taken: _____ min  |  Evidence file: `02-onchain-pause.json`

---

### Drill 3 — Settlement Signer Rotation

| Step | Result | Time (UTC) | Notes |
|------|--------|------------|-------|
| Compromise event documented | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Backend sender paused | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `schedule-signer-rotation.ts` executed | ☐ PASS  ☐ FAIL  ☐ SKIP | | Tx: ___ |
| 24h delay confirmed elapsed (drill: 30s) | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `execute-signer-rotation.ts` executed | ☐ PASS  ☐ FAIL  ☐ SKIP | | Tx: ___ |
| New signer verified on-chain | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Backend key updated in secrets manager | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Orchestrator restarted | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| **Drill 3 overall** | ☐ PASS  ☐ FAIL  ☐ PARTIAL | | |

Time taken: _____ min  |  Evidence file: `03-signer-rotation.json`

---

### Drill 4 — Partner Disablement

| Step | Result | Time (UTC) | Notes |
|------|--------|------------|-------|
| Partner identified | ☐ PASS  ☐ FAIL  ☐ SKIP | | Partner ID: ___ |
| Partner suspended via API | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Partner status = SUSPENDED confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Partner API key returns 403 confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Other partners unaffected confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Pool removal scheduled (if required) | ☐ PASS  ☐ FAIL  ☐ N/A | | Tx: ___ |
| **Drill 4 overall** | ☐ PASS  ☐ FAIL  ☐ PARTIAL | | |

Time taken: _____ min  |  Evidence file: `04-partner-disable.json`

---

### Drill 5 — Recovery / Unpause

| Step | Result | Time (UTC) | Notes |
|------|--------|------------|-------|
| Reconciliation gate passed (0 critical mismatches) | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| All incidents resolved | ☐ PASS  ☐ FAIL  ☐ SKIP | | Remaining: ___ |
| All overrides lifted | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `unpause-factory.ts` executed | ☐ PASS  ☐ FAIL  ☐ SKIP | | Tx: ___ |
| `factory.paused() = false` verified | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| `globalBlock = false` confirmed | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| Recovery decision record written | ☐ PASS  ☐ FAIL  ☐ SKIP | | |
| **Drill 5 overall** | ☐ PASS  ☐ FAIL  ☐ PARTIAL | | |

Time taken: _____ min  |  Evidence file: `05-recovery.json`

---

## Overall Drill Assessment

| Metric | Value |
|--------|-------|
| Total drills executed | / 5 |
| Total drills PASS | |
| Total drills PARTIAL | |
| Total drills FAIL / SKIP | |
| Total wall-clock time | |
| Evidence files written | |
| Blockers encountered | YES / NO |

### Overall result: PASS / PARTIAL / FAIL

---

## Issues Encountered

*Record any failures, deviations from runbook, or unexpected behaviour.*

| # | Drill | Description | Severity | Resolution |
|---|-------|-------------|----------|------------|
| 1 | | | HIGH / MEDIUM / LOW | |
| 2 | | | | |

---

## Action Items from this Drill

| # | Action | Owner | Target date |
|---|--------|-------|-------------|
| 1 | | | |
| 2 | | | |

---

## Post-Drill Sign-off

| Role | Name | Signature | Time (UTC) |
|------|------|-----------|------------|
| Incident Commander | | | |
| Technical Lead | | | |
| Risk / Compliance | | | |

---

*Retain this log alongside the evidence bundle in `governance/evidence/<DRILL_ID>/`.*
*Template version: 1.1*
