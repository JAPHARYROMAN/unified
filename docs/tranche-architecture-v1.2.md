# Unified v1.2 — Senior/Junior Tranche Architecture Design

| Field       | Value                          |
| ----------- | ------------------------------ |
| **Status**  | DRAFT                          |
| **Version** | 1.2.0                          |
| **Author**  | Smart Contracts Architect      |
| **Date**    | 2026-02-23                     |
| **Scope**   | Design specification — no code |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Existing Architecture Recap](#3-existing-architecture-recap)
4. [Tranche Model Overview](#4-tranche-model-overview)
5. [State Variables](#5-state-variables)
6. [Accounting Model](#6-accounting-model)
7. [Cashflow Waterfall](#7-cashflow-waterfall)
8. [Loss Absorption](#8-loss-absorption)
9. [Withdrawal Policy](#9-withdrawal-policy)
10. [Breaker / Risk Parameter Impact](#10-breaker--risk-parameter-impact)
11. [Interface Changes](#11-interface-changes)
12. [Migration Strategy](#12-migration-strategy)
13. [Governance Impacts](#13-governance-impacts)
14. [Gas Considerations](#14-gas-considerations)
15. [Security Considerations](#15-security-considerations)
16. [Open Questions](#16-open-questions)
17. [Appendix: Cashflow Diagrams](#17-appendix-cashflow-diagrams)

---

## 1. Executive Summary

This document specifies the design for introducing **two-tier tranching** (Senior / Junior) into the `UnifiedPool` contract family. The feature gives liquidity providers a choice between a lower-risk, capped-yield Senior tranche and a higher-risk, uncapped-yield Junior tranche while maintaining the existing single-pool UX for pools that do not opt in.

The design is **additive**: existing untranched pools continue to operate unchanged. Tranched pools deploy as new `UnifiedPoolTranched` contracts that share the same `IUnifiedPool` interface so the downstream `UnifiedLoan`, `UnifiedLoanFactory`, and `UnifiedFeeManager` contracts require zero modifications.

---

## 2. Goals & Non-Goals

### Goals

| #   | Goal                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| G1  | Optional per-pool two-tranche mode (Senior + Junior).                                                                      |
| G2  | Separate share accounting, NAV, deposit, and withdrawal per tranche.                                                       |
| G3  | Hard-coded repayment waterfall: Fees → Senior principal → Senior interest → Junior principal → Junior interest → Residual. |
| G4  | Loss absorption: Junior absorbs first; Senior absorbs only after Junior is fully wiped.                                    |
| G5  | Withdrawal policy recommendation with configurable options.                                                                |
| G6  | Compatibility with existing `IUnifiedPool` interface (Loan contracts call `onLoanRepayment` / `setLoanRole` unchanged).    |
| G7  | Clear migration path for existing deployments.                                                                             |

### Non-Goals

| #   | Non-Goal                                                         |
| --- | ---------------------------------------------------------------- |
| NG1 | More than two tranches (deferred to v1.3+).                      |
| NG2 | Tokenized (ERC-20/ERC-4626) tranche shares (may be added later). |
| NG3 | Dynamic tranche ratios that auto-rebalance.                      |
| NG4 | Cross-pool senior/junior relationships.                          |

---

## 3. Existing Architecture Recap

The current `UnifiedPool` (v1.0/v1.1) has:

- **Single share class**: `totalShares`, per-address `positions[addr].shares`.
- **NAV formula**: `totalAssetsNAV = usdcBalance + totalPrincipalOutstanding − totalBadDebt`.
- **Deposit**: Mints shares at current NAV price (`convertToShares`).
- **Withdraw**: Burns shares at current NAV price; instant if liquidity available.
- **Queued Withdrawals**: FIFO coalescing queue with `fulfillWithdraw` / `fulfillMany`.
- **Loan lifecycle**: `allocateToLoan` sends USDC → loan calls `onLoanRepayment(principalPaid, interestPaid)` on payback → `recordBadDebt` on default.
- **No breaker / liquidity-ratio logic on-chain** — only collateral-ratio minimums on the factory.

Key interfaces consumed by loans:

```solidity
interface IUnifiedPool {
    function setLoanRole(address loan, bool allowed) external;
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid) external;
}
```

The tranche design must preserve this interface so existing loan clones continue to work.

---

## 4. Tranche Model Overview

```
┌──────────────────────────────────────────────────────┐
│                  UnifiedPoolTranched                  │
│                                                      │
│  ┌────────────────────┐  ┌────────────────────────┐  │
│  │   Senior Tranche   │  │    Junior Tranche      │  │
│  │                    │  │                        │  │
│  │  shares, NAV,      │  │  shares, NAV,          │  │
│  │  targetYieldBps    │  │  uncapped residual     │  │
│  │  loss: last resort │  │  loss: first absorber  │  │
│  └────────────────────┘  └────────────────────────┘  │
│                                                      │
│           Shared USDC balance (single ERC-20)        │
│           Shared loan allocation ledger              │
└──────────────────────────────────────────────────────┘
```

### Design Decisions

| Decision                      | Rationale                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single USDC balance**       | Loan contracts transfer USDC to/from a single pool address. Splitting balances into two sub-vaults would break `IUnifiedPool`.                                      |
| **Virtual sub-accounting**    | Senior and Junior each track their own `shares`, `principalAllocated`, `interestEarned`, `badDebt` via storage structs. Actual USDC stays in one `address(this)`.   |
| **New contract, not upgrade** | `UnifiedPool` is not upgradeable (no proxy). A new `UnifiedPoolTranched` contract is deployed for tranched pools. Untranched pools remain on the existing contract. |
| **Tranche enum**              | `enum Tranche { Senior, Junior }` — extensible to `Mezzanine` later.                                                                                                |

---

## 5. State Variables

### 5.1 Tranche Struct

```solidity
struct TrancheState {
    // ── Share accounting ──
    uint256 totalShares;
    uint256 virtualBalance;            // tracked USDC attributable to this tranche
    uint256 principalAllocated;        // tranche's portion of capital deployed to loans
    uint256 principalRepaid;           // principal returned to this tranche
    uint256 interestEarned;            // net interest credited to this tranche (cash-basis only)
    uint256 badDebt;                   // write-offs absorbed by this tranche

    // ── Policy ──
    uint256 targetYieldBps;            // Senior only: max annualized yield (0 = uncapped)
    uint256 depositCap;                // max total deposits (0 = unlimited)

    // ── Withdrawal queue ──
    WithdrawRequest[] withdrawRequests;
    mapping(address => uint256) pendingShares;
    mapping(address => uint256) openRequestCount;
    mapping(address => uint256) lastOpenRequestIndex;
}
```

> **Clarification (interest accounting):** `interestEarned` is updated only
> when cash arrives via `onLoanRepayment`. Accrued-but-unpaid interest on the
> loan contract is **never** reflected in tranche NAV. If a loan defaults,
> unreceived interest is simply not credited — it is not recorded as a loss.
> See [tranche-design-clarifications.md §1](tranche-design-clarifications.md) for full rationale.

### 5.2 Position Struct (per-user, per-tranche)

```solidity
struct TranchePosition {
    uint256 shares;
    uint256 cumulativeDeposited;
    uint256 cumulativeWithdrawn;
}
```

### 5.3 Contract-Level State

```solidity
contract UnifiedPoolTranched is AccessControl, Pausable, ReentrancyGuard {

    enum Tranche { Senior, Junior }

    IERC20  public immutable usdc;
    bytes32 public immutable partnerId;

    // ── Tranche state (indexed by Tranche enum ordinal) ──
    TrancheState[2] internal tranches;

    // ── Per-user positions: user → tranche → position ──
    mapping(address => mapping(Tranche => TranchePosition)) public positions;

    // ── Global loan ledger (unchanged from v1) ──
    uint256 public totalPrincipalAllocated;
    uint256 public totalPrincipalRepaidToPool;
    uint256 public totalInterestRepaidToPool;
    uint256 public totalBadDebt;
    mapping(address => uint256) public principalOutstandingByLoan;

    // ── Tranche allocation ratio ──
    /// Percentage of each new loan allocation charged to Senior (bps).
    /// Remainder goes to Junior. E.g. 7000 = 70% Senior, 30% Junior.
    uint256 public seniorAllocationBps;

    // ── Stress / Breaker state ──
    bool public stressMode;                   // true = withdrawals locked
    uint256 public seniorLiquidityFloorBps;   // min liquidity ratio for Senior
    uint256 public juniorNavDrawdownCapBps;   // max NAV loss before stress mode
    uint256 public seniorNavDrawdownCapBps;   // max Senior NAV loss before emergency pause
    uint256 public juniorHighWaterMark;       // peak cumulative Junior deposits (for drawdown calc)

    // ── Senior withdrawal priority (post-stress recovery) ──
    bool public seniorPriorityActive;         // true = Junior fulfillment blocked
    uint256 public seniorPriorityActivatedAt; // timestamp when priority was activated
    uint256 public seniorPriorityMaxDuration; // max seconds priority can persist (default 30 days)

    // ... roles, events (see §11)
}
```

### 5.4 Storage Layout Size Estimate

| Slot Group                    | Count       | Notes                                           |
| ----------------------------- | ----------- | ----------------------------------------------- |
| Immutables                    | 2           | `usdc`, `partnerId` (not in storage)            |
| `tranches[2]` fixed fields    | ~16         | 8 uint256 × 2 tranches (incl. `virtualBalance`) |
| `tranches[2]` mappings/arrays | 8 map roots | 4 mappings × 2 tranches                         |
| Global loan ledger            | ~5          | Same as v1                                      |
| Policy scalars                | ~4          | Allocation bps, stress flag, thresholds         |
| Senior priority state         | ~3          | `seniorPriorityActive`, timestamp, duration     |
| High-water mark               | ~1          | `juniorHighWaterMark`                           |
| **Total warm slots per tx**   | **~10–14**  | Depends on operation                            |

---

## 6. Accounting Model

### 6.1 NAV Per Tranche

Each tranche maintains its own net asset value:

```
trancheNAV[t] = trancheUsdcBalance[t]
              + tranchePrincipalOutstanding[t]
              − trancheBadDebt[t]
```

Because USDC is held in a single balance, `trancheUsdcBalance` is a **virtual** quantity:

```
trancheUsdcBalance[t] = tranchePrincipalRepaid[t]
                       + trancheInterestEarned[t]
                       + trancheDeposits[t]           // cumulative deposits
                       − tranchePrincipalAllocated[t]  // sent to loans
                       − trancheWithdrawn[t]           // cumulative withdrawals
```

Alternatively (simpler bookkeeping):

```
trancheUsdcBalance[t] = (total pool USDC) × trancheShareOfLiquidity[t]
```

**Recommended approach**: Track a `virtualBalance` uint256 per tranche, updated on every deposit, withdrawal, repayment waterfall, and loss event. This avoids rounding drift from ratio-based splits.

### 6.2 Share Price

```
sharePrice[t] = trancheNAV[t] * 1e18 / tranches[t].totalShares
```

Falls back to `1e18` when `totalShares == 0` (bootstrap).

### 6.3 Deposit

```solidity
function deposit(Tranche t, uint256 amount) external {
    // ── Guardrails (see §10 and clarifications §2) ──
    if (t == Tranche.Senior) {
        // Junior must exist before Senior can deposit
        if (trancheNAV(Tranche.Junior) == 0) revert SubordinationTooLow(0, minSubordinationBps);
        // Post-deposit subordination must stay above minimum
        uint256 newSrNAV = trancheNAV(Tranche.Senior) + amount;
        uint256 jrNAV    = trancheNAV(Tranche.Junior);
        if (jrNAV * BPS < (newSrNAV + jrNAV) * minSubordinationBps) {
            revert SubordinationTooLow(jrNAV * BPS / (newSrNAV + jrNAV), minSubordinationBps);
        }
    }

    uint256 sharesToMint = convertToShares(t, amount);
    usdc.safeTransferFrom(msg.sender, address(this), amount);

    tranches[t].totalShares += sharesToMint;
    tranches[t].virtualBalance += amount;
    positions[msg.sender][t].shares += sharesToMint;
    positions[msg.sender][t].cumulativeDeposited += amount;

    // Update high-water mark for drawdown calculation
    if (t == Tranche.Junior && tranches[1].virtualBalance > juniorHighWaterMark) {
        juniorHighWaterMark = tranches[1].virtualBalance;
    }
}
```

Deposits are **tranche-specific**. A depositor must choose Senior or Junior.
Senior deposits are blocked when `subordinationRatio < minSubordinationBps` or
when `juniorNAV == 0` (see [clarifications §2.2](tranche-design-clarifications.md)).

### 6.4 Withdrawal

```solidity
function withdraw(Tranche t, uint256 shareAmount) external {
    uint256 assetsOut = convertToAssets(t, shareAmount);
    require(assetsOut <= trancheAvailableLiquidity(t));

    // ── Guardrail: Junior withdrawal must not breach subordination ──
    if (t == Tranche.Junior) {
        uint256 srNAV       = trancheNAV(Tranche.Senior);
        uint256 newJrNAV    = trancheNAV(Tranche.Junior) - assetsOut;
        uint256 totalNAV    = srNAV + newJrNAV;
        if (totalNAV > 0 && newJrNAV * BPS < totalNAV * minSubordinationBps) {
            revert SubordinationTooLow(newJrNAV * BPS / totalNAV, minSubordinationBps);
        }
    }

    tranches[t].totalShares -= shareAmount;
    tranches[t].virtualBalance -= assetsOut;
    positions[msg.sender][t].shares -= shareAmount;
    positions[msg.sender][t].cumulativeWithdrawn += assetsOut;

    usdc.safeTransfer(msg.sender, assetsOut);
}
```

Junior withdrawals that would push the subordination ratio below
`minSubordinationBps` are rejected (see [clarifications §2.2](tranche-design-clarifications.md)).

### 6.5 Loan Allocation Split

When `allocateToLoan` is called with `amount`:

```
seniorPortion = amount * seniorAllocationBps / 10_000
juniorPortion = amount - seniorPortion
```

Both portions debit from the respective tranche's `virtualBalance` and credit `principalAllocated`.

### 6.6 Worked Example

| Event                                                | Senior NAV      | Junior NAV      | Pool USDC |
| ---------------------------------------------------- | --------------- | --------------- | --------- |
| Senior deposits 700 USDC                             | 700             | 0               | 700       |
| Junior deposits 300 USDC                             | 700             | 300             | 1,000     |
| Allocate 1,000 to loan (70/30)                       | 700             | 300             | 0         |
| Loan repays 100 principal + 20 interest (after fees) | 770 + waterfall | 300 + waterfall | 120       |
| _(waterfall distributes interest — see §7)_          |                 |                 |           |

---

## 7. Cashflow Waterfall

### 7.1 Repayment Distribution (Hard-Coded Order)

When `onLoanRepayment(principalPaid, interestPaid)` is called:

```
┌─────────────────────────────────────────────────────────┐
│           Incoming: principalPaid + interestPaid         │
│                                                         │
│  Step 1 │ Fees                                          │
│         │ (Already deducted by loan before callback.    │
│         │  interestPaid is NET of fees.)                │
│                                                         │
│  Step 2 │ Senior principal                              │
│         │ Credit min(principalPaid, seniorOutstanding)   │
│         │ to Senior tranche.                            │
│                                                         │
│  Step 3 │ Senior interest (up to target yield)          │
│         │ Credit min(interestPaid, seniorInterestDue)   │
│         │ where seniorInterestDue is calculated from    │
│         │ seniorPrincipalOutstanding × targetYieldBps   │
│         │ × elapsed time.                               │
│                                                         │
│  Step 4 │ Junior principal                              │
│         │ Credit min(remainingPrincipal,                │
│         │            juniorOutstanding) to Junior.       │
│                                                         │
│  Step 5 │ Junior interest                               │
│         │ Credit remaining interest to Junior.           │
│                                                         │
│  Step 6 │ Residual to Junior                            │
│         │ Any surplus (excess interest beyond Senior    │
│         │ cap) flows to Junior.                          │
│         │ This is the Junior's risk premium.            │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Implementation Pseudocode

```solidity
function _distributeRepayment(uint256 principalPaid, uint256 interestPaid) internal {
    // NOTE: fees already deducted by UnifiedLoan before calling onLoanRepayment.

    TrancheState storage sr = tranches[uint256(Tranche.Senior)];
    TrancheState storage jr = tranches[uint256(Tranche.Junior)];

    uint256 remainingPrincipal = principalPaid;
    uint256 remainingInterest  = interestPaid;

    // ── Step 2: Senior principal ──
    uint256 srPrincipalOutstanding = sr.principalAllocated - sr.principalRepaid;
    uint256 srPrincipalCredit = _min(remainingPrincipal, srPrincipalOutstanding);
    sr.principalRepaid   += srPrincipalCredit;
    sr.virtualBalance    += srPrincipalCredit;
    remainingPrincipal   -= srPrincipalCredit;

    // ── Step 3: Senior interest (capped at target yield) ──
    uint256 srInterestDue = _seniorAccruedInterestDue();
    uint256 srInterestCredit = _min(remainingInterest, srInterestDue - sr.interestEarned);
    sr.interestEarned    += srInterestCredit;
    sr.virtualBalance    += srInterestCredit;
    remainingInterest    -= srInterestCredit;

    // ── Step 4: Junior principal ──
    uint256 jrPrincipalOutstanding = jr.principalAllocated - jr.principalRepaid;
    uint256 jrPrincipalCredit = _min(remainingPrincipal, jrPrincipalOutstanding);
    jr.principalRepaid   += jrPrincipalCredit;
    jr.virtualBalance    += jrPrincipalCredit;
    remainingPrincipal   -= jrPrincipalCredit;

    // ── Steps 5 & 6: Junior interest + residual ──
    jr.interestEarned    += remainingInterest;
    jr.virtualBalance    += remainingInterest;

    // Any leftover principal (should be 0 in normal operation) also to Junior.
    if (remainingPrincipal > 0) {
        jr.virtualBalance += remainingPrincipal;
    }
}
```

### 7.3 Senior Target Yield Calculation

```
seniorInterestDue = seniorPrincipalOutstanding × targetYieldBps / BPS_DENOMINATOR
                    × elapsedSeconds / SECONDS_PER_YEAR
```

This is tracked cumulatively. Only the delta between `seniorInterestDue` and `sr.interestEarned` is creditable per repayment event.

---

## 8. Loss Absorption

### 8.1 Bad Debt Waterfall

When `recordBadDebt(loan, amount)` is called:

```
┌──────────────────────────────────────────────────┐
│  Loss amount = writeOff                          │
│                                                  │
│  Step 1 │ Absorb from Junior                     │
│         │ jrAbsorb = min(writeOff, jrNAV)        │
│         │ jr.badDebt      += jrAbsorb            │
│         │ jr.virtualBalance -= jrAbsorb          │
│                                                  │
│  Step 2 │ If Junior exhausted, Senior absorbs    │
│         │ srAbsorb = writeOff - jrAbsorb          │
│         │ sr.badDebt      += srAbsorb            │
│         │ sr.virtualBalance -= srAbsorb          │
└──────────────────────────────────────────────────┘
```

### 8.2 Proportional vs Absolute Loss Attribution

Because the pool allocates principal to loans in a fixed Senior/Junior ratio (`seniorAllocationBps`), each loan's outstanding is implicitly split. On default:

1. Compute the loan's Senior portion: `loanSeniorOutstanding = principalOutstandingByLoan[loan] × seniorAllocationBps / 10_000`.
2. Compute Junior portion: `loanJuniorOutstanding = principalOutstandingByLoan[loan] − loanSeniorOutstanding`.
3. Apply writeOff to Junior first (up to `loanJuniorOutstanding`), then Senior.

This ensures attribution is per-loan accurate, not just pool-wide.

### 8.3 Subordination Ratio

The **effective subordination** for Senior is:

```
subordinationRatio = juniorNAV / (seniorNAV + juniorNAV)
```

Governance should set a **minimum subordination ratio** (e.g., 20%). If it falls below the threshold, new Senior deposits are paused until Junior capital is replenished.

### 8.4 Senior Accrued Interest on Default

**Decision:** Accrued-but-unreceived Senior interest is **not** recorded as a loss. It is simply never credited.

| Scenario                             | Treatment                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Loan repays normally                 | Senior receives interest up to `targetYieldBps` cap via waterfall Step 3. `sr.interestEarned` and `sr.virtualBalance` increase. |
| Loan defaults before any repayment   | Senior receives zero interest for that loan. No bad-debt entry for interest — only for principal.                               |
| Loan partially repays, then defaults | Senior keeps previously credited interest. Remaining uncredited interest is forgone, not written off.                           |

Rationale:

1. **Consistency with v1** — `totalAssetsNAV` never includes unrealised interest. Phantom interest would inflate NAV between repayments and create artificial drawdowns on default.
2. **No on-chain accrual clock per tranche** — Loan-level `interestAccrued` lives on `UnifiedLoan`. The pool has no independent time-based accumulator per tranche. Adding one would require a keeper or accrue-on-read pattern with gas overhead on every view call.
3. **Senior yield is a cap, not a guarantee** — `targetYieldBps` is a maximum, not a floor. Insufficient cash flow simply means the Senior tranche earns less.

Impact on Senior share price: unreceived interest was never added to `sr.virtualBalance`, so share price is never inflated and never needs marking down for forgone interest. The only Senior share price decline occurs when principal bad debt exceeds Junior's absorptive capacity (INV-4).

> See [tranche-design-clarifications.md §1](tranche-design-clarifications.md) for the full rationale.

### 8.5 Recovery Waterfall (Post-Default Collateral Liquidation)

When collateral is seized after default (via `claimLoanCollateral`) and converted to USDC, the recovered amount is distributed through a **recovery waterfall** that mirrors the repayment waterfall:

```
Recovery waterfall:
  1. Senior principal shortfall  (up to sr.badDebt attributed to that loan)
  2. Junior principal shortfall  (up to jr.badDebt attributed to that loan)
  3. Residual → Junior
```

Recovery reduces `badDebt` and increases `virtualBalance` for the receiving tranche. Interest recovery is not applicable because the loan is in `DEFAULTED` status and `interestAccrued` is frozen.

---

## 9. Withdrawal Policy

### 9.1 Options Evaluated

| Option                         | Pros                                      | Cons                                            |
| ------------------------------ | ----------------------------------------- | ----------------------------------------------- |
| **FIFO per tranche**           | Simple, deterministic, fair ordering      | Head-of-line blocking if large request at front |
| **Pro-rata per tranche**       | Even distribution, no blocking            | More complex, higher gas for partial fills      |
| **Hybrid: FIFO + stress lock** | FIFO in normal mode, locked during stress | Best balance of simplicity and safety           |

### 9.2 Recommendation: FIFO per Tranche with Stress Lock

**Normal operation**: Each tranche maintains its own FIFO withdrawal queue (mirrors the existing `withdrawRequests` pattern from `UnifiedPool` v1). Requests are fulfilled in order within each tranche.

**Stress mode**: When triggered (see §10), all withdrawal requests are **frozen** for both tranches. A governance-controlled `stressMode` boolean gates `fulfillWithdraw`. Requests can still be queued (to preserve ordering) but not fulfilled until stress is lifted.

**Additional constraints**:

- **Senior priority on fulfillment**: When liquidity returns (e.g., loan repayment), Senior withdrawal queue is serviced before Junior. This matches the capital structure priority. Enforced via the `seniorPriorityActive` gate (see §9.5).
- **Minimum hold period**: Optional per-tranche `minHoldSeconds` to prevent flash-deposit/withdraw arbitrage on NAV movements.

### 9.3 Withdrawal Queue State Per Tranche

```solidity
// Already contained in TrancheState struct (§5.1):
WithdrawRequest[] withdrawRequests;
mapping(address => uint256) pendingShares;
mapping(address => uint256) openRequestCount;
mapping(address => uint256) lastOpenRequestIndex;
```

### 9.4 Instant vs Queued Withdrawal Availability

| Scenario                                  | Senior                             | Junior                             |
| ----------------------------------------- | ---------------------------------- | ---------------------------------- |
| Sufficient tranche liquidity, no stress   | Instant                            | Instant                            |
| Insufficient tranche liquidity, no stress | Queue (FIFO)                       | Queue (FIFO)                       |
| Stress mode active                        | Queue only (frozen)                | Queue only (frozen)                |
| Recovery (stress lifted, priority active) | Fulfilled first                    | Blocked until Senior queue drained |
| Pool paused                               | Queue only (allowed for safe exit) | Queue only                         |

### 9.5 Senior Withdrawal Priority Mechanism

Senior priority is enforced at **fulfillment time**, not queue time.

**State variables** (see §5.3):

- `seniorPriorityActive` — boolean gate, set `true` when stress mode activates.
- `seniorPriorityActivatedAt` — timestamp of activation.
- `seniorPriorityMaxDuration` — governance-set max duration (default 30 days).

**Fulfillment rules:**

| `stressMode` | `seniorPriorityActive` | `fulfillWithdraw(Senior, id)` |  `fulfillWithdraw(Junior, id)`   |
| :----------: | :--------------------: | :---------------------------: | :------------------------------: |
|     true     |          true          | Reverts (`StressModeLocked`)  |   Reverts (`StressModeLocked`)   |
|    false     |          true          | Allowed (if liquidity exists) | Reverts (`SeniorPriorityActive`) |
|    false     |         false          | Allowed (if liquidity exists) |  Allowed (if liquidity exists)   |

**Lifecycle:**

```
NORMAL ──► STRESS ──► RECOVERY ──► NORMAL
                      stressMode = false
                      seniorPriorityActive = true (still)

                      Senior fulfillment allowed.
                      Junior fulfillment blocked.

                      Auto-clears when Senior queue
                      empty OR maxDuration elapsed.
```

**Safeguards against permanent Junior lock:**

1. **Governance override**: `DEFAULT_ADMIN_ROLE` can call `clearSeniorPriority()` to manually clear the gate.
2. **Auto-expiry**: If `seniorPriorityActive` has been true for longer than `seniorPriorityMaxDuration`, it auto-clears on the next `fulfillWithdraw` call.
3. **Partial Senior fill**: Senior requests can be partially fulfilled so a single large request cannot block the entire queue.

```solidity
// Auto-expiry check inside fulfillWithdraw:
if (seniorPriorityActive
    && block.timestamp > seniorPriorityActivatedAt + seniorPriorityMaxDuration) {
    seniorPriorityActive = false;
    emit SeniorPriorityExpired(block.timestamp);
}
```

> See [tranche-design-clarifications.md §3](tranche-design-clarifications.md) for the full walkthrough.

---

## 10. Breaker / Risk Parameter Impact

### 10.1 Liquidity Ratio Per Tranche

Define per-tranche liquidity ratio:

```
liquidityRatio[t] = trancheAvailableLiquidity[t] / trancheNAV[t]
```

**Senior liquidity floor** (`seniorLiquidityFloorBps`): If `liquidityRatio[Senior]` would drop below this threshold **after** an allocation, the allocation reverts. The check is **prospective** — it prevents the pool from entering the breached state, rather than reacting after the fact.

```solidity
// Prospective check inside allocateToLoan:
uint256 srPortionOut = amount * seniorAllocationBps / BPS;
uint256 srBalanceAfter = sr.virtualBalance - srPortionOut;
uint256 srNAV = trancheNAV(Tranche.Senior);
if (srNAV > 0 && srBalanceAfter * BPS < srNAV * seniorLiquidityFloorBps) {
    revert InsufficientTrancheLiquidity(Tranche.Senior);
}
```

**Junior has no floor** (risk-seeking capital), but governance can optionally set one.

**Behavior when Senior liquidity floor is breached:**

| Action                        | Allowed?               | Reason                               |
| ----------------------------- | ---------------------- | ------------------------------------ |
| New loan allocation           | **BLOCKED**            | `allocateToLoan` reverts             |
| Senior deposits               | Allowed                | Increases liquidity, can cure breach |
| Senior withdrawals            | Allowed (if liquidity) | Does not affect allocation gate      |
| Junior deposits / withdrawals | Allowed                | No effect on Senior floor            |
| Loan repayments               | Allowed                | May cure breach via waterfall        |

### 10.2 NAV Drawdown Thresholds

| Metric                                          | Threshold      | Action                             |
| ----------------------------------------------- | -------------- | ---------------------------------- |
| Junior NAV drawdown > `juniorNavDrawdownCapBps` | e.g., 30% loss | Enter stress mode                  |
| Senior NAV drawdown > `seniorNavDrawdownCapBps` | e.g., 5% loss  | Emergency pause + governance alert |
| Subordination ratio < `minSubordinationBps`     | e.g., < 15%    | Block new Senior deposits          |

### 10.3 Exposure Cap Impact

Existing exposure caps on `UnifiedLoanFactory` are **pool-wide**. With tranching:

- **Pool-level exposure cap**: Unchanged. Total pool exposure (Senior + Junior) is capped.
- **Tranche-level exposure cap**: New optional parameter. Limits how much of a single tranche's capital can be allocated to a single borrower.
- **Concentration limit**: `maxSingleLoanBps[t]` — max percentage of tranche NAV deployable to one loan.

### 10.4 Stress Mode Trigger Conditions

```solidity
function _checkStressTriggers() internal {
    uint256 jrNAV = trancheNAV(Tranche.Junior);

    // Junior NAV drawdown check (against high-water mark)
    if (juniorHighWaterMark > 0
        && jrNAV < juniorHighWaterMark * (BPS - juniorNavDrawdownCapBps) / BPS) {
        stressMode = true;
        seniorPriorityActive = true;
        seniorPriorityActivatedAt = block.timestamp;
        emit StressModeActivated(block.timestamp);
    }
}
```

Stress mode is **exited manually** by governance (`DEFAULT_ADMIN_ROLE`) after review.

### 10.5 Guardrail Precedence on `allocateToLoan`

All guardrails are independent and evaluated in sequence. The first failing check determines the revert reason.

```
allocateToLoan(loan, amount)
    │
    ├── Check 1: stressMode == false           → else revert StressModeLocked()
    ├── Check 2: seniorLiquidityFloor passes   → else revert InsufficientTrancheLiquidity(Senior)
    ├── Check 3: pool-level exposure cap       → else revert (existing factory check)
    │
    └── Proceed with allocation
```

> See [tranche-design-clarifications.md §2](tranche-design-clarifications.md) for the full guardrail behavior matrix.

---

## 11. Interface Changes

### 11.1 IUnifiedPool (Unchanged)

```solidity
// Loan contracts continue calling the same interface.
// UnifiedPoolTranched implements it identically.
interface IUnifiedPool {
    function setLoanRole(address loan, bool allowed) external;
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid) external;
}
```

The internal implementation of `onLoanRepayment` now calls `_distributeRepayment` to split cash across tranches.

### 11.2 New External Functions

```solidity
// ── Deposits / Withdrawals (tranche-specific) ──
function deposit(Tranche tranche, uint256 amount) external;
function withdraw(Tranche tranche, uint256 shareAmount) external;
function requestWithdraw(Tranche tranche, uint256 shareAmount) external returns (uint256);
function cancelWithdraw(Tranche tranche, uint256 requestId) external;
function fulfillWithdraw(Tranche tranche, uint256 requestId) external;
function fulfillMany(Tranche tranche, uint256[] calldata requestIds) external;

// ── Views ──
function trancheNAV(Tranche tranche) external view returns (uint256);
function trancheSharePrice(Tranche tranche) external view returns (uint256);
function trancheAvailableLiquidity(Tranche tranche) external view returns (uint256);
function trancheTotalShares(Tranche tranche) external view returns (uint256);
function convertToShares(Tranche tranche, uint256 assets) external view returns (uint256);
function convertToAssets(Tranche tranche, uint256 shares) external view returns (uint256);
function subordinationRatio() external view returns (uint256);

// ── Admin ──
function setSeniorAllocationBps(uint256 bps) external;    // timelocked
function setSeniorTargetYield(uint256 bps) external;       // timelocked
function setStressMode(bool active) external;               // admin only
function setTrancheLiquidityFloor(Tranche t, uint256 bps) external;
function setTrancheDepositCap(Tranche t, uint256 cap) external;
function clearSeniorPriority() external;                    // admin override for Junior unlock
function setSeniorPriorityMaxDuration(uint256 secs) external; // timelocked
function onCollateralRecovery(address loan, uint256 amount) external; // recovery waterfall
```

### 11.3 New Events

```solidity
event TranchDeposited(Tranche indexed tranche, address indexed user, uint256 amount, uint256 shares);
event TrancheWithdrawn(Tranche indexed tranche, address indexed user, uint256 amount, uint256 shares);
event WaterfallDistributed(
    address indexed loan,
    uint256 seniorPrincipal, uint256 seniorInterest,
    uint256 juniorPrincipal, uint256 juniorInterest
);
event LossAbsorbed(Tranche indexed tranche, address indexed loan, uint256 amount);
event StressModeActivated(uint256 timestamp);
event StressModeDeactivated(uint256 timestamp);
event SubordinationBreach(uint256 currentRatio, uint256 minimumRequired);
event SeniorPriorityActivated(uint256 timestamp);
event SeniorPriorityCleared(uint256 timestamp);
event SeniorPriorityExpired(uint256 timestamp);
event CollateralRecoveryDistributed(
    address indexed loan,
    uint256 seniorRecovery, uint256 juniorRecovery, uint256 residual
);
```

### 11.4 New Errors

```solidity
error TrancheDepositCapExceeded(Tranche tranche, uint256 current, uint256 cap);
error InsufficientTrancheLiquidity(Tranche tranche);
error StressModeLocked();
error SeniorPriorityActive();
error SubordinationTooLow(uint256 ratio, uint256 minimum);
error InvalidTranche();
error MinHoldPeriodNotElapsed(Tranche tranche, uint256 remaining);
```

---

## 12. Migration Strategy

### 12.1 Can Existing Pools Upgrade?

**No.** The current `UnifiedPool` is a non-upgradeable concrete contract (no proxy pattern). Its storage layout is incompatible with the tranche struct array. An in-place upgrade is not possible.

### 12.2 Recommended Migration Path

```
┌──────────────────────────────────────────────────┐
│  Phase 1: Deploy alongside                       │
│                                                  │
│  • Deploy UnifiedPoolTranched as a new contract  │
│  • Register it in UnifiedLoanFactory (isPool)    │
│  • Existing UnifiedPool remains operational      │
│  • New POOL-model loans can target either pool   │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  Phase 2: Gradual liquidity migration            │
│                                                  │
│  • LPs withdraw from old pool (instant or queue) │
│  • LPs deposit into tranched pool (Senior/Junior)│
│  • No forced migration — voluntary only          │
│  • Old pool winds down as loans repay            │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│  Phase 3: Sunset old pool (optional)             │
│                                                  │
│  • Once all loans repaid, old pool NAV → 0       │
│  • Pause old pool deposits via governance        │
│  • Remove from factory whitelist                 │
└──────────────────────────────────────────────────┘
```

### 12.3 Factory Changes

The `UnifiedLoanFactory` already has `isPool` mapping and `isPool` checks. The tranched pool registers in the same way. The factory needs **no contract changes** — only an `isPool[tranchedPoolAddr] = true` admin call.

### 12.4 LP Migration Helper (Optional)

An off-chain or peripheral contract could offer a one-click "migrate" that:

1. Calls `withdraw` on old pool.
2. Calls `deposit(Tranche, amount)` on new tranched pool.
3. Atomic via a router contract to avoid front-running.

---

## 13. Governance Impacts

### 13.1 New Governed Parameters

| Parameter                   | Type    | Timelock         | Default       |
| --------------------------- | ------- | ---------------- | ------------- |
| `seniorAllocationBps`       | uint256 | 24h              | 7000 (70%)    |
| `seniorTargetYieldBps`      | uint256 | 24h              | 800 (8% APY)  |
| `seniorLiquidityFloorBps`   | uint256 | 24h              | 1000 (10%)    |
| `juniorNavDrawdownCapBps`   | uint256 | 24h              | 3000 (30%)    |
| `seniorNavDrawdownCapBps`   | uint256 | 24h              | 500 (5%)      |
| `minSubordinationBps`       | uint256 | 24h              | 2000 (20%)    |
| `trancheDepositCap[Senior]` | uint256 | none             | 0 (unlimited) |
| `trancheDepositCap[Junior]` | uint256 | none             | 0 (unlimited) |
| `stressMode`                | bool    | none (emergency) | false         |
| `minHoldSeconds[Senior]`    | uint256 | 24h              | 0             |
| `minHoldSeconds[Junior]`    | uint256 | 24h              | 0             |
| `seniorPriorityMaxDuration` | uint256 | 24h              | 30 days       |

### 13.2 Timelock Scope

Parameters affecting yield distribution (`seniorAllocationBps`, `seniorTargetYieldBps`) and risk thresholds must go through the existing 24-hour timelock pattern from `UnifiedFeeManager`. The `stressMode` toggle is exempt (emergency action).

### 13.3 Multisig Recommendation

Tranche parameter changes should require the same multisig threshold as fee changes. The existing `DEFAULT_ADMIN_ROLE` pattern applies.

---

## 14. Gas Considerations

### 14.1 Deposit / Withdraw

| Operation            | v1 Gas (est.) | v1.2 Tranched (est.) | Delta                               |
| -------------------- | ------------- | -------------------- | ----------------------------------- |
| `deposit`            | ~65k          | ~70k                 | +5k (tranche lookup + extra SSTORE) |
| `withdraw` (instant) | ~70k          | ~78k                 | +8k                                 |
| `requestWithdraw`    | ~75k          | ~80k                 | +5k                                 |
| `fulfillWithdraw`    | ~85k          | ~93k                 | +8k                                 |

### 14.2 Repayment Waterfall

The `onLoanRepayment` callback now performs the waterfall distribution:

| Operation         | v1 Gas (est.) | v1.2 Tranched (est.) | Delta                                         |
| ----------------- | ------------- | -------------------- | --------------------------------------------- |
| `onLoanRepayment` | ~45k          | ~85k                 | +40k (6 extra SSTOREs for tranche accounting) |

**Mitigation**: The waterfall is simple arithmetic with no loops. The 40k increase is acceptable for a function called once per loan repayment (not per-block).

### 14.3 Bad Debt Recording

| Operation       | v1 Gas (est.) | v1.2 Tranched (est.) | Delta                                         |
| --------------- | ------------- | -------------------- | --------------------------------------------- |
| `recordBadDebt` | ~35k          | ~55k                 | +20k (Junior-first absorption + stress check) |

### 14.4 Storage Optimization Notes

- `TrancheState` is a fixed-size struct indexed by `Tranche` enum (0 or 1). No dynamic array iteration needed.
- `virtualBalance` avoids re-deriving tranche USDC share on every view call.
- Packing: `targetYieldBps` and `depositCap` could be packed into a single slot if both ≤ uint128.

---

## 15. Security Considerations

### 15.1 Invariants

The following invariants must hold at all times:

```
INV-1: tranches[0].virtualBalance + tranches[1].virtualBalance
       == usdc.balanceOf(address(this))

       (Virtual balances must reconcile to actual USDC held.)

INV-2: tranches[t].principalAllocated − tranches[t].principalRepaid
       >= 0

       (No tranche can have negative outstanding principal.)

INV-3: tranches[0].badDebt + tranches[1].badDebt == totalBadDebt

       (Loss attribution is exhaustive.)

INV-4: For any loss event, tranches[1].badDebt increases first.
       tranches[0].badDebt only increases after
       trancheNAV(Junior) == 0.

       (Subordination guarantee.)

INV-5: sum(positions[*][t].shares) == tranches[t].totalShares

       (Share supply integrity per tranche.)

INV-6: On any recordBadDebt call, only principal is written off.
       tranches[t].interestEarned is NEVER decremented by a loss event.

       (Unreceived interest is forgone, not a loss. See §8.4.)
```

### 15.2 Attack Vectors

| Vector                          | Mitigation                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flash-loan NAV manipulation** | `minHoldSeconds` prevents deposit→withdraw in same block. Shares minted before transfer (`convertToShares` snapshot).                               |
| **Senior yield siphoning**      | `targetYieldBps` is hard-capped; excess always flows to Junior.                                                                                     |
| **Withdrawal race on bad debt** | Stress mode freezes fulfillment. `_checkStressTriggers` called on every `recordBadDebt`.                                                            |
| **Subordination dilution**      | `deposit(Senior)` reverts if `subordinationRatio < minSubordinationBps`.                                                                            |
| **Rounding exploits**           | Round shares down on deposit, round assets down on withdrawal (favor the pool). First-depositor attack mitigated by initial share bootstrap at 1:1. |
| **Storage griefing**            | `MAX_OPEN_REQUESTS` cap per user per tranche (existing pattern).                                                                                    |

### 15.3 Audit Scope Recommendation

The following are high-priority audit items:

1. Waterfall distribution correctness (property-based testing).
2. Virtual balance reconciliation (fuzz `INV-1` across all state transitions).
3. Loss absorption ordering (fuzz `INV-4`).
4. Share price manipulation via donation attacks.
5. Reentrancy on `onLoanRepayment` → waterfall → stress mode toggle path.

---

## 16. Open Questions

| #    | Question                                                                         | Resolution                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | Should `seniorAllocationBps` be per-loan or pool-wide?                           | **Resolved: Pool-wide** (simpler). Per-loan adds governance overhead. See [clarifications §2](tranche-design-clarifications.md).                                         |
| OQ-2 | Should Senior target yield be updated retroactively?                             | **Resolved: No.** Yield cap applies from the point of change forward. Historical earnings are locked.                                                                    |
| OQ-3 | Should the Junior tranche have a minimum deposit to bootstrap subordination?     | **Resolved: Yes.** `juniorNAV > 0` required before Senior deposits accepted. Enforced in `deposit(Senior)`. See [clarifications §2.2](tranche-design-clarifications.md). |
| OQ-4 | Should interest accrual for Senior be time-based or event-based?                 | **Resolved: Event-based** (computed on each `onLoanRepayment`). Unreceived interest is never credited. See [clarifications §1](tranche-design-clarifications.md).        |
| OQ-5 | Should we emit ERC-4626-compatible events for future vault wrapping?             | Deferred to v1.3. The internal accounting can be wrapped later.                                                                                                          |
| OQ-6 | Should the tranched pool support `DIRECT` and `CROWDFUND` models or only `POOL`? | `POOL` only (same as v1 `UnifiedPool`). `DIRECT`/`CROWDFUND` loans don't interact with pools.                                                                            |

---

## 17. Appendix: Cashflow Diagrams

### A. Normal Repayment Flow

```
Borrower
   │
   │  repay(amount)
   ▼
UnifiedLoan
   │
   ├── Deduct fees → Treasury
   │
   │  transfer(principal + netInterest) → Pool
   │  onLoanRepayment(principal, netInterest)
   ▼
UnifiedPoolTranched
   │
   │  _distributeRepayment()
   │
   ├── Step 2: Senior principal  ──→  sr.virtualBalance ↑
   ├── Step 3: Senior interest   ──→  sr.virtualBalance ↑  (capped)
   ├── Step 4: Junior principal  ──→  jr.virtualBalance ↑
   ├── Step 5: Junior interest   ──→  jr.virtualBalance ↑
   └── Step 6: Residual          ──→  jr.virtualBalance ↑
```

### B. Default / Loss Flow

```
Admin / Keeper
   │
   │  recordBadDebt(loan, writeOff)
   ▼
UnifiedPoolTranched
   │
   │  _absorbLoss(writeOff)
   │
   ├── Junior absorbs min(writeOff, jrNAV)
   │     jr.badDebt ↑, jr.virtualBalance ↓
   │
   ├── If writeOff > jrNAV:
   │     Senior absorbs remainder
   │     sr.badDebt ↑, sr.virtualBalance ↓
   │
   └── _checkStressTriggers()
         │
         └── If drawdown > threshold → stressMode = true
```

### C. Deposit / Withdrawal Flow

```
  LP (Senior)                    LP (Junior)
     │                              │
     │ deposit(Senior, 1000)        │ deposit(Junior, 500)
     ▼                              ▼
  ┌─────────────────────────────────────────┐
  │          UnifiedPoolTranched            │
  │                                         │
  │  sr.totalShares ↑      jr.totalShares ↑ │
  │  sr.virtualBal ↑       jr.virtualBal ↑  │
  │                                         │
  │       ┌──────────────────────┐          │
  │       │  Shared USDC Balance │          │
  │       │       1,500          │          │
  │       └──────────────────────┘          │
  └─────────────────────────────────────────┘
     │                              │
     │ withdraw(Senior, shares)     │ withdraw(Junior, shares)
     ▼                              ▼
  Check:                         Check:
  - sr liquidity sufficient?     - jr liquidity sufficient?
  - not in stress mode?          - not in stress mode?
  - min hold elapsed?            - min hold elapsed?
```

### D. Stress Mode State Machine

```
                 ┌───────────────┐
                 │    NORMAL     │
                 │               │
                 │ Deposits: ✓   │
                 │ Withdrawals:✓ │
                 │ Allocations:✓ │
                 └───────┬───────┘
                         │
            juniorDrawdown > cap
            OR seniorDrawdown > cap
                         │
                         ▼
                 ┌───────────────┐
                 │    STRESS     │
                 │               │
                 │ Deposits: ✓   │
                 │ Queue: ✓      │
                 │ Fulfill: ✗    │
                 │ Allocations:✗ │
                 │               │
                 │ seniorPriority│
                 │ Active = true │
                 └───────┬───────┘
                         │
              Governance lifts stress
              (setStressMode(false))
                         │
                         ▼
                 ┌───────────────┐
                 │   RECOVERY    │
                 │               │
                 │ Deposits: ✓   │
                 │ Sr Fulfill: ✓ │
                 │ Jr Fulfill: ✗ │
                 │ Allocations:✓ │
                 │               │
                 │ seniorPriority│
                 │ Active = true │
                 └───────┬───────┘
                         │
              Senior queue drained
              OR maxDuration elapsed
              OR governance override
                         │
                         ▼
                 ┌───────────────┐
                 │    NORMAL     │
                 └───────────────┘
```

---

_End of design document._
