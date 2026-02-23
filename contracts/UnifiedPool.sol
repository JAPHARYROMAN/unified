// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUnifiedLoan.sol";
import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedPool
 * @notice Shared USDC liquidity pool for POOL-model loan funding with
 *         NAV-based share accounting.
 *
 * @dev NAV (Net Asset Value) pricing:
 *
 *   totalAssetsNAV = usdcBalance
 *                  + totalPrincipalAllocated
 *                  - totalPrincipalRepaidToPool   (already back in balance)
 *                  - totalBadDebt
 *
 *   Because repaid principal flows back into the USDC balance, the
 *   simplified formula reduces to:
 *
 *     totalAssetsNAV = usdcBalance + totalPrincipalOutstanding - totalBadDebt
 *
 *   where totalPrincipalOutstanding = totalPrincipalAllocated - totalPrincipalRepaidToPool.
 *
 *   Interest that has been repaid is already in usdcBalance, so it is
 *   automatically captured.
 */
contract UnifiedPool is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────

    /// @notice Role allowed to pause and unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role allowed to allocate liquidity to loans.
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");

    /// @notice Role granted to recognized loan contracts (for repayment callbacks).
    bytes32 public constant LOAN_ROLE = keccak256("LOAN_ROLE");

    /// @notice Role granted to the factory to register loan contracts.
    bytes32 public constant LOAN_REGISTRAR_ROLE = keccak256("LOAN_REGISTRAR_ROLE");

    /// @notice Role granted to addresses allowed to deposit into this pool.
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    // ── Immutables ─────────────────────────────────────────────────────────

    /// @notice Stablecoin used by the pool (e.g. USDC).
    IERC20 public immutable usdc;

    /// @notice Partner identifier that owns this pool (bytes32 UUID/slug, set once).
    bytes32 public immutable partnerId;

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice Total issued internal shares (virtual token).
    uint256 public totalShares;

    /// @notice Per-provider share position.
    mapping(address => UnifiedTypes.PoolPosition) public positions;

    // ── NAV tracking ───────────────────────────────────────────────────────

    /// @notice Sum of principal sent into loans (outstanding basis).
    uint256 public totalPrincipalAllocated;

    /// @notice Principal returned from loans.
    uint256 public totalPrincipalRepaidToPool;

    /// @notice Interest returned from loans (net of protocol fees).
    uint256 public totalInterestRepaidToPool;

    /// @notice Write-offs from defaults that yielded less than outstanding.
    uint256 public totalBadDebt;

    /// @notice Principal outstanding per loan address.
    mapping(address => uint256) public principalOutstandingByLoan;

    // ── Queued Withdrawals ─────────────────────────────────────────────────

    /// @notice Array of all queued withdraw requests.
    UnifiedTypes.WithdrawRequest[] public withdrawRequests;

    /// @notice Shares locked in pending withdraw requests per user.
    mapping(address => uint256) public pendingShares;

    /// @notice Number of open (unfulfilled) withdraw requests per user.
    mapping(address => uint256) public openRequestCount;

    /// @notice Hard cap on open withdraw requests per user to prevent storage griefing.
    uint256 public constant MAX_OPEN_REQUESTS = 50;

    /// @notice Index of the last open (unfulfilled) request per user (0 = none tracked).
    ///         Stored as index+1 so that 0 means "no pending request".
    mapping(address => uint256) public lastOpenRequestIndex;

    // ── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 amount, uint256 sharesBurned);
    event Allocated(address indexed loan, uint256 amount);
    event RepaidToPool(address indexed loan, uint256 amount);
    event BadDebtRecorded(address indexed loan, uint256 amount);
    event LoanRoleSet(address indexed loan, bool allowed);
    event WithdrawRequested(address indexed user, uint256 indexed requestId, uint256 shares);
    event WithdrawCoalesced(address indexed user, uint256 addedShares, uint256 newTotalShares, uint256 indexed index);
    event WithdrawCancelled(address indexed user, uint256 indexed requestId, uint256 shares);
    event WithdrawFulfilled(address indexed user, uint256 indexed requestId, uint256 shares, uint256 assets);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param admin      Default admin & initial role holder.
     * @param _usdc      USDC (or other stablecoin) address.
     * @param _partnerId Partner identifier bound to this pool (immutable).
     */
    constructor(address admin, address _usdc, bytes32 _partnerId) {
        if (admin == address(0) || _usdc == address(0)) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(ALLOCATOR_ROLE, admin);

        usdc = IERC20(_usdc);
        partnerId = _partnerId;
    }

    // ── Admin ──────────────────────────────────────────────────────────────

    /**
     * @notice Grant or revoke LOAN_ROLE for an address (typically a loan clone).
     * @dev    Callable by DEFAULT_ADMIN_ROLE or LOAN_REGISTRAR_ROLE (factory).
     * @param loan    Loan address.
     * @param allowed True to grant, false to revoke.
     */
    function setLoanRole(address loan, bool allowed) external {
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

    // ── Views ──────────────────────────────────────────────────────────────

    /**
     * @notice Liquid USDC currently held by the pool (not deployed into loans).
     */
    function availableLiquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Total principal currently deployed in loans.
     */
    function totalPrincipalOutstanding() public view returns (uint256) {
        return totalPrincipalAllocated - totalPrincipalRepaidToPool;
    }

    /**
     * @notice Net Asset Value — total pool assets.
     * @dev    usdcBalance includes repaid principal + interest already received.
     *         We add outstanding principal (still in loans) and subtract bad debt.
     */
    function totalAssetsNAV() public view returns (uint256) {
        uint256 bal = availableLiquidity();
        uint256 outstanding = totalPrincipalOutstanding();
        uint256 gross = bal + outstanding;
        // Protect against underflow if badDebt exceeds gross (shouldn't happen in practice)
        return gross > totalBadDebt ? gross - totalBadDebt : 0;
    }

    /**
     * @notice Price of one share in asset terms (18-decimal precision).
     * @return price  `totalAssetsNAV * 1e18 / totalShares`, or 1e18 if no shares.
     */
    function sharePrice() external view returns (uint256 price) {
        if (totalShares == 0) return 1e18;
        return (totalAssetsNAV() * 1e18) / totalShares;
    }

    /**
     * @notice Convert an asset amount to its share equivalent using NAV.
     */
    function convertToShares(uint256 assetAmount) public view returns (uint256) {
        if (assetAmount == 0) return 0;
        if (totalShares == 0 || totalAssetsNAV() == 0) return assetAmount; // 1:1 bootstrap
        return (assetAmount * totalShares) / totalAssetsNAV();
    }

    /**
     * @notice Convert a share amount to its asset equivalent using NAV.
     */
    function convertToAssets(uint256 shareAmount) public view returns (uint256) {
        if (shareAmount == 0 || totalShares == 0) return 0;
        return (shareAmount * totalAssetsNAV()) / totalShares;
    }

    // ── Deposit ────────────────────────────────────────────────────────────

    /**
     * @notice Deposit USDC into the pool and receive internal shares.
     * @param amount  USDC amount (caller must have approved the pool).
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert UnifiedErrors.ZeroAmount();

        // Snapshot shares *before* the transfer changes balanceOf.
        uint256 sharesToMint = convertToShares(amount);

        // Pull USDC from depositor.
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        positions[msg.sender].shares += sharesToMint;
        positions[msg.sender].cumulativeDeposited += amount;
        totalShares += sharesToMint;

        emit Deposited(msg.sender, amount, sharesToMint);
    }

    // ── Withdraw ───────────────────────────────────────────────────────────

    /**
     * @notice Burn internal shares and withdraw proportional USDC.
     * @dev    Reverts if the pool lacks liquid USDC (assets deployed in loans).
     * @param shareAmount  Number of shares to redeem.
     */
    function withdraw(uint256 shareAmount) external nonReentrant whenNotPaused {
        if (shareAmount == 0) revert UnifiedErrors.ZeroAmount();

        UnifiedTypes.PoolPosition storage position = positions[msg.sender];
        if (position.shares < shareAmount) revert UnifiedErrors.InsufficientShares();

        // Cannot withdraw shares locked in pending requests
        uint256 free = position.shares - pendingShares[msg.sender];
        if (shareAmount > free) revert UnifiedErrors.InsufficientFreeShares();

        uint256 assetsOut = convertToAssets(shareAmount);
        if (assetsOut > availableLiquidity()) revert UnifiedErrors.InsufficientPoolLiquidity();

        position.shares -= shareAmount;
        position.cumulativeWithdrawn += assetsOut;
        totalShares -= shareAmount;

        // Transfer USDC to withdrawer.
        usdc.safeTransfer(msg.sender, assetsOut);

        emit Withdrawn(msg.sender, assetsOut, shareAmount);
    }

    // ── Queued Withdrawals ─────────────────────────────────────────────────

    /**
     * @notice Queue a withdrawal request. Locks the caller's shares so they
     *         cannot be used in a second request or instant withdraw.
     *         Allowed when paused for safe exits.
     * @param shareAmount Number of shares to queue for withdrawal.
     * @return requestId  Index into the `withdrawRequests` array.
     */
    function requestWithdraw(uint256 shareAmount)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (shareAmount == 0) revert UnifiedErrors.ZeroAmount();

        UnifiedTypes.PoolPosition storage position = positions[msg.sender];
        uint256 free = position.shares - pendingShares[msg.sender];
        if (shareAmount > free) revert UnifiedErrors.InsufficientFreeShares();

        pendingShares[msg.sender] += shareAmount;

        // ── Coalesce into the last open request if possible ────────────
        uint256 lastIdx = lastOpenRequestIndex[msg.sender];
        if (lastIdx != 0) {
            // lastIdx is stored as index+1
            UnifiedTypes.WithdrawRequest storage last = withdrawRequests[lastIdx - 1];
            if (!last.fulfilled) {
                last.shares += shareAmount;
                emit WithdrawCoalesced(msg.sender, shareAmount, last.shares, lastIdx - 1);
                return lastIdx - 1;
            }
        }

        // ── New request — enforce max open requests guard ──────────────
        if (openRequestCount[msg.sender] >= MAX_OPEN_REQUESTS) {
            revert UnifiedErrors.TooManyOpenRequests();
        }

        requestId = withdrawRequests.length;
        withdrawRequests.push(UnifiedTypes.WithdrawRequest({
            user: msg.sender,
            shares: shareAmount,
            fulfilled: false
        }));
        openRequestCount[msg.sender] += 1;
        lastOpenRequestIndex[msg.sender] = requestId + 1; // store as index+1

        emit WithdrawRequested(msg.sender, requestId, shareAmount);
    }

    /**
     * @notice Cancel a pending (unfulfilled) withdraw request. Unlocks the
     *         shares so they can be used again.
     * @param requestId Index into the `withdrawRequests` array.
     */
    function cancelWithdraw(uint256 requestId) external nonReentrant whenNotPaused {
        if (requestId >= withdrawRequests.length) revert UnifiedErrors.InvalidIndex();

        UnifiedTypes.WithdrawRequest storage req = withdrawRequests[requestId];
        if (req.user != msg.sender) revert UnifiedErrors.Unauthorized();
        if (req.fulfilled) revert UnifiedErrors.AlreadyFulfilled();

        uint256 shares = req.shares;
        req.fulfilled = true; // mark as consumed (cancelled)
        pendingShares[msg.sender] -= shares;
        openRequestCount[msg.sender] -= 1;

        // Clear last-open hint if this was it
        if (lastOpenRequestIndex[msg.sender] == requestId + 1) {
            lastOpenRequestIndex[msg.sender] = 0;
        }

        emit WithdrawCancelled(msg.sender, requestId, shares);
    }

    /**
     * @notice Fulfill a single queued withdraw request.
     * @dev    Burns the queued shares at the current NAV price and sends
     *         USDC to the request owner. Reverts if the pool lacks liquidity.
     *         Callable by anyone (admin, keeper, or the user themselves).
     * @param requestId Index into the `withdrawRequests` array.
     */
    function fulfillWithdraw(uint256 requestId)
        external
        nonReentrant
    {
        _fulfillOne(requestId);
    }

    /**
     * @notice Batch-fulfill multiple queued withdraw requests.
     * @param requestIds Array of request indices to fulfill.
     */
    function fulfillMany(uint256[] calldata requestIds)
        external
        nonReentrant
    {
        for (uint256 i = 0; i < requestIds.length; i++) {
            _fulfillOne(requestIds[i]);
        }
    }

    /**
     * @dev Internal fulfillment logic shared by fulfillWithdraw and fulfillMany.
     */
    function _fulfillOne(uint256 requestId) internal {
        if (requestId >= withdrawRequests.length) revert UnifiedErrors.InvalidIndex();

        UnifiedTypes.WithdrawRequest storage req = withdrawRequests[requestId];
        if (req.fulfilled) revert UnifiedErrors.AlreadyFulfilled();

        uint256 shares = req.shares;
        address user = req.user;

        uint256 assetsOut = convertToAssets(shares);
        if (assetsOut > availableLiquidity()) revert UnifiedErrors.InsufficientPoolLiquidity();

        req.fulfilled = true;
        openRequestCount[user] -= 1;

        // Clear last-open hint if this was it
        if (lastOpenRequestIndex[user] == requestId + 1) {
            lastOpenRequestIndex[user] = 0;
        }

        // Update position & global state
        UnifiedTypes.PoolPosition storage position = positions[user];
        position.shares -= shares;
        position.cumulativeWithdrawn += assetsOut;
        pendingShares[user] -= shares;
        totalShares -= shares;

        usdc.safeTransfer(user, assetsOut);

        emit WithdrawFulfilled(user, requestId, shares, assetsOut);
    }

    /**
     * @notice Number of queued withdraw requests (including fulfilled/cancelled).
     */
    function withdrawRequestCount() external view returns (uint256) {
        return withdrawRequests.length;
    }

    /**
     * @notice Free (non-locked) shares for a given user.
     */
    function freeShares(address user) external view returns (uint256) {
        return positions[user].shares - pendingShares[user];
    }

    // ── Loan Allocation ────────────────────────────────────────────────────

    /**
     * @notice Allocate pool liquidity to a POOL-model loan.
     * @dev    Transfers USDC to the loan then calls `loan.poolFund(amount)`.
     * @param loan   Loan clone address.
     * @param amount USDC to deploy.
     */
    function allocateToLoan(address loan, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        if (amount == 0) revert UnifiedErrors.ZeroAmount();
        if (amount > availableLiquidity()) revert UnifiedErrors.PoolAllocationExceedsAvailable();

        principalOutstandingByLoan[loan] += amount;
        totalPrincipalAllocated += amount;

        // Approve loan to pull USDC, then trigger poolFund.
        usdc.forceApprove(loan, amount);
        IUnifiedLoan(loan).poolFund(amount);

        emit Allocated(loan, amount);
    }

    // ── Repayment Callback ─────────────────────────────────────────────────

    /**
     * @notice Record a loan repayment. Callable only by addresses with LOAN_ROLE
     *         (i.e. recognized loan contracts).
     * @dev    The caller (loan) must have already transferred the USDC to the pool
     *         before calling this function.
     * @param principalPaid  Amount of principal being returned.
     * @param interestPaid   Amount of interest being returned (net of fees).
     */
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid)
        external
        nonReentrant
        onlyRole(LOAN_ROLE)
    {
        address loan = msg.sender;
        uint256 outstanding = principalOutstandingByLoan[loan];

        if (principalPaid > outstanding) {
            principalPaid = outstanding; // cap to what's tracked
        }

        principalOutstandingByLoan[loan] = outstanding - principalPaid;
        totalPrincipalRepaidToPool += principalPaid;
        totalInterestRepaidToPool += interestPaid;

        emit RepaidToPool(loan, principalPaid + interestPaid);
    }

    // ── Bad-Debt Write-off ─────────────────────────────────────────────────

    /**
     * @notice Write off irrecoverable principal for a defaulted loan.
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

        principalOutstandingByLoan[loan] = outstanding - writeOff;
        totalPrincipalRepaidToPool += writeOff; // close out the allocated position
        totalBadDebt += writeOff;

        emit BadDebtRecorded(loan, writeOff);
    }

    // ── Collateral Claim Proxy ──────────────────────────────────────────────

    /**
     * @notice Claim collateral from a defaulted POOL-model loan on behalf of
     *         the pool. The loan contract sends the seized collateral to this
     *         pool address because `msg.sender == address(this)`.
     * @param loan Address of the defaulted loan.
     */
    function claimLoanCollateral(address loan)
        external
        nonReentrant
        onlyRole(ALLOCATOR_ROLE)
    {
        if (loan == address(0)) revert UnifiedErrors.ZeroAddress();
        IUnifiedLoan(loan).claimCollateral();
    }

    // ── Pause ──────────────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
