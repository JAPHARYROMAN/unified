// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UnifiedErrors
 * @notice Consolidated custom errors for protocol-wide usage.
 */
library UnifiedErrors {
    error ZeroAddress();
    error ZeroAmount();
    error Unauthorized();
    error AlreadyInitialized();
    error InvalidLoanState(uint8 current, uint8 expected);
    error LoanAlreadyFunded();
    error LoanNotFullyFunded();
    error LoanNotDefaulted();
    error RepaymentExceedsDebt();
    error GracePeriodNotElapsed();
    error NotALender();
    error NothingToClaim();
    error AlreadyClaimed();
    error CollateralNotAllowed(address token);
    error CollateralNotLocked();
    error CollateralAlreadyLocked();
    error InsufficientShares();
    error InsufficientPoolLiquidity();
    error PoolAllocationExceedsAvailable();
    error BorrowerFlagged(address borrower);
    error BorrowCapExceeded(address borrower, uint256 requested, uint256 cap);
    error FeeBpsTooHigh(uint256 provided, uint256 max);
    error FundingDeadlinePassed();
    error InvalidFundingDeadline();
    error ImplementationNotSet();
    error InvalidConfiguration();
    error UnsupportedOperation();
    error OverClaim();
    error FundingNotExpired();
    error CollateralBelowMinimum();
    error PoolNotAllowed(address pool);
    error InvalidTier(uint8 tier);
    error InvalidIndex();
    error AlreadyFulfilled();
    error InsufficientFreeShares();
    error NoPendingRequest();
    error TooManyOpenRequests();
    error LoanPaused();
    error TimelockNotReady(bytes32 id, uint256 readyAt);
    error TimelockNotScheduled(bytes32 id);
    error TimelockAlreadyScheduled(bytes32 id);

    // ── KYC / Identity ─────────────────────────────────────────────────────
    error KYCRequired();
    error JurisdictionBlocked();
    error TierCapExceeded();
    error KYCExpired();
    error InvalidKycHash();

    // ── Settlement / Fiat ─────────────────────────────────────────────────
    error FiatProofMissing();
    error FiatProofAlreadyRecorded();
    error FiatRefAlreadyUsed(bytes32 ref);

    // ── Exposure cap ──────────────────────────────────────────────────────
    error BorrowerExposureCapExceeded(address borrower, uint256 outstanding, uint256 requested, uint256 cap);

    // ── Installment ───────────────────────────────────────────────────────
    error InvalidInstallmentConfig();
    error InstallmentConfigNotSet();
    error NoInstallmentsDue();
    error LoanDelinquent();
    error DelinquencyThresholdNotReached();

    // ── Post-terminal guard ──────────────────────────────────────────────
    error LoanTerminated();

    // ── Collateral locking (loan-level) ───────────────────────────────────
    error NotBorrower();
    error AlreadyLocked();
    error InvalidStatus();

    // ── Tranche (v1.2) ────────────────────────────────────────────────────
    error TrancheDepositCapExceeded(uint8 tranche, uint256 current, uint256 cap);
    error InsufficientTrancheLiquidity(uint8 tranche);
    error StressModeLocked();
    error SeniorPriorityActive();
    error SubordinationTooLow(uint256 ratio, uint256 minimum);
    error InvalidTranche();
    error MinHoldPeriodNotElapsed(uint8 tranche, uint256 remaining);
    error CoverageFloorBreached(uint256 current, uint256 required);
    error BreakerBlocked(uint8 state);

    // ── Tranche (v1.2.1) ──────────────────────────────────────────────────
    error AllocationRatioOutOfBounds(uint256 provided, uint256 min, uint256 max);
    error SeniorImpaired(uint256 srBadDebt);
    error LaunchParametersLocked();
    error InvariantViolation(uint8 code);
}
