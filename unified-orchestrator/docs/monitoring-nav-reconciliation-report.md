# Unified v1.2.1 — Monitoring, NAV Engine & Reconciliation Report

**Prepared by:** Agent C — Backend / Analytics Architect  
**Branch:** `agent-c/v1.2.1-monitoring`  
**Date:** 2026-02-23  
**Status:** Final — ready for credit committee and engineering review

---

## Executive Summary

This report documents the design and rationale for the production-grade monitoring, NAV computation, and reconciliation layer introduced in Unified v1.2.1. The layer is built directly on top of the tranche capital structure validated by the conservative recalibration (see `conservative-recalibration-report.md`) and the tranche analytics architecture (see `tranche-analytics-architecture.md`).

Four capabilities are delivered:

1. **Tranche-Separated NAV Engine** — computes `virtualBalance`, `principalOutstanding`, `badDebt`, and `NAV` per tranche, with block-level parity verification against on-chain contract state.
2. **Invariant Poller** — calls `checkInvariants()` on every block; pages immediately on any failure; fail-closed on RPC errors.
3. **Coverage & Subordination Dashboard** — live and historical metric surface covering all nine key risk signals, with three-band status classification.
4. **Stress & Breaker Alert Playbook** — P0/P1/P2 severity matrix with nine trigger IDs, five runbooks, and a signed daily reconciliation artifact.

The system is designed around a single governing principle: **no silent failures**. Every metric that cannot be computed is treated as a breach, not a gap.

---

## 1. Context and Motivation

### 1.1 Capital Structure

The recommended tranche structure from the conservative recalibration is:

| Parameter | Value | Rationale |
|---|---|---|
| `seniorAllocationBps` | 7000 (70%) | Validated under 12 stress scenarios |
| `juniorAllocationBps` | 3000 (30%) | Hard floor — invariant-protected |
| `juniorCoverageFloorBps` | 750 | Breaker fires below this |
| `recoveryRateAssumptionPct` | 30% | Conservative floor |

The 30% junior floor is protected by the §6.1 invariant: `juniorAllocationBps` may not fall below 3000 bps without 6 months of live performance data, a realised default rate below 5%, an independent review report, and a ≥ 30-day governance timelock.

### 1.2 Why Block-Level Monitoring

The tranche structure creates asymmetric risk: senior investors bear no losses until the junior buffer is fully exhausted. This means a rapid deterioration in the junior buffer — driven by correlated defaults — can transition from "healthy" to "senior impaired" within a small number of blocks. Daily-only monitoring is insufficient. The invariant poller closes this gap by evaluating the full contract state on every block.

### 1.3 Relationship to Existing Circuit Breaker

The v1.1 circuit breaker (`CIRCUIT_BREAKER.md`) evaluates partner default rates, pool liquidity, and settlement integrity on 5-minute to daily cadences. The v1.2.1 monitoring layer adds eight new trigger IDs that operate at block cadence and are wired into the same `BreakerIncident` / `BreakerAuditLog` infrastructure. No new enforcement mechanism is introduced — the existing fail-closed enforcement state is extended.

---

## 2. NAV Engine

### 2.1 Computation

NAV is **backend-computed** from database state, not pure event-sourced. This is a deliberate design choice: fiat (KES) disbursements and repayments have no on-chain representation, so a purely on-chain NAV would be incomplete.

Per tranche:

```
virtualBalance       = commitmentUsdc − defaultImpactUsdc + cumulativeYieldUsdc
principalOutstanding = Σ allocatedUsdc  (active TrancheLoanAllocations)
badDebt              = defaultImpactUsdc
NAV                  = virtualBalance
```

Pool-level balance sheet identity (verified daily):

```
sr.virtualBalance + jr.virtualBalance + principalOutstanding
    = usdcBalance + totalBadDebt
```

### 2.2 Contract Parity

On every block, the poller reads `tranche.virtualBalance` directly from `UnifiedPoolTranched` and compares it to the backend-computed value. A divergence of ≥ 1 USDC (1,000,000 raw units) triggers a P0 `NAV_PARITY_BREACH` alert. This catches:

- Missed on-chain events (default write-offs, yield accruals)
- Event listener failures or reorg-induced state drift
- Any manual DB mutation that bypasses the event pipeline

