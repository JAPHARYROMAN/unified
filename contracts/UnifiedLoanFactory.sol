// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUnifiedLoan.sol";
import "./interfaces/IUnifiedCollateralVault.sol";
import "./interfaces/IUnifiedFeeManager.sol";
import "./interfaces/IUnifiedRiskRegistry.sol";
import "./interfaces/IUnifiedIdentityRegistry.sol";
import "./interfaces/IUnifiedPool.sol";
import "./libraries/UnifiedTypes.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedLoanFactory
 * @notice Deploys EIP-1167 loan clones, registers them, and enforces
 *         collateral-allowlist / funding-model / deadline validations.
 */
contract UnifiedLoanFactory is AccessControl, Pausable, ReentrancyGuard {
    using Clones for address;

    // ── Roles ──────────────────────────────────────────────────────────────

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ── Protocol wiring ────────────────────────────────────────────────────

    /// @notice EIP-1167 implementation contract.
    address public loanImplementation;

    /// @notice Stablecoin used for principal / repayment (e.g. USDC).
    address public immutable usdc;

    /// @notice Collateral vault — mutable so admin can upgrade.
    address public collateralVault;

    /// @notice Fee manager — mutable so admin can upgrade.
    address public feeManager;

    /// @notice Treasury receiving protocol fees.
    address public treasury;

    // ── Collateral policy ──────────────────────────────────────────────────

    /// @notice Whether a collateral token is currently accepted.
    mapping(address => bool) public allowedCollateral;

    /// @notice Minimum collateral-ratio in bps per token (future risk use).
    mapping(address => uint256) public minCollateralRatioBps;

    // ── Loan registry ──────────────────────────────────────────────────────

    /// @notice Auto-incrementing loan-id counter.
    uint256 public loanIdCounter;

    /// @notice Loan address by numeric id.
    mapping(uint256 => address) public loanById;

    /// @notice All loan addresses created for a given borrower.
    mapping(address => address[]) public loansByBorrower;

    /// @notice Quick membership check.
    mapping(address => bool) public isLoan;

    /// @notice Flat list of every deployed clone.
    address[] public loans;

    // ── Appended state (storage-layout safe) ───────────────────────────────

    /// @notice Risk registry used for borrower validation. address(0) = disabled.
    address public riskRegistry;

    /// @notice Whether an address is a whitelisted pool for POOL-model loans.
    mapping(address => bool) public isPool;

    // ── KYC / Identity ─────────────────────────────────────────────────────

    /// @notice Identity registry contract (address(0) = disabled).
    address public identityRegistry;

    /// @notice When true, borrowers must pass KYC check before creating a loan.
    bool public kycRequired;

    /// @notice When true, borrower's jurisdiction must be on the allowlist.
    bool public enforceJurisdiction;

    /// @notice When true, per-tier borrow caps are enforced.
    bool public enforceTierCaps;

    /// @notice Jurisdiction numeric code → allowed flag.
    mapping(uint256 => bool) public jurisdictionAllowed;

    /// @notice Risk-tier → maximum principal amount (0 = no cap).
    mapping(uint8 => uint256) public tierBorrowCap;

    // ── Fiat / Settlement ─────────────────────────────────────────────────

    /// @notice When true, loans require fiat disbursement proof before activation.
    bool public requireFiatProofBeforeActivate;

    /// @notice Default settlement agent assigned to new loans.
    address public settlementAgent;

    // ── Exposure cap ──────────────────────────────────────────────────────

    /// @notice Maximum total outstanding principal a single borrower may have
    ///         across all non-closed loans. 0 = no cap (disabled).
    uint256 public maxBorrowerExposure;

    // ── Timelock ───────────────────────────────────────────────────────────

    /// @notice Minimum delay before a scheduled admin change can be executed.
    uint256 public constant TIMELOCK_DELAY = 24 hours;

    /// @notice Scheduled operations: hash → earliest executable timestamp.
    mapping(bytes32 => uint256) public timelockScheduled;

    // ── Events ─────────────────────────────────────────────────────────────

    event LoanCreated(
        uint256 indexed loanId,
        address indexed loanAddress,
        address indexed borrower,
        uint8   fundingModel,
        uint256 principal,
        address collateralToken,
        uint256 collateralAmount
    );
    event LoanImplementationUpdated(address indexed oldImpl, address indexed newImpl);
    event AllowedCollateralSet(address indexed token, bool allowed);
    event MinCollateralRatioBpsSet(address indexed token, uint256 bps);
    event FeeManagerUpdated(address indexed oldAddr, address indexed newAddr);
    event CollateralVaultUpdated(address indexed oldAddr, address indexed newAddr);
    event TreasuryUpdated(address indexed oldAddr, address indexed newAddr);
    event FactoryPaused(address indexed account);
    event FactoryUnpaused(address indexed account);
    event RiskRegistryUpdated(address indexed oldAddr, address indexed newAddr);
    event PoolSet(address indexed pool, bool allowed);
    event TimelockScheduled(bytes32 indexed id, uint256 readyAt);
    event TimelockExecuted(bytes32 indexed id);
    event TimelockCancelled(bytes32 indexed id);
    event IdentityRegistryUpdated(address indexed oldAddr, address indexed newAddr);
    event KycRequiredUpdated(bool on);
    event JurisdictionPolicyUpdated(bool on);
    event TierCapsUpdated(bool on);
    event JurisdictionAllowedSet(uint256 indexed jurisdiction, bool allowed);
    event TierBorrowCapSet(uint8 indexed tier, uint256 cap);
    event FiatProofRequiredUpdated(bool on);
    event SettlementAgentUpdated(address indexed oldAddr, address indexed newAddr);
    event MaxBorrowerExposureUpdated(uint256 oldCap, uint256 newCap);

    // ── Constructor ────────────────────────────────────────────────────────

    /**
     * @param admin             Default admin / pauser.
     * @param _usdc             Stablecoin address.
     * @param _collateralVault  Initial collateral vault.
     * @param _feeManager       Initial fee manager.
     * @param _treasury         Initial treasury.
     * @param _implementation   Initial loan implementation (may be address(0) if set later).
     */
    constructor(
        address admin,
        address _usdc,
        address _collateralVault,
        address _feeManager,
        address _treasury,
        address _implementation
    ) {
        if (
            admin == address(0) ||
            _usdc == address(0) ||
            _collateralVault == address(0) ||
            _feeManager == address(0) ||
            _treasury == address(0)
        ) revert UnifiedErrors.ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);

        usdc             = _usdc;
        collateralVault  = _collateralVault;
        feeManager       = _feeManager;
        treasury         = _treasury;
        loanImplementation = _implementation;
    }

    // ── Admin setters ──────────────────────────────────────────────────────

    /// @notice Replace the loan implementation used for future clones (timelocked).
    function setLoanImplementation(address impl) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (impl == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setLoanImplementation.selector, impl));
        _consumeTimelock(id);
        address old = loanImplementation;
        loanImplementation = impl;
        emit LoanImplementationUpdated(old, impl);
    }

    // ── Timelock helpers ───────────────────────────────────────────────────

    /**
     * @notice Schedule a timelocked operation. The `id` is a hash of the
     *         call data that will be executed later.
     */
    function scheduleTimelock(bytes32 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (timelockScheduled[id] != 0) revert UnifiedErrors.TimelockAlreadyScheduled(id);
        uint256 readyAt = block.timestamp + TIMELOCK_DELAY;
        timelockScheduled[id] = readyAt;
        emit TimelockScheduled(id, readyAt);
    }

    /**
     * @notice Cancel a scheduled timelocked operation.
     */
    function cancelTimelock(bytes32 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (timelockScheduled[id] == 0) revert UnifiedErrors.TimelockNotScheduled(id);
        delete timelockScheduled[id];
        emit TimelockCancelled(id);
    }

    /**
     * @dev Consume the timelock for `id`, reverting if not scheduled or not ready.
     */
    function _consumeTimelock(bytes32 id) internal {
        uint256 readyAt = timelockScheduled[id];
        if (readyAt == 0) revert UnifiedErrors.TimelockNotScheduled(id);
        if (block.timestamp < readyAt) revert UnifiedErrors.TimelockNotReady(id, readyAt);
        delete timelockScheduled[id];
        emit TimelockExecuted(id);
    }

    /**
     * @notice Compute the timelock id for a function call on this contract.
     * @dev    Matches: keccak256(abi.encode(selector, args...))
     */
    function timelockId(bytes memory data) public pure returns (bytes32) {
        return keccak256(data);
    }

    // ── Timelocked admin setters ───────────────────────────────────────────

    /// @notice Allow or disallow a collateral token (timelocked).
    function setAllowedCollateral(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setAllowedCollateral.selector, token, allowed));
        _consumeTimelock(id);
        allowedCollateral[token] = allowed;
        emit AllowedCollateralSet(token, allowed);
    }

    /// @notice Backwards-compatible helper — allow a collateral token (timelocked).
    function allowCollateral(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.allowCollateral.selector, token));
        _consumeTimelock(id);
        allowedCollateral[token] = true;
        emit AllowedCollateralSet(token, true);
    }

    /// @notice Set minimum collateral ratio (bps) for a token (timelocked).
    function setMinCollateralRatioBps(address token, uint256 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setMinCollateralRatioBps.selector, token, bps));
        _consumeTimelock(id);
        minCollateralRatioBps[token] = bps;
        emit MinCollateralRatioBpsSet(token, bps);
    }

    /// @notice Update the fee manager address (timelocked).
    function setFeeManager(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (addr == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setFeeManager.selector, addr));
        _consumeTimelock(id);
        address old = feeManager;
        feeManager = addr;
        emit FeeManagerUpdated(old, addr);
    }

    /// @notice Update the collateral vault address (timelocked).
    function setCollateralVault(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (addr == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setCollateralVault.selector, addr));
        _consumeTimelock(id);
        address old = collateralVault;
        collateralVault = addr;
        emit CollateralVaultUpdated(old, addr);
    }

    /// @notice Update the treasury address (timelocked).
    function setTreasury(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (addr == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setTreasury.selector, addr));
        _consumeTimelock(id);
        address old = treasury;
        treasury = addr;
        emit TreasuryUpdated(old, addr);
    }

    /// @notice Set or clear the risk-registry used for borrower validation (timelocked).
    function setRiskRegistry(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setRiskRegistry.selector, addr));
        _consumeTimelock(id);
        address old = riskRegistry;
        riskRegistry = addr;
        emit RiskRegistryUpdated(old, addr);
    }

    /// @notice Whitelist (or de-list) a pool address for POOL-model loans (timelocked).
    function setPool(address pool, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert UnifiedErrors.ZeroAddress();
        bytes32 id = keccak256(abi.encode(this.setPool.selector, pool, allowed));
        _consumeTimelock(id);
        isPool[pool] = allowed;
        emit PoolSet(pool, allowed);
    }

    // ── KYC / Identity setters (timelocked) ────────────────────────────────

    /// @notice Set the identity registry address (timelocked).
    function setIdentityRegistry(address ir) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setIdentityRegistry.selector, ir));
        _consumeTimelock(id);
        address old = identityRegistry;
        identityRegistry = ir;
        emit IdentityRegistryUpdated(old, ir);
    }

    /// @notice Enable or disable KYC requirement (timelocked).
    function setKycRequired(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setKycRequired.selector, on));
        _consumeTimelock(id);
        kycRequired = on;
        emit KycRequiredUpdated(on);
    }

    /// @notice Enable or disable jurisdiction enforcement (timelocked).
    function setEnforceJurisdiction(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setEnforceJurisdiction.selector, on));
        _consumeTimelock(id);
        enforceJurisdiction = on;
        emit JurisdictionPolicyUpdated(on);
    }

    /// @notice Enable or disable tier-based borrow caps (timelocked).
    function setEnforceTierCaps(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setEnforceTierCaps.selector, on));
        _consumeTimelock(id);
        enforceTierCaps = on;
        emit TierCapsUpdated(on);
    }

    /// @notice Allow or block a jurisdiction code.
    function setJurisdictionAllowed(uint256 jurisdiction, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        jurisdictionAllowed[jurisdiction] = allowed;
        emit JurisdictionAllowedSet(jurisdiction, allowed);
    }

    /// @notice Set the borrow cap for a risk tier (0 = no cap).
    function setTierBorrowCap(uint8 tier, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tier > 4) revert UnifiedErrors.InvalidTier(tier);
        tierBorrowCap[tier] = cap;
        emit TierBorrowCapSet(tier, cap);
    }

    /// @notice Enable or disable fiat disbursement proof requirement (timelocked).
    function setRequireFiatProofBeforeActivate(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setRequireFiatProofBeforeActivate.selector, on));
        _consumeTimelock(id);
        requireFiatProofBeforeActivate = on;
        emit FiatProofRequiredUpdated(on);
    }

    /// @notice Set the default settlement agent assigned to new loans (timelocked).
    function setSettlementAgent(address agent) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setSettlementAgent.selector, agent));
        _consumeTimelock(id);
        address old = settlementAgent;
        settlementAgent = agent;
        emit SettlementAgentUpdated(old, agent);
    }

    /// @notice Set the maximum total outstanding principal allowed per borrower (timelocked).
    ///         Set to 0 to disable the cap.
    function setMaxBorrowerExposure(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 id = keccak256(abi.encode(this.setMaxBorrowerExposure.selector, cap));
        _consumeTimelock(id);
        uint256 old = maxBorrowerExposure;
        maxBorrowerExposure = cap;
        emit MaxBorrowerExposureUpdated(old, cap);
    }

    // ── Loan creation ──────────────────────────────────────────────────────

    /**
     * @notice Deploy a new loan clone, initialize it and register it.
     * @param params User-facing loan parameters.
     * @return loanId  Numeric id assigned to this loan.
     * @return loan    Address of the deployed clone.
     */
    function createLoan(UnifiedTypes.LoanParams calldata params)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 loanId, address loan)
    {
        _validateParams(params);

        // --- clone & initialize ---
        loan = loanImplementation.clone();

        (loanId, loan) = _initAndRegister(loan, params);
    }

    /**
     * @notice Deploy a new loan clone at a deterministic address, initialize
     *         it and register it.  The clone address can be pre-computed with
     *         `Clones.predictDeterministicAddress(loanImplementation, salt, address(this))`.
     * @param params User-facing loan parameters.
     * @param salt   Caller-chosen salt for CREATE2 deployment.
     * @return loanId  Numeric id assigned to this loan.
     * @return loan    Address of the deployed clone.
     */
    function createLoanDeterministic(
        UnifiedTypes.LoanParams calldata params,
        bytes32 salt
    )
        external
        whenNotPaused
        nonReentrant
        returns (uint256 loanId, address loan)
    {
        // --- pre-flight checks (same as createLoan) ---
        _validateParams(params);

        // --- deterministic clone ---
        loan = loanImplementation.cloneDeterministic(salt);

        (loanId, loan) = _initAndRegister(loan, params);
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    /**
     * @dev Sum the `principal` of every non-terminal loan for `borrower`.
     *      Terminal statuses (REPAID, DEFAULTED, CLOSED) are excluded.
     */
    function _borrowerOutstanding(address borrower) internal view returns (uint256 total) {
        address[] storage bLoans = loansByBorrower[borrower];
        uint256 len = bLoans.length;
        for (uint256 i; i < len; ) {
            IUnifiedLoan l = IUnifiedLoan(bLoans[i]);
            UnifiedTypes.LoanStatus s = l.status();
            // CREATED(0), FUNDING(1), ACTIVE(2) are outstanding
            if (s <= UnifiedTypes.LoanStatus.ACTIVE) {
                total += l.principal();
            }
            unchecked { ++i; }
        }
    }

    /**
     * @dev Common pre-flight param validations shared by both creation paths.
     */
    function _validateParams(UnifiedTypes.LoanParams calldata params) internal view {
        if (loanImplementation == address(0)) revert UnifiedErrors.ImplementationNotSet();
        if (params.borrower == address(0))    revert UnifiedErrors.ZeroAddress();
        if (params.principalAmount == 0)      revert UnifiedErrors.ZeroAmount();
        if (params.collateralAmount == 0)     revert UnifiedErrors.ZeroAmount();
        if (params.durationSeconds == 0)      revert UnifiedErrors.ZeroAmount();

        if (!allowedCollateral[params.collateralToken]) {
            revert UnifiedErrors.CollateralNotAllowed(params.collateralToken);
        }

        if (params.fundingDeadline != 0 && params.fundingDeadline <= block.timestamp) {
            revert UnifiedErrors.InvalidFundingDeadline();
        }

        if (uint8(params.fundingModel) > uint8(UnifiedTypes.FundingModel.POOL)) {
            revert UnifiedErrors.InvalidConfiguration();
        }

        if (params.fundingModel == UnifiedTypes.FundingModel.POOL) {
            if (params.pool == address(0)) revert UnifiedErrors.ZeroAddress();
            if (!isPool[params.pool]) revert UnifiedErrors.PoolNotAllowed(params.pool);
        }

        // Minimum collateral ratio check (if configured for this token)
        {
            uint256 minRatio = minCollateralRatioBps[params.collateralToken];
            if (minRatio > 0) {
                uint256 minCollateral = (params.principalAmount * minRatio) / 10_000;
                if (params.collateralAmount < minCollateral) {
                    revert UnifiedErrors.CollateralBelowMinimum();
                }
            }
        }

        // Risk-registry borrower validation (if registry is configured)
        if (riskRegistry != address(0)) {
            IUnifiedRiskRegistry(riskRegistry).validateBorrow(
                params.borrower,
                params.principalAmount
            );
        }

        // ── KYC / Identity enforcement ─────────────────────────────────────
        if (identityRegistry != address(0) && kycRequired) {
            if (!IUnifiedIdentityRegistry(identityRegistry).isApproved(params.borrower)) {
                revert UnifiedErrors.KYCRequired();
            }
        }

        if (identityRegistry != address(0) && enforceJurisdiction) {
            IUnifiedIdentityRegistry.IdentityData memory identity =
                IUnifiedIdentityRegistry(identityRegistry).getIdentity(params.borrower);
            if (!jurisdictionAllowed[identity.jurisdiction]) {
                revert UnifiedErrors.JurisdictionBlocked();
            }
        }

        if (identityRegistry != address(0) && enforceTierCaps) {
            IUnifiedIdentityRegistry.IdentityData memory identity =
                IUnifiedIdentityRegistry(identityRegistry).getIdentity(params.borrower);
            uint256 cap = tierBorrowCap[identity.riskTier];
            if (cap > 0 && params.principalAmount > cap) {
                revert UnifiedErrors.TierCapExceeded();
            }
        }

        // ── On-chain borrower exposure cap ──────────────────────────────────
        if (maxBorrowerExposure > 0) {
            uint256 outstanding = _borrowerOutstanding(params.borrower);
            if (outstanding + params.principalAmount > maxBorrowerExposure) {
                revert UnifiedErrors.BorrowerExposureCapExceeded(
                    params.borrower,
                    outstanding,
                    params.principalAmount,
                    maxBorrowerExposure
                );
            }
        }
    }

    /**
     * @dev Initialize an already-deployed clone and register it in
     *      bookkeeping + collateral-vault.
     *
     *      NOTE: `registerLoan` on the vault uses LOAN_REGISTRAR_ROLE which
     *      MUST be granted exclusively to this factory contract.  Any other
     *      holder of that role could register arbitrary addresses as loans.
     */
    function _initAndRegister(
        address loan,
        UnifiedTypes.LoanParams calldata params
    ) internal returns (uint256 loanId, address) {
        IUnifiedLoan(loan).initialize(
            UnifiedTypes.LoanInitParams({
                borrower:         params.borrower,
                currency:         usdc,
                principal:        params.principalAmount,
                aprBps:           params.interestRateBps,
                duration:         params.durationSeconds,
                gracePeriod:      params.gracePeriodSeconds,
                fundingTarget:    params.principalAmount,
                fundingDeadline:  params.fundingDeadline,
                fundingModel:     params.fundingModel,
                repaymentModel:   params.repaymentModel,
                pool:             params.pool,
                collateralAsset:  params.collateralToken,
                collateralAmount: params.collateralAmount,
                collateralVault:  collateralVault,
                feeManager:       feeManager,
                treasury:         treasury,
                pauser:           address(this),
                settlementAgent:  settlementAgent,
                requireFiatProof: requireFiatProofBeforeActivate,
                totalInstallments:      params.totalInstallments,
                installmentInterval:    params.installmentInterval,
                installmentGracePeriod: params.installmentGracePeriod,
                penaltyAprBps:          params.penaltyAprBps,
                defaultThresholdDays:   params.defaultThresholdDays,
                scheduleHash:           params.scheduleHash
            })
        );

        // Register the clone with the vault so it can lock / release / seize.
        // IMPORTANT: registerLoan uses LOAN_REGISTRAR_ROLE — only the factory
        // should hold this role to prevent unauthorized loan registrations.
        IUnifiedCollateralVault(collateralVault).registerLoan(loan);

        // Register the clone with the fee manager so it can call collectFee.
        IUnifiedFeeManager(feeManager).registerLoan(loan);

        // For POOL loans, register the clone with the pool so it can call onLoanRepayment.
        if (params.fundingModel == UnifiedTypes.FundingModel.POOL) {
            IUnifiedPool(params.pool).setLoanRole(loan, true);
        }

        // --- registry bookkeeping ---
        loanId = loanIdCounter;
        loanIdCounter = loanId + 1;

        loanById[loanId]  = loan;
        loansByBorrower[params.borrower].push(loan);
        isLoan[loan]      = true;
        loans.push(loan);

        emit LoanCreated(
            loanId,
            loan,
            params.borrower,
            uint8(params.fundingModel),
            params.principalAmount,
            params.collateralToken,
            params.collateralAmount
        );

        return (loanId, loan);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    /**
     * @notice Compute the total outstanding principal for a borrower across
     *         all non-terminal loans (CREATED, FUNDING, ACTIVE).
     */
    function borrowerOutstanding(address borrower) external view returns (uint256) {
        return _borrowerOutstanding(borrower);
    }

    /// @notice Total number of loans deployed by this factory.
    function loanCount() external view returns (uint256) {
        return loans.length;
    }

    /// @notice Number of loans for a specific borrower.
    function borrowerLoanCount(address borrower) external view returns (uint256) {
        return loansByBorrower[borrower].length;
    }

    // ── Pause / Unpause ────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
        emit FactoryPaused(msg.sender);
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
        emit FactoryUnpaused(msg.sender);
    }

    /// @notice Pause or unpause an individual loan created by this factory.
    function setLoanPaused(address loan, bool paused) external onlyRole(PAUSER_ROLE) {
        if (!isLoan[loan]) revert UnifiedErrors.Unauthorized();
        IUnifiedLoan(loan).setPaused(paused);
    }
}
