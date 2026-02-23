# UnifiedPoolTranched — v1.2.1 Pre-Merge Hardening

> Revision: **v1.2.1** | Date: 2025-01-XX | Status: **ready for merge**

---

## 1. Diff Summary (v1.2.0 → v1.2.1)

### contracts/libraries/UnifiedErrors.sol

| Change                                                                    | Detail                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| +`AllocationRatioOutOfBounds(uint256 provided, uint256 min, uint256 max)` | Replaces generic `InvalidConfiguration` for allocation bounds |
| +`SeniorImpaired(uint256 srBadDebt)`                                      | Emitted context error for senior bad-debt breach              |
| +`LaunchParametersLocked()`                                               | One-way governance lock on structural params                  |
| +`InvariantViolation(uint8 code)`                                         | On-chain invariant hook revert (codes 1–3)                    |

### contracts/UnifiedPoolTranched.sol

| Area                  | v1.2.0                             | v1.2.1                                                                                                                                                                 |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocation bounds** | `bps > BPS → InvalidConfiguration` | `bps ∉ [5000, 9000] → AllocationRatioOutOfBounds`                                                                                                                      |
| **Constants**         | —                                  | `MIN_SENIOR_ALLOCATION_BPS = 5000`, `MAX_SENIOR_ALLOCATION_BPS = 9000`                                                                                                 |
| **Coverage floor**    | Soft check (event only)            | Hard revert in `allocateToLoan` when `jr/sr < juniorCoverageFloorBps` post-allocation                                                                                  |
| **Senior impairment** | Manual stress toggle               | Auto `stressMode + _pause()` when `sr.badDebt > 0` after `recordBadDebt`                                                                                               |
| **Invariant hook**    | None                               | `_assertCoreInvariants()` called after `allocateToLoan`, `onLoanRepayment`, `recordBadDebt`                                                                            |
| **External view**     | —                                  | `checkInvariants() → (bool ok, uint8 code)` for off-chain monitoring                                                                                                   |
| **Launch lock**       | —                                  | `launchLocked` bool + `lockLaunchParameters()` one-way; blocks `setSeniorAllocationBps`, `setSeniorTargetYield`, `setMinSubordinationBps`, `setJuniorCoverageFloorBps` |
| **Events**            | —                                  | +`SeniorImpairmentDetected`, +`LaunchParametersLockedEvent`, +`InvariantChecked`                                                                                       |

### test/UnifiedPoolTranched.test.ts

| Metric       | v1.2.0                                  | v1.2.1                                               |
| ------------ | --------------------------------------- | ---------------------------------------------------- |
| Total tests  | 58                                      | **90**                                               |
| New sections | —                                       | §17–§22                                              |
| §11 update   | Tested `> 10000 → InvalidConfiguration` | Tested `∉ [5000, 9000] → AllocationRatioOutOfBounds` |

---

## 2. Updated Invariant Table

| ID        | Invariant                                                                               | Enforcement                                                             | Hook                                           |
| --------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| **INV-1** | `sr.balance + jr.balance + principalOutstanding == USDC.balanceOf(pool) + totalBadDebt` | `_assertCoreInvariants()` → revert `InvariantViolation(1)`              | allocateToLoan, onLoanRepayment, recordBadDebt |
| **INV-2** | `principalOutstanding` never exceeds prior peak within a single epoch                   | `_assertCoreInvariants()` → revert `InvariantViolation(2)`              | allocateToLoan, onLoanRepayment, recordBadDebt |
| **INV-3** | `sr.badDebt + jr.badDebt == totalBadDebt`                                               | `_assertCoreInvariants()` → revert `InvariantViolation(3)`              | allocateToLoan, onLoanRepayment, recordBadDebt |
| **INV-4** | Junior absorbs loss before Senior                                                       | `recordBadDebt` waterfall logic                                         | recordBadDebt                                  |
| **INV-5** | `subordinationRatio >= minSubordinationBps` after every deposit/withdraw                | `deposit()` / `withdraw()` revert `SubordinationTooLow`                 | deposit, withdraw                              |
| **INV-6** | Senior share price ≥ 1.0 under normal ops (no bad debt)                                 | Waterfall cap in `onLoanRepayment`                                      | economic design                                |
| **INV-7** | `(jr.balance * BPS) / sr.balance >= juniorCoverageFloorBps` after allocation            | `allocateToLoan` → revert `CoverageFloorBreached`                       | **NEW v1.2.1**                                 |
| **INV-8** | `sr.badDebt == 0` (zero tolerance)                                                      | `recordBadDebt` → auto stress + pause + emit `SeniorImpairmentDetected` | **NEW v1.2.1**                                 |