### 2.3 Coverage Ratio — Commitment-Based

The coverage ratio uses the **commitment-based** junior buffer, not `juniorNAV`:

```
juniorBuffer     = juniorCommitmentUsdc − juniorDefaultImpactUsdc
coverageRatioBps = (juniorBuffer × 10,000) / seniorExposureUsdc
```

Using `juniorNAV` would inflate the buffer with accrued yield, which carries no loss-absorbing capacity. This is consistent with standard structured finance OC test conventions and the architecture established in `tranche-analytics-architecture.md §2.3`.

### 2.4 Daily Snapshot Schedule

| Job | Time (UTC) | Output |
|---|---|---|
| NAV snapshot | 01:00 | `TrancheNAVSnapshot` upserted per tranche |
| Yield report | 02:00 | `TrancheYieldReport` |
| Coverage report | 02:00 | `CoverageRatioReport` → breaker check |
| Reconciliation | 03:00 | Signed `DailyReconArtifact` |

---

## 3. Invariant Poller

### 3.1 What Is Polled

On every new block, four contract reads are executed in parallel:

| Call | Type | Failure action |
|---|---|---|
| `checkInvariants()` | view | P0 if `ok == false` |
| `paused()` | view | P0 if `true` (unexpected) |
| `stressMode()` | view | P1 if `true` |
| `seniorPriorityActive()` | view | P2 if `true` |

Additionally, `TrancheNAVService.computePoolNAV()` is called to verify NAV parity and the balance sheet identity on every block.

### 3.2 Fail-Closed Design

If any RPC call throws — network error, provider timeout, node unavailability — the block is treated as an invariant failure:

- P0 alert is paged immediately
- A failed `InvariantPollRecord` is persisted with `invariantCode: -1`
- No blocks are silently skipped

This ensures that a monitoring outage is indistinguishable from a protocol failure from the on-call engineer's perspective.

### 3.3 Persistence

Every block produces one `InvariantPollRecord` row. The table is indexed on `(poolId, blockNumber)` and `invariantOk` to support fast failure queries. The dashboard `GET /admin/tranche/poll/failures` endpoint queries this index directly.

---

## 4. Coverage & Subordination Dashboard

### 4.1 Metric Surface

Nine signals are monitored continuously, refreshed every 30 seconds:

| Signal | Warning | Critical |
|---|---|---|
| `coverageRatioBps` | < 1,500 bps (2× floor) | < 750 bps (floor) |
| `subordinationBps` | < 4,500 bps (1.5× min) | < 3,000 bps (floor) |
| `invariantOk` | — | `false` |
| `paused` | — | `true` |
| `stressMode` | `true` | — |
| `seniorPriorityActive` | `true` | — |
| `navParityDeltaUsdc` | > 0 | > 1,000,000 |
| `reconDeltaUsdc` | > 0 | > 1,000,000 |
| `seniorImpairmentUsdc` | — | > 0 |

### 4.2 Status Bands

**Coverage:**
- `HEALTHY` — `coverageRatioBps ≥ 1,500` (buffer is more than 2× the floor)
- `WARNING` — `750 ≤ coverageRatioBps < 1,500` (approaching floor; ops notified)
- `BREAKER_ZONE` — `coverageRatioBps < 750` (breaker fires; originations halted)

**Subordination:**
- `HEALTHY` — `subordinationBps ≥ 4,500`
- `WARNING` — `3,000 ≤ subordinationBps < 4,500` (approaching floor invariant)
- `FLOOR_BREACH` — `subordinationBps < 3,000` (junior floor invariant violated)

### 4.3 API Endpoints

All endpoints require `X-Admin-Key` header.

```
GET  /admin/tranche/coverage              Live CoverageState
GET  /admin/tranche/coverage/history      Daily history (configurable window)
GET  /admin/tranche/nav                   Live PoolNAVState
GET  /admin/tranche/nav/history           Daily TrancheNAVSnapshot history
GET  /admin/tranche/subordination         Subordination ratio + trend
GET  /admin/tranche/poll/latest           Most recent BlockPollRecord
GET  /admin/tranche/poll/failures         Recent invariant failures
GET  /admin/tranche/recon/latest          Most recent signed DailyReconArtifact
```

