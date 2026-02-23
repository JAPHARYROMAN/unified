# Installment Enforcement — Backend Integration Notes

## Overview

UnifiedLoan v1.1 adds installment-aware enforcement with deterministic state
transitions. The backend **generates the schedule** and stores it off-chain;
the contract stores only a `scheduleHash` (bytes32) plus a minimal config set.

---

## On-Chain Config (per loan)

| Field                    | Type    | Description                                   |
| ------------------------ | ------- | --------------------------------------------- |
| `totalInstallments`      | uint256 | Number of scheduled installments              |
| `installmentInterval`    | uint256 | Seconds between due dates                     |
| `installmentGracePeriod` | uint256 | Grace seconds after each due date             |
| `penaltyAprBps`          | uint256 | Penalty interest APR (bps) while delinquent   |
| `defaultThresholdDays`   | uint256 | Days of delinquency before default is allowed |
| `scheduleHash`           | bytes32 | keccak256 of backend-generated schedule       |

These fields are **immutable** after loan creation (set during `initialize()`).

---

## Events to Index

| Event                  | Indexed Fields              | Purpose                                 |
| ---------------------- | --------------------------- | --------------------------------------- |
| `InstallmentConfigSet` | `loan`                      | Config stored at creation               |
| `RepaymentApplied`     | `loan`                      | Structured allocation breakdown         |
| `InstallmentPaid`      | `loan`, `installmentNumber` | Installment milestone crossed           |
| `LoanDelinquent`       | `loan`, `installmentIndex`  | Delinquency detected (with daysPastDue) |
| `LoanCured`            | `loan`, `installmentIndex`  | Borrower caught up, delinquency cleared |
| `LoanDefaulted`        | `loan`, `installmentIndex`  | Default triggered (with daysPastDue)    |

### RepaymentApplied Payload

```
totalAmount, feePortion, interestPortion, principalPortion, timestamp
```

Invariant: `feePortion + interestPortion + principalPortion == totalAmount`

Allocation order: **late fees → interest → principal** (strict).

---

## Backend Responsibilities

1. **Schedule generation**: Compute the installment schedule (amounts, dates)
   and store it in the orchestrator DB. Hash the schedule and pass the hash as
   `scheduleHash` when calling `createLoan`.

2. **Delinquency monitoring**: Call `checkDelinquency()` periodically (or rely
   on keepers). This is a public function — anyone can call it to update the
   on-chain delinquency flag.

3. **Default triggering**: Once `delinquentSince + defaultThresholdDays` has
   elapsed, anyone can call `markDefault()`. The backend should monitor and
   call this when appropriate.

4. **Event indexing**: Index the events above for the dashboard, notifications,
   and audit trail. `RepaymentApplied` provides the breakdown needed for
   ledger reconciliation.

---

## Key Invariants

- No repayment can exceed total outstanding obligation (reverts with
  `RepaymentExceedsDebt`).
- No state transitions are possible after DEFAULTED except `claimCollateral()`
  and the resulting `close()` path.
- INSTALLMENT loans cannot be created with `totalInstallments == 0` or
  `installmentInterval == 0` (reverts with `InvalidInstallmentConfig`).
- Delinquency is detected relative to the grace deadline, not the current
  timestamp — `delinquentSince` anchors to the missed deadline.
- Late fees accrue only while `delinquentSince > 0` using `penaltyAprBps` on
  `principalOutstanding`.

---

## Gas Profile

No per-installment arrays are stored on-chain. Storage footprint is 9 slots
(all scalars). Repayment gas usage is bounded and does not scale with
installment count (< 500k gas in all tested scenarios).

---

## Default & Post-Default Safety (v1.1 addendum)

### Default Trigger Paths

| Model       | Trigger Condition                                          | Event                                         |
| ----------- | ---------------------------------------------------------- | --------------------------------------------- |
| INSTALLMENT | `delinquentSince > 0 && delinquentDuration ≥ thresholdSec` | `LoanDefaulted(loan, installmentIndex, days)` |
| BULLET      | `block.timestamp ≥ startTs + duration + gracePeriod`       | `LoanDefaulted(loan, 0, daysPastMaturity)`    |

Both paths also emit the legacy `Defaulted(timestamp)` event.

### Post-Default Restrictions

After `status == DEFAULTED`, the following actions are **blocked**:

- `repay()` — `inStatus(ACTIVE)` modifier
- `fund()` / `poolFund()` — status must be `CREATED` or `FUNDING`
- `activateAndDisburse()` — `inStatus(FUNDING)` modifier
- `close()` — `inStatus(REPAID)` modifier
- `markDefault()` — `inStatus(ACTIVE)` modifier (prevents double-default)
- `recordFiatDisbursement()` / `recordFiatRepayment()` — `notTerminal` modifier

The **only** permitted transition from `DEFAULTED` is `claimCollateral() → CLOSED`.

### Collateral Claim Safety

| Funding Model | Claimant      | Method                              | Behavior                                    |
| ------------- | ------------- | ----------------------------------- | ------------------------------------------- |
| DIRECT        | Single lender | `loan.claimCollateral()`            | Full amount, auto-close                     |
| CROWDFUND     | Each lender   | `loan.claimCollateral()` (per-call) | Pro-rata share, auto-close when vault empty |
| POOL          | Pool contract | `pool.claimLoanCollateral(loan)`    | Full amount, auto-close                     |

**Invariants enforced:**

- `collateralClaimedTotal <= collateralAmount` (assert + `OverClaim` revert)
- Contributions zeroed after claim (prevents double-claim per lender)
- POOL model: only the pool contract address can call `claimCollateral` on the loan

### Pause + Default Interaction

`markDefault()` and `claimCollateral()` are **not** guarded by `whenLoanNotPaused`.
This ensures that a paused loan does not trap lender funds — default can always
trigger and collateral can always be claimed regardless of pause state.

### E2E Harness Integration

The backend E2E harness should cover:

1. **Threshold boundary**: Verify `markDefault()` reverts 1 second before
   threshold and succeeds at the exact threshold timestamp.
2. **Double-default**: Confirm second `markDefault()` call reverts.
3. **Claim lifecycle**: Default → claim → verify CLOSED status and correct
   collateral balances for all three funding models.
4. **Pause + default**: Pause a loan, advance time past threshold, confirm
   `markDefault()` + `claimCollateral()` both succeed.
5. **Fiat proof blocking**: After default, confirm `recordFiatDisbursement()`
   and `recordFiatRepayment()` revert with `LoanTerminated`.
6. **Pool claim proxy**: Use `pool.claimLoanCollateral(loanAddress)` (not
   `loan.claimCollateral()` directly) for POOL-model defaults.
