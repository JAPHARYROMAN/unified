# Tranche Architecture v1.2 — Design Clarifications

| Field       | Value                                                        |
| ----------- | ------------------------------------------------------------ |
| **Parent**  | [tranche-architecture-v1.2.md](tranche-architecture-v1.2.md) |
| **Date**    | 2026-02-23                                                   |
| **Purpose** | Resolve three outstanding design questions                   |

---

## 1. Senior Accrued Interest vs Default

### Question

When a loan defaults, how is the Senior tranche's **accrued-but-uncredited** interest handled? Does the Senior tranche lose accrued yield, or is it crystallised as a receivable?

### Context

In the current `UnifiedLoan` (v1), interest accrues continuously via `_accrueInterest()` but only materialises as USDC in the pool when `repay()` is called. If the loan defaults, any accrued interest that was never repaid simply does not exist as a pool asset — it was never transferred. The pool's NAV only counts `usdcBalance + principalOutstanding − badDebt`; unrealised interest is not in the NAV.

In the tranched design, Senior interest is capped at `targetYieldBps` and credited to `sr.interestEarned` only when cash actually arrives via `onLoanRepayment`. The question is whether the Senior tranche should record "expected but unreceived" interest as a loss on default.

### Decision

**Senior accrued interest that was never received is NOT recorded as a loss. It is simply never credited.**

Rationale and mechanics:

| Scenario                             | Treatment                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loan repays normally                 | Senior receives interest up to `targetYieldBps` cap via waterfall Steps 3. `sr.interestEarned` increases. `sr.virtualBalance` increases.             |
| Loan defaults before any repayment   | Senior receives zero interest for that loan. `sr.interestEarned` is unchanged. No bad-debt entry for interest — only for principal.                  |
| Loan partially repays, then defaults | Senior keeps whatever interest was already credited in prior waterfall distributions. The remaining uncredited interest is forgone, not written off. |

**Why no interest write-off:**

1. **Consistency with v1** — Today's `UnifiedPool.totalAssetsNAV()` does not include unrealised interest. Introducing phantom interest into Senior NAV only to write it off on default would inflate NAV between repayments and then create artificial drawdowns.
2. **No on-chain accrual clock per tranche** — Interest accrual lives on the `UnifiedLoan` contract (`interestAccrued`, `lastAccrualTs`). The pool has no independent time-based accumulator. Adding one per tranche would require a keeper or accrue-on-read pattern and adds gas overhead on every view call (see design doc OQ-4).
3. **Senior yield is a cap, not a guarantee** — `targetYieldBps` defines the maximum the Senior tranche can earn, not a minimum obligation. If loan cash flows are insufficient, Senior simply earns less. This is a structural feature, not a loss event.

**Impact on Senior share price:**

- Senior share price reflects `sr.virtualBalance + sr.principalOutstanding − sr.badDebt`. Since unreceived interest was never added to `sr.virtualBalance` or `sr.interestEarned`, share price is never inflated and never needs to be marked down for forgone interest.
- The only Senior share price decline occurs when principal bad debt exceeds Junior's absorptive capacity (INV-4 from the design doc).

**Edge case — partial recovery after default:**

If collateral is seized and liquidated after a default (via `claimLoanCollateral`), recovered USDC enters the pool's balance and should be distributed through a **recovery waterfall** that mirrors the repayment waterfall: Senior principal recovery first, then Junior. Interest recovery is not applicable because the loan is already in `DEFAULTED` status and `interestAccrued` is frozen.

```
Recovery waterfall (post-default collateral liquidation):
  1. Senior principal shortfall (up to sr.badDebt for that loan)
  2. Junior principal shortfall (up to jr.badDebt for that loan)
  3. Residual to Junior
```

---

## 2. Allocation Guardrail Behavior

### Question

Confirm the exact blocking/gating behavior when allocation guardrails are triggered. Specifically:

- What is blocked?
- What remains allowed?
- Who can override?

### Decision

Three independent guardrails gate `allocateToLoan`. Each is evaluated at call-time. **All three must pass** for allocation to proceed.

### 2.1 Senior Liquidity Floor

| Parameter   | `seniorLiquidityFloorBps`                                                 |
| ----------- | ------------------------------------------------------------------------- |
| **Default** | 1000 (10%)                                                                |
| **Check**   | `sr.virtualBalance / trancheNAV(Senior) >= seniorLiquidityFloorBps / BPS` |
| **Trigger** | Senior's idle USDC drops below floor after allocation would execute       |

**When triggered:**

