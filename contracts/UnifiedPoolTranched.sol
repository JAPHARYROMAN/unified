// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUnifiedPool.sol";
import "./interfaces/IUnifiedLoan.sol";
import "./interfaces/ICircuitBreaker.sol";
import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";
import "./libraries/TrancheTypes.sol";

/**
 * @title UnifiedPoolTranched
 * @notice Two-tier (Senior / Junior) USDC liquidity pool with per-tranche
 *         share accounting, cashflow waterfall, subordination-based loss
 *         absorption, and indexed withdrawal queues.
 *
 * @dev Implements `IUnifiedPool` so that downstream `UnifiedLoan` and
 *      `UnifiedLoanFactory` contracts require zero modifications.
 *
 *      Key design invariants (see docs/tranche-architecture-v1.2.md §15.1):
 *
 *        INV-CASH: sr.virtualBalance + jr.virtualBalance == usdc.balanceOf(this)
 *        INV-CLAIMS: claims ledger must reconcile and remain net-of-bad-debt
 *        INV-2: t.principalAllocated >= t.principalRepaid
 *        INV-3: sr.badDebt + jr.badDebt == totalBadDebt
 *        INV-4: Junior absorbs losses first; Senior only after Junior NAV == 0
 *        INV-5: sum(positions[*][t].shares) == tranches[t].totalShares
 *        INV-6: interestEarned is never decremented by loss events
 *
 *      v1.2.1 additions:
 *        INV-7: allocateToLoan MUST revert if post-allocation coverage < floor
 *        INV-8: sr.badDebt > 0 ⇒ emergency pause + stress (zero-tolerance)
 *
 *      Capital Preservation > Yield Optimization.
 *      Favor over-collateralization. Favor explicit math. Favor determinism.
 */
