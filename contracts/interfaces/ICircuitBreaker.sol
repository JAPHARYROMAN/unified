// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICircuitBreaker
 * @notice Read-only interface consumed by pool contracts to query breaker state.
 *
 * @dev States are breaker-level intents. Individual pools may enforce
 *      a subset depending on integration.
 *      UnifiedPoolTranched currently enforces only:
 *        - GLOBAL_HARD_STOP => guarded entrypoints revert
 *      and treats all other states as informational.
 */
interface ICircuitBreaker {
    enum BreakerState {
        NORMAL,
        PARTNER_BLOCKED,
        POOL_FROZEN,
        GLOBAL_HARD_STOP,
        RECOVERY_MONITOR,
        CLEARED
    }

    /// @notice Return the current breaker state for a given pool address.
    function stateOf(address pool) external view returns (BreakerState);
}
