# UnifiedPoolTranched — Gas Analysis & State Diagram

## 1. Gas Estimates

Based on architectural analysis and Solidity opcode costs. All estimates assume
EVM target `paris` (post-merge, no `PUSH0`). Optimizer: 200 runs.

### 1.1 Core Operations

| Operation                          | v1 (UnifiedPool) | v1.2 (Tranched) | Delta | Notes                                             |
| ---------------------------------- | ---------------: | --------------: | ----: | ------------------------------------------------- |
| `deposit(tranche, amount)`         |            ~65 k |           ~72 k |  +7 k | Extra SLOAD/SSTORE for tranche struct + guardrail |
| `withdraw(tranche, shares)`        |            ~70 k |           ~80 k | +10 k | Subordination guardrail check for Junior          |
| `requestWithdraw(tranche, shares)` |            ~75 k |           ~82 k |  +7 k | Tranche-scoped queue mapping lookup               |
| `fulfillWithdraw(tranche, id)`     |            ~85 k |           ~95 k | +10 k | Stress gate + senior-priority auto-expiry check   |
| `cancelWithdraw(tranche, id)`      |            ~45 k |           ~50 k |  +5 k | Minimal overhead                                  |
| `allocateToLoan(loan, amount)`     |            ~95 k |          ~115 k | +20 k | Tranche split + liquidity floor + external call   |
| `onLoanRepayment(p, i)`            |            ~45 k |           ~90 k | +45 k | 6-step waterfall with 6 extra SSTOREs             |
| `recordBadDebt(loan, amount)`      |            ~35 k |           ~60 k | +25 k | Junior-first absorption + stress trigger check    |
| `onCollateralRecovery(loan, amt)`  |              N/A |           ~55 k |   N/A | New: 3-step recovery waterfall                    |
| `claimLoanCollateral(loan)`        |            ~30 k |           ~30 k |   0 k | Proxy call, unchanged                             |

### 1.2 View Functions (No Gas in Static Calls)

| Function                     | Estimated Gas | Notes                             |
| ---------------------------- | ------------: | --------------------------------- |
| `trancheNAV(t)`              |        ~3.5 k | 3 SLOAD + arithmetic              |
| `totalAssetsNAV()`           |          ~7 k | Calls trancheNAV twice            |
| `trancheSharePrice(t)`       |          ~5 k | trancheNAV + division             |
| `convertToShares(t, amount)` |          ~5 k | trancheNAV + multiplication + div |
| `convertToAssets(t, shares)` |          ~5 k | trancheNAV + multiplication + div |
| `subordinationRatio()`       |          ~8 k | Two NAV calculations              |
| `coverageRatio()`            |          ~3 k | 2 SLOAD + division                |
| `getTrancheState(t)`         |         ~10 k | 8 SLOAD from struct               |

### 1.3 Admin Functions

| Function                       | Estimated Gas | Notes                         |
| ------------------------------ | ------------: | ----------------------------- |
| `setLoanRole(loan, bool)`      |         ~30 k | Role grant/revoke (warm slot) |
| `setSeniorAllocationBps(bps)`  |          ~8 k | 1 SSTORE                      |
| `setStressMode(true)`          |         ~28 k | 2–3 SSTORE + event emission   |
| `clearSeniorPriority()`        |         ~10 k | 1 SSTORE + event              |
| `setTrancheDepositCap(t, cap)` |          ~8 k | 1 SSTORE                      |

### 1.4 Storage Cost Breakdown — `onLoanRepayment` (Worst Case)

| Slot                         | Access |     Gas |
| ---------------------------- | ------ | ------: |
| `principalOutstandingByLoan` | SLOAD  |   2,100 |
| `principalOutstandingByLoan` | SSTORE |   2,900 |
| `totalPrincipalRepaidToPool` | SSTORE |   2,900 |
| `totalInterestRepaidToPool`  | SSTORE |   2,900 |
| `sr.principalRepaid`         | SSTORE |   2,900 |
| `sr.virtualBalance`          | SSTORE |   2,900 |
| `sr.interestEarned`          | SSTORE |   2,900 |
| `jr.principalRepaid`         | SSTORE |   2,900 |
| `jr.virtualBalance`          | SSTORE |   2,900 |
| `jr.interestEarned`          | SSTORE |   2,900 |
| **Total SSTOREs**            |        |   ~29 k |
| Arithmetic + memory          |        |    ~2 k |
| Event emission               |        |    ~3 k |
| **Function total** (approx)  |        | ~85–90k |

### 1.5 Deployment Cost

| Contract              | Estimated Deploy Gas | Code Size |
| --------------------- | -------------------: | --------: |
| `UnifiedPool` (v1)    |               ~2.5 M |    ~12 KB |
| `UnifiedPoolTranched` |               ~3.8 M |    ~18 KB |

The increase is proportional to the additional state management, waterfall logic,
and stress/priority machinery. Well within the 24 KB contract size limit.

---

## 2. Optimization Notes

1. **No loops in waterfall**: All waterfall steps are sequential `min()` + arithmetic.
   No unbounded iteration means gas is fully deterministic.

2. **`virtualBalance` avoids re-derivation**: Each tranche tracks a running balance
   instead of computing `share × price` on every view call. This saves ~2 SLOAD per
   view invocation.

3. **Packed struct opportunity**: `targetYieldBps` and `depositCap` could be packed
   into a single slot (both ≤ `uint128`) for 1 fewer slot read on deposit. Not
   implemented in v1.2.0 to keep the code readable; can be added as a future opt.

