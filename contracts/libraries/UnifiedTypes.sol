// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title UnifiedTypes
 * @notice Shared enums, structs, and constants used across the Unified protocol contracts.
 */
library UnifiedTypes {
    // ── Loan Enums ─────────────────────────────────────────────────────────

    /// @notice Funding models for loan origination.
    enum FundingModel {
        DIRECT,
        CROWDFUND,
        POOL
    }

    /// @notice Repayment schedule models.
    enum RepaymentModel {
        BULLET,
        INSTALLMENT
    }

    /// @notice Loan lifecycle states.
    enum LoanStatus {
        CREATED,
        FUNDING,
        ACTIVE,
        REPAID,
        DEFAULTED,
        CLOSED
    }

    // ── Risk Enums ─────────────────────────────────────────────────────────

    /// @notice Risk classification tiers for borrowers.
    enum RiskTier {
        UNRATED,
        LOW,
        MEDIUM,
        HIGH,
        CRITICAL
    }

    // ── Loan Structs ───────────────────────────────────────────────────────

    /// @notice User-facing parameters supplied to the factory when creating a loan.
    struct LoanParams {
        FundingModel fundingModel;
        RepaymentModel repaymentModel;
        address borrower;
        address collateralToken;
        uint256 collateralAmount;
        uint256 principalAmount;
        uint256 interestRateBps;
        uint256 durationSeconds;
        uint256 gracePeriodSeconds;
        uint256 fundingDeadline;
        address pool;
        // ── Installment fields (set to 0/empty for BULLET) ──────────────
        uint256 totalInstallments;
        uint256 installmentInterval;
        uint256 installmentGracePeriod;
        uint256 penaltyAprBps;
        uint256 defaultThresholdDays;
        bytes32 scheduleHash;
    }

    /// @notice Full initialization parameters constructed by the factory and
    ///         passed to the loan clone's `initialize()` function.
    struct LoanInitParams {
        address borrower;
        address currency;
        uint256 principal;
        uint256 aprBps;
        uint256 duration;
        uint256 gracePeriod;
        uint256 fundingTarget;
        uint256 fundingDeadline;
        FundingModel fundingModel;
        RepaymentModel repaymentModel;
        address pool;
        address collateralAsset;
        uint256 collateralAmount;
        address collateralVault;
        address feeManager;
        address treasury;
        address pauser;
        address settlementAgent;
        bool requireFiatProof;
        // ── Installment fields (ignored for BULLET loans) ────────────────
        uint256 totalInstallments;
        uint256 installmentInterval;
        uint256 installmentGracePeriod;
        uint256 penaltyAprBps;
        uint256 defaultThresholdDays;
        bytes32 scheduleHash;
    }

    // ── Fee / Risk / Pool Structs ──────────────────────────────────────────

    /// @notice Protocol-wide fee configuration in basis points.
    struct FeeConfig {
        uint256 originationFeeBps;
        uint256 servicingFeeBps;
        uint256 defaultPenaltyBps;
    }

    /// @notice Borrower risk attestation written by authorized oracle.
    struct RiskAttestation {
        RiskTier tier;
        uint256 borrowCap;
        uint64 updatedAt;
        uint256 flags;      // bitmask: bit 0 = blocked, others TBD
    }

    /// @notice Internal pool accounting position for a provider.
    struct PoolPosition {
        uint256 shares;
        uint256 cumulativeDeposited;
        uint256 cumulativeWithdrawn;
    }

    /// @notice Queued withdrawal request for a pool depositor.
    struct WithdrawRequest {
        address user;
        uint256 shares;
        bool fulfilled;
    }

    /// @notice Basis points denominator.
    uint256 internal constant BPS_DENOMINATOR = 10_000;
}
