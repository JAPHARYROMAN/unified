// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./interfaces/IUnifiedIdentityRegistry.sol";
import "./libraries/UnifiedErrors.sol";

/**
 * @title UnifiedIdentityRegistry
 * @notice On-chain KYC status registry. Stores no PII — only approval flags,
 *         a provider-reference hash, numeric jurisdiction codes, risk tiers,
 *         and expiry timestamps.
 *
 * @dev    A compliance multisig holds KYC_MANAGER_ROLE and updates identity
 *         records.  DEFAULT_ADMIN_ROLE is intended for a timelock.
 */
contract UnifiedIdentityRegistry is IUnifiedIdentityRegistry, AccessControl, Pausable {

    // ── Roles ──────────────────────────────────────────────────────────────

    bytes32 public constant KYC_MANAGER_ROLE = keccak256("KYC_MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE      = keccak256("PAUSER_ROLE");

    // ── Storage ────────────────────────────────────────────────────────────

    mapping(address => IdentityData) private _identities;

    // ── Events ─────────────────────────────────────────────────────────────

    event IdentityUpdated(
        address indexed user,
        bool    approved,
        bytes32 kycHash,
        uint256 jurisdiction,
        uint8   riskTier,
        uint256 expiry,
        uint256 updatedAt
    );

    // ── Constructor ────────────────────────────────────────────────────────

    constructor(address admin) {
        if (admin == address(0)) revert UnifiedErrors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KYC_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ── Mutators ───────────────────────────────────────────────────────────

    /**
     * @notice Set the identity record for `user`.
     * @dev    Only callable by an address with KYC_MANAGER_ROLE.
     *
     * Rules:
     *   - `riskTier` must be <= 4.
     *   - If `approved == true`:
     *       • `expiry` must be > block.timestamp.
     *       • `kycHash` must be non-zero.
     *   - `approved == false` is always allowed (revocation / suspension).
     */
    function setIdentity(
        address user,
        bool    approved,
        bytes32 kycHash,
        uint256 jurisdiction,
        uint8   riskTier,
        uint256 expiry
    )
        external
        onlyRole(KYC_MANAGER_ROLE)
        whenNotPaused
    {
        if (user == address(0)) revert UnifiedErrors.ZeroAddress();
        if (riskTier > 4) revert UnifiedErrors.InvalidTier(riskTier);

        if (approved) {
            if (expiry <= block.timestamp) revert UnifiedErrors.KYCExpired();
            if (kycHash == bytes32(0))     revert UnifiedErrors.InvalidKycHash();
        }

        _identities[user] = IdentityData({
            kycApproved:  approved,
            kycHash:      kycHash,
            jurisdiction: jurisdiction,
            riskTier:     riskTier,
            expiry:       expiry,
            updatedAt:    block.timestamp
        });

        emit IdentityUpdated(user, approved, kycHash, jurisdiction, riskTier, expiry, block.timestamp);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    /// @inheritdoc IUnifiedIdentityRegistry
    function isApproved(address user) external view override returns (bool) {
        IdentityData storage d = _identities[user];
        return d.kycApproved && d.expiry > block.timestamp;
    }

    /// @inheritdoc IUnifiedIdentityRegistry
    function getIdentity(address user) external view override returns (IdentityData memory) {
        return _identities[user];
    }

    /// @notice Public accessor matching the `identities` mapping from spec.
    function identities(address user) external view returns (IdentityData memory) {
        return _identities[user];
    }

    // ── Pause ──────────────────────────────────────────────────────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
