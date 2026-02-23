# Incident Post-Mortem

**Incident ID:** ___________________________
**Post-Mortem Author:** ___________________________
**Date Written (UTC):** ___________________________
**Review Meeting Date:** ___________________________
**Status:** DRAFT / UNDER REVIEW / FINAL

---

## 1. Incident Summary

| Field | Value |
|-------|-------|
| Severity | CRITICAL / HIGH / MEDIUM |
| Scope | GLOBAL / PARTNER / POOL |
| Trigger | *(BreakerTrigger enum value or free-text)* |
| First detected (UTC) | |
| Incident opened (UTC) | |
| Incident resolved (UTC) | |
| Total duration | |
| Was this a drill? | YES / NO |
| Customer/partner impact | *(describe or "None")* |
| Funds at risk at peak | *(USD amount or "None")* |

### Summary (2–4 sentences)

*Describe what happened, why it mattered, and what was done to resolve it.*

---

## 2. Timeline

*All times in UTC. Include every significant event — detection, escalation, decisions, actions, resolution.*

| Time (UTC) | Event | Actor |
|------------|-------|-------|
| | Alert triggered / metric exceeded threshold | system |
| | Incident commander assigned | |
| | Incident opened in system | |
| | First responder acknowledged | |
| | Soft halt applied (if applicable) | |
| | Hard pause applied (if applicable) | |
| | Root cause identified | |
| | Fix deployed | |
| | Recovery authorized | |
| | Incident resolved | |
| | Post-mortem initiated | |

---

## 3. Root Cause Analysis

### 3A — What happened (technical)

*Describe the root cause in technical detail. Reference specific metrics, log lines, or on-chain transactions.*

### 3B — Contributing factors

- *Factor 1*
- *Factor 2*
- *Factor 3*

### 3C — Why it wasn't caught sooner

*What monitoring gap, process gap, or human factor allowed this to reach the severity it did?*

---

## 4. Impact Assessment

| Area | Impact | Notes |
|------|--------|-------|
| Originations blocked | YES / NO | Duration: ___ |
| Active loans affected | YES / NO | Count: ___ |
| Partner(s) suspended | YES / NO | Partner(s): ___ |
| Pool(s) removed | YES / NO | Pool(s): ___ |
| On-chain pause invoked | YES / NO | Tx: ___ |
| Signer rotation required | YES / NO | |
| External notification required | YES / NO | Recipients: ___ |
| Regulatory reporting required | YES / NO | Regulator: ___ |

---

## 5. What Went Well

*Processes, tooling, or decisions that worked effectively during the incident.*

-
-
-

---

## 6. What Went Poorly

*Gaps in process, tooling failures, or decisions that slowed response or worsened impact.*

-
-
-

---

## 7. Action Items

*Each item must have an owner and a target date. Mark BLOCKING if it must be completed before the next drill.*

| # | Action | Owner | Target date | Blocking? | Status |
|---|--------|-------|-------------|-----------|--------|
| 1 | | | | YES / NO | OPEN |
| 2 | | | | YES / NO | OPEN |
| 3 | | | | YES / NO | OPEN |
| 4 | | | | YES / NO | OPEN |

---

## 8. Evidence References

| Artifact | Location |
|----------|----------|
| Decision checklist | `governance/evidence/<INCIDENT_ID>/decision-checklist.md` |
| Drill evidence bundle | `governance/evidence/<INCIDENT_ID>/` |
| Reconciliation report | |
| Audit log export | |
| On-chain tx links | |
| Monitoring dashboard snapshot | |

---

## 9. Sign-off

*All reviewers must sign before status is set to FINAL.*

| Role | Name | Signature | Date (UTC) |
|------|------|-----------|------------|
| Post-Mortem Author | | | |
| Incident Commander | | | |
| Technical Lead | | | |
| Risk / Compliance | | | |
| Engineering Manager | | | |

---

*Retain this document in the governance incident record alongside the evidence bundle.*
*Template version: 1.1*