---

## 5. Alert Severity & Runbooks

### 5.1 Severity Matrix

| Severity | Trigger | Condition | Immediate Response |
|---|---|---|---|
| **P0** | `INVARIANT_FAILURE` | `checkInvariants().ok == false` | Page on-call + ops lead. All originations halted. |
| **P0** | `SENIOR_TRANCHE_DRAWDOWN` | `seniorImpairmentUsdc > 0` | Page credit committee. Freeze pool. Notify senior investors. |
| **P0** | `GLOBAL_HARD_STOP` | `paused == true` (unexpected) | Page on-call. Do not unpause without root cause. |
| **P0** | `NAV_PARITY_BREACH` | `parityDeltaUsdc > 1,000,000` | Page on-call. No settlements until parity restored. |
| **P0** | `POLLER_RPC_ERROR` | RPC call throws | Page on-call. Treat as invariant failure. |
| **P1** | `STRESS_MODE_ACTIVE` | `stressMode == true` | Notify credit committee. Monitor coverage hourly. |
| **P1** | `COVERAGE_WARNING` | `coverageRatioBps < 1,500` | Notify ops. Review origination pipeline. |
| **P1** | `SUBORDINATION_WARNING` | `subordinationBps < 4,500` | Notify credit committee. Freeze new originations. |
| **P2** | `SENIOR_PRIORITY_ACTIVE` | `seniorPriorityActive == true` | Notify ops. Confirm expected (stress mode side-effect). |

### 5.2 Runbook Summaries

**P0 — Invariant Failure**
Query `/admin/tranche/poll/failures` for `invariantCode`. Cross-reference with contract error table. Do not resolve the incident until DB state matches on-chain state exactly. No override without engineering lead and credit committee sign-off.

**P0 — Senior Impairment**
Confirm `senior.badDebt > 0` via `/admin/tranche/nav`. Notify all senior investors per investor agreement. Initiate collateral claim and legal process. Do not resolve until full loss accounting is signed off.

**P0 — NAV Parity Breach**
Inspect `parityDeltaUsdc` per tranche. Check event listener logs for missed events. If replay is needed, trigger `TrancheNAVService.recomputeFromEvents(poolId, fromBlock)`. No settlements until delta == 0.

**P1 — Stress Mode**
Monitor `coverageRatioBps` every 30 minutes. If declining faster than 200 bps/day, escalate to P0 and freeze originations. No new originations until `stressMode == false`.

**P1 — Coverage Warning**
Review 7-day coverage history for trend. If `coverageRatioBps < 750`, the breaker fires automatically — follow P0 invariant runbook.

---

## 6. Daily Reconciliation

### 6.1 Identity Verification

The reconciliation service verifies the balance sheet identity at 03:00 UTC every day against a specific block snapshot:

```
sr.virtualBalance + jr.virtualBalance + principalOutstanding
    = usdcBalance + totalBadDebt
```

Any deviation (`reconDeltaUsdc ≠ 0`) triggers a P0 `RECON_IDENTITY_BREACH` alert.

### 6.2 Signed Artifact

Each successful reconciliation produces a `DailyReconArtifact` containing:

- All balance sheet components (BigInt, 6-decimal USDC)
- `reconOk` boolean and `reconDeltaUsdc` deviation
- NAV parity status per tranche
- HMAC-SHA256 signature over canonical JSON, keyed by `RECON_SIGNING_KEY`

The signature allows downstream consumers (auditors, investors) to verify artifact integrity without trusting the transport layer. Artifacts are persisted to `DailyReconArtifact` and queryable via `/admin/tranche/recon/latest`.

### 6.3 Audit Trail

The reconciliation artifact, combined with the `BreakerAuditLog` (append-only, no deletes), provides a complete daily audit trail of pool health. Together they satisfy the following audit requirements:

- **Balance sheet completeness** — every USDC in the pool is accounted for
- **Loss attribution** — `defaultImpactUsdc` per tranche records exactly which tranche absorbed each loss
- **Tamper evidence** — HMAC signature detects any post-hoc artifact modification
- **Incident history** — every breaker firing, acknowledgement, and resolution is logged with operator identity