| Action              | Allowed?                      | Reason                                                                    |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| New loan allocation | **BLOCKED**                   | `allocateToLoan` reverts with `InsufficientTrancheLiquidity(Senior)`      |
| Senior deposits     | Allowed                       | Deposits increase liquidity and can cure the breach                       |
| Senior withdrawals  | Allowed (if liquidity exists) | Withdrawal reduces `virtualBalance` further but doesn't affect allocation |
| Junior deposits     | Allowed                       | No effect on Senior floor                                                 |
| Junior withdrawals  | Allowed                       | No effect on Senior floor                                                 |
| Loan repayments     | Allowed                       | Repayment cash may cure the breach via waterfall                          |

**The check is prospective**: the allocation function computes the post-allocation Senior liquidity ratio and reverts if it would breach the floor. This prevents the pool from entering the breached state rather than reacting after the fact.

```solidity
// Pseudocode inside allocateToLoan:
uint256 srPortionOut = amount * seniorAllocationBps / BPS;
uint256 srBalanceAfter = sr.virtualBalance - srPortionOut;
uint256 srNAV = trancheNAV(Tranche.Senior);
if (srNAV > 0 && srBalanceAfter * BPS < srNAV * seniorLiquidityFloorBps) {
    revert InsufficientTrancheLiquidity(Tranche.Senior);
}
```

### 2.2 Minimum Subordination Ratio

| Parameter   | `minSubordinationBps`                                              |
| ----------- | ------------------------------------------------------------------ |
| **Default** | 2000 (20%)                                                         |
| **Check**   | `juniorNAV / (seniorNAV + juniorNAV) >= minSubordinationBps / BPS` |
| **Trigger** | Junior capital is too thin relative to Senior                      |

**When triggered:**

| Action              | Allowed?                    | Reason                                                                                             |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| New Senior deposits | **BLOCKED**                 | `deposit(Senior)` reverts with `SubordinationTooLow`                                               |
| New loan allocation | Allowed                     | Allocation doesn't change the subordination ratio (both tranches are debited proportionally)       |
| Junior deposits     | Allowed                     | Junior deposits increase subordination and can cure the breach                                     |
| Senior withdrawals  | Allowed                     | Actually improves subordination ratio                                                              |
| Junior withdrawals  | **BLOCKED if would breach** | `withdraw(Junior)` checks post-withdrawal subordination and reverts if it would drop below minimum |

**Note**: This guardrail does NOT block loan allocations because `seniorAllocationBps` ensures both tranches are debited proportionally — the ratio is preserved. However, bad debt events that wipe Junior will breach subordination and block further Senior deposits until Junior is replenished.

### 2.3 Junior NAV Drawdown Cap (Stress Trigger)

| Parameter   | `juniorNavDrawdownCapBps`                                                  |
| ----------- | -------------------------------------------------------------------------- |
| **Default** | 3000 (30%)                                                                 |
| **Check**   | `juniorNAV >= juniorHighWaterMark * (BPS - juniorNavDrawdownCapBps) / BPS` |
| **Trigger** | Junior NAV has fallen more than 30% from its high-water mark               |

**When triggered:**

| Action                   | Allowed?        | Reason                                              |
| ------------------------ | --------------- | --------------------------------------------------- |
| `stressMode` flag        | **SET to true** | Automatic on `recordBadDebt`                        |
| New loan allocation      | **BLOCKED**     | Pool is paused during stress review                 |
| Deposits (both tranches) | Allowed         | LPs may still add capital                           |
| Withdrawal queueing      | Allowed         | Requests are recorded for ordering                  |
| Withdrawal fulfillment   | **FROZEN**      | `fulfillWithdraw` reverts with `StressModeLocked()` |
| Instant withdrawals      | **FROZEN**      | Same gate as fulfillment                            |

**Override**: Only `DEFAULT_ADMIN_ROLE` (multisig) can call `setStressMode(false)` to lift the freeze after governance review.

### 2.4 Guardrail Precedence

```
allocateToLoan(loan, amount)
    │
    ├── Check 1: stressMode == false          → else revert StressModeLocked()
    ├── Check 2: seniorLiquidityFloor passes  → else revert InsufficientTrancheLiquidity(Senior)
    ├── Check 3: pool-level exposure cap      → else revert (existing factory check)
    │
    └── Proceed with allocation
```

All three checks are independent and evaluated in sequence. First failing check determines the revert reason.

---

## 3. Senior Withdrawal Priority Under Stress

### Question

The design document states that Senior withdrawal queues are serviced before Junior when liquidity returns. How exactly does this work when stress mode is active and then lifted?

### Decision

**Senior withdrawal priority is enforced at fulfillment time, not at queue time.** The ordering guarantee is:

> When stress mode is lifted and `fulfillWithdraw` / `fulfillMany` becomes callable again, **all pending Senior requests must be fulfilled before any Junior request can be fulfilled.**

### 3.1 Mechanism

The pool tracks a **global fulfillment gate**:

