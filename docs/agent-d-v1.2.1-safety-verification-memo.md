# AGENT D — Adversarial Safety & Invariant Verification (UNIFIED v1.2.1)

## Branch / Commit
- Branch: `master` (current local branch, not `agent-d/v1.2.1-safety-review`)
- Commit hash: unavailable (`HEAD` unborn in this workspace; no initial commit)

## Validation Executed
- `npx hardhat test test/UnifiedPoolTranched.test.ts` -> `90 passing`
- `npx hardhat test test/UnifiedProtocol.test.ts --grep "onLoanRepayment reverts without LOAN_ROLE|factory createLoan auto-grants LOAN_ROLE on pool for POOL loans"` -> `2 passing`

## 1) Safety Verification Memo (Attack Surface)

### High Findings
1. `INV-1` formula appears incompatible with real loan funding flow (inference from code).
   - `allocateToLoan` decrements virtual balances, increments principal out, then calls `loan.poolFund(amount)` which transfers USDC from pool to loan (`contracts/UnifiedPoolTranched.sol:800`, `contracts/UnifiedPoolTranched.sol:806`, `contracts/UnifiedPoolTranched.sol:811`, `contracts/UnifiedLoan.sol:434`).
   - Invariant currently checks `sumVirtual + principalOut == poolUSDC + totalBadDebt` (`contracts/UnifiedPoolTranched.sol:1183`).
   - With actual transfer-to-loan, this can fail economically unless assumptions differ.
   - Test gap confirms this path is not exercised in tranched tests (`test/UnifiedPoolTranched.test.ts:867`).

2. Loan authenticity boundary is weak in allocation path.
   - `allocateToLoan` does not require `LOAN_ROLE` nor code-size/interface conformance; it only checks non-zero address (`contracts/UnifiedPoolTranched.sol:767`).
   - It grants allowance then external-calls `poolFund` (`contracts/UnifiedPoolTranched.sol:810`).
   - Malicious/non-conforming recipient risk exists if allocator/governance is compromised.

### Medium Findings
1. Breaker hard-stop semantics are bypassable vs interface intent.
   - Interface says `GLOBAL_HARD_STOP = all mutations blocked` (`contracts/interfaces/ICircuitBreaker.sol:12`).
   - In practice breaker guard is only applied on `deposit`, `withdraw`, `allocateToLoan` (`contracts/UnifiedPoolTranched.sol:239`, `contracts/UnifiedPoolTranched.sol:492`, `contracts/UnifiedPoolTranched.sol:549`, `contracts/UnifiedPoolTranched.sol:764`).
   - Mutations like `requestWithdraw`, `cancelWithdraw`, `fulfillWithdraw` still proceed.

2. FIFO queue is not enforced on-chain.
   - Queue IDs are user-selectable at fulfillment; no head pointer/next-index gate (`contracts/UnifiedPoolTranched.sol:677`, `contracts/UnifiedPoolTranched.sol:690`, `contracts/UnifiedPoolTranched.sol:703`).
   - This allows out-of-order fulfillment and queue-ordering strategy exploits under low liquidity.

### Pass / Confirmed Controls
1. Unauthorized repayment callbacks blocked by `onlyRole(LOAN_ROLE)` (`contracts/UnifiedPoolTranched.sol:832`) and tested (`test/UnifiedProtocol.test.ts:1803`).
2. Reentrancy protections on token/external-call paths: `deposit/withdraw/request/cancel/fulfill/allocate/onLoanRepayment/claimLoanCollateral` are `nonReentrant` (`contracts/UnifiedPoolTranched.sol:490`, `contracts/UnifiedPoolTranched.sol:547`, `contracts/UnifiedPoolTranched.sol:602`, `contracts/UnifiedPoolTranched.sol:650`, `contracts/UnifiedPoolTranched.sol:679`, `contracts/UnifiedPoolTranched.sol:762`, `contracts/UnifiedPoolTranched.sol:831`, `contracts/UnifiedPoolTranched.sol:1087`).
3. Effects-before-interactions generally respected in withdraw and repayment accounting before transfer/callbacks (`contracts/UnifiedPoolTranched.sol:580`, `contracts/UnifiedPoolTranched.sol:585`, `contracts/UnifiedPoolTranched.sol:840`, `contracts/UnifiedPoolTranched.sol:844`).
4. Launch parameter lock is one-way and enforced for critical setters (`contracts/UnifiedPoolTranched.sol:273`, `contracts/UnifiedPoolTranched.sol:281`, `contracts/UnifiedPoolTranched.sol:286`, `contracts/UnifiedPoolTranched.sol:292`, `contracts/UnifiedPoolTranched.sol:347`), with tests (`test/UnifiedPoolTranched.test.ts:1045`).