---

## 7. New Infrastructure Components

### 7.1 Prisma Models Added

| Model | Purpose |
|---|---|
| `InvariantPollRecord` | One row per block; stores all polled state and alert metadata |
| `DailyReconArtifact` | Signed daily balance sheet identity check |

Both extend the existing schema without modifying existing models.

### 7.2 BreakerTrigger Enum Extensions

Eight new values added to the existing `BreakerTrigger` enum:

```
INVARIANT_FAILURE       SENIOR_TRANCHE_DRAWDOWN
JUNIOR_TRANCHE_DEPLETION  NAV_PARITY_BREACH
STRESS_MODE_ACTIVE      COVERAGE_WARNING
SUBORDINATION_WARNING   POLLER_RPC_ERROR
```

### 7.3 New Services

| Service | Module | Schedule |
|---|---|---|
| `TrancheNAVService` | `TrancheModule` | Daily 01:00 UTC + on-demand |
| `TrancheReconService` | `TrancheModule` | Daily 03:00 UTC |
| `InvariantPollerService` | `TrancheModule` | Every block (event-driven) |

### 7.4 Environment Variables Required

| Variable | Required | Description |
|---|---|---|
| `RECON_SIGNING_KEY` | **Yes** | HMAC key for recon artifact signatures (min 32 bytes) |
| `POOL_CONTRACT_ADDRESS` | **Yes** | `UnifiedPoolTranched` contract address |
| `RPC_URL` | **Yes** | EVM RPC endpoint for block listener and contract reads |

---

## 8. Risk Assessment

### 8.1 Residual Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| RPC provider outage | Medium | Fail-closed: treated as P0. Recommend secondary RPC fallback. |
| Event listener missed event | Low | Daily NAV parity check catches any drift within 24 hours; block-level parity check catches it within one block. |
| DB write failure during poll | Low | Alert is emitted before DB write; alert delivery is not gated on persistence. |
| Recon signing key compromise | Very Low | Rotate `RECON_SIGNING_KEY`; re-sign historical artifacts if needed. |

### 8.2 What This Layer Does Not Cover

- **Liquidity ratio per tranche** — deferred to v1.3 (closed-end term loan pools; no on-demand redemption)
- **Cross-pool correlation monitoring** — deferred; requires multi-pool data aggregation
- **On-chain governance timelock enforcement** — the 30-day timelock for the junior floor invariant is a governance process; this layer monitors the outcome (subordination breach) but does not enforce the process

---

## 9. Deployment Summary

**Branch:** `agent-c/v1.2.1-monitoring`

```bash
# 1. Migrate schema
npx prisma migrate dev --name add_monitoring_v1_2_1
npx prisma generate

# 2. Set environment variables
RECON_SIGNING_KEY=<min-32-byte-secret>
POOL_CONTRACT_ADDRESS=<contract-address>
RPC_URL=<rpc-endpoint>

# 3. Register TrancheModule in AppModule
# 4. Deploy and verify checklist (see spec §6.6)
```

**Verification checklist:**
- [ ] `InvariantPollRecord` rows created for every block
- [ ] `DailyReconArtifact` created at 03:00 UTC with `reconOk: true`
- [ ] `GET /admin/tranche/coverage` returns correct `coverageRatioBps`
- [ ] P0 alert fires when `checkInvariants()` returns `ok: false` in test
- [ ] P1 alert fires when `stressMode: true` in test
- [ ] Recon signature verifies with `RECON_SIGNING_KEY`
- [ ] Poller fail-closed: RPC error → P0 alert + failed poll record persisted

---

## 10. References

| Document | Path |
|---|---|
| Tranche Analytics Architecture | `docs/tranche-analytics-architecture.md` |
| Circuit Breaker Engine (v1.1) | `docs/CIRCUIT_BREAKER.md` |
| Conservative Recalibration Report | `docs/conservative-recalibration-report.md` |
| Capital Structure Calibration Report | `docs/capital-structure-calibration-report.md` |
| Monitoring Spec (implementation detail) | `docs/monitoring-nav-reconciliation-spec.md` |

---

*Report prepared by Agent C. Branch: `agent-c/v1.2.1-monitoring`. Date: 2026-02-23.*
