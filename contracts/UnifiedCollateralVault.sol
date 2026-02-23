// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedCollateralVault
 * @notice ERC-20 collateral escrow for Unified loan clones.
 * @dev    - No admin withdrawals — tokens can only leave via `releaseCollateral`
 *           or `seizeCollateral`, both of which require `msg.sender == loan`.
 *         - One locked position per loan; cannot re-lock until released/seized.
 */
contract UnifiedCollateralVault is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @notice Role granted to registered loan contracts.
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    /// @notice Role allowed to register new loan contracts (granted to factory).
    bytes32 public constant LOAN_REGISTRAR_ROLE = keccak256("LOAN_REGISTRAR_ROLE");

    // ── Storage ────────────────────────────────────────────────────────────

    struct LockedCollateral {
        address token;
        uint256 totalAmount;
        uint256 remainingAmount;
        bool    isLocked;
    }

    /// @notice Collateral position keyed by loan address.
    mapping(address => LockedCollateral) public lockedByLoan;

    // ── Events ─────────────────────────────────────────────────────────────

    event LoanRegistered(address indexed loan, address indexed registrar);
    event CollateralLocked(address indexed loan, address indexed token, address indexed fromBorrower, uint256 amount);
    event CollateralReleased(address indexed loan, address indexed toBorrower, address indexed token, uint256 amount);
    event CollateralSeized(address indexed loan, address indexed toRecipient, address indexed token, uint256 amount);
    event PartialSeized(address indexed loan, address indexed to, uint256 amount, uint256 remaining);

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(address admin) {
        if (admin == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ── Registration ───────────────────────────────────────────────────────

    /**
     * @notice Registers a loan clone and grants it LOAN_ROLE.
     * @param loan Address of the deployed loan clone.
     */
    function registerLoan(address loan) external onlyRole(LOAN_REGISTRAR_ROLE) {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(LOAN_ROLE, loan);
        emit LoanRegistered(loan, msg.sender);
    }

    // ── Lock ───────────────────────────────────────────────────────────────

    /**
     * @notice Lock ERC-20 collateral for a loan.
     * @dev    Pulls `amount` of `token` from `fromBorrower` into this vault.
     *
     *         Two valid caller patterns:
     *           (a) A registered loan contract (holds LOAN_ROLE) calling on the
     *               borrower's behalf — the standard path via UnifiedLoan.lockCollateral().
     *           (b) The borrower calling directly, provided the target `loan`
     *               address is a registered loan (holds LOAN_ROLE).
     *
     * @param loan         Loan address the collateral is associated with.
     * @param token        ERC-20 collateral token.
     * @param amount       Amount to lock (must be > 0).
     * @param fromBorrower Address from which tokens are pulled (must have approved this vault).
     */
    function lockCollateral(
        address loan,
        address token,
        uint256 amount,
        address fromBorrower
    )
        external
        nonReentrant
    {
        // (a) Registered loan calling on the borrower's behalf.
        // (b) Borrower calling directly, with a registered loan address as target.
        bool callerIsLoan     = hasRole(LOAN_ROLE, msg.sender);
        bool callerIsBorrower = (msg.sender == fromBorrower) && hasRole(LOAN_ROLE, loan);
        if (!callerIsLoan && !callerIsBorrower) revert UnifiedErrors.Unauthorized();
        if (loan == address(0) || token == address(0) || fromBorrower == address(0)) {
            revert UnifiedErrors.ZeroAddress();
        }
        if (amount == 0) revert UnifiedErrors.ZeroAmount();
        if (lockedByLoan[loan].isLocked) revert UnifiedErrors.CollateralAlreadyLocked();

        lockedByLoan[loan] = LockedCollateral({
            token:           token,
            totalAmount:     amount,
            remainingAmount: amount,
            isLocked:        true
        });

        IERC20(token).safeTransferFrom(fromBorrower, address(this), amount);

        emit CollateralLocked(loan, token, fromBorrower, amount);
    }

    // ── Release ────────────────────────────────────────────────────────────

    /**
     * @notice Release all locked collateral back to the borrower.
     * @dev    Only the loan contract itself may release its own collateral
     *         (`msg.sender == loan`).
     * @param loan       Loan address whose collateral is released.
     * @param toBorrower Recipient (borrower) address.
     */
    function releaseCollateral(address loan, address toBorrower)
        external
        nonReentrant
    {
        if (msg.sender != loan) revert UnifiedErrors.Unauthorized();
        if (!hasRole(LOAN_ROLE, loan)) revert UnifiedErrors.Unauthorized();
        if (toBorrower == address(0)) revert UnifiedErrors.ZeroAddress();

        LockedCollateral memory pos = lockedByLoan[loan];
        if (!pos.isLocked || pos.remainingAmount == 0) revert UnifiedErrors.CollateralNotLocked();

        // Release is only allowed when no partial seize has occurred
        if (pos.remainingAmount != pos.totalAmount) revert UnifiedErrors.Unauthorized();

        delete lockedByLoan[loan];

        IERC20(pos.token).safeTransfer(toBorrower, pos.remainingAmount);

        emit CollateralReleased(loan, toBorrower, pos.token, pos.remainingAmount);
    }

    // ── Seize ──────────────────────────────────────────────────────────────

    /**
     * @notice Seize a portion (or all) of locked collateral to a recipient.
     * @dev    Only the loan contract itself may seize its own collateral
     *         (`msg.sender == loan`).
     * @param loan        Loan address whose collateral is seized.
     * @param toRecipient Recipient of the seized tokens.
     * @param amount      Amount to seize (must be ≤ locked amount).
     */
    function seizeCollateral(address loan, address toRecipient, uint256 amount)
        external
        nonReentrant
    {
        if (msg.sender != loan) revert UnifiedErrors.Unauthorized();
        if (!hasRole(LOAN_ROLE, loan)) revert UnifiedErrors.Unauthorized();
        if (toRecipient == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        LockedCollateral storage pos = lockedByLoan[loan];
        if (!pos.isLocked || pos.remainingAmount < amount) revert UnifiedErrors.CollateralNotLocked();

        address token = pos.token;

        pos.remainingAmount -= amount;
        uint256 remaining = pos.remainingAmount;

        if (remaining == 0) {
            delete lockedByLoan[loan];
        }

        IERC20(token).safeTransfer(toRecipient, amount);

        emit CollateralSeized(loan, toRecipient, token, amount);
        emit PartialSeized(loan, toRecipient, amount, remaining);
    }

    // ── View ───────────────────────────────────────────────────────────────

    /**
     * @notice Returns the locked collateral position for a loan.
     * @param loan Loan address.
     * @return token           Collateral token address.
     * @return totalAmount     Original locked amount.
     * @return remainingAmount Amount still remaining in vault.
     * @return locked          Whether the position is currently active.
     */
    function getLocked(address loan)
        external
        view
        returns (address token, uint256 totalAmount, uint256 remainingAmount, bool locked)
    {
        LockedCollateral memory pos = lockedByLoan[loan];
        return (pos.token, pos.totalAmount, pos.remainingAmount, pos.isLocked);
    }
}
