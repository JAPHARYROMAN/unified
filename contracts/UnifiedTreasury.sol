// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedTreasury
 * @notice Pull-based fee custody contract for the Unified protocol.
 *
 * @dev MVP design:
 *   - `receiveERC20` pulls tokens from the caller (fee manager, loan, etc.)
 *     via `safeTransferFrom`.  Caller must have approved this contract first.
 *   - Admin withdrawal is gated behind `WITHDRAWER_ROLE` (intended for a
 *     multisig address).
 */
contract UnifiedTreasury is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @notice Role allowed to withdraw funds (future multisig).
    bytes32 public constant WITHDRAWER_ROLE = keccak256("WITHDRAWER_ROLE");

    // ── Events ─────────────────────────────────────────────────────────────

    event FeeReceived(address indexed token, uint256 amount, address indexed from);
    event ERC20Withdrawn(address indexed token, address indexed to, uint256 amount);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param admin  Default admin (also granted WITHDRAWER_ROLE initially).
     */
    constructor(address admin) {
        if (admin == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WITHDRAWER_ROLE, admin);
    }

    // ── Receive Fees ───────────────────────────────────────────────────────

    /**
     * @notice Pull ERC-20 tokens from the caller into the treasury.
     * @dev    Caller must have approved this contract for at least `amount`.
     * @param token  ERC-20 token address.
     * @param amount Amount to pull.
     */
    function receiveERC20(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit FeeReceived(token, amount, msg.sender);
    }

    // ── Withdrawal (multisig-gated) ────────────────────────────────────────

    /**
     * @notice Withdraw ERC-20 tokens to a recipient.
     * @dev    Gated behind WITHDRAWER_ROLE — assign to a multisig in production.
     * @param token  ERC-20 token address.
     * @param to     Recipient.
     * @param amount Amount.
     */
    function withdrawERC20(address token, address to, uint256 amount)
        external
        onlyRole(WITHDRAWER_ROLE)
        nonReentrant
    {
        if (token == address(0) || to == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        IERC20(token).safeTransfer(to, amount);

        emit ERC20Withdrawn(token, to, amount);
    }
}
