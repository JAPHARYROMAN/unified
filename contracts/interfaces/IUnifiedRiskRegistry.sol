// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedRiskRegistry
 * @notice Interface for borrower risk data consumed by factory and loans.
 */
interface IUnifiedRiskRegistry {
    function setRisk(address borrower, uint8 tier, uint256 borrowCap, uint256 flags) external;
    function getRisk(address borrower) external view returns (uint8 tier, uint256 cap, uint256 flags, uint64 updatedAt);
    function isBlocked(address borrower) external view returns (bool);
    function validateBorrow(address borrower, uint256 requestedAmount) external view;
}
