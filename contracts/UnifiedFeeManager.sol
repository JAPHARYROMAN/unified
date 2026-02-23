// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedFeeManager
 * @notice Stores protocol fee basis-point configuration and provides
 *         pure-math view helpers for computing fees.  Fee collection
 *         pulls tokens from the caller via `safeTransferFrom` and
 *         forwards them to the treasury.
 */
contract UnifiedFeeManager is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @notice Role allowed to update fee bps and treasury address.
    bytes32 public constant FEE_ROLE = keccak256("FEE_ROLE");

    /// @notice Role granted to registered loan contracts so they can call collectFee.
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    /// @notice Role allowed to register new loan contracts (granted to factory).
    bytes32 public constant LOAN_REGISTRAR_ROLE = keccak256("LOAN_REGISTRAR_ROLE");

    // ── Constants ──────────────────────────────────────────────────────────

    /// @notice Maximum basis points allowed for any single fee (50 %).
    uint256 public constant MAX_FEE_BPS = 5_000;

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice Origination fee in basis points (charged on principal at activation).
    uint256 public originationFeeBps;

    /// @notice Interest-fee in basis points (charged on each interest payment).
    uint256 public interestFeeBps;

    /// @notice Late-fee in basis points (charged on overdue amounts).
    uint256 public lateFeeBps;

    /// @notice Address that receives all collected fees.
    address public treasury;

    // ── Timelock ───────────────────────────────────────────────────────────

    /// @notice Minimum delay before a scheduled fee change can be executed.
    uint256 public constant TIMELOCK_DELAY = 24 hours;

    /// @notice Scheduled operations: hash → earliest executable timestamp.
    mapping(bytes32 => uint256) public timelockScheduled;

    // ── Events ─────────────────────────────────────────────────────────────

    event FeesUpdated(uint256 originationFeeBps, uint256 interestFeeBps, uint256 lateFeeBps);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event FeeCollected(address indexed loan, address indexed token, uint256 amount);
    event LoanRegistered(address indexed loan);
    event TimelockScheduled(bytes32 indexed id, uint256 readyAt);
    event TimelockExecuted(bytes32 indexed id);
    event TimelockCancelled(bytes32 indexed id);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param admin     Default admin & initial FEE_ROLE holder.
     * @param _treasury Initial fee-receiving address.
     */
    constructor(address admin, address _treasury) {
        if (admin == address(0) || _treasury == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_ROLE, admin);

        treasury = _treasury;
    }

    // ── Loan Registration (DEFAULT_ADMIN) ─────────────────────────────────

    /**
     * @notice Register a loan contract so it can call collectFee.
     * @param loan  Address of the loan clone.
     */
    function registerLoan(address loan) external onlyRole(LOAN_REGISTRAR_ROLE) {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        _grantRole(LOAN_ROLE, loan);
        emit LoanRegistered(loan);
    }

    // ── Fee Collection (LOAN_ROLE) ─────────────────────────────────────────

    /**
     * @notice Pull `amount` of `token` from the calling loan and forward to treasury.
     * @dev    The loan must have approved this contract for at least `amount`.
     * @param token  ERC-20 token to collect.
     * @param amount Amount to collect.
     */
    function collectFee(address token, uint256 amount) external onlyRole(LOAN_ROLE) nonReentrant {
        if (amount == 0) revert UnifiedErrors.ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, treasury, amount);
        emit FeeCollected(msg.sender, token, amount);
    }

    // ── Timelock helpers ───────────────────────────────────────────────────

    /**
     * @notice Schedule a timelocked operation.
     */
    function scheduleTimelock(bytes32 id) external onlyRole(FEE_ROLE) {
        if (timelockScheduled[id] != 0) revert UnifiedErrors.TimelockAlreadyScheduled(id);
        uint256 readyAt = block.timestamp + TIMELOCK_DELAY;
        timelockScheduled[id] = readyAt;
        emit TimelockScheduled(id, readyAt);
    }

    /**
     * @notice Cancel a scheduled timelocked operation.
     */
    function cancelTimelock(bytes32 id) external onlyRole(FEE_ROLE) {
        if (timelockScheduled[id] == 0) revert UnifiedErrors.TimelockNotScheduled(id);
        delete timelockScheduled[id];
        emit TimelockCancelled(id);
    }

    function _consumeTimelock(bytes32 id) internal {
        uint256 readyAt = timelockScheduled[id];
        if (readyAt == 0) revert UnifiedErrors.TimelockNotScheduled(id);
        if (block.timestamp < readyAt) revert UnifiedErrors.TimelockNotReady(id, readyAt);
        delete timelockScheduled[id];
        emit TimelockExecuted(id);
    }

    /**
     * @notice Compute the timelock id for a function call.
     */
    function timelockId(bytes memory data) public pure returns (bytes32) {
        return keccak256(data);
    }

    // ── Fee Setters (FEE_ROLE, timelocked) ─────────────────────────────────

    /**
     * @notice Update all three fee rates at once (timelocked).
     * @param _originationFeeBps  New origination fee bps.
     * @param _interestFeeBps     New interest fee bps.
     * @param _lateFeeBps         New late fee bps.
     */
    function setFees(
        uint256 _originationFeeBps,
        uint256 _interestFeeBps,
        uint256 _lateFeeBps
    ) external onlyRole(FEE_ROLE) {
        if (_originationFeeBps > MAX_FEE_BPS) revert UnifiedErrors.FeeBpsTooHigh(_originationFeeBps, MAX_FEE_BPS);
        if (_interestFeeBps > MAX_FEE_BPS) revert UnifiedErrors.FeeBpsTooHigh(_interestFeeBps, MAX_FEE_BPS);
        if (_lateFeeBps > MAX_FEE_BPS) revert UnifiedErrors.FeeBpsTooHigh(_lateFeeBps, MAX_FEE_BPS);

        bytes32 id = keccak256(abi.encode(this.setFees.selector, _originationFeeBps, _interestFeeBps, _lateFeeBps));
        _consumeTimelock(id);

        originationFeeBps = _originationFeeBps;
        interestFeeBps = _interestFeeBps;
        lateFeeBps = _lateFeeBps;

        emit FeesUpdated(_originationFeeBps, _interestFeeBps, _lateFeeBps);
    }

    /**
     * @notice Update the fee-receiving treasury address (timelocked).
     * @param newTreasury  New treasury address (must not be zero).
     */
    function setTreasury(address newTreasury) external onlyRole(FEE_ROLE) {
        if (newTreasury == address(0)) revert UnifiedErrors.ZeroAddress();

        bytes32 id = keccak256(abi.encode(this.setTreasury.selector, newTreasury));
        _consumeTimelock(id);

        address old = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(old, newTreasury);
    }

    // ── View Helpers ───────────────────────────────────────────────────────

    /**
     * @notice Compute origination fee for a given principal.
     */
    function computeOriginationFee(uint256 amount) external view returns (uint256) {
        return (amount * originationFeeBps) / UnifiedTypes.BPS_DENOMINATOR;
    }

    /**
     * @notice Compute interest fee for a given interest payment.
     */
    function computeInterestFee(uint256 interestAmount) external view returns (uint256) {
        return (interestAmount * interestFeeBps) / UnifiedTypes.BPS_DENOMINATOR;
    }

    /**
     * @notice Compute late fee for a given overdue amount.
     */
    function computeLateFee(uint256 amount) external view returns (uint256) {
        return (amount * lateFeeBps) / UnifiedTypes.BPS_DENOMINATOR;
    }
}