contract UnifiedPoolTranched is AccessControl, Pausable, ReentrancyGuard, IUnifiedPool {
    using SafeERC20 for IERC20;
    using TrancheTypes for TrancheTypes.Tranche;

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public constant BPS = 10_000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_OPEN_REQUESTS = 50;

    /// @notice Hard bounds for seniorAllocationBps (governance cannot set outside).
    uint256 public constant MIN_SENIOR_ALLOCATION_BPS = 5000; // 50%
    uint256 public constant MAX_SENIOR_ALLOCATION_BPS = 9000; // 90%

    // ═══════════════════════════════════════════════════════════════════════
    //                                ROLES
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant PAUSER_ROLE        = keccak256("PAUSER_ROLE");
    bytes32 public constant ALLOCATOR_ROLE     = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant LOAN_ROLE          = keccak256("LOAN_ROLE");
    bytes32 public constant LOAN_REGISTRAR_ROLE = keccak256("LOAN_REGISTRAR_ROLE");
    bytes32 public constant DEPOSITOR_ROLE     = keccak256("DEPOSITOR_ROLE");

    // ═══════════════════════════════════════════════════════════════════════
    //                             IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Stablecoin used by the pool (e.g. USDC, 6 decimals).
    IERC20 public immutable usdc;

    /// @notice Partner identifier bound to this pool (set once).
    bytes32 public immutable partnerId;

    // ═══════════════════════════════════════════════════════════════════════
    //                           TRANCHE STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Fixed-size array indexed by Tranche ordinal (0 = Senior, 1 = Junior).
    TrancheTypes.TrancheState[2] internal _tranches;

    /// @notice Per-user, per-tranche positions.
    ///         user → tranche ordinal → position.
    mapping(address => mapping(uint256 => TrancheTypes.TranchePosition)) public positions;

    /// @notice Withdrawal queue per tranche. tranche ordinal → requestId → request.
    mapping(uint256 => mapping(uint256 => UnifiedTypes.WithdrawRequest)) internal _withdrawRequests;

    /// @notice Shares locked in pending withdraw requests. tranche → user → shares.
    mapping(uint256 => mapping(address => uint256)) public pendingShares;

    /// @notice Open (unfulfilled) request count per tranche per user.
    mapping(uint256 => mapping(address => uint256)) public openRequestCount;

    /// @notice Index+1 of last open request per tranche per user (0 = none).
    mapping(uint256 => mapping(address => uint256)) public lastOpenRequestIndex;

    // ═══════════════════════════════════════════════════════════════════════
    //                        GLOBAL LOAN LEDGER
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public totalPrincipalAllocated;
    uint256 public totalPrincipalRepaidToPool;
    uint256 public totalInterestRepaidToPool;
    uint256 public totalBadDebt;
    mapping(address => uint256) public principalOutstandingByLoan;

    // ═══════════════════════════════════════════════════════════════════════
    //                        TRANCHE POLICY PARAMS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Percentage of each loan allocation charged to Senior (bps).
    ///         E.g. 7000 = 70% Senior, 30% Junior.
    uint256 public seniorAllocationBps = 7000;

    /// @notice Minimum subordination ratio (juniorNAV / totalNAV) in bps.
    uint256 public minSubordinationBps = 2000;

    /// @notice Junior coverage floor: (jr.virtualBalance * BPS) / sr.virtualBalance >= this.
    uint256 public juniorCoverageFloorBps = 750;

    /// @notice Assumed recovery rate used for informational events (bps, e.g. 3000 = 30%).
    uint256 public recoveryRateAssumptionPct = 3000;

    /// @notice Senior liquidity floor bps — allocation blocked if breached.
    uint256 public seniorLiquidityFloorBps = 1000;

    // ═══════════════════════════════════════════════════════════════════════
    //                        STRESS / PRIORITY STATE
    // ═══════════════════════════════════════════════════════════════════════

    bool    public stressMode;
    uint256 public juniorNavDrawdownCapBps   = 3000;
    uint256 public seniorNavDrawdownCapBps   = 500;
    uint256 public juniorHighWaterMark;

    bool    public seniorPriorityActive;
    uint256 public seniorPriorityActivatedAt;
    uint256 public seniorPriorityMaxDuration = 30 days;

    /// @notice Optional external circuit-breaker contract (address(0) = disabled).
    ICircuitBreaker public breaker;

    /// @notice Per-loan bad debt attribution.  loan → [srBadDebt, jrBadDebt].
    mapping(address => uint256[2]) public loanBadDebt;

    /// @notice Pool creation timestamp — used as the interest epoch start.
    uint256 public immutable deployedAt;

    /// @notice Once true, critical launch parameters are immutable.
    bool public launchLocked;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event TrancheDeposited(uint8 indexed tranche, address indexed user, uint256 amount, uint256 shares);
    event TrancheWithdrawn(uint8 indexed tranche, address indexed user, uint256 amount, uint256 shares);
    event Allocated(address indexed loan, uint256 amount);
    event RepaidToPool(address indexed loan, uint256 amount);
    event BadDebtRecorded(address indexed loan, uint256 amount);
    event LoanRoleSet(address indexed loan, bool allowed);

    event WaterfallDistributed(
        address indexed loan,
        uint256 seniorPrincipal,
        uint256 seniorInterest,
        uint256 juniorPrincipal,
        uint256 juniorInterest
    );
    event LossAbsorbed(uint8 indexed tranche, address indexed loan, uint256 amount);

    event StressModeActivated(uint256 timestamp);
    event StressModeDeactivated(uint256 timestamp);
    event SubordinationBreach(uint256 currentRatio, uint256 minimumRequired);
    event SeniorPriorityActivated(uint256 timestamp);
    event SeniorPriorityCleared(uint256 timestamp);
    event SeniorPriorityExpired(uint256 timestamp);

    event WithdrawRequested(uint8 indexed tranche, address indexed user, uint256 indexed requestId, uint256 shares);
    event WithdrawCoalesced(uint8 indexed tranche, address indexed user, uint256 addedShares, uint256 newTotalShares, uint256 indexed index);
    event WithdrawCancelled(uint8 indexed tranche, address indexed user, uint256 indexed requestId, uint256 shares);
    event WithdrawFulfilled(uint8 indexed tranche, address indexed user, uint256 indexed requestId, uint256 shares, uint256 assets);

    event CollateralRecoveryDistributed(
        address indexed loan,
        uint256 seniorRecovery,
        uint256 juniorRecovery,
        uint256 residual
    );

    event CoverageFloorBreached(uint256 current, uint256 required);
    event SeniorImpairmentDetected(uint256 srBadDebt, uint256 timestamp);
    event LaunchParametersLockedEvent(uint256 timestamp);
    event InvariantChecked(uint8 code, bool passed);

    // ═══════════════════════════════════════════════════════════════════════
    //                            CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @param admin       Default admin & initial role holder.
     * @param _usdc       USDC (or other stablecoin) address.
     * @param _partnerId  Partner identifier bound to this pool.
     * @param _seniorTargetYieldBps  Senior maximum annualised yield (bps).
     */
    constructor(
        address admin,
        address _usdc,
        bytes32 _partnerId,
        uint256 _seniorTargetYieldBps
    ) {
        if (admin == address(0) || _usdc == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(ALLOCATOR_ROLE, admin);

        usdc       = IERC20(_usdc);
        partnerId  = _partnerId;
        deployedAt = block.timestamp;

        _tranches[0].targetYieldBps = _seniorTargetYieldBps;
        // Junior has no yield cap (0 = uncapped, the default).
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                           MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier validTranche(TrancheTypes.Tranche t) {
        if (uint256(t) > 1) revert UnifiedErrors.InvalidTranche();
        _;
    }

    modifier whenBreakerAllows() {
        if (address(breaker) != address(0)) {
            ICircuitBreaker.BreakerState bs = breaker.stateOf(address(this));
            if (bs == ICircuitBreaker.BreakerState.GLOBAL_HARD_STOP) {
                revert UnifiedErrors.BreakerBlocked(uint8(bs));
            }
        }
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IUnifiedPool
    function setLoanRole(address loan, bool allowed) external override {
        if (
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender) &&
            !hasRole(LOAN_REGISTRAR_ROLE, msg.sender)
        ) revert UnifiedErrors.Unauthorized();
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        if (allowed) {
            _grantRole(LOAN_ROLE, loan);
        } else {
            _revokeRole(LOAN_ROLE, loan);
        }
        emit LoanRoleSet(loan, allowed);
    }

    function setBreaker(address _breaker) external onlyRole(DEFAULT_ADMIN_ROLE) {
        breaker = ICircuitBreaker(_breaker);
    }

    function setSeniorAllocationBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (launchLocked) revert UnifiedErrors.LaunchParametersLocked();
        if (bps < MIN_SENIOR_ALLOCATION_BPS || bps > MAX_SENIOR_ALLOCATION_BPS) {
            revert UnifiedErrors.AllocationRatioOutOfBounds(bps, MIN_SENIOR_ALLOCATION_BPS, MAX_SENIOR_ALLOCATION_BPS);
        }
        seniorAllocationBps = bps;
    }

    function setSeniorTargetYield(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (launchLocked) revert UnifiedErrors.LaunchParametersLocked();
        _tranches[0].targetYieldBps = bps;
    }

    function setMinSubordinationBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (launchLocked) revert UnifiedErrors.LaunchParametersLocked();
        if (bps > BPS) revert UnifiedErrors.InvalidConfiguration();
        minSubordinationBps = bps;
    }

    function setJuniorCoverageFloorBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (launchLocked) revert UnifiedErrors.LaunchParametersLocked();
        if (bps > BPS) revert UnifiedErrors.InvalidConfiguration();
        juniorCoverageFloorBps = bps;
    }

    function setSeniorLiquidityFloorBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS) revert UnifiedErrors.InvalidConfiguration();
        seniorLiquidityFloorBps = bps;
    }

    function setJuniorNavDrawdownCapBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS) revert UnifiedErrors.InvalidConfiguration();
        juniorNavDrawdownCapBps = bps;
    }

    function setSeniorNavDrawdownCapBps(uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > BPS) revert UnifiedErrors.InvalidConfiguration();
        seniorNavDrawdownCapBps = bps;
    }

    function setTrancheDepositCap(TrancheTypes.Tranche t, uint256 cap)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        validTranche(t)
    {
        _tranches[uint256(t)].depositCap = cap;
    }

    function setStressMode(bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stressMode = active;
        if (active) {
            seniorPriorityActive = true;
            seniorPriorityActivatedAt = block.timestamp;
            emit StressModeActivated(block.timestamp);
            emit SeniorPriorityActivated(block.timestamp);
        } else {
            emit StressModeDeactivated(block.timestamp);
        }
    }

    function clearSeniorPriority() external onlyRole(DEFAULT_ADMIN_ROLE) {
        seniorPriorityActive = false;
        emit SeniorPriorityCleared(block.timestamp);
    }

    function setSeniorPriorityMaxDuration(uint256 secs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        seniorPriorityMaxDuration = secs;
    }

    /**
     * @notice Permanently lock critical launch parameters.
     *         Once called, `seniorAllocationBps`, `seniorTargetYieldBps`,
     *         `minSubordinationBps`, and `juniorCoverageFloorBps` cannot
     *         be modified. This is a one-way operation.
     */
    function lockLaunchParameters() external onlyRole(DEFAULT_ADMIN_ROLE) {
        launchLocked = true;
        emit LaunchParametersLockedEvent(block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                             VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Liquid USDC held by the pool.
    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Total principal currently deployed in loans (pool-wide).
    function totalPrincipalOutstanding() public view returns (uint256) {
        return totalPrincipalAllocated - totalPrincipalRepaidToPool;
    }

    /// @notice NAV of a single tranche.
    function trancheNAV(TrancheTypes.Tranche t) public view validTranche(t) returns (uint256) {
        TrancheTypes.TrancheState storage ts = _tranches[uint256(t)];
        uint256 outstanding = ts.principalAllocated - ts.principalRepaid;
        uint256 gross = ts.virtualBalance + outstanding;
        return gross > ts.badDebt ? gross - ts.badDebt : 0;
    }

    /// @notice Combined pool NAV (sr + jr).
    function totalAssetsNAV() public view returns (uint256) {
        return trancheNAV(TrancheTypes.Tranche.Senior) + trancheNAV(TrancheTypes.Tranche.Junior);
    }

    /// @notice Share price for a given tranche (18-decimal precision).
    function trancheSharePrice(TrancheTypes.Tranche t) public view validTranche(t) returns (uint256) {
        TrancheTypes.TrancheState storage ts = _tranches[uint256(t)];
        if (ts.totalShares == 0) return 1e18;
        return (trancheNAV(t) * 1e18) / ts.totalShares;
    }

    /// @notice Virtual USDC attributable to a tranche (not deployed in loans).
    function trancheAvailableLiquidity(TrancheTypes.Tranche t) public view validTranche(t) returns (uint256) {
        return _tranches[uint256(t)].virtualBalance;
    }

    /// @notice Total shares of a tranche.
    function trancheTotalShares(TrancheTypes.Tranche t) public view validTranche(t) returns (uint256) {
        return _tranches[uint256(t)].totalShares;
    }

    /// @notice Convert assets → shares for a given tranche.
    function convertToShares(TrancheTypes.Tranche t, uint256 assetAmount) public view validTranche(t) returns (uint256) {
        if (assetAmount == 0) return 0;
        TrancheTypes.TrancheState storage ts = _tranches[uint256(t)];
        uint256 nav = trancheNAV(t);
        if (ts.totalShares == 0 || nav == 0) return assetAmount; // 1:1 bootstrap
        return (assetAmount * ts.totalShares) / nav;
    }

    /// @notice Convert shares → assets for a given tranche.
    function convertToAssets(TrancheTypes.Tranche t, uint256 shareAmount) public view validTranche(t) returns (uint256) {
        TrancheTypes.TrancheState storage ts = _tranches[uint256(t)];
        if (shareAmount == 0 || ts.totalShares == 0) return 0;
        return (shareAmount * trancheNAV(t)) / ts.totalShares;
    }

    /// @notice Current subordination ratio (juniorNAV / totalNAV) in bps.
    function subordinationRatio() public view returns (uint256) {
        uint256 srNAV = trancheNAV(TrancheTypes.Tranche.Senior);
        uint256 jrNAV = trancheNAV(TrancheTypes.Tranche.Junior);
        uint256 total = srNAV + jrNAV;
        if (total == 0) return BPS; // no assets, full subordination
        return (jrNAV * BPS) / total;
    }

    /// @notice Coverage ratio = jr.virtualBalance * BPS / sr.virtualBalance.
    function coverageRatio() public view returns (uint256) {
        uint256 srBal = _tranches[0].virtualBalance;
        if (srBal == 0) return type(uint256).max;
        return (_tranches[1].virtualBalance * BPS) / srBal;
    }

    /// @notice Number of queued withdraw requests (including fulfilled) for a tranche.
    function withdrawRequestCount(TrancheTypes.Tranche t) external view validTranche(t) returns (uint256) {
        return _tranches[uint256(t)].withdrawQueueLength;
    }

    /// @notice Free (non-locked) shares for a user in a tranche.
    function freeShares(TrancheTypes.Tranche t, address user) external view validTranche(t) returns (uint256) {
        uint256 ti = uint256(t);
        return positions[user][ti].shares - pendingShares[ti][user];
    }

    /// @notice Read a withdraw request.
    function getWithdrawRequest(TrancheTypes.Tranche t, uint256 requestId)
        external
        view
        validTranche(t)
        returns (address user, uint256 shares, bool fulfilled)
    {
        UnifiedTypes.WithdrawRequest storage r = _withdrawRequests[uint256(t)][requestId];
        return (r.user, r.shares, r.fulfilled);
    }

    /// @notice Expose tranche state for external consumers.
    function getTrancheState(TrancheTypes.Tranche t)
        external
        view
        validTranche(t)
        returns (
            uint256 totalShares_,
            uint256 virtualBalance_,
            uint256 principalAllocated_,
            uint256 principalRepaid_,
            uint256 interestEarned_,
            uint256 badDebt_,
            uint256 targetYieldBps_,
            uint256 depositCap_
        )
    {
        TrancheTypes.TrancheState storage ts = _tranches[uint256(t)];
        return (
            ts.totalShares,
            ts.virtualBalance,
            ts.principalAllocated,
            ts.principalRepaid,
            ts.interestEarned,
            ts.badDebt,
            ts.targetYieldBps,
            ts.depositCap
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                             DEPOSIT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit USDC into a specific tranche.
     * @param t      Target tranche (Senior or Junior).
     * @param amount USDC amount (caller must have approved the pool).
     */
    function deposit(TrancheTypes.Tranche t, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        whenBreakerAllows
        validTranche(t)
    {
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        uint256 ti = uint256(t);
        TrancheTypes.TrancheState storage ts = _tranches[ti];

        // ── Deposit cap check ──
        if (ts.depositCap > 0 && ts.virtualBalance + amount > ts.depositCap) {
            revert UnifiedErrors.TrancheDepositCapExceeded(uint8(ti), ts.virtualBalance, ts.depositCap);
        }

        // ── Senior subordination guardrail ──
        if (t == TrancheTypes.Tranche.Senior) {
            uint256 jrNAV = trancheNAV(TrancheTypes.Tranche.Junior);
            if (jrNAV == 0) revert UnifiedErrors.SubordinationTooLow(0, minSubordinationBps);
            uint256 newSrNAV = trancheNAV(TrancheTypes.Tranche.Senior) + amount;
            uint256 totalNAV = newSrNAV + jrNAV;
            uint256 ratio = (jrNAV * BPS) / totalNAV;
            if (ratio < minSubordinationBps) {
                revert UnifiedErrors.SubordinationTooLow(ratio, minSubordinationBps);
            }
        }

        // Snapshot shares before transfer changes balanceOf
        uint256 sharesToMint = convertToShares(t, amount);

        // Pull USDC from depositor
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        ts.totalShares += sharesToMint;
        ts.virtualBalance += amount;
        positions[msg.sender][ti].shares += sharesToMint;
        positions[msg.sender][ti].cumulativeDeposited += amount;

        // Update Junior high-water mark
        if (t == TrancheTypes.Tranche.Junior && _tranches[1].virtualBalance > juniorHighWaterMark) {
            juniorHighWaterMark = _tranches[1].virtualBalance;
        }

        emit TrancheDeposited(uint8(ti), msg.sender, amount, sharesToMint);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                            WITHDRAW
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Burn shares and withdraw proportional USDC from a tranche.
     * @param t           Target tranche.
     * @param shareAmount Number of shares to redeem.
     */
    function withdraw(TrancheTypes.Tranche t, uint256 shareAmount)
        external
        nonReentrant
        whenNotPaused
        whenBreakerAllows
        validTranche(t)
    {
        if (shareAmount == 0) revert UnifiedErrors.ZeroAmount();
        if (stressMode) revert UnifiedErrors.StressModeLocked();

        uint256 ti = uint256(t);
        TrancheTypes.TranchePosition storage pos = positions[msg.sender][ti];
        if (pos.shares < shareAmount) revert UnifiedErrors.InsufficientShares();

        uint256 free = pos.shares - pendingShares[ti][msg.sender];
        if (shareAmount > free) revert UnifiedErrors.InsufficientFreeShares();

        uint256 assetsOut = convertToAssets(t, shareAmount);
        TrancheTypes.TrancheState storage ts = _tranches[ti];

        if (assetsOut > ts.virtualBalance) revert UnifiedErrors.InsufficientTrancheLiquidity(uint8(ti));

        // ── Junior withdrawal subordination guardrail ──
        if (t == TrancheTypes.Tranche.Junior) {
            uint256 srNAV    = trancheNAV(TrancheTypes.Tranche.Senior);
            uint256 newJrNAV = trancheNAV(TrancheTypes.Tranche.Junior) - assetsOut;
            uint256 totalNAV = srNAV + newJrNAV;
            if (totalNAV > 0) {
                uint256 ratio = (newJrNAV * BPS) / totalNAV;
                if (ratio < minSubordinationBps) {
                    revert UnifiedErrors.SubordinationTooLow(ratio, minSubordinationBps);
                }
            }
        }

        pos.shares -= shareAmount;
        pos.cumulativeWithdrawn += assetsOut;
        ts.totalShares -= shareAmount;
        ts.virtualBalance -= assetsOut;

        usdc.safeTransfer(msg.sender, assetsOut);

        emit TrancheWithdrawn(uint8(ti), msg.sender, assetsOut, shareAmount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                       QUEUED WITHDRAWALS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Queue a withdrawal request for a tranche. Allowed when paused.
     * @param t           Target tranche.
     * @param shareAmount Shares to queue.
     * @return requestId  Index of the request in the tranche's queue.
     */
    function requestWithdraw(TrancheTypes.Tranche t, uint256 shareAmount)
        external
        nonReentrant
        validTranche(t)
        returns (uint256 requestId)
    {
        if (shareAmount == 0) revert UnifiedErrors.ZeroAmount();

        uint256 ti = uint256(t);
        TrancheTypes.TranchePosition storage pos = positions[msg.sender][ti];
        uint256 free = pos.shares - pendingShares[ti][msg.sender];
        if (shareAmount > free) revert UnifiedErrors.InsufficientFreeShares();

        pendingShares[ti][msg.sender] += shareAmount;

        // ── Coalesce into last open request ──
        uint256 lastIdx = lastOpenRequestIndex[ti][msg.sender];
        if (lastIdx != 0) {
            UnifiedTypes.WithdrawRequest storage last = _withdrawRequests[ti][lastIdx - 1];
            if (!last.fulfilled) {
                last.shares += shareAmount;
                emit WithdrawCoalesced(uint8(ti), msg.sender, shareAmount, last.shares, lastIdx - 1);
                return lastIdx - 1;
            }
        }

        if (openRequestCount[ti][msg.sender] >= MAX_OPEN_REQUESTS) {
            revert UnifiedErrors.TooManyOpenRequests();
        }

        requestId = _tranches[ti].withdrawQueueLength;
        _withdrawRequests[ti][requestId] = UnifiedTypes.WithdrawRequest({
            user: msg.sender,
            shares: shareAmount,
            fulfilled: false
        });
        _tranches[ti].withdrawQueueLength = requestId + 1;
        openRequestCount[ti][msg.sender] += 1;
        lastOpenRequestIndex[ti][msg.sender] = requestId + 1;

        emit WithdrawRequested(uint8(ti), msg.sender, requestId, shareAmount);
    }

    /**
     * @notice Cancel a pending withdraw request.
     * @param t         Target tranche.
     * @param requestId Queue index.
     */
    function cancelWithdraw(TrancheTypes.Tranche t, uint256 requestId)
        external
        nonReentrant
        validTranche(t)
    {
        uint256 ti = uint256(t);
        if (requestId >= _tranches[ti].withdrawQueueLength) revert UnifiedErrors.InvalidIndex();

        UnifiedTypes.WithdrawRequest storage req = _withdrawRequests[ti][requestId];
        if (req.user != msg.sender) revert UnifiedErrors.Unauthorized();
        if (req.fulfilled) revert UnifiedErrors.AlreadyFulfilled();

        uint256 shares = req.shares;
        req.fulfilled = true;
        pendingShares[ti][msg.sender] -= shares;
        openRequestCount[ti][msg.sender] -= 1;

        if (lastOpenRequestIndex[ti][msg.sender] == requestId + 1) {
            lastOpenRequestIndex[ti][msg.sender] = 0;
        }

        emit WithdrawCancelled(uint8(ti), msg.sender, requestId, shares);
    }

    /**
     * @notice Fulfill a single queued withdraw request.
     * @param t         Target tranche.
     * @param requestId Queue index.
     */
    function fulfillWithdraw(TrancheTypes.Tranche t, uint256 requestId)
        external
        nonReentrant
        validTranche(t)
    {
        _fulfillOne(t, requestId);
    }

    /**
     * @notice Batch-fulfill multiple queued withdraw requests for a tranche.
     * @param t          Target tranche.
     * @param requestIds Array of request indices.
     */
    function fulfillMany(TrancheTypes.Tranche t, uint256[] calldata requestIds)
        external
        nonReentrant
        validTranche(t)
    {
        for (uint256 i = 0; i < requestIds.length; i++) {
            _fulfillOne(t, requestIds[i]);
        }
    }

    /**
     * @dev Internal fulfillment with stress/priority gates.
     */
    function _fulfillOne(TrancheTypes.Tranche t, uint256 requestId) internal {
        // ── Stress gate ──
        if (stressMode) revert UnifiedErrors.StressModeLocked();

        // ── Auto-expiry of senior priority ──
        if (seniorPriorityActive
            && block.timestamp > seniorPriorityActivatedAt + seniorPriorityMaxDuration) {
            seniorPriorityActive = false;
            emit SeniorPriorityExpired(block.timestamp);
        }

        // ── Junior blocked during senior priority ──
        if (t == TrancheTypes.Tranche.Junior && seniorPriorityActive) {
            revert UnifiedErrors.SeniorPriorityActive();
        }

        uint256 ti = uint256(t);
        if (requestId >= _tranches[ti].withdrawQueueLength) revert UnifiedErrors.InvalidIndex();

        UnifiedTypes.WithdrawRequest storage req = _withdrawRequests[ti][requestId];
        if (req.fulfilled) revert UnifiedErrors.AlreadyFulfilled();

        uint256 shares = req.shares;
        address user = req.user;
        TrancheTypes.TrancheState storage ts = _tranches[ti];

        uint256 assetsOut = convertToAssets(t, shares);
        if (assetsOut > ts.virtualBalance) revert UnifiedErrors.InsufficientTrancheLiquidity(uint8(ti));

        req.fulfilled = true;
        openRequestCount[ti][user] -= 1;
        if (lastOpenRequestIndex[ti][user] == requestId + 1) {
            lastOpenRequestIndex[ti][user] = 0;
        }

        TrancheTypes.TranchePosition storage pos = positions[user][ti];
        pos.shares -= shares;
        pos.cumulativeWithdrawn += assetsOut;
        pendingShares[ti][user] -= shares;
        ts.totalShares -= shares;
        ts.virtualBalance -= assetsOut;

        usdc.safeTransfer(user, assetsOut);

        emit WithdrawFulfilled(uint8(ti), user, requestId, shares, assetsOut);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                        LOAN ALLOCATION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Allocate pool liquidity to a POOL-model loan, splitting the
     *         amount across Senior/Junior per `seniorAllocationBps`.
     * @param loan   Loan clone address.
     * @param amount Total USDC to deploy (before tranche split).
     */
    function allocateToLoan(address loan, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        whenBreakerAllows
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();
        if (stressMode) revert UnifiedErrors.StressModeLocked();

        // ── Tranche split ──
        uint256 srPortion = (amount * seniorAllocationBps) / BPS;
        uint256 jrPortion = amount - srPortion;

        TrancheTypes.TrancheState storage sr = _tranches[0];
        TrancheTypes.TrancheState storage jr = _tranches[1];

        // ── Liquidity checks ──
        if (srPortion > sr.virtualBalance) revert UnifiedErrors.InsufficientTrancheLiquidity(0);
        if (jrPortion > jr.virtualBalance) revert UnifiedErrors.InsufficientTrancheLiquidity(1);
        if (amount > availableLiquidity()) revert UnifiedErrors.PoolAllocationExceedsAvailable();

        // ── Senior liquidity floor (prospective) ──
        uint256 srBalanceAfter = sr.virtualBalance - srPortion;
        uint256 srNAV = trancheNAV(TrancheTypes.Tranche.Senior);
        if (srNAV > 0 && srBalanceAfter * BPS < srNAV * seniorLiquidityFloorBps) {
            revert UnifiedErrors.InsufficientTrancheLiquidity(0);
        }

        // ── Coverage floor guardrail (INV-7: hard revert) ──
        uint256 jrBalanceAfter = jr.virtualBalance - jrPortion;
        if (srBalanceAfter > 0) {
            uint256 postCoverage = (jrBalanceAfter * BPS) / srBalanceAfter;
            if (postCoverage < juniorCoverageFloorBps) {
                revert UnifiedErrors.CoverageFloorBreached(postCoverage, juniorCoverageFloorBps);
            }
        }

        // ── Update tranche accounting ──
        sr.virtualBalance -= srPortion;
        sr.principalAllocated += srPortion;
        jr.virtualBalance -= jrPortion;
        jr.principalAllocated += jrPortion;

        // ── Update global ledger ──
        principalOutstandingByLoan[loan] += amount;
        totalPrincipalAllocated += amount;

        // ── Allocation authenticity guard ──
        if (!hasRole(LOAN_ROLE, loan) || loan.code.length == 0) {
            revert UnifiedErrors.Unauthorized();
        }

        // ── Fund the loan ──
        usdc.forceApprove(loan, amount);
        IUnifiedLoan(loan).poolFund(amount);

        emit Allocated(loan, amount);

        _assertCoreInvariants();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                     REPAYMENT CALLBACK (waterfall)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @inheritdoc IUnifiedPool
     * @dev The caller (loan) must have already transferred USDC to the pool.
     *      Fees are deducted by `UnifiedLoan` before calling this function;
     *      `interestPaid` is net of fees.
     */
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid)
        external
        override
        nonReentrant
        onlyRole(LOAN_ROLE)
    {
        address loan = msg.sender;
        uint256 outstanding = principalOutstandingByLoan[loan];
        if (principalPaid > outstanding) {
            principalPaid = outstanding;
        }

        principalOutstandingByLoan[loan] = outstanding - principalPaid;
        totalPrincipalRepaidToPool += principalPaid;
        totalInterestRepaidToPool += interestPaid;

        _distributeRepayment(loan, principalPaid, interestPaid);

        emit RepaidToPool(loan, principalPaid + interestPaid);

        _assertCoreInvariants();
    }

    /**
     * @dev Waterfall distribution of repaid principal and interest.
     *
     *  Order: SeniorPrincipal → SeniorInterest(capped) → JuniorPrincipal → JuniorInterest+Residual
     */
    function _distributeRepayment(
        address loan,
        uint256 principalPaid,
        uint256 interestPaid
    ) internal {
        TrancheTypes.TrancheState storage sr = _tranches[0];
        TrancheTypes.TrancheState storage jr = _tranches[1];

        uint256 remainingPrincipal = principalPaid;
        uint256 remainingInterest  = interestPaid;

        // ── Step 1: Senior principal ──
        uint256 srOutstanding = sr.principalAllocated - sr.principalRepaid;
        uint256 srPrincipalCredit = _min(remainingPrincipal, srOutstanding);
        if (srPrincipalCredit > 0) {
            sr.principalRepaid  += srPrincipalCredit;
            sr.virtualBalance   += srPrincipalCredit;
            remainingPrincipal  -= srPrincipalCredit;
        }

        // ── Step 2: Senior interest (capped at target yield) ──
        uint256 srInterestDue = _seniorAccruedInterestDue();
        uint256 srInterestCap = srInterestDue > sr.interestEarned
            ? srInterestDue - sr.interestEarned
            : 0;
        uint256 srInterestCredit = _min(remainingInterest, srInterestCap);
        if (srInterestCredit > 0) {
            sr.interestEarned  += srInterestCredit;
            sr.virtualBalance  += srInterestCredit;
            remainingInterest  -= srInterestCredit;
        }

        // ── Step 3: Junior principal ──
        uint256 jrOutstanding = jr.principalAllocated - jr.principalRepaid;
        uint256 jrPrincipalCredit = _min(remainingPrincipal, jrOutstanding);
        if (jrPrincipalCredit > 0) {
            jr.principalRepaid  += jrPrincipalCredit;
            jr.virtualBalance   += jrPrincipalCredit;
            remainingPrincipal  -= jrPrincipalCredit;
        }

        // ── Step 4 & 5: Junior interest + residual ──
        if (remainingInterest > 0) {
            jr.interestEarned  += remainingInterest;
            jr.virtualBalance  += remainingInterest;
        }

        // Any leftover principal (edge case) also goes to Junior
        if (remainingPrincipal > 0) {
            jr.virtualBalance += remainingPrincipal;
        }

        emit WaterfallDistributed(
            loan,
            srPrincipalCredit,
            srInterestCredit,
            jrPrincipalCredit,
            remainingInterest   // junior interest = all remaining interest
        );
    }

    /**
     * @dev Cumulative senior interest due based on target yield, allocated
     *      principal, and elapsed time since deployment.
     *
     *      seniorInterestDue = sr.principalAllocated × targetYieldBps / BPS
     *                          × elapsed / SECONDS_PER_YEAR
     *
     *      This is a simplified linear accumulator. The loan-level APR may
     *      differ, but the senior tranche is capped at its own target yield.
     */
    function _seniorAccruedInterestDue() internal view returns (uint256) {
        TrancheTypes.TrancheState storage sr = _tranches[0];
        if (sr.targetYieldBps == 0) return type(uint256).max; // uncapped
        uint256 elapsed = block.timestamp - deployedAt;
        return (sr.principalAllocated * sr.targetYieldBps * elapsed) / (BPS * SECONDS_PER_YEAR);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                         BAD-DEBT / LOSS ABSORPTION
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Write off irrecoverable principal for a defaulted loan.
     *         Junior absorbs first; Senior absorbs the remainder.
     * @param loan   Loan address.
     * @param amount Amount of principal to write off.
     */
    function recordBadDebt(address loan, uint256 amount)
        external
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        uint256 outstanding = principalOutstandingByLoan[loan];
        uint256 writeOff = amount > outstanding ? outstanding : amount;

        // Close out global ledger
        principalOutstandingByLoan[loan] = outstanding - writeOff;
        totalBadDebt += writeOff;

        // ── Absorb loss (Junior-first) ──
        _absorbLoss(loan, writeOff);

        // ── Zero-tolerance senior impairment trigger (INV-8) ──
        if (_tranches[0].badDebt > 0) {
            if (!stressMode) {
                stressMode = true;
                seniorPriorityActive = true;
                seniorPriorityActivatedAt = block.timestamp;
                emit StressModeActivated(block.timestamp);
                emit SeniorPriorityActivated(block.timestamp);
            }
            if (!paused()) {
                _pause();
            }
            emit SeniorImpairmentDetected(_tranches[0].badDebt, block.timestamp);
        }

        // ── Stress trigger check ──
        _checkStressTriggers();

        _assertCoreInvariants();
    }

    /**
     * @dev Junior-first loss absorption. Only principal is written off (INV-6).
     */
    function _absorbLoss(address loan, uint256 writeOff) internal {
        TrancheTypes.TrancheState storage sr = _tranches[0];
        TrancheTypes.TrancheState storage jr = _tranches[1];

        // Junior absorbs up to its remaining principal claim.
        uint256 jrOutstanding = jr.principalAllocated - jr.principalRepaid;
        uint256 jrAbsorb = _min(writeOff, jrOutstanding);

        if (jrAbsorb > 0) {
            jr.badDebt += jrAbsorb;

            loanBadDebt[loan][1] += jrAbsorb;
            emit LossAbsorbed(1, loan, jrAbsorb);
        }

        // Senior absorbs remainder (if Junior exhausted)
        uint256 srAbsorb = writeOff - jrAbsorb;
        if (srAbsorb > 0) {
            sr.badDebt += srAbsorb;

            loanBadDebt[loan][0] += srAbsorb;
            emit LossAbsorbed(0, loan, srAbsorb);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                    COLLATERAL RECOVERY WATERFALL
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Distribute recovered USDC from collateral liquidation.
     *         Mirrors the repayment waterfall for bad-debt reversal:
     *           1. Senior principal shortfall (up to sr.badDebt for that loan)
     *           2. Junior principal shortfall (up to jr.badDebt for that loan)
     *           3. Residual → Junior
     * @dev `amount` MUST already be transferred to this pool before call.
     * @param loan   Loan address (must have prior bad debt recorded).
     * @param amount Recovered USDC credited in this call.
     */
    function onCollateralRecovery(address loan, uint256 amount)
        external
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        uint256 remaining = amount;

        // ── Step 1: Senior recovery ──
        uint256 srShortfall = loanBadDebt[loan][0];
        uint256 srRecovery = _min(remaining, srShortfall);
        if (srRecovery > 0) {
            _tranches[0].virtualBalance += srRecovery;
            _tranches[0].badDebt -= srRecovery;
            _tranches[0].principalRepaid += srRecovery;
            loanBadDebt[loan][0] -= srRecovery;
            totalBadDebt -= srRecovery;
            remaining -= srRecovery;
        }

        // ── Step 2: Junior recovery ──
        uint256 jrShortfall = loanBadDebt[loan][1];
        uint256 jrRecovery = _min(remaining, jrShortfall);
        if (jrRecovery > 0) {
            _tranches[1].virtualBalance += jrRecovery;
            _tranches[1].badDebt -= jrRecovery;
            _tranches[1].principalRepaid += jrRecovery;
            loanBadDebt[loan][1] -= jrRecovery;
            totalBadDebt -= jrRecovery;
            remaining -= jrRecovery;
        }

        // ── Step 3: Residual → Junior ──
        uint256 residual = remaining;
        if (residual > 0) {
            _tranches[1].virtualBalance += residual;
        }

        // Recovery that cures bad debt also counts as principal repaid.
        uint256 appliedToBadDebt = srRecovery + jrRecovery;
        if (appliedToBadDebt > 0) {
            totalPrincipalRepaidToPool += appliedToBadDebt;
        }

        emit CollateralRecoveryDistributed(loan, srRecovery, jrRecovery, residual);

        _assertCoreInvariants();
    }

    /**
     * @notice Proxy to claim collateral from a defaulted loan.
     * @param loan Loan address.
     */
    function claimLoanCollateral(address loan)
        external
        nonReentrant
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        IUnifiedLoan(loan).claimCollateral();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                         STRESS TRIGGERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev Check NAV drawdown thresholds and activate stress mode if breached.
     *      Called automatically after recordBadDebt.
     */
    function _checkStressTriggers() internal {
        // ── Junior drawdown vs high-water mark ──
        uint256 jrNAV = trancheNAV(TrancheTypes.Tranche.Junior);
        if (juniorHighWaterMark > 0) {
            uint256 threshold = (juniorHighWaterMark * (BPS - juniorNavDrawdownCapBps)) / BPS;
            if (jrNAV < threshold && !stressMode) {
                stressMode = true;
                seniorPriorityActive = true;
                seniorPriorityActivatedAt = block.timestamp;
                emit StressModeActivated(block.timestamp);
                emit SeniorPriorityActivated(block.timestamp);
            }
        }

        // ── Senior drawdown (emergency) ──
        uint256 srNAV = trancheNAV(TrancheTypes.Tranche.Senior);
        uint256 srTotal = _tranches[0].principalAllocated; // cumulative invested
        if (srTotal > 0 && srNAV < (srTotal * (BPS - seniorNavDrawdownCapBps)) / BPS) {
            // Emergency pause
            if (!paused()) {
                _pause();
            }
        }

        // ── Coverage floor ──
        uint256 srBal = _tranches[0].virtualBalance;
        if (srBal > 0) {
            uint256 coverage = (_tranches[1].virtualBalance * BPS) / srBal;
            if (coverage < juniorCoverageFloorBps) {
                emit CoverageFloorBreached(coverage, juniorCoverageFloorBps);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                           PAUSE
    // ═══════════════════════════════════════════════════════════════════════

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                           INTERNALS
    // ═══════════════════════════════════════════════════════════════════════

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                      INVARIANT HOOK (v1.2.1)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev Runtime assertion of core accounting invariants.
     *      Called after every state-mutating ledger operation.
     *
     *      INV-CASH: sr.virtualBalance + jr.virtualBalance == usdc.balanceOf(this)
     *      INV-2: t.principalAllocated >= t.principalRepaid (per tranche)
     *      INV-3: sr.badDebt + jr.badDebt == totalBadDebt
     *
     *      Reverts with InvariantViolation(code) on failure.
     *        code 1 = INV-CASH (cash reconciliation: vb == actual)
     *        code 2 = INV-2-sr (senior principal monotonicity)
     *        code 3 = INV-2-jr (junior principal monotonicity)
     *        code 4 = INV-3 (bad debt attribution)
     *        code 5 = INV-CLAIMS (claims ledger reconciliation / net claim floor)
     */
    function _assertCoreInvariants() internal view {
        TrancheTypes.TrancheState storage sr = _tranches[0];
        TrancheTypes.TrancheState storage jr = _tranches[1];

        // INV-CASH: tranche cash sub-ledger equals actual pool USDC
        uint256 sumVirtual = sr.virtualBalance + jr.virtualBalance;
        uint256 actualBalance = usdc.balanceOf(address(this));
        if (sumVirtual != actualBalance) {
            revert UnifiedErrors.InvariantViolation(1);
        }

        // INV-2: principal monotonicity
        if (sr.principalAllocated < sr.principalRepaid) {
            revert UnifiedErrors.InvariantViolation(2);
        }
        if (jr.principalAllocated < jr.principalRepaid) {
            revert UnifiedErrors.InvariantViolation(3);
        }

        // INV-3: bad debt attribution exhaustive
        if (sr.badDebt + jr.badDebt != totalBadDebt) {
            revert UnifiedErrors.InvariantViolation(4);
        }

        // INV-CLAIMS: global and tranche principal ledgers reconcile, and
        // net principal claim (gross - badDebt) cannot go negative.
        uint256 principalOut = totalPrincipalAllocated - totalPrincipalRepaidToPool;
        uint256 tranchePrincipalOut =
            (sr.principalAllocated - sr.principalRepaid) +
            (jr.principalAllocated - jr.principalRepaid);
        if (tranchePrincipalOut != principalOut || principalOut < totalBadDebt) {
            revert UnifiedErrors.InvariantViolation(5);
        }
        uint256 netPrincipalOut = principalOut - totalBadDebt;
        uint256 trancheNetPrincipalOut = tranchePrincipalOut - totalBadDebt;
        if (trancheNetPrincipalOut != netPrincipalOut) {
            revert UnifiedErrors.InvariantViolation(5);
        }
    }

    /**
     * @notice External view to check invariants without reverting.
     * @return ok True if all core invariants hold.
     * @return code 0 if ok, else the failing invariant code.
     */
    function checkInvariants() external view returns (bool ok, uint8 code) {
        TrancheTypes.TrancheState storage sr = _tranches[0];
        TrancheTypes.TrancheState storage jr = _tranches[1];

        if (sr.virtualBalance + jr.virtualBalance != usdc.balanceOf(address(this))) return (false, 1);
        if (sr.principalAllocated < sr.principalRepaid) return (false, 2);
        if (jr.principalAllocated < jr.principalRepaid) return (false, 3);
        if (sr.badDebt + jr.badDebt != totalBadDebt) return (false, 4);
        {
            uint256 principalOut = totalPrincipalAllocated - totalPrincipalRepaidToPool;
            uint256 tranchePrincipalOut =
                (sr.principalAllocated - sr.principalRepaid) +
                (jr.principalAllocated - jr.principalRepaid);
            if (tranchePrincipalOut != principalOut || principalOut < totalBadDebt) return (false, 5);
            uint256 netPrincipalOut = principalOut - totalBadDebt;
            uint256 trancheNetPrincipalOut = tranchePrincipalOut - totalBadDebt;
            if (trancheNetPrincipalOut != netPrincipalOut) return (false, 5);
        }

        return (true, 0);
    }
}