```solidity
/// @notice When true, Junior fulfillment is blocked until Senior queue is drained.
bool public seniorPriorityActive;
```

This flag is automatically set to `true` when stress mode is activated and remains `true` until the Senior withdrawal queue is fully drained (all Senior `openRequestCount` across all users drops to zero, or governance explicitly clears it).

### 3.2 Fulfillment Rules

| `stressMode` | `seniorPriorityActive` | `fulfillWithdraw(Senior, id)`  |   `fulfillWithdraw(Junior, id)`    |
| :----------: | :--------------------: | :----------------------------: | :--------------------------------: |
|     true     |          true          | **Reverts** (StressModeLocked) |   **Reverts** (StressModeLocked)   |
|    false     |          true          |   **Allowed** (if liquidity)   | **Reverts** (SeniorPriorityActive) |
|    false     |         false          |   **Allowed** (if liquidity)   |     **Allowed** (if liquidity)     |

### 3.3 Lifecycle

```
NORMAL                  STRESS                  RECOVERY                NORMAL
──────────────── ──►  ──────────────── ──►  ──────────────── ──►  ────────────
                      stressMode = true      stressMode = false
                      seniorPriorityActive   seniorPriorityActive
                      = true                 = true (still)

                      All fulfillment        Senior fulfillment       Both tranches
                      blocked.               allowed.                 fulfillable.
                                             Junior blocked.

                                             Auto-clears when
                                             Senior queue empty.
```

### 3.4 Detailed Walkthrough

**Setup**: Pool has $1M Senior, $300K Junior deployed. A major default wipes $250K.

1. `recordBadDebt(loan, 250_000e6)` is called.
2. Junior absorbs $250K (Junior NAV drops from $300K → $50K, an 83% drawdown).
3. `_checkStressTriggers()` sees drawdown > 30% cap → sets `stressMode = true` and `seniorPriorityActive = true`.
4. LPs queue withdrawals but none can be fulfilled.
5. Governance reviews, determines remaining loans are healthy, calls `setStressMode(false)`.
6. A keeper calls `fulfillMany(Senior, seniorRequestIds)`. Senior requests are processed using available liquidity.
7. After all Senior requests are fulfilled (or cancelled), `seniorPriorityActive` is automatically set to `false`.
8. Junior requests can now be fulfilled via `fulfillMany(Junior, juniorRequestIds)`.

### 3.5 Why Not Interleave?

An alternative would be to interleave Senior and Junior fulfillment (e.g., 70/30 matching the allocation ratio). This was rejected because:

- **Capital structure priority must hold in stress** — Senior LPs accepted lower yield in exchange for first-loss protection. This protection extends to exit priority.
- **Simplicity** — A single boolean gate is cheaper and easier to audit than a proportional interleaving mechanism.
- **Junior accepted the risk** — Junior earns uncapped residual yield precisely because they are subordinated in all dimensions: loss absorption, repayment waterfall, and withdrawal priority.

### 3.6 Safeguard Against Permanent Junior Lock

To prevent Junior LPs from being locked out indefinitely:

- **Governance override**: `DEFAULT_ADMIN_ROLE` can call `clearSeniorPriority()` to manually set `seniorPriorityActive = false` if the Senior queue is stuck (e.g., insufficient liquidity for a large Senior request while smaller Junior requests could be filled).
- **Maximum priority duration**: An optional `seniorPriorityMaxDuration` (governance-set, default 30 days). If `seniorPriorityActive` has been true for longer than this duration, it auto-clears on the next `fulfillWithdraw` call.
- **Partial Senior fill**: Senior requests can be partially fulfilled (amount available < full request). This prevents a single large Senior request from blocking the entire queue.

```solidity
// Auto-expiry check in fulfillWithdraw:
if (seniorPriorityActive && block.timestamp > seniorPriorityActivatedAt + seniorPriorityMaxDuration) {
    seniorPriorityActive = false;
    emit SeniorPriorityExpired(block.timestamp);
}
```

---

## Summary of Decisions

| #   | Topic                                   | Decision                                                                                                                                                                                                                             |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Senior accrued interest on default      | **Not recorded as a loss.** Unreceived interest is simply never credited. Senior share price is unaffected. Only principal bad debt (after Junior exhaustion) impacts Senior.                                                        |
| 2   | Allocation guardrail behavior           | **Three independent prospective checks** (liquidity floor, subordination minimum, stress mode) evaluated on `allocateToLoan`. Each blocks allocation independently. Subordination also gates Senior deposits and Junior withdrawals. |
| 3   | Senior withdrawal priority under stress | **Hard priority: all Senior fulfilled before any Junior** after stress is lifted. Enforced via `seniorPriorityActive` boolean. Auto-expires after configurable max duration. Governance override available.                          |
