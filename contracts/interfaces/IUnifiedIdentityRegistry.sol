// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedIdentityRegistry
 * @notice Interface for on-chain KYC identity data consumed by the factory.
 */
interface IUnifiedIdentityRegistry {
    struct IdentityData {
        bool kycApproved;
        bytes32 kycHash;
        uint256 jurisdiction;
        uint8 riskTier;
        uint256 expiry;
        uint256 updatedAt;
    }

    function isApproved(address user) external view returns (bool);
    function getIdentity(address user) external view returns (IdentityData memory);
}
