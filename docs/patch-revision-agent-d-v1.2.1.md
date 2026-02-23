# Patch Revision — Agent D (v1.2.1 Safety)

## Revision ID
- `agent-d-patch-revision-v1.2.1-safety`
- Date: 2026-02-23

## Scope
This revision captures the required pre-merge actions for the adversarial safety pass:
1. Real-loan integration invariant test
2. Allocation authenticity guard
3. FIFO posture decision artifact
4. Breaker interface comment update

## Files Changed
- `contracts/UnifiedPoolTranched.sol`
- `contracts/interfaces/ICircuitBreaker.sol`
- `test/UnifiedPoolTranched.test.ts`
- `docs/fifo-enforcement-posture.md`

## Contract Patch Summary
### `contracts/UnifiedPoolTranched.sol`
- Added allocation authenticity guard in `allocateToLoan`:
  - Requires `LOAN_ROLE` on `loan`
  - Requires `loan.code.length > 0`
  - Reverts `Unauthorized` if either check fails
- Updated INV-1 implementation and docs:
  - Runtime check now enforces:
    - `sr.virtualBalance + jr.virtualBalance + totalBadDebt == usdc.balanceOf(pool)`
  - Applied in both:
    - `_assertCoreInvariants()`
    - `checkInvariants()`
- Updated top-level doc wording from FIFO to indexed queue semantics.

### `contracts/interfaces/ICircuitBreaker.sol`
- Updated interface comment to reflect integration reality:
  - Breaker states are intent-level
  - `UnifiedPoolTranched` currently enforces only `GLOBAL_HARD_STOP`
  - Other states treated as informational unless integrated by pool logic

## Test Additions
### `test/UnifiedPoolTranched.test.ts`
- Added helper:
  - `deployPoolModelLoan(...)` to deploy and initialize real `UnifiedLoan` in POOL model
- Added test:
  - `reverts allocation to EOA even with LOAN_ROLE (authenticity guard)`
- Added test:
  - `real POOL loan funding path preserves invariants`
  - Validates real funding flow through `poolFund` and confirms `checkInvariants() == (true, 0)`
- Added test:
  - `queue posture: fulfillment is index-addressable (non-strict FIFO)`
  - Documents current non-strict FIFO behavior as explicit posture evidence

## Decision Artifact
### `docs/fifo-enforcement-posture.md`
- Captures selected posture:
  - Non-strict FIFO on-chain (index-addressable fulfillment)
  - FIFO as operator policy
- Explicitly marks Architect sign-off as required before merge
- Includes strict-FIFO upgrade path if architecture changes later

## Verification
Executed:
- `npx hardhat test test/UnifiedPoolTranched.test.ts`

Result:
- `93 passing`

Key confirmations:
- Authenticity guard rejects EOA allocation targets
- Real loan `poolFund` allocation path now validates invariants under live flow
- No regressions observed in existing tranched suite

## Notes
- Workspace has no commit history (`HEAD` unborn), so commit hash cannot be attached in this environment.
