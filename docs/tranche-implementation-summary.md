# UnifiedPoolTranched — Implementation Summary

| Field       | Value                            |
| ----------- | -------------------------------- |
| **Version** | 1.2.0                            |
| **Date**    | 2026-02-23                       |
| **Scope**   | Production contract + test suite |

---

## Files Created

| File                                       | Lines | Purpose                                                      |
| ------------------------------------------ | ----: | ------------------------------------------------------------ |
| `contracts/UnifiedPoolTranched.sol`        |  ~680 | Full production two-tier tranched pool contract              |
| `contracts/interfaces/ICircuitBreaker.sol` |   ~30 | Read-only breaker interface with 6-state `BreakerState` enum |
| `contracts/libraries/TrancheTypes.sol`     |   ~50 | `Tranche` enum, `TrancheState` struct, `TranchePosition`     |
| `test/UnifiedPoolTranched.test.ts`         |  ~850 | 58 Hardhat/Chai tests across 16 sections                     |
| `docs/tranche-gas-analysis.md`             |  ~200 | Gas estimates, Mermaid state diagram, invariant proofs       |

## Files Modified

| File                                    | Change                                 |
| --------------------------------------- | -------------------------------------- |
| `contracts/libraries/UnifiedErrors.sol` | Added 8 tranche-specific custom errors |

---

## Contract Architecture

### IUnifiedPool Compatibility

`UnifiedPoolTranched` implements `IUnifiedPool` identically to `UnifiedPool`:

```solidity
interface IUnifiedPool {
    function setLoanRole(address loan, bool allowed) external;
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid) external;
}
```

Downstream `UnifiedLoan`, `UnifiedLoanFactory`, and `UnifiedFeeManager` require **zero modifications**. The tranched pool registers in the factory via the existing `isPool` mapping.

### Tranche Model

- **Senior (index 0)**: Lower risk, capped yield via `targetYieldBps`, loss-absorber of last resort.
- **Junior (index 1)**: Higher risk, uncapped residual yield, first-loss absorber.
- **Single USDC balance**: Both tranches share one `address(this)` balance. Virtual sub-accounting tracks each tranche's portion.

### Inheritance

```
AccessControl + Pausable + ReentrancyGuard + IUnifiedPool
        │
        └── UnifiedPoolTranched
```

### Roles

| Role                  | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `DEFAULT_ADMIN_ROLE`  | Governance: parameter changes, stress control  |
| `PAUSER_ROLE`         | Emergency pause/unpause                        |
| `ALLOCATOR_ROLE`      | Loan allocation, bad debt recording, recovery  |
| `LOAN_ROLE`           | Granted to loan clones for repayment callbacks |
| `LOAN_REGISTRAR_ROLE` | Factory-granted for loan registration          |
| `DEPOSITOR_ROLE`      | Whitelisted depositors (optional gating)       |

---

## Key Features

### 1. Cashflow Waterfall (§7)

Repayment distribution order inside `_distributeRepayment`:

1. **Senior principal** — up to Senior outstanding
2. **Senior interest** — capped at `targetYieldBps` (annualised, time-weighted)
3. **Junior principal** — up to Junior outstanding
4. **Junior interest + residual** — all remaining flows to Junior

Fees are deducted by `UnifiedLoan` _before_ the `onLoanRepayment` callback.

### 2. Loss Absorption (§8)

`_absorbLoss` enforces Junior-first loss absorption:

- `jrAbsorb = min(writeOff, jrNAV)`
- `srAbsorb = writeOff - jrAbsorb` (only when Junior NAV == 0)

Only principal is written off. Unreceived interest is never recorded as a loss (INV-6).

### 3. Recovery Waterfall (§8.5)

`onCollateralRecovery` distributes seized collateral proceeds:

1. Senior principal shortfall (up to `loanBadDebt[loan][0]`)
2. Junior principal shortfall (up to `loanBadDebt[loan][1]`)
3. Residual → Junior

### 4. Subordination Guardrails (§10)

| Guardrail                           | Protects         | Enforced On             |
| ----------------------------------- | ---------------- | ----------------------- |
| Junior NAV == 0 blocks Sr deposit   | Subordination    | `deposit(Senior, amt)`  |
| Post-deposit subordination check    | Min ratio        | `deposit(Senior, amt)`  |
| Post-withdrawal subordination check | Min ratio        | `withdraw(Junior, shr)` |
| Senior liquidity floor              | Sr liquidity     | `allocateToLoan`        |
| Deposit cap                         | Max tranche size | `deposit(t, amt)`       |

### 5. Stress Mode & Senior Priority (§9–10)

Three-state machine: **NORMAL → STRESS → RECOVERY → NORMAL**

- **Auto-trigger**: Junior NAV drawdown exceeds `juniorNavDrawdownCapBps` (checked on `recordBadDebt`)
- **Senior priority**: Junior fulfillment blocked during RECOVERY phase
- **Auto-expiry**: Senior priority clears after `seniorPriorityMaxDuration` (default 30 days)
- **Emergency pause**: Auto-triggered when Senior NAV drawdown exceeds `seniorNavDrawdownCapBps`

### 6. Circuit Breaker Integration

