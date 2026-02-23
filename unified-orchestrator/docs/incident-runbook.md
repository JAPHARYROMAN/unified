# Incident Runbook: Reconciliation + Chain Action Recovery

## Scope
This runbook covers:
- safely requeueing stuck/failed chain actions
- resolving ambiguous fiat repayment matching

All steps assume use of admin endpoints protected by `x-api-key`.

## 1) Safe Requeue Procedure

### Preconditions
- action is `FAILED`, or
- action is `PROCESSING`/`SENT` and stale beyond threshold (default: 15 min)
- if action is `SENT`, `txHash` must be empty (if tx hash exists, do **not** requeue blindly)

### Steps
1. Inspect queue: `GET /admin/ops/chain-actions?status=PROCESSING&min_age_minutes=15`
2. Inspect timeline: `GET /admin/ops/loans/{loanId}/timeline`
3. Confirm no mined tx exists for the same intent in chain explorer / logs.
4. Requeue: `POST /admin/ops/chain-actions/{id}/requeue?min_stuck_minutes=15`
5. Verify transition to `QUEUED` and new processing attempt in queue view.
6. Confirm eventual `SENT/MINED` transition and loan state progression.

### Do Not Requeue If
- `txHash` is present but confirmation is delayed/unknown
- there is evidence the tx already mined and downstream DB update is lagging

## 2) Ambiguous Repayment Matching Procedure

### Symptoms
- inbound fiat repayment confirmed by provider
- no corresponding on-chain repayment action/application
- multiple open loans for same borrower/provider reference context

### Steps
1. Run reconciliation: `GET /admin/ops/reconciliation`
2. List candidate transfers: `GET /admin/ops/fiat-transfers?status=CONFIRMED&provider={provider}`
3. Open each loan timeline and compare:
   - amount
   - provider reference
   - confirmation timestamp
   - repayment window/status
4. If one clear match exists:
   - attach/update `chain_action_id`
   - execute repayment chain action
   - set transfer `status=APPLIED_ONCHAIN`, `applied_onchain_at=now`
5. If no clear match exists:
   - move record to manual exception queue
   - add operator note with candidate loans and reason
   - escalate to compliance/ops lead for final mapping decision
6. Re-run reconciliation and confirm mismatch clears.

## 3) Triage Targets
- Time-to-root-cause target: < 10 minutes using:
  - `/admin/ops/alerts`
  - `/admin/ops/chain-actions`
  - `/admin/ops/fiat-transfers`
  - `/admin/ops/loans/{loanId}/timeline`

## 4) Daily Gate
- Execute reconciliation once daily (or via scheduler) and require:
  - `criticalCount == 0` before close of day.
