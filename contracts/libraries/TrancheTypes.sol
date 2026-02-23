// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./UnifiedTypes.sol";

/**
 * @title TrancheTypes
 * @notice Shared types for the two-tier Senior/Junior tranching system.
 */
library TrancheTypes {
    // ── Tranche identifier ─────────────────────────────────────────────────

    /// @notice Two-tier tranche enum.  Senior = 0, Junior = 1.
    enum Tranche {
        Senior,
        Junior
    }

    // ── Per-tranche accounting ─────────────────────────────────────────────

    /// @notice Full per-tranche state.
    ///         Withdrawal-queue mappings live outside the struct (Solidity
    ///         doesn't allow mappings inside structs stored in arrays).
    struct TrancheState {
        // ── Share accounting ──
        uint256 totalShares;
        uint256 virtualBalance;       // tracked USDC attributable to this tranche
        uint256 principalAllocated;   // capital deployed to loans via this tranche
        uint256 principalRepaid;      // principal returned to this tranche
        uint256 interestEarned;       // net interest credited (cash-basis only)
        uint256 badDebt;              // write-offs absorbed by this tranche

        // ── Policy ──
        uint256 targetYieldBps;       // Senior only: max annualised yield (0 = uncapped)
        uint256 depositCap;           // max virtual balance (0 = unlimited)

        // ── Withdrawal queue ──
        uint256 withdrawQueueLength;  // logical length of queue (in-struct counter)
    }

    /// @notice Per-user, per-tranche position (mirrors UnifiedTypes.PoolPosition
    ///         but scoped to a tranche).
    struct TranchePosition {
        uint256 shares;
        uint256 cumulativeDeposited;
        uint256 cumulativeWithdrawn;
    }
}
