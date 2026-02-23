# Unified v1.1 — 100-Loan Pilot Harness (Installments)

## Scope
- Scenario orchestration across 3 cohorts: `20 + 40 + 40`
- Deterministic manifest generation for audit review
- Breaker trigger + recovery validation

## Test Entry
- File: `unified-orchestrator/src/modules/circuit-breaker/pilot-installment-100-loan.harness.spec.ts`
- Command:
```bash
npm test -- --runInBand src/modules/circuit-breaker/pilot-installment-100-loan.harness.spec.ts
```

## Manifest Schema
Top-level:
- `runId`
- `generatedAt`
- `cohorts`
- `loans` (100 entries)
- `assertions`
- `summary`

Per-loan fields:
- `partnerId`
- `poolId`
- `loanId`
- `schedule_hash`
- `activation_timestamps`
- `repayment_schedule_timestamps`
- `tx_hashes`
- `delinquency_state_timeline`
- `breaker_events_timeline`
- `reconciliation_report_ids`
- `scenarios`

## Cohort Composition
- `COHORT_1_CORRECTNESS` (20):
  - On-time/grace paths + overpay-attempt checks
- `COHORT_2_BEHAVIOR` (40):
  - Multi-partner behavior + partial payment combinations
- `COHORT_3_STRESS` (40):
  - Late beyond grace
  - Multi-installment partial payments
  - Webhook-delay activation guard path
  - Sender failure to DLQ
  - Manual replay recovery

## Assertions in Harness
- `activeWithoutProofImpossible`
- `overpayReverts`
- `accrualIdempotent`
- `breakerThresholdsExceeded`
- `recoveryClearsIncidents`

## Sample Output
The harness prints:
- `INSTALLMENT_100_LOAN_PILOT_MANIFEST` JSON
- Full run summary
- `sample_loans` (first 3 loan manifests) for quick audit preview

