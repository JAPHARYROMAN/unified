// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedPool
 * @notice Interface for pool interactions from loans and the factory.
 */
interface IUnifiedPool {
    function setLoanRole(address loan, bool allowed) external;
    function onLoanRepayment(uint256 principalPaid, uint256 interestPaid) external;
}
