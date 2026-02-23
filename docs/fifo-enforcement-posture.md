# FIFO Enforcement Posture (UnifiedPoolTranched)

## Decision
- Posture selected for v1.2.1 merge: **index-addressable fulfillment (non-strict FIFO) with operator policy FIFO**.

## Rationale
- Current contract architecture uses `fulfillWithdraw(tranche, requestId)` and does not maintain a head pointer.
- Strict on-chain FIFO would add additional state and revert paths (head lock semantics) and changes operational flexibility under stress.
- The selected posture preserves existing behavior while making the policy explicit.

## Required Architect Sign-off
- This posture requires Architect approval before merge because it is a product-level fairness decision, not a bugfix-only change.

## Future Option (if strict FIFO is mandated)
1. Add `nextFulfillableRequestId[tranche]`.
2. Require `requestId == nextFulfillableRequestId[tranche]` in `_fulfillOne`.
3. Advance pointer only after successful fulfillment/cancel semantics are finalized.
4. Add griefing analysis for low-liquidity head blocking.
