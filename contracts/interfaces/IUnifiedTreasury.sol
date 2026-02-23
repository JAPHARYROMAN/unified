// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IUnifiedTreasury
 * @notice Interface for the protocol fee treasury.
 */
interface IUnifiedTreasury {
    function receiveERC20(address token, uint256 amount) external;
    function withdrawERC20(address token, address to, uint256 amount) external;
}