## 2) State-Transition Proof Table

| State | deposit | withdraw | requestWithdraw | cancelWithdraw | fulfillWithdraw | allocateToLoan | onLoanRepayment | Notes |
|---|---|---|---|---|---|---|---|---|
| NORMAL | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Standard mode |
| STRESS | Yes (unless paused) | No (`StressModeLocked`) | Yes | Yes | No (`StressModeLocked`) | No (`StressModeLocked`) | Yes | `stressMode` gates withdrawal/fulfillment/allocation |
| PAUSED | No (`whenNotPaused`) | No (`whenNotPaused`) | Yes | Yes | Yes (if not stress/priority blocked) | No (`whenNotPaused`) | Yes | Safe-exit queueing/cancel supported |
| STRESS+PAUSED | No | No | Yes | Yes | No | No | Yes | Lockdown except queue mgmt + repayment |
| RECOVERY_MONITOR (breaker=4) | Yes currently | Yes currently | Yes | Yes | Yes | Yes currently | Yes | Diverges from breaker interface intent (`POOL_FROZEN`-like expected) |

## 3) Invariant Stress Verification

| Invariant | Status | Evidence |
|---|---|---|
| INV-1 full balance identity | **At risk / needs integration proof** | Formula at `contracts/UnifiedPoolTranched.sol:1183`; tranched tests explicitly avoid real `poolFund` path (`test/UnifiedPoolTranched.test.ts:867`) |
| INV-7 coverage enforcement | Pass | Hard revert in allocation (`contracts/UnifiedPoolTranched.sol:790`), tested (`test/UnifiedPoolTranched.test.ts:839`) |
| INV-8 zero-tolerance senior impairment | Logic present, **under-tested with real outstanding loans** | Trigger in `recordBadDebt` (`contracts/UnifiedPoolTranched.sol:962`); tests acknowledge inability to force real outstanding (`test/UnifiedPoolTranched.test.ts:926`) |
| No negative virtual balances | Pass by construction | Checked or floored in withdraw/fulfill/loss (`contracts/UnifiedPoolTranched.sol:565`, `contracts/UnifiedPoolTranched.sol:730`, `contracts/UnifiedPoolTranched.sol:997`, `contracts/UnifiedPoolTranched.sol:1015`) |
| No share supply drift | Pass by construction | Mint/burn symmetry in deposit/withdraw/fulfill (`contracts/UnifiedPoolTranched.sol:523`, `contracts/UnifiedPoolTranched.sol:582`, `contracts/UnifiedPoolTranched.sol:742`) |

### Invariant Stress Tests Required (Gaps Found)
1. Real-loan integration: `allocateToLoan` -> actual `UnifiedLoan.poolFund` transfer -> post-call `checkInvariants()`.
2. Breaker-hard-stop mutation denial test matrix (including queue ops and fulfill paths).
3. FIFO enforcement test under low liquidity with adversarial request ordering.
4. Malicious-loan conformance tests: EOA/non-contract recipient, non-pulling `poolFund`, delayed allowance pull.

## 4) Formal No-Trapped-Funds Argument
1. During pause/stress, users can always `requestWithdraw` and `cancelWithdraw`, so shares are not permanently locked in pending state (`contracts/UnifiedPoolTranched.sol:600`, `contracts/UnifiedPoolTranched.sol:648`).
2. Inbound recovery channels remain live: `onLoanRepayment` and `onCollateralRecovery` are not pause-gated, so pool solvency can improve while paused (`contracts/UnifiedPoolTranched.sol:828`, `contracts/UnifiedPoolTranched.sol:1042`).
3. Exit from lockdown is governance-controlled (`unpause`, `setStressMode(false)`, optional `clearSeniorPriority`) (`contracts/UnifiedPoolTranched.sol:1144`, `contracts/UnifiedPoolTranched.sol:320`, `contracts/UnifiedPoolTranched.sol:332`).
4. Therefore, no protocol-level permanent trapped-funds condition is evident under honest governance liveness.
5. Residual risk: if governance/pauser is unavailable or malicious, withdrawals can be indefinitely delayed (operational centralization risk, not arithmetic fund loss).
