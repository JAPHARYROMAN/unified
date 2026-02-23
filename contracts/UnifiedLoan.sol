// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUnifiedCollateralVault.sol";
import "./interfaces/IUnifiedFeeManager.sol";
import "./interfaces/IUnifiedPool.sol";
import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedLoan
 * @notice EIP-1167 clone-initializable loan contract supporting DIRECT,
 *         CROWDFUND, and POOL funding models with simple interest accrual,
 *         fee integration, and hardened invariant checks.
 */
contract UnifiedLoan is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Storage (original layout — DO NOT reorder) ─────────────────────────

    address public borrower;
    IERC20  public currency;           // USDC
    uint256 public principal;
    uint256 public aprBps;

    uint256 public startTs;
    uint256 public duration;
    uint256 public gracePeriod;

    uint256 public fundingTarget;
    uint256 public fundedAmount;
    uint256 public fundingDeadline;

    UnifiedTypes.FundingModel   public fundingModel;
    UnifiedTypes.RepaymentModel public repaymentModel;

    /// @notice Lender contribution amounts (DIRECT & CROWDFUND).
    mapping(address => uint256) public contributions;
    /// @notice Ordered lender list (CROWDFUND — also used for DIRECT single lender).
    address[] public lenders;

    /// @notice Pool address (POOL model only).
    address public pool;

    address public collateralAsset;
    uint256 public collateralAmount;
    address public collateralVault;

    address public feeManager;
    address public treasury;

    uint256 public principalOutstanding;
    uint256 public interestAccrued;
    uint256 public lastAccrualTs;
    uint256 public repaidTotal;

    UnifiedTypes.LoanStatus public status;

    // ── NEW storage (appended only) ────────────────────────────────────────

    /// @notice Running total of collateral seized via claimCollateral().
    uint256 public collateralClaimedTotal;

    /// @notice Cumulative interest fees routed to treasury.
    uint256 public interestFeesTotal;

    /// @notice Origination fee deducted at activation.
    uint256 public originationFeeCharged;

    /// @notice Address authorized to pause/unpause this loan.
    address public pauser;

    /// @notice Whether this loan is currently paused.
    bool public loanPaused;

    /// @notice Address authorized to record fiat settlement proofs.
    address public settlementAgent;

    /// @notice Whether fiat disbursement proof is required before activation.
    bool public requireFiatProofBeforeActivate;

    /// @notice Fiat disbursement proof reference (bytes32 hash). Zero = not recorded.
    bytes32 public fiatDisbursementRef;

    /// @notice Timestamp when fiat disbursement proof was recorded.
    uint256 public fiatDisbursedAt;

    /// @notice Latest fiat repayment proof reference (bytes32 hash).
    bytes32 public lastFiatRepaymentRef;

    /// @notice Tracks fiat settlement refs already used (prevents double-count).
    mapping(bytes32 => bool) public fiatRefUsed;

    /// @notice True once the borrower has locked collateral via this loan's wrapper.
    ///         Appended last to preserve the storage layout of deployed clones.
    bool public collateralLocked;

    // ── Installment storage (appended for layout safety) ───────────────────

    /// @notice Number of scheduled installments (0 = not installment loan).
    uint256 public totalInstallments;

    /// @notice Seconds between installment due dates.
    uint256 public installmentInterval;

    /// @notice Grace period in seconds after each due date before delinquency.
    uint256 public installmentGracePeriod;

    /// @notice Penalty APR in basis points applied while delinquent.
    uint256 public penaltyAprBps;

    /// @notice Days a loan can be delinquent before default.
    uint256 public defaultThresholdDays;

    /// @notice Hash of the backend-generated deterministic schedule.
    bytes32 public scheduleHash;

    /// @notice Number of installments fully paid.
    uint256 public installmentsPaid;

    /// @notice Accrued late fees (penalty interest).
    uint256 public lateFeeAccrued;

    /// @notice Timestamp when loan entered delinquent state (0 = not delinquent).
    uint256 public delinquentSince;

    // ── Role constants (clone-pattern — checked against settlementAgent address) ──

    /// @notice Role identifier for the settlement operator.
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    // ── Events ─────────────────────────────────────────────────────────────

    event Initialized(
        address indexed borrower,
        uint256 principal,
        uint8   fundingModel,
        uint8   repaymentModel
    );
    event Funded(address indexed lender, uint256 amount, uint256 fundedAmount);
    event Activated(address indexed borrower, uint256 timestamp);
    event Disbursed(address indexed borrower, uint256 amount);
    event Repaid(address indexed payer, uint256 amount, uint256 remaining);
    event Defaulted(uint256 timestamp);
    event CollateralClaimed(address indexed claimant, uint256 amount);
    event Closed(uint256 timestamp);
    event ContributionWithdrawn(address indexed lender, uint256 amount);
    event OriginationFeePaid(address indexed treasury, uint256 amount);
    event InterestFeePaid(address indexed treasury, uint256 amount);
    event LoanPausedEvent(address indexed account);
    event LoanUnpausedEvent(address indexed account);
    event FiatDisbursementRecorded(address indexed loan, bytes32 indexed ref, uint256 at);
    event FiatRepaymentRecorded(address indexed loan, bytes32 indexed ref, uint256 at);
    event FiatActionRecorded(address indexed loan, bytes32 indexed ref, uint8 actionType, uint256 at);
    event CollateralLocked(address indexed loan, address indexed borrower, address indexed token, uint256 amount);

    // ── Installment events (audit-grade) ──────────────────────────────────
    event InstallmentConfigSet(
        address indexed loan,
        bytes32 scheduleHash,
        uint256 installmentCount,
        uint256 intervalSeconds,
        uint256 graceSeconds,
        uint256 penaltyAprBps
    );
    event RepaymentApplied(
        address indexed loan,
        uint256 totalAmount,
        uint256 feePortion,
        uint256 interestPortion,
        uint256 principalPortion,
        uint256 timestamp
    );
    event InstallmentPaid(
        address indexed loan,
        uint256 indexed installmentNumber,
        uint256 amount,
        uint256 lateFee
    );
    event LoanDelinquent(
        address indexed loan,
        uint256 indexed installmentIndex,
        uint256 daysPastDue
    );
    event LoanCured(
        address indexed loan,
        uint256 indexed installmentIndex
    );
    event LoanDefaulted(
        address indexed loan,
        uint256 indexed installmentIndex,
        uint256 daysPastDue
    );

    // ── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyBorrower() {
        if (msg.sender != borrower) revert UnifiedErrors.Unauthorized();
        _;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert UnifiedErrors.Unauthorized();
        _;
    }

    modifier inStatus(UnifiedTypes.LoanStatus expected) {
        if (status != expected) {
            revert UnifiedErrors.InvalidLoanState(uint8(status), uint8(expected));
        }
        _;
    }

    modifier whenLoanNotPaused() {
        if (loanPaused) revert UnifiedErrors.LoanPaused();
        _;
    }

    modifier onlySettlementAgent() {
        if (msg.sender != settlementAgent) revert UnifiedErrors.Unauthorized();
        _;
    }

    /// @dev Prevents actions on loans that have reached a terminal status.
    modifier notTerminal() {
        if (
            status == UnifiedTypes.LoanStatus.DEFAULTED ||
            status == UnifiedTypes.LoanStatus.CLOSED ||
            status == UnifiedTypes.LoanStatus.REPAID
        ) {
            revert UnifiedErrors.LoanTerminated();
        }
        _;
    }

    // ── Initializer ────────────────────────────────────────────────────────

    /// @notice Initializes a clone instance. Called once by the factory.
    /// @param p Packed initialization parameters built by the factory.
    function initialize(UnifiedTypes.LoanInitParams calldata p) external initializer {
        // --- address validation ---
        if (
            p.borrower == address(0) ||
            p.currency == address(0) ||
            p.collateralVault == address(0) ||
            p.feeManager == address(0) ||
            p.treasury == address(0)
        ) revert UnifiedErrors.ZeroAddress();

        if (
            p.fundingModel == UnifiedTypes.FundingModel.POOL &&
            p.pool == address(0)
        ) revert UnifiedErrors.ZeroAddress();

        // --- numeric validation ---
        if (p.principal == 0 || p.collateralAmount == 0 || p.duration == 0) {
            revert UnifiedErrors.ZeroAmount();
        }

        // --- core terms ---
        borrower        = p.borrower;
        currency        = IERC20(p.currency);
        principal       = p.principal;
        aprBps          = p.aprBps;
        duration        = p.duration;
        gracePeriod     = p.gracePeriod;

        // --- funding ---
        fundingTarget   = p.principal;       // must raise the full principal
        fundingDeadline = p.fundingDeadline;
        fundingModel    = p.fundingModel;
        repaymentModel  = p.repaymentModel;
        pool            = p.pool;

        // --- collateral ---
        collateralAsset  = p.collateralAsset;
        collateralAmount = p.collateralAmount;
        collateralVault  = p.collateralVault;

        // --- protocol addresses ---
        feeManager = p.feeManager;
        treasury   = p.treasury;
        pauser     = p.pauser != address(0) ? p.pauser : p.borrower;
        settlementAgent = p.settlementAgent;
        requireFiatProofBeforeActivate = p.requireFiatProof;

        // --- installment parameters (only for INSTALLMENT model) ---
        if (p.repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT) {
            if (p.totalInstallments == 0 || p.installmentInterval == 0) {
                revert UnifiedErrors.InvalidInstallmentConfig();
            }
            totalInstallments       = p.totalInstallments;
            installmentInterval     = p.installmentInterval;
            installmentGracePeriod  = p.installmentGracePeriod;
            penaltyAprBps           = p.penaltyAprBps;
            defaultThresholdDays    = p.defaultThresholdDays;
            scheduleHash            = p.scheduleHash;

            emit InstallmentConfigSet(
                address(this),
                p.scheduleHash,
                p.totalInstallments,
                p.installmentInterval,
                p.installmentGracePeriod,
                p.penaltyAprBps
            );
        }

        // --- accounting ---
        principalOutstanding = 0;
        interestAccrued      = 0;
        lastAccrualTs        = 0;
        repaidTotal          = 0;

        status = UnifiedTypes.LoanStatus.CREATED;

        emit Initialized(
            p.borrower,
            p.principal,
            uint8(p.fundingModel),
            uint8(p.repaymentModel)
        );
    }

    // ── Funding ────────────────────────────────────────────────────────────

    /**
     * @notice Fund the loan (DIRECT or CROWDFUND models).
     * @dev    DIRECT: only one lender; may fund across multiple txs.
     *         CROWDFUND: many lenders; each records contribution.
     *         POOL: reverts — use `poolFund` instead.
     * @param amount Amount of `currency` to contribute.
     */
    function fund(uint256 amount)
        external
        nonReentrant
        whenLoanNotPaused
    {
        // Allow funding in CREATED (first tx) and FUNDING (subsequent txs)
        if (
            status != UnifiedTypes.LoanStatus.CREATED &&
            status != UnifiedTypes.LoanStatus.FUNDING
        ) {
            revert UnifiedErrors.InvalidLoanState(
                uint8(status),
                uint8(UnifiedTypes.LoanStatus.FUNDING)
            );
        }

        if (fundingModel == UnifiedTypes.FundingModel.POOL) {
            revert UnifiedErrors.UnsupportedOperation();
        }

        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        if (
            fundingDeadline != 0 &&
            block.timestamp > fundingDeadline
        ) revert UnifiedErrors.FundingDeadlinePassed();

        if (fundedAmount + amount > fundingTarget) {
            revert UnifiedErrors.LoanAlreadyFunded();
        }

        // DIRECT: enforce single-lender rule
        if (fundingModel == UnifiedTypes.FundingModel.DIRECT) {
            if (lenders.length > 0 && lenders[0] != msg.sender) {
                revert UnifiedErrors.Unauthorized();
            }
        }

        // Track contribution
        if (contributions[msg.sender] == 0) {
            lenders.push(msg.sender);
        }
        contributions[msg.sender] += amount;
        fundedAmount += amount;

        // Invariant: fundedAmount <= fundingTarget
        assert(fundedAmount <= fundingTarget);

        // Move tokens into this contract (escrow)
        currency.safeTransferFrom(msg.sender, address(this), amount);

        // Transition state
        if (status == UnifiedTypes.LoanStatus.CREATED) {
            status = UnifiedTypes.LoanStatus.FUNDING;
        }

        emit Funded(msg.sender, amount, fundedAmount);
    }

    /**
     * @notice Fund the loan from the pool (POOL model only).
     * @dev    Callable only by the designated pool address.
     * @param amount Amount of `currency` the pool supplies.
     */
    function poolFund(uint256 amount)
        external
        nonReentrant
        whenLoanNotPaused
        onlyPool
    {
        if (
            status != UnifiedTypes.LoanStatus.CREATED &&
            status != UnifiedTypes.LoanStatus.FUNDING
        ) {
            revert UnifiedErrors.InvalidLoanState(
                uint8(status),
                uint8(UnifiedTypes.LoanStatus.FUNDING)
            );
        }

        if (fundingModel != UnifiedTypes.FundingModel.POOL) {
            revert UnifiedErrors.UnsupportedOperation();
        }

        if (amount == 0) revert UnifiedErrors.ZeroAmount();
        if (fundedAmount + amount > fundingTarget) {
            revert UnifiedErrors.LoanAlreadyFunded();
        }

        fundedAmount += amount;

        // Invariant: fundedAmount <= fundingTarget
        assert(fundedAmount <= fundingTarget);

        // Pool transfers currency into the loan escrow
        currency.safeTransferFrom(msg.sender, address(this), amount);

        if (status == UnifiedTypes.LoanStatus.CREATED) {
            status = UnifiedTypes.LoanStatus.FUNDING;
        }

        emit Funded(msg.sender, amount, fundedAmount);
    }

    // ── Contribution Withdrawal (CROWDFUND) ────────────────────────────────

    /**
     * @notice Withdraw contribution from an expired CROWDFUND that did not
     *         reach its funding target.
     * @dev    Only available when:
     *         - fundingModel == CROWDFUND
     *         - fundingDeadline > 0 AND block.timestamp > fundingDeadline
     *         - fundedAmount < fundingTarget  (not fully funded)
     *         - caller has a non-zero contribution
     */
    function withdrawContribution()
        external
        nonReentrant
    {
        // Must be CROWDFUND
        if (fundingModel != UnifiedTypes.FundingModel.CROWDFUND) {
            revert UnifiedErrors.UnsupportedOperation();
        }

        // Must be in FUNDING (or CREATED with partial == 0, but that's moot)
        if (
            status != UnifiedTypes.LoanStatus.CREATED &&
            status != UnifiedTypes.LoanStatus.FUNDING
        ) {
            revert UnifiedErrors.InvalidLoanState(
                uint8(status),
                uint8(UnifiedTypes.LoanStatus.FUNDING)
            );
        }

        // Funding deadline must have passed
        if (fundingDeadline == 0 || block.timestamp <= fundingDeadline) {
            revert UnifiedErrors.FundingNotExpired();
        }

        // Must not be fully funded (if fully funded, proceed to activation)
        if (fundedAmount >= fundingTarget) {
            revert UnifiedErrors.LoanAlreadyFunded();
        }

        uint256 contribution = contributions[msg.sender];
        if (contribution == 0) revert UnifiedErrors.NotALender();

        contributions[msg.sender] = 0;
        fundedAmount -= contribution;

        // Transfer currency back to the lender
        currency.safeTransfer(msg.sender, contribution);

        emit ContributionWithdrawn(msg.sender, contribution);

        // If all contributions withdrawn, reset to CREATED
        if (fundedAmount == 0) {
            status = UnifiedTypes.LoanStatus.CREATED;
        }
    }

    // ── Activation & Disbursement ──────────────────────────────────────────

    /**
     * @notice Activate the loan and disburse principal to the borrower.
     * @dev    Requirements:
     *         1. `fundedAmount == fundingTarget`
     *         2. Collateral must already be locked in the vault.
     *         3. Caller must be borrower, the lender (DIRECT), or pool (POOL).
     *         Origination fee is deducted from principal and sent to treasury.
     */
    function activateAndDisburse()
        external
        nonReentrant
        whenLoanNotPaused
    {
        // Accept from FUNDING state only
        if (status != UnifiedTypes.LoanStatus.FUNDING) {
            revert UnifiedErrors.InvalidLoanState(
                uint8(status),
                uint8(UnifiedTypes.LoanStatus.FUNDING)
            );
        }

        // Restrict caller
        if (fundingModel == UnifiedTypes.FundingModel.DIRECT) {
            // borrower or the single lender
            if (msg.sender != borrower && (lenders.length == 0 || msg.sender != lenders[0])) {
                revert UnifiedErrors.Unauthorized();
            }
        } else if (fundingModel == UnifiedTypes.FundingModel.POOL) {
            // borrower or pool
            if (msg.sender != borrower && msg.sender != pool) {
                revert UnifiedErrors.Unauthorized();
            }
        } else {
            // CROWDFUND: borrower only
            if (msg.sender != borrower) revert UnifiedErrors.Unauthorized();
        }

        if (fundedAmount < fundingTarget) {
            revert UnifiedErrors.LoanNotFullyFunded();
        }

        // Verify collateral is locked and fully intact
        IUnifiedCollateralVault vault = IUnifiedCollateralVault(collateralVault);
        (, uint256 totalCol, uint256 remainingCol, bool isLocked) = vault.lockedByLoan(address(this));
        if (!isLocked) revert UnifiedErrors.CollateralNotLocked();
        // Collateral must be untouched at activation
        if (remainingCol != totalCol) revert UnifiedErrors.CollateralNotLocked();
        // Total must match the expected collateral amount
        if (totalCol != collateralAmount) revert UnifiedErrors.CollateralNotLocked();

        // Fiat settlement proof check
        if (requireFiatProofBeforeActivate && fiatDisbursementRef == bytes32(0)) {
            revert UnifiedErrors.FiatProofMissing();
        }

        // Installment config guard: INSTALLMENT loans must have config set
        if (
            repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT &&
            totalInstallments == 0
        ) {
            revert UnifiedErrors.InstallmentConfigNotSet();
        }

        // Activate
        status               = UnifiedTypes.LoanStatus.ACTIVE;
        startTs              = block.timestamp;
        principalOutstanding = principal;
        lastAccrualTs        = block.timestamp;

        // Invariant: principalOutstanding <= principal
        assert(principalOutstanding <= principal);

        emit Activated(borrower, block.timestamp);

        // Compute origination fee
        uint256 fee = IUnifiedFeeManager(feeManager).computeOriginationFee(principal);
        originationFeeCharged = fee;

        if (fee > 0) {
            // Send fee to treasury
            currency.safeTransfer(treasury, fee);
            emit OriginationFeePaid(treasury, fee);
        }

        // Disburse remaining to borrower
        uint256 disbursement = principal - fee;
        currency.safeTransfer(borrower, disbursement);

        emit Disbursed(borrower, disbursement);
    }

    // ── Repayment ──────────────────────────────────────────────────────────

    /**
     * @notice Repay part or all of the outstanding debt.
     * @dev    Accrues interest before applying the payment.
     *         Interest fees are routed to treasury.
     *         Automatically marks REPAID when debt reaches zero.
     * @param amount Amount of `currency` to repay.
     */
    function repay(uint256 amount)
        external
        nonReentrant
        onlyBorrower
        inStatus(UnifiedTypes.LoanStatus.ACTIVE)
    {
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        // For INSTALLMENT model, accrue late fees first using the previous
        // accrual boundary, then accrue regular interest.
        if (repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT) {
            _accrueLateFees();
        }
        _accrueInterest();

        uint256 debt = principalOutstanding + interestAccrued + lateFeeAccrued;
        if (amount > debt) revert UnifiedErrors.RepaymentExceedsDebt();

        // ── Allocation: late fees → interest → principal ──
        uint256 lateFeePortion;
        uint256 interestPortion;

        if (repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT && lateFeeAccrued > 0) {
            // 1. Late fees first
            if (amount <= lateFeeAccrued) {
                lateFeePortion = amount;
                lateFeeAccrued -= amount;
                amount = 0;
            } else {
                lateFeePortion = lateFeeAccrued;
                amount -= lateFeeAccrued;
                lateFeeAccrued = 0;
            }
        }

        // 2. Interest
        if (amount > 0) {
            if (amount <= interestAccrued) {
                interestPortion = amount;
                interestAccrued -= amount;
                amount = 0;
            } else {
                interestPortion = interestAccrued;
                amount -= interestAccrued;
                interestAccrued = 0;
            }
        }

        // 3. Principal
        uint256 principalPortion;
        if (amount > 0) {
            principalPortion = amount;
            principalOutstanding -= amount;
        }

        // Invariant: principalOutstanding <= principal
        assert(principalOutstanding <= principal);

        uint256 totalPaid = lateFeePortion + interestPortion + principalPortion;
        repaidTotal += totalPaid;

        // Pull tokens from borrower
        currency.safeTransferFrom(msg.sender, address(this), totalPaid);

        // Route interest + late-fee to treasury
        uint256 feeableInterest = interestPortion + lateFeePortion;
        if (feeableInterest > 0) {
            uint256 interestFee = IUnifiedFeeManager(feeManager).computeInterestFee(feeableInterest);
            if (interestFee > 0) {
                interestFeesTotal += interestFee;
                currency.safeTransfer(treasury, interestFee);
                emit InterestFeePaid(treasury, interestFee);
            }
        }

        // Notify pool of repayment (POOL model only)
        if (fundingModel == UnifiedTypes.FundingModel.POOL && pool != address(0)) {
            // Net interest = feeableInterest minus the fee already sent to treasury
            uint256 feeDeducted = feeableInterest > 0
                ? IUnifiedFeeManager(feeManager).computeInterestFee(feeableInterest)
                : 0;
            uint256 netInterest = feeableInterest - feeDeducted;

            uint256 toPool = principalPortion + netInterest;
            if (toPool > 0) {
                currency.safeTransfer(pool, toPool);
                IUnifiedPool(pool).onLoanRepayment(principalPortion, netInterest);
            }
        }

        uint256 remaining = principalOutstanding + interestAccrued + lateFeeAccrued;
        emit Repaid(msg.sender, totalPaid, remaining);
        emit RepaymentApplied(
            address(this),
            totalPaid,
            lateFeePortion,
            interestPortion,
            principalPortion,
            block.timestamp
        );

        // ── Installment tracking ──
        if (repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT && totalInstallments > 0) {
            // Compute how many installments are now fully covered by repaidTotal
            uint256 installmentPrincipal = principal / totalInstallments;
            uint256 newInstallmentsPaid = installmentPrincipal > 0
                ? _min(repaidTotal / installmentPrincipal, totalInstallments)
                : totalInstallments;

            if (newInstallmentsPaid > installmentsPaid) {
                for (uint256 i = installmentsPaid; i < newInstallmentsPaid; i++) {
                    emit InstallmentPaid(address(this), i + 1, installmentPrincipal, lateFeePortion);
                    // Reset late fee portion after first installment event
                    lateFeePortion = 0;
                }
                installmentsPaid = newInstallmentsPaid;
            }

            // Clear delinquency if caught up
            if (delinquentSince > 0) {
                uint256 expectedPaid = _installmentsDueCount();
                if (installmentsPaid >= expectedPaid) {
                    delinquentSince = 0;
                    emit LoanCured(address(this), installmentsPaid);
                }
            }
        }

        // Auto-transition when fully repaid
        if (remaining == 0) {
            status = UnifiedTypes.LoanStatus.REPAID;
        }
    }

    // ── Default ────────────────────────────────────────────────────────────

    /**
     * @notice Mark the loan as defaulted if overdue beyond the grace period.
     * @dev    Anyone may call this; it is a public-good liquidation trigger.
     */
    function markDefault()
        external
        nonReentrant
        inStatus(UnifiedTypes.LoanStatus.ACTIVE)
    {
        if (repaymentModel == UnifiedTypes.RepaymentModel.INSTALLMENT && totalInstallments > 0) {
            // Installment path: check delinquency duration
            _checkDelinquency();
            if (delinquentSince == 0) {
                revert UnifiedErrors.GracePeriodNotElapsed();
            }
            uint256 delinquentDuration = block.timestamp - delinquentSince;
            uint256 thresholdSec = defaultThresholdDays * 1 days;
            if (delinquentDuration < thresholdSec) {
                revert UnifiedErrors.DelinquencyThresholdNotReached();
            }

            _accrueLateFees();
            _accrueInterest();

            status = UnifiedTypes.LoanStatus.DEFAULTED;

            uint256 delinquentDays = delinquentDuration / 1 days;
            // installmentIndex = first unpaid installment (1-indexed)
            uint256 defaultInstIdx = installmentsPaid + 1;
            emit LoanDefaulted(address(this), defaultInstIdx, delinquentDays);
            emit Defaulted(block.timestamp);
        } else {
            // Bullet path: maturity + grace
            uint256 maturity = startTs + duration + gracePeriod;
            if (block.timestamp < maturity) {
                revert UnifiedErrors.GracePeriodNotElapsed();
            }

            _accrueInterest();

            status = UnifiedTypes.LoanStatus.DEFAULTED;

            uint256 daysPastMaturity = (block.timestamp - maturity) / 1 days;
            emit LoanDefaulted(address(this), 0, daysPastMaturity);
            emit Defaulted(block.timestamp);
        }
    }

    // ── Collateral Claim ───────────────────────────────────────────────────

    /**
     * @notice Claim collateral after default.
     * @dev    For DIRECT the single lender claims entire collateral.
     *         For POOL the pool address claims entire collateral.
     *         For CROWDFUND each lender claims a pro-rata share; loan auto-
     *         closes when all collateral has been claimed.
     *         Tracks `collateralClaimedTotal` and reverts with OverClaim if
     *         total would exceed `collateralAmount`.
     */
    function claimCollateral()
        external
        nonReentrant
        inStatus(UnifiedTypes.LoanStatus.DEFAULTED)
    {
        IUnifiedCollateralVault vault = IUnifiedCollateralVault(collateralVault);
        (, , uint256 vaultRemaining, ) = vault.lockedByLoan(address(this));

        if (fundingModel == UnifiedTypes.FundingModel.POOL) {
            // Only the pool may claim
            if (msg.sender != pool) revert UnifiedErrors.Unauthorized();

            // Seize whatever the vault still holds
            uint256 seizeAmt = vaultRemaining;
            if (seizeAmt == 0) revert UnifiedErrors.NothingToClaim();

            if (collateralClaimedTotal + seizeAmt > collateralAmount) {
                revert UnifiedErrors.OverClaim();
            }

            vault.seizeCollateral(address(this), pool, seizeAmt);
            collateralClaimedTotal += seizeAmt;
            assert(collateralClaimedTotal <= collateralAmount);
            emit CollateralClaimed(pool, seizeAmt);

            // Auto-close
            status = UnifiedTypes.LoanStatus.CLOSED;
            emit Closed(block.timestamp);

        } else if (fundingModel == UnifiedTypes.FundingModel.DIRECT) {
            // Single lender claims all remaining
            uint256 contribution = contributions[msg.sender];
            if (contribution == 0) revert UnifiedErrors.NotALender();

            uint256 seizeAmt = vaultRemaining;
            if (seizeAmt == 0) revert UnifiedErrors.NothingToClaim();

            if (collateralClaimedTotal + seizeAmt > collateralAmount) {
                revert UnifiedErrors.OverClaim();
            }

            contributions[msg.sender] = 0;
            collateralClaimedTotal += seizeAmt;
            assert(collateralClaimedTotal <= collateralAmount);
            vault.seizeCollateral(address(this), msg.sender, seizeAmt);
            emit CollateralClaimed(msg.sender, seizeAmt);

            // Auto-close
            status = UnifiedTypes.LoanStatus.CLOSED;
            emit Closed(block.timestamp);

        } else {
            // CROWDFUND: pro-rata claim based on fundedAmount
            uint256 contribution = contributions[msg.sender];
            if (contribution == 0) revert UnifiedErrors.NotALender();

            uint256 share = (collateralAmount * contribution) / fundedAmount;
            // Cap to vault remaining (dust-safe)
            if (share > vaultRemaining) {
                share = vaultRemaining;
            }
            if (share == 0) revert UnifiedErrors.NothingToClaim();

            if (collateralClaimedTotal + share > collateralAmount) {
                revert UnifiedErrors.OverClaim();
            }

            // Zero-out to prevent re-claim
            contributions[msg.sender] = 0;
            collateralClaimedTotal += share;
            assert(collateralClaimedTotal <= collateralAmount);

            vault.seizeCollateral(address(this), msg.sender, share);
            emit CollateralClaimed(msg.sender, share);

            // Check if vault is now empty => auto-close
            (, , uint256 afterRemaining, ) = vault.lockedByLoan(address(this));
            if (afterRemaining == 0) {
                status = UnifiedTypes.LoanStatus.CLOSED;
                emit Closed(block.timestamp);
            }
        }
    }

    // ── Close ──────────────────────────────────────────────────────────────

    /**
     * @notice Close the loan after full repayment.
     * @dev    Releases collateral back to borrower and distributes
     *         escrowed repayment tokens to lender(s) / pool.
     */
    function close()
        external
        nonReentrant
        inStatus(UnifiedTypes.LoanStatus.REPAID)
    {
        // Guard: collateral must be fully intact (no partial seizures)
        IUnifiedCollateralVault vault = IUnifiedCollateralVault(collateralVault);
        (, uint256 totalCol, uint256 remainingCol, bool isLocked) = vault.lockedByLoan(address(this));
        if (isLocked && remainingCol != totalCol) {
            revert UnifiedErrors.CollateralNotLocked();
        }

        status = UnifiedTypes.LoanStatus.CLOSED;

        // Release collateral to borrower
        IUnifiedCollateralVault(collateralVault).releaseCollateral(
            address(this),
            borrower
        );

        // Distribute escrowed repayment to lenders / pool
        uint256 balance = currency.balanceOf(address(this));
        if (balance > 0) {
            if (fundingModel == UnifiedTypes.FundingModel.POOL) {
                currency.safeTransfer(pool, balance);
            } else {
                // Pro-rata to each lender
                for (uint256 i = 0; i < lenders.length; i++) {
                    address lender = lenders[i];
                    uint256 contribution = contributions[lender];
                    if (contribution == 0) continue;
                    uint256 share = (balance * contribution) / fundingTarget;
                    if (share > 0) {
                        currency.safeTransfer(lender, share);
                    }
                }
            }
        }

        emit Closed(block.timestamp);
    }

    // ── Interest Accrual ───────────────────────────────────────────────────

    /**
     * @notice Accrue simple interest up to the current block timestamp.
     * @dev    Formula: interestAccrued += principalOutstanding * aprBps * dt / (365 days * 10_000)
     */
    function accrueInterest() public {
        _accrueInterest();
    }

    function _accrueInterest() internal {
        if (
            status != UnifiedTypes.LoanStatus.ACTIVE ||
            lastAccrualTs == 0
        ) return;

        uint256 dt = block.timestamp - lastAccrualTs;
        if (dt == 0) return;

        uint256 accruedNow = (principalOutstanding * aprBps * dt) /
            (365 days * 10_000);

        interestAccrued += accruedNow;
        lastAccrualTs = block.timestamp;
    }

    // ── View Helpers ───────────────────────────────────────────────────────

    /// @notice Number of distinct lenders.
    function lenderCount() external view returns (uint256) {
        return lenders.length;
    }

    /// @notice Total outstanding debt (principal + accrued interest snapshot).
    function totalDebt() external view returns (uint256) {
        return principalOutstanding + interestAccrued;
    }

    // ── Installment Helpers ──────────────────────────────────────────────

    /**
     * @notice Check and update delinquency status for installment loans.
     * @dev    Compares installments due vs installments paid. If behind
     *         and past the per-installment grace period → mark delinquent.
     */
    function checkDelinquency() external {
        _checkDelinquency();
    }

    function _checkDelinquency() internal {
        if (status != UnifiedTypes.LoanStatus.ACTIVE) return;
        if (repaymentModel != UnifiedTypes.RepaymentModel.INSTALLMENT) return;
        if (totalInstallments == 0) return;

        uint256 due = _installmentsDueCount();
        if (installmentsPaid < due) {
            // Determine if past the grace period for the oldest unpaid installment
            uint256 unpaidIdx = installmentsPaid; // 0-indexed
            uint256 dueDate = startTs + (unpaidIdx + 1) * installmentInterval;
            uint256 gracedDeadline = dueDate + installmentGracePeriod;

            if (block.timestamp > gracedDeadline && delinquentSince == 0) {
                delinquentSince = gracedDeadline;
                uint256 daysPast = (block.timestamp - gracedDeadline) / 1 days;
                emit LoanDelinquent(address(this), unpaidIdx + 1, daysPast);
            }
        }
    }

    /**
     * @notice Accrue late fees (penalty interest) when delinquent.
     * @dev    Uses penaltyAprBps on principalOutstanding.
     */
    function _accrueLateFees() internal {
        if (delinquentSince == 0 || penaltyAprBps == 0) return;
        if (status != UnifiedTypes.LoanStatus.ACTIVE) return;

        uint256 dt = block.timestamp - _max(delinquentSince, lastAccrualTs);
        if (dt == 0) return;

        uint256 penalty = (principalOutstanding * penaltyAprBps * dt) /
            (365 days * 10_000);
        lateFeeAccrued += penalty;
    }

    /**
     * @notice Number of installments that should have been paid by now.
     * @return count Number due (capped at totalInstallments).
     */
    function _installmentsDueCount() internal view returns (uint256 count) {
        if (startTs == 0 || installmentInterval == 0) return 0;
        uint256 elapsed = block.timestamp - startTs;
        count = elapsed / installmentInterval;
        if (count > totalInstallments) count = totalInstallments;
    }

    /**
     * @notice Public view: number of installments due at the current timestamp.
     */
    function installmentsDueCount() external view returns (uint256) {
        return _installmentsDueCount();
    }

    /**
     * @notice Public view: amount due for the next installment (principal portion).
     */
    function installmentAmount() external view returns (uint256) {
        if (totalInstallments == 0) return 0;
        return principal / totalInstallments;
    }

    /**
     * @notice Public view: due date for a specific installment number (1-indexed).
     */
    function installmentDueDate(uint256 installmentNumber) external view returns (uint256) {
        if (installmentNumber == 0 || installmentNumber > totalInstallments) return 0;
        return startTs + installmentNumber * installmentInterval;
    }

    /**
     * @notice Public view: total outstanding debt including late fees.
     */
    function totalDebtWithFees() external view returns (uint256) {
        return principalOutstanding + interestAccrued + lateFeeAccrued;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ── Collateral Locking ────────────────────────────────────────────────

    /**
     * @notice Borrower-friendly wrapper: pulls collateral from the borrower
     *         into the vault and marks the loan as collateral-locked.
     *
     * @dev Requirements:
     *   - Caller must be the borrower.
     *   - Loan must be in CREATED or FUNDING state.
     *   - Collateral must not have been locked already.
     *
     *  The vault's `lockCollateral` will pull `collateralAmount` of
     *  `collateralAsset` from the borrower; the borrower must have
     *  approved the vault for at least that amount beforehand.
     */
    function lockCollateral() external nonReentrant {
        if (msg.sender != borrower) revert UnifiedErrors.NotBorrower();
        // Check already-locked before status so a borrower always gets the
        // most informative error regardless of the current loan state.
        if (collateralLocked) revert UnifiedErrors.AlreadyLocked();
        if (
            status != UnifiedTypes.LoanStatus.CREATED &&
            status != UnifiedTypes.LoanStatus.FUNDING
        ) revert UnifiedErrors.InvalidStatus();

        collateralLocked = true;

        IUnifiedCollateralVault(collateralVault).lockCollateral(
            address(this),
            collateralAsset,
            collateralAmount,
            borrower
        );

        emit CollateralLocked(address(this), borrower, collateralAsset, collateralAmount);
    }

    // ── Pause Control ──────────────────────────────────────────────────────

    /**
     * @notice Pause or unpause this loan. Only callable by the designated pauser.
     * @param _paused True to pause, false to unpause.
     */
    function setPaused(bool _paused) external {
        if (msg.sender != pauser) revert UnifiedErrors.Unauthorized();
        loanPaused = _paused;
        if (_paused) {
            emit LoanPausedEvent(msg.sender);
        } else {
            emit LoanUnpausedEvent(msg.sender);
        }
    }

    // ── Settlement Proof Hooks ────────────────────────────────────────────

    /**
     * @notice Record fiat disbursement proof. Required before activation
     *         when `requireFiatProof` is enabled.
     * @param ref  Hash of the provider settlement reference (no PII).
     */
    function recordFiatDisbursement(bytes32 ref) external onlySettlementAgent notTerminal {
        if (ref == bytes32(0)) revert UnifiedErrors.ZeroAmount();
        if (fiatDisbursementRef != bytes32(0)) revert UnifiedErrors.FiatProofAlreadyRecorded();
        fiatDisbursementRef = ref;
        fiatDisbursedAt = block.timestamp;
        fiatRefUsed[ref] = true;
        emit FiatDisbursementRecorded(address(this), ref, block.timestamp);
        emit FiatActionRecorded(address(this), ref, 0, block.timestamp);
    }

    /**
     * @notice Record fiat repayment proof.
     * @param ref  Hash of the provider settlement reference (no PII).
     */
    function recordFiatRepayment(bytes32 ref) external onlySettlementAgent notTerminal {
        if (ref == bytes32(0)) revert UnifiedErrors.ZeroAmount();
        if (fiatRefUsed[ref]) revert UnifiedErrors.FiatRefAlreadyUsed(ref);
        fiatRefUsed[ref] = true;
        lastFiatRepaymentRef = ref;
        emit FiatRepaymentRecorded(address(this), ref, block.timestamp);
        emit FiatActionRecorded(address(this), ref, 1, block.timestamp);
    }
}
