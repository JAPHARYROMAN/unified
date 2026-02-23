// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedRiskRegistry
 * @notice On-chain borrower risk data written by an authorized oracle.
 *
 * @dev Per-borrower storage:
 *   - `tier`      (uint8)   — risk classification (0 = UNRATED … 4 = CRITICAL)
 *   - `borrowCap` (uint256) — maximum borrow amount in the currency's decimals
 *   - `flags`     (uint256) — generic bitmask (bit 0 = blocked, others TBD)
 *
 *   NO PII (names, phone numbers, etc.) is stored on-chain.
 */
contract UnifiedRiskRegistry is AccessControl {

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @notice Role allowed to write borrower risk data.
    bytes32 public constant RISK_ORACLE_ROLE = keccak256("RISK_ORACLE_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────

    /// @notice Bit-0 of `flags` — if set, borrower is blocked from new loans.
    uint256 public constant FLAG_BLOCKED = 1 << 0;

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice Latest risk record per borrower.
    mapping(address => UnifiedTypes.RiskAttestation) public attestations;

    // ── Events ─────────────────────────────────────────────────────────────

    event RiskUpdated(address indexed borrower, uint8 tier, uint256 cap, uint256 flags);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param admin  Default admin & initial RISK_ORACLE_ROLE holder.
     */
    constructor(address admin) {
        if (admin == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ORACLE_ROLE, admin);
    }

    // ── Write (RISK_ORACLE_ROLE) ───────────────────────────────────────────

    /**
     * @notice Set or update a borrower's risk profile.
     * @param borrower   Borrower wallet address.
     * @param tier       Risk tier (0–4, maps to `UnifiedTypes.RiskTier`).
     * @param borrowCap  Maximum allowed borrow amount (0 = unlimited).
     * @param flags      Bitmask of flags (bit 0 = blocked).
     */
    function setRisk(
        address borrower,
        uint8 tier,
        uint256 borrowCap,
        uint256 flags
    ) external onlyRole(RISK_ORACLE_ROLE) {
        if (borrower == address(0)) revert UnifiedErrors.ZeroAddress();
        if (tier > 4) revert UnifiedErrors.InvalidTier(tier);

        attestations[borrower] = UnifiedTypes.RiskAttestation({
            tier: UnifiedTypes.RiskTier(tier),
            borrowCap: borrowCap,
            updatedAt: uint64(block.timestamp),
            flags: flags
        });

        emit RiskUpdated(borrower, tier, borrowCap, flags);
    }

    // ── Read Helpers ───────────────────────────────────────────────────────

    /**
     * @notice Return the full risk profile for a borrower.
     * @param borrower  Borrower wallet address.
     * @return tier      Risk tier (0–4).
     * @return cap       Maximum borrow amount.
     * @return flags     Bitmask (bit 0 = blocked).
     * @return updatedAt Timestamp of last update.
     */
    function getRisk(address borrower)
        external
        view
        returns (uint8 tier, uint256 cap, uint256 flags, uint64 updatedAt)
    {
        UnifiedTypes.RiskAttestation memory att = attestations[borrower];
        return (uint8(att.tier), att.borrowCap, att.flags, att.updatedAt);
    }

    /**
     * @notice Check whether a borrower is blocked (bit-0 of flags).
     */
    function isBlocked(address borrower) external view returns (bool) {
        return attestations[borrower].flags & FLAG_BLOCKED != 0;
    }

    /**
     * @notice Validate that `borrower` is not blocked and that
     *         `requestedAmount` does not exceed the borrower's cap.
     * @dev    Reverts with `BorrowerFlagged` or `BorrowCapExceeded`.
     */
    function validateBorrow(address borrower, uint256 requestedAmount) external view {
        UnifiedTypes.RiskAttestation memory att = attestations[borrower];

        if (att.flags & FLAG_BLOCKED != 0) revert UnifiedErrors.BorrowerFlagged(borrower);
        if (att.borrowCap > 0 && requestedAmount > att.borrowCap) {
            revert UnifiedErrors.BorrowCapExceeded(borrower, requestedAmount, att.borrowCap);
        }
    }
}