### Off-chain monitoring

`checkInvariants()` returns `(true, 0)` when all three core invariants (INV-1/2/3) hold, or `(false, code)` with the first failing code. Recommended: call every block and alert on `code != 0`.

---

## 3. Stress-Mode Calibration Note

### Trigger Matrix

| Trigger                             | Condition                                                     | Action                                                                       |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Manual (governance)**             | `setStressMode(true)`                                         | `stressMode = true`, `seniorPriorityActive = true`                           |
| **Junior NAV drawdown**             | `jr.nav / jr.highWaterMark < (BPS - juniorNavDrawdownCapBps)` | Stress via circuit breaker (if wired)                                        |
| **Senior NAV drawdown**             | `sr.nav / sr.highWaterMark < (BPS - seniorNavDrawdownCapBps)` | Stress via circuit breaker (if wired)                                        |
| **Zero-tolerance impairment (NEW)** | `sr.badDebt > 0` after `recordBadDebt`                        | **Auto**: `stressMode = true` + `_pause()` + emit `SeniorImpairmentDetected` |

### Calibration Notes

1. **Zero-tolerance is intentionally aggressive.** Any non-zero senior bad debt means the Junior tranche was insufficient to absorb the full loss. This is a protocol-level emergency — automatic pause prevents further deposits/withdrawals while governance assesses.

2. **Pause vs stress distinction.** `setStressMode(true)` alone blocks allocations and Junior fulfillments but does NOT pause deposits (allowing liquidity injection). The zero-tolerance trigger adds `_pause()` on top, which halts ALL external activity. Governance must `unpause()` explicitly after root-cause analysis.

3. **Senior priority duration.** On stress entry, `seniorPriorityActive` is set with a `maxDuration` window (default: 7 days). After expiry, Junior fulfillments auto-resume. The zero-tolerance trigger does NOT change `maxDuration` — it relies on pause to hold everything while governance intervenes.

4. **Coverage floor vs subordination.** `juniorCoverageFloorBps` (INV-7) guards the ratio at **allocation time**, preventing loans from draining Junior cover. `minSubordinationBps` (INV-5) guards at **deposit/withdraw time**, preventing capital structure dilution. Both are locked after `lockLaunchParameters()`.

5. **Recovery path after impairment.** After senior impairment:
   - Governance calls `unpause()` to re-enable deposits
   - Junior depositors inject fresh capital to restore coverage
   - Governance calls `setStressMode(false)` once subordination is healthy
   - Senior priority window begins winding down
   - Normal operations resume after senior priority expires or is cleared

---

## 4. Test Coverage Summary (§17–§22)

| Section                  | Tests  | Focus                                                                                                                                                                            |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §17 Coverage Invariant   | 2      | Hard revert on allocation below floor; clean pass above floor                                                                                                                    |
| §18 Allocation Guardrail | 4      | Below MIN, above MAX, valid range, default within bounds                                                                                                                         |
| §19 Senior Impairment    | 3      | Stress+pause trigger, emission path, persistence                                                                                                                                 |
| §20 Invariant Hook       | 5      | Clean state, deposit/withdraw cycle, interest, recovery, per-deposit                                                                                                             |
| §21 Launch Lock          | 8      | Lock flag, 4 param reverts, operational params exempt, one-way, access control                                                                                                   |
| §22 Adversarial          | 10     | Sandwich, subordination dilution, withdrawal drain, greedy withdraw, double-spend shares, queue griefing, stress deposits, recovery ordering, NAV consistency, coverage tracking |
| **Total new**            | **32** |                                                                                                                                                                                  |

**Grand total: 90 tests, 0 failures, ~4s execution.**
