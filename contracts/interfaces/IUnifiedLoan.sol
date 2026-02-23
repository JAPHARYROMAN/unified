// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/UnifiedTypes.sol";

/**
 * @title IUnifiedLoan
 * @notice Interface for EIP-1167 clone-initializable loan contracts.
 */
interface IUnifiedLoan {
    function initialize(UnifiedTypes.LoanInitParams calldata params) external;
    function lockCollateral() external;
    function fund(uint256 amount) external;
    function poolFund(uint256 amount) external;
    function activateAndDisburse() external;
    function repay(uint256 amount) external;
    function markDefault() external;
    function claimCollateral() external;
    function close() external;
    function accrueInterest() external;
    function withdrawContribution() external;
    function setPaused(bool paused) external;
    function recordFiatDisbursement(bytes32 ref) external;
    function recordFiatRepayment(bytes32 ref) external;
    function fiatDisbursementRef() external view returns (bytes32);
    function fiatDisbursedAt() external view returns (uint256);
    function lastFiatRepaymentRef() external view returns (bytes32);
    function fiatRefUsed(bytes32 ref) external view returns (bool);
    function requireFiatProofBeforeActivate() external view returns (bool);
    function SETTLEMENT_ROLE() external view returns (bytes32);
    function principal() external view returns (uint256);
    function status() external view returns (UnifiedTypes.LoanStatus);
}
