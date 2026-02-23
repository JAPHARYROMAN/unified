# Unified v1.2 — Governance Parameter Lock (Conservative Launch)

| Field          | Value                                              |
|----------------|----------------------------------------------------|
| **Status**     | RATIFIED — CONSERVATIVE LAUNCH VERSION             |
| **Version**    | 1.2.0-conservative                                 |
| **Supersedes** | 1.2.0 (Proposal — Pending Review)                  |
| **Author**     | Governance Architect                               |
| **Date**       | 2026-02-23                                         |
| **Scope**      | All Unified protocol parameters                    |
| **Posture**    | Conservative — bounds tightened for launch without 12-month production data |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Parameter Taxonomy](#2-parameter-taxonomy)
3. [Complete Parameter Register](#3-complete-parameter-register)
   - [3A — On-Chain: UnifiedLoanFactory](#3a--on-chain-unifiedloanfactory)
   - [3B — On-Chain: UnifiedFeeManager](#3b--on-chain-unifiedfeemanager)
   - [3C — On-Chain: UnifiedPool / UnifiedPoolTranched (v1.2)](#3c--on-chain-unifiedpool--unifiedpooltranched-v12)
   - [3D — Off-Chain: Circuit-Breaker Thresholds](#3d--off-chain-circuit-breaker-thresholds)
   - [3E — Per-Loan Parameters](#3e--per-loan-parameters)
4. [Hard Bounds](#4-hard-bounds)
5. [Adjustment Frequency Limits](#5-adjustment-frequency-limits)
6. [Stability Windows](#6-stability-windows)
7. [Emergency Override Rules](#7-emergency-override-rules)
8. [Change Notification Requirements](#8-change-notification-requirements)
9. [Anti-Abuse Rules](#9-anti-abuse-rules)
   - [9.3 — Conservative Launch Ratchet Rule](#93--conservative-launch-ratchet-rule)
10. [Capital Structure Integrity Invariants](#10-capital-structure-integrity-invariants)
11. [Governance Abuse Scenarios and Mitigations](#11-governance-abuse-scenarios-and-mitigations)

**Appendices**
- [Appendix A — Parameter Change Checklist](#appendix-a--parameter-change-checklist)
- [Appendix B — Governance Role Matrix](#appendix-b--governance-role-matrix)
- [Appendix C — Parameter Immutability Map](#appendix-c--parameter-immutability-map)
- [Appendix D — Conservative Bound Justification Memo](#appendix-d--conservative-bound-justification-memo)

---

## 1. Executive Summary

This document classifies every configurable parameter in the Unified protocol into a governance tier, defines hard bounds for each, specifies frequency limits to prevent parameter thrashing, and mandates notification windows before changes take effect.

This version (**1.2.0-conservative**) tightens the bounds established in the initial proposal to reflect a **conservative launch posture**: the protocol launches without 12 months of production data, with pilot-calibrated recovery rate assumptions (≤ 40%), a hard ceiling on Senior allocation (≤ 75% / 7,500 bps), and an explicit ratchet rule that prevents any drift toward aggressive Senior leverage without documented evidence. All bounds here are more restrictive than v1.2.0; they relax only when the conditions in §9.3 (Senior Allocation Ratchet) or Appendix D (Justification Memo) are met.

**Three core objectives:**

| Objective | Mechanism |
|-----------|-----------|
| Prevent governance abuse | Role separation + timelock + quorum requirements |
| Prevent parameter thrashing | Frequency limits + stability windows + change velocity caps |
| Preserve capital structure integrity | Conservative hard bounds; Senior allocation ratchet; Junior reduction requires 60-day window + public report |

**Conservative-launch additions (v1.2.0-conservative vs v1.2.0):**

| Change | v1.2.0 | v1.2.0-conservative |
|--------|--------|---------------------|
| `seniorAllocationBps` ceiling | 9,000 (90%) | **7,500 (75%)** |
| `minSubordinationBps` floor | 1,000 (10%) | **1,500 (15%)** |
| `seniorLiquidityFloorBps` floor | 500 (5%) | **1,000 (10%)** |
| `juniorCoverageFloorBps` floor | *(not defined)* | **1,000 (10%)** |
| `recoveryRateAssumptionPct` ceiling | *(not defined)* | **40%** |
| `breakerSeniorThresholdUsdc` | *(not defined)* | **0 (immutable at launch)** |
| Junior allocation reduction | 14-day frequency limit | **60-day stability window + public report** |
| Senior allocation increase | delta cap only | **Ratchet rule (§9.3) — 6 months data required** |

---

## 2. Parameter Taxonomy

Parameters are classified into five governance tiers:

```
Tier 0 — IMMUTABLE
  ↓ cannot ever change (set in constructor)

Tier 1 — CONSTANT
  ↓ hardcoded in contract; requires redeploy + migration

Tier 2 — TIMELOCK-GOVERNED
  ↓ 24h on-chain timelock + DEFAULT_ADMIN_ROLE multisig
  ↓ subject to frequency limits and stability windows

Tier 3 — EMERGENCY-ADJUSTABLE
  ↓ single multisig call, no timelock delay
  ↓ subject to post-action mandatory review
  ↓ auto-expiring overrides only

Tier 4 — OPERATIONAL
  ↓ set per-transaction at loan creation
  ↓ bounded by on-chain enforced minimums/maximums
  ↓ no post-deployment governance gate
```

### Tier Definitions

| Tier | Delay | Who can change | Reversible | Audit trail |
|------|-------|----------------|------------|-------------|
| 0 — Immutable | ∞ | Nobody | No | N/A |
| 1 — Constant | Redeploy | DEFAULT_ADMIN via migration | Contract only | On-chain + deployment record |
| 2 — Timelock-Governed | ≥ 24h on-chain | DEFAULT_ADMIN_ROLE | Yes | On-chain events |
| 3 — Emergency | 0 | PAUSER_ROLE / DEFAULT_ADMIN_ROLE | Yes | On-chain events + mandatory postmortem |
| 4 — Operational | 0 | Originator (bounded by Tier 2 params) | No (per-loan) | On-chain loan event |

---

## 3. Complete Parameter Register

### 3A — On-Chain: UnifiedLoanFactory

| Parameter | Current / Default | Tier | Hard Floor | Hard Ceiling | Notes |
|-----------|------------------|------|------------|--------------|-------|
| `usdc` | deployment-time | **0 — Immutable** | — | — | Stablecoin cannot be repointed |
| `TIMELOCK_DELAY` | 24 hours | **1 — Constant** | 24 hours | — | Cannot be shortened without redeploy |
| `loanImplementation` | deployment-time | **2 — Timelock** | — | — | 24h delay before new clone logic activates |
| `collateralVault` | deployment-time | **2 — Timelock** | — | — | Must be non-zero |
| `feeManager` | deployment-time | **2 — Timelock** | — | — | Must be non-zero |
| `treasury` | deployment-time | **2 — Timelock** | — | — | Must be non-zero |
| `riskRegistry` | deployment-time | **2 — Timelock** | — | — | `address(0)` disables; disabling is also timelocked |
| `identityRegistry` | deployment-time | **2 — Timelock** | — | — | `address(0)` disables; disabling is also timelocked |
| `settlementAgent` | deployment-time | **2 — Timelock** | — | — | Must be non-zero |
| `isPool[addr]` | per-pool | **2 — Timelock** | — | — | Add and remove both timelocked |
| `allowedCollateral[token]` | per-token | **2 — Timelock** | — | — | Add and revoke both timelocked |
| `minCollateralRatioBps[token]` | per-token | **2 — Timelock** | 5,000 bps (50%) | 20,000 bps (200%) | See §4 |
| `kycRequired` | false | **2 — Timelock** | — | — | Disabling is also timelocked |
| `enforceJurisdiction` | false | **2 — Timelock** | — | — | Disabling is also timelocked |
| `enforceTierCaps` | false | **2 — Timelock** | — | — | |
| `requireFiatProofBeforeActivate` | false | **2 — Timelock** | — | — | |
| `maxBorrowerExposure` | 0 (disabled) | **2 — Timelock** | 0 (no cap) | — | 0 disables; lowering is immediate cap-in effect |
| `jurisdictionAllowed[code]` | per-code | **3 — Emergency*** | — | — | *Currently no timelock; propose adding one (see §9.2) |
| `tierBorrowCap[tier]` | 0 (no cap) | **3 — Emergency*** | 0 | — | *Currently no timelock; propose adding one (see §9.2) |
| Factory `paused` state | false | **3 — Emergency** | — | — | PAUSER_ROLE; mandatory postmortem if used in production |

> **Note on `jurisdictionAllowed` and `tierBorrowCap`:** These are currently non-timelocked admin setters. This is a governance gap — see [§9.2](#92-identified-governance-gaps) for the proposed fix.

---

### 3B — On-Chain: UnifiedFeeManager

| Parameter | Current / Default | Tier | Hard Floor | Hard Ceiling | Notes |
|-----------|------------------|------|------------|--------------|-------|
| `TIMELOCK_DELAY` | 24 hours | **1 — Constant** | 24 hours | — | |
| `MAX_FEE_BPS` | 5,000 bps (50%) | **1 — Constant** | — | 5,000 bps | Hard-coded contract ceiling |
| `originationFeeBps` | deployment-time | **2 — Timelock** | 0 | 500 bps (5%) | See §4 — governance ceiling < contract ceiling |
| `interestFeeBps` | deployment-time | **2 — Timelock** | 0 | 1,000 bps (10%) | |
| `lateFeeBps` | deployment-time | **2 — Timelock** | 0 | 500 bps (5%) | |
| `treasury` | deployment-time | **2 — Timelock** | — | — | Must be non-zero |

---

### 3C — On-Chain: UnifiedPool / UnifiedPoolTranched (v1.2)

#### Untranched pool (v1.0/v1.1)

| Parameter | Tier | Notes |
|-----------|------|-------|
| `usdc` | **0 — Immutable** | |
| `partnerId` | **0 — Immutable** | |
| `MAX_OPEN_REQUESTS` | **1 — Constant** | Anti-griefing cap |
| Pool `paused` state | **3 — Emergency** | PAUSER_ROLE |

#### Tranched pool (v1.2 — `UnifiedPoolTranched`)

Launch defaults and conservative bounds. Parameters marked ★ are tightened vs v1.2.0.

| Parameter | Launch Default | Tier | Hard Floor | Hard Ceiling | Notes |
|-----------|---------------|------|------------|--------------|-------|
| `usdc` | — | **0 — Immutable** | — | — | |
| `partnerId` | — | **0 — Immutable** | — | — | |
| `breakerSeniorThresholdUsdc` | **0** | **0 — Immutable at launch** | 0 | 0 | Fixed at zero; Senior breach fires at first dollar of loss. Revisable only via §9.3 ratchet process. ★ |
| `seniorAllocationBps` | **7,000 (70%)** | **2 — Timelock** | 5,000 (50%) | **7,500 (75%) ★** | Conservative ceiling: 75/25 is maximum Senior share at launch. Increase requires §9.3 ratchet. |
| `seniorTargetYieldBps` | 800 (8% APY) | **2 — Timelock** | 0 | 2,000 (20% APY) | Operative ceiling is WANPY₁₂ (§10.1A), not this hard ceiling. |
| `seniorLiquidityFloorBps` | **1,500 (15%)** | **2 — Timelock** | **1,000 (10%) ★** | 5,000 (50%) | Floor raised from 5% to 10% (conservative). Must satisfy CONSTRAINT-6. |
| `juniorNavDrawdownCapBps` | 3,000 (30%) | **2 — Timelock** | **1,500 (15%) ★** | 5,000 (50%) | Minimum 15% ensures Junior is not wiped out undetected before stress fires. |
| `juniorCoverageFloorBps` | **1,500 (15%)** | **2 — Timelock** | **1,000 (10%) ★** | 3,000 (30%) | Minimum buffer of Junior NAV required before new Senior deposits accepted. ★ |
| `seniorNavDrawdownCapBps` | 500 (5%) | **2 — Timelock** | 100 (1%) | 2,000 (20%) | Emergency pause trigger. |
| `minSubordinationBps` | **2,000 (20%)** | **2 — Timelock** | **1,500 (15%) ★** | 5,000 (50%) | Floor raised from 10% to 15%: Junior must cover ≥ 15% of pool at all times. |
| `recoveryRateAssumptionPct` | **40%** | **1 — Code-Constant at launch** | — | **40% ★** | Off-chain model parameter used in WANPY₁₂ stress scenarios (§10.1B). Capped at 40% until 6 months of realized recovery data exists. Conservative: pilot sweep used 30–60%, locked at 40% midpoint. |
| `minHoldSeconds[Senior]` | 0 | **2 — Timelock** | 0 | 7 days | Flash-loan protection. |
| `minHoldSeconds[Junior]` | 0 | **2 — Timelock** | 0 | 7 days | |
| `seniorPriorityMaxDuration` | 30 days | **2 — Timelock** | 7 days | 180 days | Must not permanently lock Junior. |
| `trancheDepositCap[Senior]` | 0 (unlimited) | **3 — Emergency** | 0 | — | 0 = no cap; used for rapid exposure limiting. |
| `trancheDepositCap[Junior]` | 0 (unlimited) | **3 — Emergency** | 0 | — | |
| `stressMode` | false | **3 — Emergency** | — | — | Freeze; mandatory manual lift with postmortem gate. |
| `seniorPriorityActive` (clear) | — | **3 — Emergency** | — | — | Junior unlock; governance override only. |

---

### 3D — Off-Chain: Circuit-Breaker Thresholds

These thresholds live in `circuit-breaker.types.ts` (TypeScript constant `TRIGGER_CATALOGUE`). They are **not** on-chain; a code change and backend redeploy is required to modify them.

| Trigger | Current Threshold | Tier | Proposed Floor | Proposed Ceiling | Action on Fire |
|---------|------------------|------|----------------|------------------|----------------|
| `ACTIVE_WITHOUT_DISBURSEMENT_PROOF` | count > 0 | **1 — Code-Constant** | 0 | 0 (always immediate) | BLOCK_ALL_ORIGINATIONS |
| `FIAT_CONFIRMED_NO_CHAIN_RECORD` | count > 0 | **1 — Code-Constant** | 0 | 0 (always immediate) | BLOCK_ALL_ORIGINATIONS |
| `PARTNER_DEFAULT_RATE_30D` | > 8% | **2 — Config-Governed*** | 5% | 20% | BLOCK_PARTNER_ORIGINATIONS |
| `PARTNER_DELINQUENCY_14D` | > 15% | **2 — Config-Governed*** | 10% | 35% | BLOCK_PARTNER_ORIGINATIONS + TIGHTEN_TERMS |
| `POOL_LIQUIDITY_RATIO` | < 25% | **2 — Config-Governed*** | 5% | 50% | FREEZE_ORIGINATIONS |
| `POOL_NAV_DRAWDOWN_7D` | < 2% loss | **2 — Config-Governed*** | 1% | 10% | FREEZE_ORIGINATIONS + TIGHTEN_TERMS |

> \* "Config-Governed" means: requires a pull-request → code review → staging validation → production deploy. The governance review window must be ≥ 7 days for threshold changes.

**Proposed migration to configurable thresholds:** The `TRIGGER_CATALOGUE` should be moved to a database-backed configuration table (`BreakerThresholdConfig`) governed by a versioned admin API that enforces the floors/ceilings above. This eliminates deploy coupling for routine threshold calibration.

---

### 3E — Per-Loan Parameters

These are set at loan creation and **cannot be changed after the loan is created**. They are bounded by the Tier 2 parameters above.

| Loan Parameter | Bounded by | Minimum | Maximum |
|----------------|-----------|---------|---------|
| `principalAmount` | `maxBorrowerExposure`, `tierBorrowCap` | 1 USDC | `maxBorrowerExposure` |
| `interestRateBps` (APR) | — | 0 | 10,000 bps (100% APR) |
| `penaltyAprBps` | — | 0 | 20,000 bps (200% APR) |
| `durationSeconds` | — | 1 day | 10 years |
| `gracePeriodSeconds` | — | 0 | 365 days |
| `collateralAmount` | `minCollateralRatioBps[token]` | `principal × minRatio` | — |
| `totalInstallments` | — | 1 | 360 |
| `installmentInterval` | — | 1 day | — |
| `defaultThresholdDays` | — | 1 | 365 |

---

## 4. Hard Bounds

Hard bounds are enforced at the point of parameter change. Attempting to set a parameter outside its hard bounds **must revert** (on-chain) or be **rejected at the API layer** (off-chain). Bounds are more restrictive than the contract-level maximums to preserve capital structure integrity.

### Fee bounds (UnifiedFeeManager)

| Parameter | Contract Max | Governance Ceiling | Rationale |
|-----------|-------------|-------------------|-----------|
| `originationFeeBps` | 5,000 (50%) | **500 bps (5%)** | Prevents predatory origination extraction |
| `interestFeeBps` | 5,000 (50%) | **1,000 bps (10%)** | Interest fee > 10% is confiscatory |
| `lateFeeBps` | 5,000 (50%) | **500 bps (5%)** | Late fee stacking with penalty APR |

### Collateral ratio bounds (UnifiedLoanFactory)

| Parameter | Floor | Ceiling | Rationale |
|-----------|-------|---------|-----------|
| `minCollateralRatioBps[any]` | **5,000 bps (50%)** | **20,000 bps (200%)** | Below 50% creates undercollateralized credit risk; above 200% is economically prohibitive |

### Tranche bounds (UnifiedPoolTranched)

Conservative-launch bounds (★ = tightened vs v1.2.0). Bounds relax only via the §9.3 ratchet process or a formal governance amendment with a completed Appendix D justification memo.

| Parameter | Floor | Ceiling | Rationale |
|-----------|-------|---------|-----------|
| `seniorAllocationBps` | **5,000 (50%)** | **7,500 (75%) ★** | Launch ceiling of 75%: a 25% mandatory Junior share ensures meaningful first-loss absorption without 12-month recovery data. The v1.2.0 ceiling of 90% is only available after the §9.3 ratchet conditions are met. |
| `seniorTargetYieldBps` | **0** | **2,000 (20% APY)** | Hard ceiling unchanged; operative ceiling is WANPY₁₂ (§10.1A), which is the binding constraint. |
| `minSubordinationBps` | **1,500 (15%) ★** | **5,000 (50%)** | Floor raised from 10% to 15%: at 70/30 allocation, 15% subordination means Junior must absorb 50% of its nominal share before Senior is touched. This is consistent with `juniorCoverageFloorBps ≥ 1,000`. |
| `juniorCoverageFloorBps` | **1,000 (10%) ★** | **3,000 (30%)** | New parameter. Minimum Junior NAV as a percentage of total pool NAV required before additional Senior deposits are accepted. Prevents Senior depositors entering a pool where Junior coverage is insufficient. |
| `juniorNavDrawdownCapBps` | **1,500 (15%) ★** | **5,000 (50%)** | Floor raised from 10% to 15%: stress mode fires before Junior is more than 15% drawn down from high-water mark. |
| `seniorNavDrawdownCapBps` | **100 (1%)** | **2,000 (20%)** | Unchanged: emergency pause fires on first 1% Senior NAV loss. |
| `seniorLiquidityFloorBps` | **1,000 (10%) ★** | **5,000 (50%)** | Floor raised from 5% to 10%: allocation block fires before severe illiquidity. Must satisfy CONSTRAINT-6: `seniorLiquidityFloorBps ≥ ⌊POOL_LIQUIDITY_RATIO_threshold × 10,000⌋`. |
| `recoveryRateAssumptionPct` | — | **40% ★** | Off-chain cap on the recovery rate used in WANPY₁₂ stress-scenario calculations. Conservative: pilot sweep range was 30–60%; 40% is the lower quartile. Ceiling removed after 6 months of realized recovery data (see §9.3). |

### Circuit-breaker threshold bounds (off-chain)

| Trigger | Floor | Ceiling | Rationale |
|---------|-------|---------|-----------|
| `PARTNER_DEFAULT_RATE_30D` | **5%** | **20%** | Above 20% threshold makes the breaker meaningless |
| `PARTNER_DELINQUENCY_14D` | **10%** | **35%** | |
| `POOL_LIQUIDITY_RATIO` | **5%** | **50%** | A floor below 5% invites insolvency before detection |
| `POOL_NAV_DRAWDOWN_7D` | **1%** | **10%** | A ceiling above 10% is too tolerant of loss |

---

## 5. Adjustment Frequency Limits

To prevent parameter thrashing (rapid back-and-forth changes that manipulate protocol behavior), each Tier 2 parameter has a **minimum interval** between successive changes.

| Parameter Group | Direction | Min Interval Between Changes | Rationale |
|-----------------|-----------|------------------------------|-----------|
| Fee rates (`originationFeeBps`, `interestFeeBps`, `lateFeeBps`) | Any | **30 days** | Existing borrowers and LPs must be able to plan |
| Collateral ratios (`minCollateralRatioBps`) | Any | **14 days** | Sudden increases strand existing borrowers |
| Pool whitelist (`isPool`) | Add | **7 days** | |
| Pool whitelist (`isPool`) | Remove | **48h** | Removal may be emergency-driven |
| Collateral allowlist (`allowedCollateral`) | Add | **7 days** | |
| Collateral allowlist (`allowedCollateral`) | Remove | **48h** | |
| Circuit-breaker thresholds | Any | **7 days** | Prevents gaming threshold changes to avoid triggers |
| `seniorAllocationBps` | Increase (Junior↓) | **Blocked — §9.3 ratchet required** | Cannot increase Senior share without 6 months data + independent review |
| `seniorAllocationBps` | Decrease (Junior↑) | **14 days** | Increasing Junior protection is permitted with normal timelock |
| `juniorCoverageFloorBps` | Decrease | **60 days** ★ | Reducing Junior floor weakens capital structure |
| `juniorCoverageFloorBps` | Increase | **7 days** | Strengthening protection is permitted with short interval |
| `minSubordinationBps` | Decrease | **60 days** ★ | Lowering subordination floor requires extended observation |
| `minSubordinationBps` | Increase | **7 days** | |
| Tranche risk thresholds (`juniorNavDrawdownCapBps`, `seniorNavDrawdownCapBps`) | Any | **30 days** | Capital structure changes need extended notice |
| Senior yield cap (`seniorTargetYieldBps`) | Any | **14 days** | Affects LP return expectations |
| `recoveryRateAssumptionPct` | Increase | **Blocked — §9.3 ratchet required** | Cannot raise recovery assumption without realized data |
| `recoveryRateAssumptionPct` | Decrease | **14 days** | Lowering assumption is conservative; permitted normally |
| KYC/jurisdiction policies (`kycRequired`, `enforceJurisdiction`) | Any | **30 days** | Regulatory compliance requires stability |
| Borrower exposure cap (`maxBorrowerExposure`) | Any | **7 days** | |

**Implementation note:** Frequency limits are not currently enforced on-chain. They must be enforced at the governance process level (timelock scheduling requires a prior-change timestamp check in the governance tooling or multisig UI). On-chain enforcement is a v1.3 recommendation.

---

## 6. Stability Windows

A **stability window** is the minimum time a parameter must remain at its new value before another change can be proposed (not just scheduled). This is distinct from the frequency limit — it measures from when the change *took effect*, not from when the prior change was *scheduled*.

| Parameter Group | Direction | Stability Window | Additional Requirement |
|-----------------|-----------|-----------------|------------------------|
| Fee rates | Any | **30 days** | — |
| `seniorAllocationBps` (increase) | Junior↓ | **Blocked** | §9.3 ratchet — minimum 6 months live data |
| `seniorAllocationBps` (decrease) | Junior↑ | **14 days** | — |
| `juniorCoverageFloorBps` (decrease) | Floor↓ | **60 days ★** | Public report required before scheduling (see §9.3 Public Report requirement) |
| `minSubordinationBps` (decrease) | Floor↓ | **60 days ★** | Public report required before scheduling |
| Tranche drawdown caps | Any | **60 days** | — |
| `recoveryRateAssumptionPct` (increase) | Cap↑ | **Blocked** | §9.3 ratchet — 6 months realized recovery data |
| Circuit-breaker thresholds | Any | **14 days** | — |
| Collateral policy | Any | **14 days** | — |
| KYC/jurisdiction | Any | **90 days** | Regulatory stability requirement |

**Emergency exception:** Tier 3 parameters (emergency-adjustable) are exempt from stability windows. However, every emergency use **requires a postmortem** (using the POSTMORTEM_TEMPLATE) before the parameter is returned to its normal state.

---

## 7. Emergency Override Rules

Emergency actions bypass the 24-hour timelock and stability windows. They are governed by strict post-action requirements.

### 7.1 Parameters adjustable without timelock

| Parameter | Who | Maximum Duration | Auto-Expiry |
|-----------|-----|-----------------|-------------|
| Factory `paused` state | PAUSER_ROLE | Indefinite (manual lift) | No — must be lifted via governance |
| Pool `paused` state | PAUSER_ROLE | Indefinite (manual lift) | No |
| `stressMode` | DEFAULT_ADMIN_ROLE | Indefinite (manual lift) | No |
| `trancheDepositCap[t]` | DEFAULT_ADMIN_ROLE | Indefinite | No |
| `seniorPriorityActive` (clear) | DEFAULT_ADMIN_ROLE | One-shot clear | N/A |
| Circuit-breaker overrides | Admin API | `expiresInMinutes` required | Yes — hard expiry |

### 7.2 Mandatory post-action requirements

Every emergency parameter change **must** result in:

1. **Immediate:** Incident opened in circuit-breaker system (or existing incident referenced).
2. **Within 24h:** Completed DECISION_CHECKLIST filed in governance evidence bundle.
3. **Within 72h:** Postmortem initiated (may remain DRAFT for up to 14 days).
4. **Before re-enabling:** Postmortem status set to FINAL and signed by all required roles.
5. **Before next governance cycle:** Root-cause action items assigned and tracked.

### 7.3 Recovery gate

No emergency parameter may be returned to its normal state without all of the following:

```
☐  Reconciliation report shows 0 critical mismatches
☐  All open incidents for the related trigger are resolved
☐  Root cause documented in postmortem (at least DRAFT)
☐  Approver 1 sign-off (Incident Commander)
☐  Approver 2 sign-off (Risk / Compliance)
```

This mirrors Section 5 of the DECISION_CHECKLIST.

---

## 8. Change Notification Requirements

### 8.1 On-chain notification (automatic)

The timelock pattern already provides on-chain advance notice:

| Event | When emitted | Listening parties |
|-------|-------------|-------------------|
| `TimelockScheduled(id, readyAt)` | At scheduling | All watchdog monitors |
| `TimelockExecuted(id)` | At execution | All watchdog monitors |
| `TimelockCancelled(id)` | At cancellation | All watchdog monitors |
| `FeesUpdated(...)` | On fee change | Partners, LPs |
| `PoolSet(pool, allowed)` | On pool change | Affected partner |
| `SettlementAgentUpdated(...)` | On agent rotation | Orchestrator operator |

### 8.2 Off-chain notification requirements

| Change Type | Advance Notice | Recipients | Channel |
|-------------|---------------|------------|---------|
| Fee rate increase | **14 days** | All active partners + LPs | Email + API webhook |
| Fee rate decrease | **3 days** | All active partners + LPs | API webhook |
| Collateral ratio increase | **14 days** | Affected borrowers, partners | Email + API webhook |
| Pool whitelist removal | **7 days** | Affected partner | Email + API webhook |
| Collateral revocation | **7 days** | Affected borrowers/partners | Email + API webhook |
| KYC/jurisdiction policy | **30 days** | All active partners | Email + regulatory notice |
| Circuit-breaker threshold change | **7 days** | Internal risk team | Internal Slack + audit log |
| Tranche parameter change | **7 days** | Affected LPs (tranched pool) | Email + API webhook |
| Emergency action | **Immediate** (post-action) | All partners + LPs | Email + status page |

### 8.3 Notification format

All pre-change notifications must include:

```
Subject: [GOVERNANCE NOTICE] <Parameter> change scheduled
- Current value: <X>
- Proposed value: <Y>
- Effective date (UTC): <timelock readyAt>
- Timelock ID: <bytes32>
- Reason: <one-paragraph rationale>
- Contact: <governance@unified>
```

---

## 9. Anti-Abuse Rules

### 9.1 Core anti-abuse constraints

**Rule A — Direction Ratchet (fees only):**
Fee rates may not be increased more than twice in any rolling 180-day window, regardless of the individual change magnitude. Each increase resets the ratchet counter.

**Rule B — Delta Cap per Change:**
No single parameter change may move a value by more than 50% of its permitted range in one operation. Example: if `seniorAllocationBps` range is 5,000–9,000 (range = 4,000 bps), a single change may not exceed 2,000 bps.

*Exception:* Emergency Tier 3 changes and binary (boolean) parameters are exempt from the delta cap.

**Rule C — No Same-Block Scheduling:**
A timelock cannot be scheduled and consumed in the same transaction. The `TIMELOCK_DELAY = 24h` constant enforces this at the contract level.

**Rule D — Cascade Prevention:**
If multiple timelocked changes affect the same parameter group (e.g., multiple fee changes), only one may be active (scheduled but not yet consumed) at a time. The existing `TimelockAlreadyScheduled` revert enforces this for identical operations.

**Rule E — Stability Window Enforcement:**
A new Tier 2 change to a parameter with an active stability window (see §6) must be blocked by governance tooling until the window expires. This is a process-level control pending on-chain enforcement in v1.3.

### 9.2 Identified Governance Gaps

The following parameters currently lack on-chain governance protection and represent known risks:

| Parameter | Current state | Risk | Proposed fix |
|-----------|--------------|------|--------------|
| `jurisdictionAllowed[code]` | No timelock | Jurisdiction can be added/removed immediately without notice | Add 24h timelock |
| `tierBorrowCap[tier]` | No timelock | Caps can be raised silently | Add 24h timelock; add delta cap (max 2× in one step) |

**Recommended contract change (v1.2.1 patch):**

```solidity
// Proposed: add timelock to setJurisdictionAllowed
function setJurisdictionAllowed(uint256 jurisdiction, bool allowed)
    external onlyRole(DEFAULT_ADMIN_ROLE) {
    bytes32 id = keccak256(abi.encode(
        this.setJurisdictionAllowed.selector, jurisdiction, allowed));
    _consumeTimelock(id);
    jurisdictionAllowed[jurisdiction] = allowed;
    emit JurisdictionAllowedSet(jurisdiction, allowed);
}

// Proposed: add timelock + delta cap to setTierBorrowCap
function setTierBorrowCap(uint8 tier, uint256 cap)
    external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (tier > 4) revert UnifiedErrors.InvalidTier(tier);
    // Delta cap: new cap may not exceed 2× existing cap (if set)
    uint256 existing = tierBorrowCap[tier];
    if (existing > 0 && cap > existing * 2) revert CapDeltaExceeded();
    bytes32 id = keccak256(abi.encode(this.setTierBorrowCap.selector, tier, cap));
    _consumeTimelock(id);
    tierBorrowCap[tier] = cap;
    emit TierBorrowCapSet(tier, cap);
}
```

### 9.3 Conservative Launch Ratchet Rule

The ratchet rule governs all changes that would **reduce Junior protection** or **increase Senior leverage**. It applies to the following parameters:

- `seniorAllocationBps` (any increase)
- `recoveryRateAssumptionPct` (any increase)
- `minSubordinationBps` (any decrease)
- `juniorCoverageFloorBps` (any decrease)
- Removal of `breakerSeniorThresholdUsdc = 0` constraint

No such change may be proposed, scheduled, or executed until **all five gates** below are satisfied. Partial satisfaction does not permit partial relaxation.

#### Gate 1 — Six-Month Live Data Requirement

The protocol must have been operating in production (mainnet or equivalent) for a continuous period of **at least 180 calendar days** with a minimum portfolio size of **USD 1,000,000 in active principal** for at least 90 of those days.

```
liveProductionDays     ≥ 180
daysAboveMinPortfolio  ≥ 90   (activePortfolio ≥ USD 1,000,000)
```

Evidence: orchestrator database export showing `totalPrincipalAllocated` by date, signed by Risk Lead.

#### Gate 2 — Realized Default Rate Below Calibrated Threshold

The trailing 180-day realized default rate across all pools must be **strictly below** the `PARTNER_DEFAULT_RATE_30D` circuit-breaker threshold (currently 8%):

```
realizedDefaultRate₁₈₀ = totalBadDebt_180d / totalPrincipalOriginated_180d

Gate passes if: realizedDefaultRate₁₈₀ < 0.08
               AND no pool has defaultRate30d > 0.05 on the computation date
```

A gate-2 failure during the observation window resets the 180-day clock. The rate must be below threshold **continuously** for 180 days, not merely at the snapshot date.

Evidence: Signed WANPY₁₂ attestation report (§10.1C) covering the full 180-day period, including per-pool default rates.

#### Gate 3 — Realized Recovery Rate Sufficient

The trailing 180-day realized recovery rate on defaulted loans must be **at or above 40%**:

```
realizedRecoveryRate₁₈₀ = sum(collateralRecovered) / sum(principalWrittenOff)

Gate passes if: realizedRecoveryRate₁₈₀ ≥ 0.40
```

If the pool has zero defaults in the period, this gate requires an independent third-party stress-test report confirming the 40% assumption is defensible given the collateral composition. Absence of defaults does not automatically pass Gate 3.

Evidence: Collateral liquidation records from `UnifiedCollateralVault` events, reconciled with `pool.totalBadDebt` deltas.

#### Gate 4 — Independent Review Artifact

A written review by an independent party (external auditor, risk committee member, or designated governance observer with no economic interest in the proposed change) must:

1. Confirm Gates 1–3 evidence is complete and accurate.
2. Model the proposed parameter change under the base-case and all stress scenarios from §10.1B.
3. Confirm that WANPY₁₂ computed under the new parameters remains ≥ `seniorTargetYieldBps`.
4. Confirm all capital structure invariants (CONSTRAINT-1 through CONSTRAINT-7) are satisfied at the proposed new values.
5. State explicitly whether the change is recommended, recommended with conditions, or not recommended.

The review artifact must be published publicly (governance forum or equivalent) for **at least 14 days** before `scheduleTimelock` is called.

#### Gate 5 — Public Report and Comment Period

A public report summarising the proposed change, the Gate 1–4 evidence, and the independent review outcome must be published and open for community comment for **at least 14 days**. Comments must be addressed in writing before the change is scheduled.

The public report must include:

```
PUBLIC REPORT — Senior Allocation Ratchet
──────────────────────────────────────────────────────────────
Proposed change             : <parameter> from <old> to <new>
Publication date (UTC)      : ____________________
Comment period closes (UTC) : ____________________

Gate 1 — Live data
  Production start date     : ____________________
  Continuous live days      : ____
  Days above min portfolio  : ____
  Evidence attachment       : [link]

Gate 2 — Realized default rate
  Observation period        : 180 days ending ____________________
  realizedDefaultRate₁₈₀   : ______%
  All pools below 5%?       : ☐ YES  ☐ NO
  Evidence attachment       : [WANPY₁₂ attestation link]

Gate 3 — Realized recovery rate
  realizedRecoveryRate₁₈₀  : ______%
  (or) zero-default stress-test: ☐ PROVIDED  ☐ N/A
  Evidence attachment       : [link]

Gate 4 — Independent review
  Reviewer (name/org)       : ____________________
  Review published (UTC)    : ____________________
  Recommendation            : RECOMMENDED / CONDITIONAL / NOT RECOMMENDED
  Review artifact link      : [link]

Gate 5 — Comment period
  Comments received         : ____  (addressed: ____)
  Comment log               : [link]

All gates passed?           : ☐ YES  ☐ NO
Scheduled by (operator)     : ____________________  Date: ________
──────────────────────────────────────────────────────────────
```

#### Ratchet step limit

Even after all five gates are passed, a single ratchet step may not increase `seniorAllocationBps` by more than **500 bps (5 percentage points)** per approval cycle. Example: from 7,000 to 7,500 is one step; 7,000 to 8,000 requires two separate ratchet cycles, each with independent gate evaluation.

The absolute maximum after any number of ratchet cycles remains the hard ceiling defined in §4 (currently 7,500 bps at launch; the ceiling itself may only be raised via a full document amendment ratified by Risk/Compliance).

---

## 10. Capital Structure Integrity Invariants

The following invariants must hold across all Tier 2 parameter changes. Governance tooling must validate these before permitting any scheduling. Violation of any invariant is grounds for immediate cancellation of a proposed change.

### 10.1 Tranche solvency invariant

At all times:

```
CONSTRAINT-1: seniorAllocationBps + (10,000 - seniorAllocationBps) = 10,000
  (trivially true — split must sum to 100%)

CONSTRAINT-2: minSubordinationBps ≥ (10,000 - seniorAllocationBps) / 2
  Rationale: the minimum subordination buffer must be at least half the
  Junior's nominal allocation share. Ensures that a 50% drawdown of Junior
  NAV does not immediately breach subordination.

  Example: seniorAllocationBps = 7,000 → Junior share = 3,000 bps.
  minSubordinationBps ≥ 1,500 bps.

CONSTRAINT-3: seniorNavDrawdownCapBps < juniorNavDrawdownCapBps
  Rationale: Senior emergency pause must fire before Junior stress-mode trigger.
  Prevents a state where Junior is in stress but Senior is not paused.

CONSTRAINT-4: seniorTargetYieldBps ≤ WANPY₁₂
  where WANPY₁₂ is the Trailing 12-Month Weighted Average Net Pool Yield
  defined formally in §10.1A below.
  Rationale: Senior yield cap must not exceed the pool's achievable net yield.
  A cap above WANPY₁₂ is economically empty — Senior would never receive it —
  and creates false LP expectations. Governance must produce a signed WANPY₁₂
  attestation report before scheduling any change to seniorTargetYieldBps.
```

### 10.1A — Formal Definition: Trailing 12-Month Weighted Average Net Pool Yield (WANPY₁₂)

#### Purpose

WANPY₁₂ is the canonical yield baseline for CONSTRAINT-4. It is the sole permitted reference for validating a proposed `seniorTargetYieldBps` value. No other yield figure — portfolio APR, contractual coupon, benchmark rate — may substitute for it.

#### Formula

```
WANPY₁₂ = Σᵢ [ w_i × netYield_i ]

where the sum runs over all active pools i with T₁₂ ≥ 90 days, and:

  w_i = timeWeightedNAV_i / Σⱼ timeWeightedNAV_j

  netYield_i = [ (interestCash_i − protocolFees_i − badDebtWriteoffs_i)
                  / timeWeightedNAV_i ]
               × (365 / T₁₂_days)           ← annualisation factor

  timeWeightedNAV_i = Σₖ ( NAV_i(tₖ) × Δtₖ_days ) / T₁₂_days

  T₁₂_days = min(observationPeriod_i_days, 365)
```

**Annualisation note:** The numerator `(interestCash_i − protocolFees_i − badDebtWriteoffs_i)` is a cumulative USDC cash-flow amount earned over T₁₂_days. The denominator `timeWeightedNAV_i` is the time-weighted average NAV over the same period, expressed as a USDC amount. Dividing gives a fractional return for the period T₁₂_days — **not** an annual rate unless T₁₂_days = 365. Multiplying by `(365 / T₁₂_days)` converts to a uniform annualised basis so that pools with 90 days of history and pools with 365 days of history are comparable.

#### Step-by-step calculation procedure

The following procedure must be followed exactly, in order, for each computation. Deviation from these steps invalidates the attestation report.

**Step 1 — Determine observation window.**
For each pool i, set:
```
windowEnd   = computation date (UTC 00:00:00)
windowStart = max(pool_i.deployedAt, windowEnd − 365 days)
T₁₂_days_i = (windowEnd − windowStart) in whole days
```
Exclude pool i from the computation if `T₁₂_days_i < 90`.

**Step 2 — Compute cumulative cash-flow numerator.**
From the orchestrator database for the period [windowStart, windowEnd):
```
interestCash_i     = pool_i.totalInterestRepaidToPool(windowEnd)
                   − pool_i.totalInterestRepaidToPool(windowStart)

protocolFees_i     = SUM of FeeCollected.amount WHERE loan.poolId = pool_i.id
                     AND FeeCollected.timestamp IN [windowStart, windowEnd)
                     AND feeType IN ('origination', 'interest')
                     [exclude 'late' fee type]

badDebtWriteoffs_i = pool_i.totalBadDebt(windowEnd)
                   − pool_i.totalBadDebt(windowStart)

netCashFlow_i      = interestCash_i − protocolFees_i − badDebtWriteoffs_i
```

**Step 3 — Compute time-weighted average NAV.**
Using hourly NAV snapshots from the reconciliation store:
```
timeWeightedNAV_i = Σₖ [ NAV_i(tₖ) × (tₖ₊₁ − tₖ)_days ] / T₁₂_days_i

where NAV_i(tₖ) = usdc.balanceOf(pool_i) + principalOutstanding_i − totalBadDebt_i
      at snapshot timestamp tₖ

For any gap in snapshot coverage > 6 hours, interpolate linearly between
the last known NAV before and the first known NAV after the gap.
If gaps total > 5% of T₁₂_days_i, the pool must be excluded this cycle
and the gap noted in the attestation report.
```

**Step 4 — Compute per-pool annualised net yield.**
```
netYield_i = (netCashFlow_i / timeWeightedNAV_i) × (365 / T₁₂_days_i)

If timeWeightedNAV_i = 0 (pool was unfunded for the entire window), set w_i = 0
and exclude from the weighted average.
```

**Step 5 — Compute pool weights.**
```
w_i = timeWeightedNAV_i / Σⱼ timeWeightedNAV_j

where the sum over j excludes pools with T₁₂_days_j < 90 and pools
with timeWeightedNAV_j = 0.
```

**Step 6 — Compute WANPY₁₂.**
```
WANPY₁₂ = Σᵢ [ w_i × netYield_i ]

Convert to bps: WANPY₁₂_bps = floor(WANPY₁₂ × 10,000)
```
Round down (floor) so the result is conservative: governance cannot claim a
fractional bps advantage over the computed ceiling.

**Step 7 — Apply stress-scenario check.**
Look up the current 30-day portfolio default rate from the circuit-breaker metrics:
```
if defaultRate30d > 0.035: apply "Mild stress" WANPY₁₂ = min(WANPY₁₂_bps, 700)
if defaultRate30d > 0.050: apply "Moderate stress" WANPY₁₂ = min(WANPY₁₂_bps, 611)
if defaultRate30d > 0.080: apply "Severe stress"   WANPY₁₂ = min(WANPY₁₂_bps, 480)
```
The stress-adjusted figure (not the raw computed figure) is the operative ceiling for CONSTRAINT-4.

**Step 8 — Record in attestation report (§10.1C).**
Record all intermediate values from Steps 1–7, per pool, in the attestation template. The report is invalid if any step is omitted or if intermediate values are missing.

#### Term definitions

| Symbol | Source | Description |
|--------|--------|-------------|
| `interestCash_i` | `pool.totalInterestRepaidToPool` delta over T₁₂ | Interest actually received in cash by pool i during the period. Accrued-but-unpaid interest is **excluded**. |
| `protocolFees_i` | Sum of `FeeCollected` events on `UnifiedFeeManager` for loans allocated from pool i over T₁₂ | Origination fees + interest fees paid to treasury. Late fees are excluded (they compensate for credit risk already captured in `badDebtWriteoffs_i`). |
| `badDebtWriteoffs_i` | `pool.totalBadDebt` delta over T₁₂ | Principal write-offs recorded via `recordBadDebt`. Does **not** include unreceived interest (per tranche design §8.4). |
| `NAV_i(tₖ)` | Hourly snapshot: `usdc.balanceOf(pool_i) + principalOutstanding_i − totalBadDebt_i` | Point-in-time NAV at snapshot tₖ. Sourced from the on-chain reconciliation report. |
| `Δtₖ` | Duration of snapshot interval | Fraction of T₁₂. |
| `w_i` | Computed | Pool i's share of aggregate time-weighted NAV. Pools with `timeWeightedNAV_i = 0` are excluded from the weighted average. |

#### Minimum observation period

A pool must have **at least 90 days** of production history before it contributes to WANPY₁₂. Pools with fewer than 90 days of data are excluded from both the numerator and denominator (i.e., `w_i = 0`) until the threshold is met.

If **no pool** has reached 90 days of history, the WANPY₁₂ computation falls back to the **pilot calibration baseline** defined in §10.1B.

#### Computation schedule

WANPY₁₂ must be recomputed:

- **Monthly** as part of the standard governance cycle, by the Risk team.
- **On-demand** whenever a change to `seniorTargetYieldBps` is proposed.
- **After any incident** that results in a `recordBadDebt` write-off exceeding 1% of aggregate pool NAV.

The computed value must be published as a signed attestation report (see §10.1C) before the associated timelock can be scheduled.

#### Worked example (representative)

Using pilot parameters from `pilot-installment-100-loan.harness.spec.ts` and `tranche-parameter-sweep.engine.ts`:

```
Inputs (one pool, 12-month observation):
  Contractual APR (aprBps)          = 1,200 bps (12%)
  Loan book utilization             = 75%  (BASE_LOAN_BOOK_UTILIZATION)
  Gross interest earned             = 12% × 75% = 9.00% of pool NAV
  Protocol interest fee (interestFeeBps, illustrative)  = 500 bps (5% of interest received)
  Interest fee drag                 = 9.00% × 5% = 0.45%
  Annualized default rate           = 2.0%  (base: ~0.8%/month, pilot observed)
  Recovery rate                     = 50%   (midpoint of sweep range 0.3–0.6)
  Bad-debt drag                     = 2.0% × (1 − 0.50) × 75% utilization = 0.75%

WANPY₁₂ (single pool) = 9.00% − 0.45% − 0.75% = 7.80%
                       = 780 bps
```

This is consistent with the current `seniorTargetYieldBps = 800 bps` — the default is at or near the pilot-calibrated ceiling, not arbitrarily chosen.

Under a stressed scenario (default rate 5%, recovery 35%):

```
  Bad-debt drag = 5.0% × (1 − 0.35) × 75% = 2.44%
  WANPY₁₂       = 9.00% − 0.45% − 2.44% = 6.11% = 611 bps
```

A governance proposal to set `seniorTargetYieldBps = 800` during a stressed period would therefore **fail CONSTRAINT-4** and must be rejected.

### 10.1B — Pilot Calibration Baseline

When insufficient production history exists to compute WANPY₁₂ (see §10.1A minimum observation period), the following pilot-derived baseline applies:

| Scenario | WANPY₁₂ (bps) | Conditions |
|----------|---------------|------------|
| **Base case** | **780 bps** | APR 1,200 bps, utilization 75%, default 2.0%, recovery 50% |
| Mild stress | 700 bps | APR 1,200 bps, utilization 75%, default 3.5%, recovery 45% |
| Moderate stress | 611 bps | APR 1,200 bps, utilization 75%, default 5.0%, recovery 35% |
| Severe stress | 480 bps | APR 1,200 bps, utilization 70%, default 8.0%, recovery 30% |

**Governance rule:** During the pilot calibration period, `seniorTargetYieldBps` must not exceed the **base case** figure of **780 bps** unless a full WANPY₁₂ computation using production data demonstrates a higher sustainable yield.

The current default `seniorTargetYieldBps = 800 bps` is 20 bps above the pilot base-case WANPY₁₂. This is intentional headroom for portfolios with above-average APR or lower default rates. It must be reviewed and confirmed or tightened once 90 days of production data are available.

### 10.1C — WANPY₁₂ Attestation Report (required before scheduling)

Any proposal to change `seniorTargetYieldBps` must include a signed attestation report containing:

```
WANPY₁₂ Attestation
────────────────────────────────────────────────────────────────────
Computation date (UTC)   : ____________________
Observation period       : _____ days (min 90; max 365)
Pools included           : ____  (excluded: ____ below 90-day threshold)
Aggregate time-wtd NAV   : USD ____________________

Per-pool breakdown:
  Pool address / ID      | timeWeightedNAV | interestCash | fees | badDebt | netYield
  ─────────────────────────────────────────────────────────────────────────────────────
  [pool 1]               |                 |              |      |         |
  [pool 2]               |                 |              |      |         |

Weighted WANPY₁₂         : ______ bps
Proposed seniorTargetYieldBps : ______ bps
CONSTRAINT-4 satisfied?  : ☐ YES  ☐ NO

Stress-test override check (§10.1B)
  Current portfolio default rate (30d) : ______%
  Applicable stress scenario           : BASE / MILD / MODERATE / SEVERE
  Stress-adjusted WANPY₁₂             : ______ bps
  Proposed value ≤ stress-adjusted?    : ☐ YES  ☐ NO

Attested by (Risk Lead)   : ________________  Date: ________
Reviewed by (Compliance)  : ________________  Date: ________
────────────────────────────────────────────────────────────────────
```

This report must be appended to the governance evidence bundle before `scheduleTimelock` is called for `setSeniorTargetYield`.

### 10.2 Fee extraction invariant

```
CONSTRAINT-5: originationFeeBps + (aprBps_min × interestFeeBps / 10,000)
              ≤ 1,500 bps (15% effective all-in protocol fee on a
              representative 1-year loan at minimum APR)
  Rationale: Prevents fee stacking from making the protocol extractive
  relative to the borrower's cost of capital.
```

### 10.3 Liquidity invariant

```
CONSTRAINT-6: seniorLiquidityFloorBps ≥ ⌊POOL_LIQUIDITY_RATIO_threshold × 10,000⌋

  Unit note: seniorLiquidityFloorBps is in bps (e.g. 2,500).
             POOL_LIQUIDITY_RATIO_threshold is a decimal (e.g. 0.25).
             Convert: threshold_bps = floor(threshold × 10,000).

  Rationale: The on-chain Senior liquidity floor (blocks allocations when
  liquidityRatio < floor) must activate at a HIGHER liquidity ratio than
  the circuit-breaker pool liquidity trigger (freezes originations when
  liquidityRatio < threshold). Because a higher bps value means the guard
  fires sooner (at a less-depleted pool), the on-chain floor must be ≥ the
  circuit-breaker threshold expressed in bps. This ensures the on-chain
  guard is always the tighter constraint and the circuit-breaker never fires
  against a pool that is already allocation-blocked.

  Violation direction: if seniorLiquidityFloorBps < threshold_bps, the
  circuit-breaker fires first and freezes originations while allocations are
  still technically on-chain-permitted — defeating the layered defence.

  Example: POOL_LIQUIDITY_RATIO_threshold = 0.25 → threshold_bps = 2,500.
           seniorLiquidityFloorBps must be ≥ 2,500 bps.
           Setting it to 1,000 bps (10%) would allow on-chain allocations
           at 15% liquidity while the circuit-breaker has already frozen
           originations at 25% — an inconsistent state.
```

### 10.4 Borrower exposure invariant

```
CONSTRAINT-7: tierBorrowCap[tier] ≤ maxBorrowerExposure (if maxBorrowerExposure > 0)
  Rationale: Per-tier caps are subordinate to the global exposure cap.
  A per-tier cap above the global cap is silently ineffective.
```

---

## 11. Governance Abuse Scenarios and Mitigations

| Scenario | Risk | Mitigation |
|----------|------|------------|
| Fee inflation attack: admin slowly ratchets fees to maximum over multiple changes | Protocol becomes extractive; LPs and borrowers exit | Rule A (direction ratchet); 14-day advance notice; governance ceiling below contract MAX_FEE_BPS |
| Threshold lowering attack: lower breaker thresholds to suppress legitimate incidents | Risk metrics masked; defaults accumulate silently | Threshold floors (§4); 7-day advance notice; code-review gate for off-chain changes |
| Collateral stripping: remove collateral allowance for a token with existing loans | Existing borrowers cannot meet margin calls; forced defaults | Timelock + 7-day notice; collateral removal must verify no active loans use the token before execution |
| Senior capture: raise `seniorAllocationBps` toward maximum → Junior absorbs shrinking slice → Senior de facto unprotected | Junior protection rendered nominal | Hard ceiling at **7,500 bps (75%)** ★; §9.3 ratchet blocks increases without 6-month evidence; CONSTRAINT-2 validation |
| Subordination erosion: lower `minSubordinationBps` below Junior's actual share | Senior deposits accepted with inadequate protection | Hard floor at 10%; CONSTRAINT-2 validation against current `seniorAllocationBps` |
| Emergency freeze abuse: use `stressMode` as competitive leverage against a partner | Junior LPs locked without legitimate trigger | Mandatory postmortem within 72h; DECISION_CHECKLIST gate for re-enabling; independent compliance observer sign-off required |
| Timelocked-and-cancel cycling: schedule changes repeatedly then cancel to signal manipulation | Market confusion; front-running | `TimelockAlreadyScheduled` reverts duplicates; cancellation is itself logged on-chain; pattern triggers internal audit flag |
| Silent jurisdiction expansion: add new jurisdiction without notice | Regulatory exposure | Proposed fix: add 24h timelock + 7-day notification requirement (§9.2) |

---

## Appendix A — Parameter Change Checklist

Before scheduling any Tier 2 parameter change, the proposer must confirm:

```
☐ Hard bounds check: new value within [floor, ceiling] defined in §4
☐ Frequency check: minimum interval since last change has elapsed (§5)
☐ Stability window check: prior change stability window has expired (§6)
☐ Delta cap check: change magnitude ≤ 50% of permitted range (§9.1 Rule B)
☐ Capital structure invariants: all CONSTRAINT-1 through CONSTRAINT-7 pass (§10)
☐ Timelock ID computed and recorded
☐ Off-chain notifications scheduled per §8.2 timing requirements
☐ Risk team sign-off obtained
☐ For tranche parameters: tranched pool LP notification sent
☐ RATCHET CHECK (Junior-reducing changes only): all five §9.3 gates satisfied and evidence appended to the governance evidence bundle
```

---

## Appendix B — Governance Role Matrix

| Action | DEFAULT_ADMIN_ROLE | PAUSER_ROLE | FEE_ROLE | LOAN_REGISTRAR_ROLE |
|--------|-------------------|-------------|----------|---------------------|
| Schedule timelock (factory) | ✓ | — | — | — |
| Execute timelocked setter | ✓ | — | — | — |
| Cancel timelock | ✓ | — | — | — |
| Pause / unpause factory | ✓ | ✓ | — | — |
| Pause / unpause pool | ✓ | ✓ | — | — |
| Update fee rates | — | — | ✓ (+ timelock) | — |
| Update treasury (FeeManager) | — | — | ✓ (+ timelock) | — |
| Register loan (FeeManager) | — | — | — | ✓ |
| Set stress mode | ✓ | — | — | — |
| Set tranche deposit cap | ✓ | — | — | — |
| Clear senior priority | ✓ | — | — | — |
| Fire governance drill | ✓ (+ ADMIN_API_KEY) | — | — | — |

---

## Appendix C — Parameter Immutability Map

This map classifies every protocol parameter by its changeability tier. Use it as a quick reference when evaluating governance proposals.

### Legend

| Symbol | Meaning |
|--------|---------|
| ⛔ NEVER | Immutable — constructor-set or hardcoded; can only change via contract redeploy + full migration |
| 🔒 RATCHET | Cannot increase (or decrease, per direction) without satisfying §9.3 five-gate ratchet |
| ⏱ TIMELOCK | Changeable via 24h on-chain timelock + DEFAULT_ADMIN_ROLE multisig; subject to §4–§6 bounds |
| ⚡ EMERGENCY | Adjustable without timelock in emergency; mandatory postmortem within 72h |
| 📋 OPERATIONAL | Routine governance; FEE_ROLE or equivalent; still timelocked |

### C.1 — On-Chain: UnifiedLoanFactory

| Parameter | Tier | Symbol | Change Constraint |
|-----------|------|--------|------------------|
| `usdc` (token address) | 0 — Immutable | ⛔ NEVER | Constructor-set |
| `feeManager` (address) | 0 — Immutable | ⛔ NEVER | Constructor-set |
| `TIMELOCK_DELAY` (24h) | 1 — Constant | ⛔ NEVER | Hardcoded; redeploy required |
| `loanImplementation` | 2 — Timelock | ⏱ TIMELOCK | scheduleSetImplementation → executeSetImplementation |
| `paused` | 3 — Emergency | ⚡ EMERGENCY | PAUSER_ROLE; no timelock; §7 postmortem gate |
| `maxLoanAmount` | 2 — Timelock | ⏱ TIMELOCK | §4 bounds; 14-day notice |
| `minLoanAmount` | 2 — Timelock | ⏱ TIMELOCK | §4 bounds; 14-day notice |
| `maxBorrowerExposure` | 2 — Timelock | ⏱ TIMELOCK | §4 bounds; CONSTRAINT-7 |
| `minCollateralizationBps` | 2 — Timelock | ⏱ TIMELOCK | §4 bounds; 7-day notice |
| `jurisdictionAllowed[j]` | 4 — Operational | ⏱ TIMELOCK | Proposed 24h timelock + 7-day notice (§9.2) |
| `tierBorrowCap[tier]` | 4 — Operational | ⏱ TIMELOCK | Proposed 24h timelock; CONSTRAINT-7 |

### C.2 — On-Chain: UnifiedFeeManager

| Parameter | Tier | Symbol | Change Constraint |
|-----------|------|--------|------------------|
| `MAX_FEE_BPS` (5,000) | 1 — Constant | ⛔ NEVER | Hardcoded; redeploy required |
| `TIMELOCK_DELAY` (24h) | 1 — Constant | ⛔ NEVER | Hardcoded; redeploy required |
| `originationFeeBps` | 2 — Timelock | ⏱ TIMELOCK | §4 ceiling 1,500 bps; FEE_ROLE; 14-day notice; CONSTRAINT-5 |
| `interestFeeBps` | 2 — Timelock | ⏱ TIMELOCK | §4 ceiling 1,000 bps; FEE_ROLE; 14-day notice; CONSTRAINT-5 |
| `lateFeeBps` | 2 — Timelock | ⏱ TIMELOCK | §4 ceiling 2,000 bps; FEE_ROLE; 14-day notice |
| `treasury` | 2 — Timelock | ⏱ TIMELOCK | FEE_ROLE; 14-day notice; zero-address check |

### C.3 — On-Chain: UnifiedPool / UnifiedPoolTranched (v1.2)

| Parameter | Tier | Symbol | Change Constraint | Notes |
|-----------|------|--------|------------------|-------|
| `usdc` (token address) | 0 — Immutable | ⛔ NEVER | Constructor-set | |
| `partnerId` | 0 — Immutable | ⛔ NEVER | Constructor-set | |
| `breakerSeniorThresholdUsdc` | 0 — Immutable at launch | ⛔ NEVER | Fixed at 0; §9.3 ratchet required to unlock nonzero | ★ conservative |
| `recoveryRateAssumptionPct` | 1 — Code-Constant at launch | ⛔ NEVER (launch) | 40% ceiling; §9.3 ratchet required to raise | ★ conservative |
| `seniorAllocationBps` (increase) | 2 — Timelock | 🔒 RATCHET | §9.3 five-gate ratchet; max 500 bps step; ceiling 7,500 bps | ★ conservative |
| `seniorAllocationBps` (decrease) | 2 — Timelock | ⏱ TIMELOCK | 14-day frequency; floor 5,000 bps | |
| `seniorTargetYieldBps` | 2 — Timelock | ⏱ TIMELOCK | Ceiling = WANPY₁₂; CONSTRAINT-4; 14-day notice |  |
| `seniorLiquidityFloorBps` (decrease) | 2 — Timelock | 🔒 RATCHET | 60-day stability; CONSTRAINT-6; floor 1,000 bps | ★ conservative |
| `seniorLiquidityFloorBps` (increase) | 2 — Timelock | ⏱ TIMELOCK | 14-day frequency; ceiling 5,000 bps | |
| `juniorNavDrawdownCapBps` (decrease) | 2 — Timelock | 🔒 RATCHET | 60-day stability; floor 1,500 bps | ★ conservative |
| `juniorNavDrawdownCapBps` (increase) | 2 — Timelock | ⏱ TIMELOCK | Ceiling 5,000 bps | |
| `juniorCoverageFloorBps` (decrease) | 2 — Timelock | 🔒 RATCHET | 60-day stability + public report; floor 1,000 bps | ★ conservative |
| `juniorCoverageFloorBps` (increase) | 2 — Timelock | ⏱ TIMELOCK | Ceiling 3,000 bps | |
| `minSubordinationBps` (decrease) | 2 — Timelock | 🔒 RATCHET | 60-day stability; CONSTRAINT-2; floor 1,500 bps | ★ conservative |
| `minSubordinationBps` (increase) | 2 — Timelock | ⏱ TIMELOCK | Ceiling 5,000 bps | |
| `seniorPriorityMaxDuration` | 2 — Timelock | ⏱ TIMELOCK | Reasonable range; 14-day notice | |
| `stressMode` (activate) | 3 — Emergency | ⚡ EMERGENCY | PAUSER_ROLE; mandatory postmortem within 72h | |
| `stressMode` (deactivate) | 3 — Emergency | ⚡ EMERGENCY | DECISION_CHECKLIST gate required (§7) | |
| `depositCapUsdc` (senior/junior) | 2 — Timelock | ⏱ TIMELOCK | DEFAULT_ADMIN_ROLE; 14-day notice | |

### C.4 — Off-Chain: Circuit-Breaker Thresholds

| Parameter | Tier | Symbol | Change Constraint |
|-----------|------|--------|------------------|
| `ACTIVE_WITHOUT_DISBURSEMENT_PROOF` threshold (0) | 1 — Constant | ⛔ NEVER | Hardcoded in TypeScript; redeploy required |
| `FIAT_CONFIRMED_NO_CHAIN_RECORD` threshold (0) | 1 — Constant | ⛔ NEVER | Hardcoded in TypeScript; redeploy required |
| `PARTNER_DEFAULT_RATE_30D` threshold (8%) | 1 — Constant | ⛔ NEVER | Hardcoded; floor 5%; code-review gate; 7-day notice |
| `PARTNER_DELINQUENCY_14D` threshold (15%) | 1 — Constant | ⛔ NEVER | Hardcoded; floor 10%; code-review gate; 7-day notice |
| `POOL_LIQUIDITY_RATIO` threshold (25%) | 1 — Constant | ⛔ NEVER | Hardcoded; CONSTRAINT-6 interaction; 7-day notice |
| `POOL_NAV_DRAWDOWN_7D` threshold (2%) | 1 — Constant | ⛔ NEVER | Hardcoded; floor 1%; code-review gate; 7-day notice |

### C.5 — Per-Loan Parameters (set at origination)

| Parameter | Tier | Symbol | Change Constraint |
|-----------|------|--------|------------------|
| `principalUsdc` | 0 — Immutable | ⛔ NEVER | Set at activation; cannot change |
| `aprBps` | 0 — Immutable | ⛔ NEVER | Set at origination; cannot change |
| `termMonths` | 0 — Immutable | ⛔ NEVER | Set at origination; cannot change |
| `collateralToken` / `collateralAmount` | 0 — Immutable | ⛔ NEVER | Set at origination; cannot change |
| `loanState` | 3 — Emergency | ⚡ EMERGENCY | State machine transitions only; cannot regress |

### C.6 — Summary Count

| Symbol | Count | Parameters |
|--------|-------|------------|
| ⛔ NEVER | 18 | All immutables + constants + per-loan |
| 🔒 RATCHET | 7 | Junior-protection parameters (direction-restricted) |
| ⏱ TIMELOCK | 15 | Standard governed parameters |
| ⚡ EMERGENCY | 4 | Pause flags; stress mode; loan state |
| **Total** | **44** | |

★ = tightened in v1.2.0-conservative vs v1.2.0

---

## Appendix D — Conservative Bound Justification Memo

**To:** Protocol Governance
**From:** Governance Architect
**Re:** Rationale for Conservative Launch Bounds (v1.2.0-conservative)
**Date:** 2026-02-23
**Status:** Ratified

---

### D.1 — Purpose

This memo documents the reasoning behind each bound tightened in v1.2.0-conservative relative to the initial v1.2.0 proposal. The conservative posture reflects a single governing principle:

> **Absent 12 months of live production data, governance must not have the authority to move parameters toward a regime whose safety properties can only be verified with production data.**

Every tightening in this document follows from that principle.

---

### D.2 — `seniorAllocationBps` ceiling: 9,000 → 7,500 bps

**Change:** Maximum Senior allocation reduced from 90% to 75% of pool NAV.

**Rationale:**

The pilot tranche-parameter sweep (`tranche-parameter-sweep.engine.ts`) tested Senior allocation from 6,000 to 9,000 bps across recovery rates 0.30–0.60. At 9,000 bps Senior allocation:

- Junior tranche absorbs only 10% of losses (1,000 bps of NAV).
- At a 5% default rate and 35% recovery, loss absorption required = 5% × 65% = 3.25% of NAV — already 32.5% of the Junior tranche's 10% NAV share.
- At an 8% default rate and 30% recovery, Junior is fully wiped and Senior suffers losses before the circuit-breaker fires.

At 7,500 bps Senior allocation:

- Junior tranche absorbs 25% of losses (2,500 bps of NAV).
- The same 5% / 35% scenario consumes only 13% of Junior's share — sustainable even in moderate stress.
- Under severe stress (8% / 30%), Junior absorbs 3.25% of pool NAV against a 25% NAV share — fully absorbs the shock without Senior impairment.

**Conclusion:** The 75/25 split is the maximum Senior allocation where Junior provides meaningful first-loss protection across all scenarios tested in the pilot sweep. 90% cannot be justified without empirical evidence of sub-5% default rates in production.

---

### D.3 — `minSubordinationBps` floor: 1,000 → 1,500 bps

**Change:** Minimum required Junior subordination raised from 10% to 15%.

**Rationale:**

`minSubordinationBps` is a structural floor: it prevents new Senior deposits from being accepted when Junior coverage is already thin. Raising this floor from 10% to 15% ensures the pool maintains adequate first-loss buffer even near the deposit limit.

At 10% minimum subordination combined with 90% Senior ceiling, governance could operate a pool at exactly the boundary of both constraints simultaneously — an extremely fragile state. At 15% minimum subordination with 75% Senior ceiling, there is a 10-percentage-point buffer between the operational ceiling and the structural floor.

**Conclusion:** Coordinated with the Senior allocation ceiling reduction to prevent simultaneous tightening at both extremes.

---

### D.4 — `seniorLiquidityFloorBps` floor: 500 → 1,000 bps

**Change:** Minimum on-chain Senior liquidity floor raised from 5% to 10% of pool NAV.

**Rationale:**

CONSTRAINT-6 requires `seniorLiquidityFloorBps ≥ ⌊POOL_LIQUIDITY_RATIO_threshold × 10,000⌋`. The circuit-breaker pool liquidity trigger is at 25% (2,500 bps). The original 500 bps floor allowed an on-chain guard as low as 5% — far below the circuit-breaker threshold, rendering the on-chain guard meaningless in all realistic scenarios.

The 1,000 bps floor is still below the circuit-breaker threshold (2,500 bps), but governance policy (§4) now enforces that the **actual deployed value** must satisfy CONSTRAINT-6 (i.e., be ≥ 2,500 bps). The floor at 1,000 bps represents the minimum the contract bounds will accept; actual deployment should be set to 2,500 bps or higher.

**Conclusion:** The 500 bps floor was a dead letter — any compliant value must be ≥ 2,500 bps. The new 1,000 bps floor reduces the gap between the absolute minimum and the operationally required minimum, providing a less misleading constraint.

---

### D.5 — `juniorCoverageFloorBps`: new parameter, floor 1,000 bps

**Change:** New parameter formalizes minimum Junior coverage ratio as a governance-protected value.

**Rationale:**

Prior to v1.2.0, no explicit governance parameter prevented governance from setting a Junior coverage floor below 10%. The `juniorCoverageFloorBps` parameter (with a governance floor of 1,000 bps) creates an explicit protection: the on-chain Junior coverage mechanism cannot be configured below 10% of pool NAV without satisfying the §9.3 ratchet.

The 10% floor corresponds to the minimum Junior coverage scenario tested in the pilot that did not produce Senior impairment under base-case conditions.

---

### D.6 — `recoveryRateAssumptionPct` ceiling: 40%

**Change:** Recovery rate assumption is capped at 40% and frozen as a Code-Constant at launch.

**Rationale:**

The pilot sweep (`tranche-parameter-sweep.engine.ts`) tested recovery rates from 30% to 60%. The WANPY₁₂ pilot calibration baseline uses 50% as a worked-example midpoint. However, **the 50% recovery rate is not validated by production data** — it is a modelling assumption.

The conservative launch ceiling of 40% is selected because:

1. **40% is the lower-middle of the tested range** — it produces materially more conservative loss estimates than 50% while remaining achievable based on typical secured-lending recovery empirics.
2. **Raising the recovery assumption inflates yield estimates**, which in turn inflates the WANPY₁₂ ceiling and allows governance to claim higher `seniorTargetYieldBps`. Capping at 40% prevents upward manipulation of the yield ceiling via optimistic recovery assumptions.
3. **The 40% ceiling is itself ratchet-gated** — it can only be raised after the §9.3 evidence standard is met, including a `realizedRecoveryRate₁₈₀ ≥ 0.40` requirement (i.e., actual recovery rates must first meet the current ceiling before it can be raised further).

---

### D.7 — `breakerSeniorThresholdUsdc` fixed at 0

**Change:** The threshold below which Senior priority is blocked is fixed at 0 USDC at launch.

**Rationale:**

Setting this to 0 means the Senior priority block activates at the **first dollar of shortfall** — i.e., as soon as the pool has insufficient liquidity to pay Senior in full. This is the strictest possible setting. Raising this threshold creates a tolerance band within which Senior investors can still receive priority distributions despite a pool shortfall — a form of "managed impairment" that may be appropriate once the pool's behaviour under stress is well understood, but is premature without production data.

---

### D.8 — Junior reduction stability: 14 days → 60 days + public report

**Change:** Any governance action that reduces Junior protection (decreases `juniorCoverageFloorBps`, `minSubordinationBps`, or the Junior allocation share) requires a 60-day stability window and a mandatory public report, replacing the prior 14-day frequency limit.

**Rationale:**

A 14-day frequency limit allows governance to reduce Junior protection 26 times per year in rapid succession — an insufficient protection against incremental erosion. The 60-day window creates a meaningful observation period: if a Junior reduction is approved on Day 0, the next reduction cannot be scheduled until Day 60, forcing governance to observe at least one reporting cycle of pool performance before the next reduction.

The mandatory public report requirement ensures that Junior LPs and external observers have documented evidence before each reduction step.

---

### D.9 — Senior allocation increase: blocked pending §9.3 ratchet

**Change:** Any increase in `seniorAllocationBps` is blocked without satisfying the §9.3 five-gate ratchet (180 days live data, realised default rate < 8%, realised recovery rate ≥ 40%, independent review, 14-day public comment).

**Rationale:**

Senior allocation is the single most consequential capital structure parameter — it determines how much loss Junior must absorb before Senior is impaired. Allowing governance to increase this parameter without a minimum evidence standard would permit the protocol to drift toward aggressive leverage on the basis of short-term favourable conditions that may not be representative.

The 180-day minimum live data requirement is the shortest period over which a statistically meaningful loan default pattern can emerge (given typical 6–12 month loan terms). The 8% default rate ceiling ensures the protocol is not increasing Senior leverage during a period of deteriorating portfolio quality.

---

### D.10 — Ratchet step limit: 500 bps per approval cycle

**Change:** Each §9.3 approval can increase `seniorAllocationBps` by at most 500 bps.

**Rationale:**

Starting from 7,000 bps (70%) default, reaching the 7,500 bps ceiling requires one approval cycle. Starting from 5,000 bps (minimum), reaching the ceiling requires five cycles — each requiring at least 180 days of new evidence. This prevents governance from ratifying a single large jump that circumvents the intent of the ratchet. The step size of 500 bps is 1/5 of the range between the default (7,000) and ceiling (7,500), providing an appropriately fine-grained progression.

---

*Appendix D is an integral part of the v1.2.0-conservative ratification record. Any amendment to the bounds documented in §3–§9 requires a corresponding update to this memo explaining the revised justification.*

---

*This document is subject to ratification by the Risk/Compliance function before implementation.*
*All hard bounds and frequency limits herein are proposals — they become effective upon deployment of the enforcement mechanism described in §9.2 and the on-chain implementation of stability window tracking (v1.3 target).*
*Document version: 1.2.0-conservative | Template version: 1.1*
