// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedCollateralVault
 * @notice Interface for escrow operations invoked by loan clones.
 */
interface IUnifiedCollateralVault {
    function registerLoan(address loan) external;
    function lockCollateral(address loan, address token, uint256 amount, address fromBorrower) external;
    function releaseCollateral(address loan, address toBorrower) external;
    function seizeCollateral(address loan, address toRecipient, uint256 amount) external;
    function lockedByLoan(address loan) external view returns (address token, uint256 totalAmount, uint256 remainingAmount, bool isLocked);
    function getLocked(address loan) external view returns (address token, uint256 totalAmount, uint256 remainingAmount, bool locked);
}