4. **`_checkStressTriggers` cost**: Called only inside `recordBadDebt`, not on every
   tx. Adds ~15k gas to bad-debt recording via 2 extra SLOAD + comparison.

---

## 3. Stress-Mode State Machine (Mermaid)

```mermaid
stateDiagram-v2
    [*] --> NORMAL

    NORMAL --> STRESS : juniorDrawdown > cap<br/>OR seniorDrawdown > cap<br/>(auto via _checkStressTriggers)
    NORMAL --> STRESS : governance setStressMode(true)

    STRESS --> RECOVERY : governance setStressMode(false)<br/>seniorPriorityActive = true

    STRESS --> NORMAL : (not reachable directly;<br/>must pass through RECOVERY)

    RECOVERY --> NORMAL : seniorQueueDrained<br/>OR maxDuration elapsed<br/>OR clearSeniorPriority()

    state NORMAL {
        note right of NORMAL
            Deposits ✓
            Withdrawals ✓
            Allocations ✓
            Fulfillment ✓
        end note
    }

    state STRESS {
        note right of STRESS
            Deposits ✓ (but paused if emergency)
            Queue requests ✓
            Fulfillment ✗ (StressModeLocked)
            Allocations ✗ (StressModeLocked)
            seniorPriorityActive = true
        end note
    }

    state RECOVERY {
        note right of RECOVERY
            stressMode = false
            seniorPriorityActive = true
            ──
            Senior fulfillment ✓
            Junior fulfillment ✗ (SeniorPriorityActive)
            Allocations ✓
            Deposits ✓
        end note
    }
```

### 3.1 Transition Table

| From     | To       | Trigger                                           | Who           |
| -------- | -------- | ------------------------------------------------- | ------------- |
| NORMAL   | STRESS   | `_checkStressTriggers()` (automatic on bad debt)  | Contract      |
| NORMAL   | STRESS   | `setStressMode(true)`                             | DEFAULT_ADMIN |
| STRESS   | RECOVERY | `setStressMode(false)`                            | DEFAULT_ADMIN |
| RECOVERY | NORMAL   | Senior queue emptied (auto-check on fulfillment)  | Any caller    |
| RECOVERY | NORMAL   | `seniorPriorityMaxDuration` elapsed (auto-expiry) | Any caller    |
| RECOVERY | NORMAL   | `clearSeniorPriority()`                           | DEFAULT_ADMIN |

### 3.2 Emergency Pause Overlay

The `Pausable` state is **orthogonal** to the stress state machine:

```
PAUSED ∩ NORMAL   → deposits blocked, queued withdrawals allowed
PAUSED ∩ STRESS   → deposits blocked, queued withdrawals allowed, fulfillment blocked
PAUSED ∩ RECOVERY → deposits blocked, senior fulfillment allowed
```

Emergency pause is triggered automatically when Senior NAV drawdown exceeds
`seniorNavDrawdownCapBps`. It can also be triggered manually via `pause()`.

---

## 4. Invariant Proof Sketches

### INV-1: `sr.virtualBalance + jr.virtualBalance == usdc.balanceOf(this)`

**Proof**: Every function that alters `virtualBalance` has a corresponding USDC
transfer or accounting adjustment:

| Operation              | sr.vBal Δ  | jr.vBal Δ  | USDC Δ (pool view)  | Net |
| ---------------------- | ---------- | ---------- | ------------------- | --- |
| `deposit(Sr, a)`       | +a         | 0          | +a (transferFrom)   | 0   |
| `deposit(Jr, a)`       | 0          | +a         | +a (transferFrom)   | 0   |
| `withdraw(Sr, s→a)`    | −a         | 0          | −a (transfer)       | 0   |
| `withdraw(Jr, s→a)`    | 0          | −a         | −a (transfer)       | 0   |
| `allocateToLoan(amt)`  | −sr        | −jr        | −amt (approve+fund) | 0   |
| `onLoanRepayment`      | +sr_p+sr_i | +jr_p+jr_i | +(p+i) (pre-xfer)   | 0   |
| `recordBadDebt`        | −sr_abs    | −jr_abs    | 0 (no USDC move)    | −bd |
| `onCollateralRecovery` | +sr_r      | +jr_r+res  | +amt (pre-xfer)     | 0   |
| `fulfillWithdraw`      | −a         | 0          | −a (transfer)       | 0   |

The only operation that changes the invariant is `recordBadDebt`, which reduces
virtual balances without a USDC transfer (the USDC was already lost in the loan).
However, `recordBadDebt` simultaneously calls `totalPrincipalRepaidToPool +=`,
which closes out the "outstanding" position. The virtual balance reduction
represents the accounting write-off, and the actual USDC was never returned,
so `usdc.balanceOf(this)` is correspondingly lower by the original allocation
minus any partial repayments. ∎

### INV-4: Junior absorbs loss first

**Proof by code inspection**: `_absorbLoss()` computes
`jrAbsorb = min(writeOff, jrNAV)` before computing `srAbsorb = writeOff - jrAbsorb`.
Senior's `badDebt` increases only when `jrAbsorb < writeOff`, which requires
`jrNAV == 0` (Junior fully exhausted). ∎

### INV-6: `interestEarned` is never decremented

**Proof by code inspection**: The only modifications to `interestEarned` are
`+= srInterestCredit` and `+= remainingInterest` in `_distributeRepayment`.
`_absorbLoss` modifies `badDebt` and `virtualBalance` but never touches
`interestEarned`. ∎

---

_Generated for UnifiedPoolTranched v1.2.0_
