// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedFeeManager
 * @notice Interface for fee computation views.
 */
interface IUnifiedFeeManager {
    function computeOriginationFee(uint256 amount) external view returns (uint256);
    function computeInterestFee(uint256 interestAmount) external view returns (uint256);
    function computeLateFee(uint256 amount) external view returns (uint256);
    function treasury() external view returns (address);
    function registerLoan(address loan) external;
    function collectFee(address token, uint256 amount) external;
}