Optional `ICircuitBreaker` contract. When set, `GLOBAL_HARD_STOP` blocks all mutations via the `whenBreakerAllows` modifier.

---

## Governed Parameters

| Parameter                   | Default       | Timelock | Range   |
| --------------------------- | ------------- | -------- | ------- |
| `seniorAllocationBps`       | 7000 (70%)    | Admin    | 0–10000 |
| `seniorTargetYieldBps`      | Constructor   | Admin    | 0–∞     |
| `minSubordinationBps`       | 2000 (20%)    | Admin    | 0–10000 |
| `juniorCoverageFloorBps`    | 750 (7.5%)    | Admin    | 0–10000 |
| `seniorLiquidityFloorBps`   | 1000 (10%)    | Admin    | 0–10000 |
| `juniorNavDrawdownCapBps`   | 3000 (30%)    | Admin    | 0–10000 |
| `seniorNavDrawdownCapBps`   | 500 (5%)      | Admin    | 0–10000 |
| `seniorPriorityMaxDuration` | 30 days       | Admin    | 0–∞     |
| `trancheDepositCap[t]`      | 0 (unlimited) | Admin    | 0–∞     |
| `stressMode`                | false         | None     | bool    |

---

## Invariants

| ID    | Invariant                                                            |
| ----- | -------------------------------------------------------------------- |
| INV-1 | `sr.virtualBalance + jr.virtualBalance == usdc.balanceOf(this)`      |
| INV-2 | `t.principalAllocated >= t.principalRepaid` for each tranche         |
| INV-3 | `sr.badDebt + jr.badDebt == totalBadDebt`                            |
| INV-4 | Junior absorbs loss first; Senior only after Junior NAV == 0         |
| INV-5 | `sum(positions[*][t].shares) == tranches[t].totalShares` per tranche |
| INV-6 | `interestEarned` is never decremented by a loss event                |

---

## Test Coverage (58 Tests)

| Section | Category                      |  Tests |
| ------: | ----------------------------- | -----: |
|      §1 | Deployment                    |      3 |
|      §2 | Deposits & Subordination      |      6 |
|      §3 | Withdrawals                   |      4 |
|      §4 | Queued Withdrawals & Priority |      7 |
|      §5 | Loan Allocation               |      2 |
|      §6 | Repayment Waterfall           |      3 |
|      §7 | Loss Absorption               |      4 |
|      §8 | Collateral Recovery           |      3 |
|      §9 | Stress Mode                   |      4 |
|     §10 | NAV & Share Price             |      5 |
|     §11 | Admin                         |      4 |
|     §12 | Pause                         |      2 |
|     §13 | Coverage Floor                |      1 |
|     §14 | Edge Cases                    |      6 |
|     §15 | Multi-user Fairness           |      2 |
|     §16 | Dual Tranche Interaction      |      2 |
|         | **Total**                     | **58** |

---

## New Custom Errors

```solidity
error TrancheDepositCapExceeded(uint8 tranche, uint256 current, uint256 cap);
error InsufficientTrancheLiquidity(uint8 tranche);
error StressModeLocked();
error SeniorPriorityActive();
error SubordinationTooLow(uint256 ratio, uint256 minimum);
error InvalidTranche();
error MinHoldPeriodNotElapsed(uint8 tranche, uint256 remaining);
error CoverageFloorBreached(uint256 current, uint256 required);
error BreakerBlocked(uint8 state);
```

---

## Events

```solidity
event TrancheDeposited(uint8 indexed tranche, address indexed user, uint256 amount, uint256 shares);
event TrancheWithdrawn(uint8 indexed tranche, address indexed user, uint256 amount, uint256 shares);
event WaterfallDistributed(address indexed loan, uint256 srPrincipal, uint256 srInterest, uint256 jrPrincipal, uint256 jrInterest);
event LossAbsorbed(uint8 indexed tranche, address indexed loan, uint256 amount);
event StressModeActivated(uint256 timestamp);
event StressModeDeactivated(uint256 timestamp);
event SeniorPriorityActivated(uint256 timestamp);
event SeniorPriorityCleared(uint256 timestamp);
event SeniorPriorityExpired(uint256 timestamp);
event CollateralRecoveryDistributed(address indexed loan, uint256 srRecovery, uint256 jrRecovery, uint256 residual);
event CoverageFloorBreached(uint256 current, uint256 required);
event SubordinationBreach(uint256 currentRatio, uint256 minimumRequired);
```

---

## Deployment Checklist

1. Deploy `UnifiedPoolTranched(admin, usdc, partnerId, seniorTargetYieldBps)`
2. Register in factory: `factory.setPool(tranchedPoolAddr, true)` (admin call)
3. Grant `LOAN_REGISTRAR_ROLE` to factory on the tranched pool
4. Grant `DEPOSITOR_ROLE` to whitelisted LPs (if gating enabled)
5. Fund Junior tranche first (required before Senior deposits)
6. Optionally set `breaker` address via `setBreaker()`

---

## Related Documents

- [tranche-architecture-v1.2.md](tranche-architecture-v1.2.md) — Full design specification
- [tranche-design-clarifications.md](tranche-design-clarifications.md) — Design decision rationale
- [tranche-gas-analysis.md](tranche-gas-analysis.md) — Gas estimates, state diagram, invariant proofs
