# Governance Emergency Decision Checklist

**Incident ID:** ___________________________
**Date / Time (UTC):** ___________________________
**Incident Commander:** ___________________________
**Approvers (min. 2):** ___________________________  /  ___________________________

---

## Section 1 — Incident Classification

| Question | Answer |
|----------|--------|
| What is the trigger / alert? | |
| Severity (CRITICAL / HIGH / MEDIUM) | |
| Scope (GLOBAL / PARTNER / POOL) | |
| Is this a confirmed incident or a drill? | CONFIRMED / DRILL |
| Time of first detection (UTC) | |
| Time of this decision (UTC) | |

---

## Section 2 — Origination Halt Decision

### 2A — Soft Halt (Backend circuit-breaker)

| Check | Status | Notes |
|-------|--------|-------|
| Reconciliation report shows mismatches | ☐ YES  ☐ NO | |
| ACTIVE_WITHOUT_DISBURSEMENT_PROOF count > 0 | ☐ YES  ☐ NO | Count: ___ |
| FIAT_CONFIRMED_NO_CHAIN_RECORD count > 0 | ☐ YES  ☐ NO | Count: ___ |
| Partner default rate > 8% (30d) | ☐ YES  ☐ NO | Partner: ___ / Rate: ___% |
| Pool liquidity ratio < 25% | ☐ YES  ☐ NO | Ratio: ___% |
| **DECISION: Halt originations?** | **☐ YES  ☐ NO** | |
| If YES — trigger fired via drill script? | ☐ YES  ☐ NO | Incident ID: ___ |

### 2B — Hard Pause (On-chain)

*Requires approval from ≥ 2 signers.*

| Check | Status | Notes |
|-------|--------|-------|
| Soft halt insufficient (funds at risk on-chain) | ☐ YES  ☐ NO | |
| PAUSER_ROLE holder available | ☐ YES  ☐ NO | |
| Timelock governance path preferred (24h delay) | ☐ YES  ☐ NO | |
| Emergency path required (immediate pause) | ☐ YES  ☐ NO | |
| **DECISION: Hard pause factory?** | **☐ YES  ☐ NO** | |
| Pause tx hash | | |
| Verified `factory.paused() = true` | ☐ YES  ☐ NO | |

---

## Section 3 — Signer Rotation Decision

| Check | Status | Notes |
|-------|--------|-------|
| Signer key confirmed or suspected compromised | ☐ YES  ☐ NO | |
| Unauthorised txns observed on-chain | ☐ YES  ☐ NO | Tx: ___ |
| New signer address prepared and verified | ☐ YES  ☐ NO | |
| Backend sender paused during rotation | ☐ YES  ☐ NO | |
| **DECISION: Rotate signer?** | **☐ YES  ☐ NO** | |
| Timelock schedule tx | | |
| Execute tx (after 24h) | | |
| Backend key updated in secrets manager | ☐ YES  ☐ NO | |
| Orchestrator restarted | ☐ YES  ☐ NO | |

---

## Section 4 — Partner Disablement Decision

| Check | Status | Notes |
|-------|--------|-------|
| Partner identified (name / ID) | | |
| Reason for disablement | | |
| Existing active loans reviewed | ☐ YES  ☐ NO | Count: ___ |
| Other partners unaffected confirmed | ☐ YES  ☐ NO | |
| **DECISION: Suspend partner?** | **☐ YES  ☐ NO** | |
| Partner API key verified rejected (403) | ☐ YES  ☐ NO | |
| Pool removal required on-chain? | ☐ YES  ☐ NO | Pool: ___ |

---

## Section 5 — Recovery Authorization

*Recovery requires ALL of the following to be checked before proceeding.*

| Gate | Status | Evidence |
|------|--------|----------|
| Reconciliation report: 0 critical mismatches | ☐ PASSED  ☐ FAILED | Report timestamp: ___ |
| All open incidents resolved | ☐ YES  ☐ NO | Remaining: ___ |
| All active overrides reviewed | ☐ YES  ☐ NO | |
| Root cause identified | ☐ YES  ☐ NO | Summary: ___ |
| Fix deployed / validated | ☐ YES  ☐ NO | |
| Approver 1 signs off | | Name: ___ / Time: ___ |
| Approver 2 signs off | | Name: ___ / Time: ___ |
| **AUTHORIZATION: Proceed with recovery?** | **☐ YES  ☐ NO** | |

### Recovery actions taken

| Action | Tx hash / API call | Time (UTC) | Operator |
|--------|--------------------|------------|----------|
| Resolve incident | | | |
| Unpause factory | | | |
| Re-add pool (if removed) | | | |
| Re-activate partner (if suspended) | | | |
| Verify `globalBlock = false` | | | |

---

## Section 6 — Sign-off

| Role | Name | Signature | Timestamp (UTC) |
|------|------|-----------|----------------|
| Incident Commander | | | |
| Technical Lead | | | |
| Risk / Compliance | | | |

---

*Retain this checklist in the evidence bundle and governance incident record.*
*Template version: 1.1*
