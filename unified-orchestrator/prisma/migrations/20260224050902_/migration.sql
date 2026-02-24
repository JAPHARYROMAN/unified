-- CreateEnum
CREATE TYPE "loan_status" AS ENUM ('CREATED', 'FUNDING', 'ACTIVE', 'REPAID', 'DEFAULTED', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "chain_action_type" AS ENUM ('CREATE_LOAN', 'FUND_LOAN', 'ACTIVATE_LOAN', 'CONFIGURE_SCHEDULE', 'RECORD_DISBURSEMENT', 'REPAY', 'RECORD_REPAYMENT');

-- CreateEnum
CREATE TYPE "chain_action_status" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'RETRYING', 'MINED', 'FAILED', 'DLQ');

-- CreateEnum
CREATE TYPE "fiat_transfer_direction" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "installment_status" AS ENUM ('PENDING', 'DUE', 'PAID', 'PARTIALLY_PAID', 'DELINQUENT', 'DEFAULTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "accrual_status" AS ENUM ('CURRENT', 'IN_GRACE', 'DELINQUENT', 'DEFAULT_CANDIDATE', 'DEFAULTED');

-- CreateEnum
CREATE TYPE "recon_report_scope" AS ENUM ('POOL', 'GLOBAL');

-- CreateEnum
CREATE TYPE "settlement_check_kind" AS ENUM ('FIAT_CONFIRMED_NO_CHAIN', 'CHAIN_RECORD_NO_FIAT', 'ACTIVE_MISSING_DISBURSEMENT');

-- CreateEnum
CREATE TYPE "drift_kind" AS ENUM ('ROUNDING_DRIFT', 'TIMING_DRIFT', 'SCHEDULE_HASH_MISMATCH', 'ACCRUAL_DOUBLE_CHARGE');

-- CreateEnum
CREATE TYPE "recon_incident_severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM');

-- CreateEnum
CREATE TYPE "recon_incident_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "tranche_type" AS ENUM ('SENIOR', 'JUNIOR');

-- CreateEnum
CREATE TYPE "tranche_status" AS ENUM ('ACTIVE', 'DEPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "breaker_trigger" AS ENUM ('ACTIVE_WITHOUT_DISBURSEMENT_PROOF', 'FIAT_CONFIRMED_NO_CHAIN_RECORD', 'PARTNER_DEFAULT_RATE_30D', 'PARTNER_DELINQUENCY_14D', 'POOL_LIQUIDITY_RATIO', 'POOL_NAV_DRAWDOWN_7D', 'JUNIOR_TRANCHE_DEPLETION', 'SENIOR_TRANCHE_DRAWDOWN', 'INVARIANT_FAILURE', 'NAV_PARITY_BREACH', 'STRESS_MODE_ACTIVE', 'COVERAGE_WARNING', 'SUBORDINATION_WARNING', 'POLLER_RPC_ERROR');

-- CreateEnum
CREATE TYPE "breaker_action" AS ENUM ('BLOCK_ALL_ORIGINATIONS', 'BLOCK_PARTNER_ORIGINATIONS', 'FREEZE_ORIGINATIONS', 'TIGHTEN_TERMS', 'REQUIRE_MANUAL_APPROVAL', 'OPEN_INCIDENT');

-- CreateEnum
CREATE TYPE "breaker_scope" AS ENUM ('GLOBAL', 'PARTNER', 'POOL');

-- CreateEnum
CREATE TYPE "breaker_incident_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- AlterTable
ALTER TABLE "AlertEvent" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DailyReconArtifactV2" ALTER COLUMN "date" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvariantCheck" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "max_loan_size_usdc" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "reserve_ratio_bps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "loans" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "borrower_wallet" TEXT NOT NULL,
    "principal_usdc" BIGINT NOT NULL,
    "collateral_token" TEXT NOT NULL,
    "collateral_amount" BIGINT NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "interest_rate_bps" INTEGER NOT NULL,
    "status" "loan_status" NOT NULL DEFAULT 'CREATED',
    "loan_contract" TEXT,
    "pool_contract" TEXT,
    "chain_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_actions" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "type" "chain_action_type" NOT NULL,
    "status" "chain_action_status" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "action_key" TEXT,
    "contract_address" TEXT,
    "function_name" TEXT,
    "encoded_params_hash" TEXT,
    "tx_hash" TEXT,
    "nonce" INTEGER,
    "bump_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "revert_reason" TEXT,
    "block_number" INTEGER,
    "gas_used" BIGINT,
    "confirmations_required" INTEGER NOT NULL DEFAULT 1,
    "confirmations_received" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "mined_at" TIMESTAMP(3),
    "dlq_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_guardrails" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "min_apr_bps" INTEGER NOT NULL,
    "max_apr_bps" INTEGER NOT NULL,
    "min_duration_sec" INTEGER NOT NULL,
    "max_duration_sec" INTEGER NOT NULL,
    "max_loan_usdc" BIGINT NOT NULL,
    "max_borrower_outstanding_usdc" BIGINT NOT NULL,
    "min_reserve_ratio_bps" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiat_transfers" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "direction" "fiat_transfer_direction" NOT NULL,
    "status" "fiat_transfer_status" NOT NULL DEFAULT 'PENDING',
    "provider_ref" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "amount_kes" BIGINT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "ref_hash" TEXT,
    "proof_hash" TEXT,
    "raw_payload" JSONB,
    "confirmed_at" TIMESTAMP(3),
    "applied_onchain_at" TIMESTAMP(3),
    "chain_action_id" UUID,
    "failed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "webhook_timestamp" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiat_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signer_nonces" (
    "id" UUID NOT NULL,
    "signer_address" TEXT NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "nonce" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signer_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_nonces" (
    "id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_dead_letters" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "raw_body" TEXT NOT NULL,
    "fail_reason" TEXT NOT NULL,
    "headers" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_schedules" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "schedule_hash" TEXT NOT NULL,
    "schedule_json" TEXT NOT NULL,
    "total_installments" INTEGER NOT NULL,
    "principal_per_installment" BIGINT NOT NULL,
    "interest_rate_bps" INTEGER NOT NULL,
    "penalty_apr_bps" INTEGER NOT NULL DEFAULT 0,
    "grace_period_seconds" INTEGER NOT NULL DEFAULT 0,
    "interval_seconds" INTEGER NOT NULL,
    "start_timestamp" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_entries" (
    "id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "installment_index" INTEGER NOT NULL,
    "due_timestamp" BIGINT NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "principal_due" BIGINT NOT NULL,
    "interest_due" BIGINT NOT NULL,
    "total_due" BIGINT NOT NULL,
    "principal_paid" BIGINT NOT NULL DEFAULT 0,
    "interest_paid" BIGINT NOT NULL DEFAULT 0,
    "late_fee_accrued" BIGINT NOT NULL DEFAULT 0,
    "penalty_accrued" BIGINT NOT NULL DEFAULT 0,
    "status" "installment_status" NOT NULL DEFAULT 'PENDING',
    "accrual_status" "accrual_status" NOT NULL DEFAULT 'CURRENT',
    "days_past_due" INTEGER NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3),
    "delinquent_since" TIMESTAMP(3),
    "delinquent_days" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installment_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accrual_snapshots" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "hour_bucket" TIMESTAMP(3) NOT NULL,
    "days_past_due" INTEGER NOT NULL,
    "penalty_delta" BIGINT NOT NULL,
    "accrual_status" "accrual_status" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accrual_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recon_reports" (
    "id" UUID NOT NULL,
    "report_date" DATE NOT NULL,
    "scope" "recon_report_scope" NOT NULL,
    "pool_id" UUID,
    "total_active_loans" INTEGER NOT NULL,
    "total_principal_usdc" BIGINT NOT NULL,
    "total_interest_usdc" BIGINT NOT NULL,
    "total_penalty_usdc" BIGINT NOT NULL,
    "total_repayments_fiat" BIGINT NOT NULL,
    "total_repayments_chain" BIGINT NOT NULL,
    "delinquency_distribution" JSONB NOT NULL,
    "default_list" JSONB NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "report_json" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recon_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recon_incidents" (
    "id" UUID NOT NULL,
    "report_id" UUID,
    "kind" "drift_kind" NOT NULL,
    "severity" "recon_incident_severity" NOT NULL,
    "status" "recon_incident_status" NOT NULL DEFAULT 'OPEN',
    "loan_id" UUID,
    "partner_id" UUID,
    "pool_id" UUID,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "tolerance" DOUBLE PRECISION NOT NULL,
    "detail" TEXT NOT NULL,
    "breaker_fired" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recon_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_checks" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "kind" "settlement_check_kind" NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tranches" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "tranche_type" "tranche_type" NOT NULL,
    "status" "tranche_status" NOT NULL DEFAULT 'ACTIVE',
    "commitment_usdc" BIGINT NOT NULL,
    "deployed_usdc" BIGINT NOT NULL DEFAULT 0,
    "nav_usdc" BIGINT NOT NULL DEFAULT 0,
    "yield_bps" INTEGER NOT NULL DEFAULT 0,
    "cumulative_yield_usdc" BIGINT NOT NULL DEFAULT 0,
    "exposure_usdc" BIGINT NOT NULL DEFAULT 0,
    "default_impact_usdc" BIGINT NOT NULL DEFAULT 0,
    "waterfall_priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tranches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tranche_loan_allocations" (
    "id" UUID NOT NULL,
    "tranche_id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "allocated_usdc" BIGINT NOT NULL,
    "allocation_pct" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tranche_loan_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tranche_nav_snapshots" (
    "id" UUID NOT NULL,
    "tranche_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "nav_usdc" BIGINT NOT NULL,
    "exposure_usdc" BIGINT NOT NULL,
    "yield_bps" INTEGER NOT NULL,
    "default_impact_usdc" BIGINT NOT NULL,
    "coverage_ratio_bps" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tranche_nav_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breaker_incidents" (
    "id" UUID NOT NULL,
    "trigger" "breaker_trigger" NOT NULL,
    "scope" "breaker_scope" NOT NULL,
    "partner_id" UUID,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "actions_applied" "breaker_action"[],
    "status" "breaker_incident_status" NOT NULL DEFAULT 'OPEN',
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "breaker_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breaker_audit_logs" (
    "id" UUID NOT NULL,
    "incident_id" UUID,
    "trigger" "breaker_trigger",
    "action" "breaker_action",
    "scope" "breaker_scope" NOT NULL,
    "partner_id" UUID,
    "metric_value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "operator" TEXT NOT NULL DEFAULT 'system',
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breaker_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invariant_poll_records" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "block_number" BIGINT NOT NULL,
    "block_hash" TEXT NOT NULL,
    "polled_at" TIMESTAMP(3) NOT NULL,
    "invariant_ok" BOOLEAN NOT NULL,
    "invariant_code" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL,
    "stress_mode" BOOLEAN NOT NULL,
    "senior_priority_active" BOOLEAN NOT NULL,
    "nav_parity_ok" BOOLEAN NOT NULL,
    "nav_parity_delta_usdc" BIGINT NOT NULL DEFAULT 0,
    "alert_emitted" BOOLEAN NOT NULL DEFAULT false,
    "alert_severity" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invariant_poll_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_recon_artifacts" (
    "id" TEXT NOT NULL,
    "recon_date" DATE NOT NULL,
    "pool_id" TEXT NOT NULL,
    "snapshot_block" BIGINT NOT NULL,
    "snapshot_block_hash" TEXT NOT NULL,
    "sr_virtual_balance" BIGINT NOT NULL,
    "jr_virtual_balance" BIGINT NOT NULL,
    "principal_outstanding" BIGINT NOT NULL,
    "total_principal_allocated" BIGINT NOT NULL,
    "total_principal_repaid_to_pool" BIGINT NOT NULL,
    "usdc_balance" BIGINT NOT NULL,
    "total_bad_debt" BIGINT NOT NULL,
    "cash_lhs" BIGINT NOT NULL,
    "cash_rhs" BIGINT NOT NULL,
    "cash_ok" BOOLEAN NOT NULL,
    "claims_lhs" BIGINT NOT NULL,
    "claims_rhs" BIGINT NOT NULL,
    "claims_ok" BOOLEAN NOT NULL,
    "recon_ok" BOOLEAN NOT NULL,
    "sr_nav_parity_ok" BOOLEAN NOT NULL,
    "jr_nav_parity_ok" BOOLEAN NOT NULL,
    "sr_parity_delta_usdc" BIGINT NOT NULL,
    "jr_parity_delta_usdc" BIGINT NOT NULL,
    "signed_by" TEXT NOT NULL,
    "signature_hex" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_recon_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breaker_overrides" (
    "id" UUID NOT NULL,
    "trigger" "breaker_trigger" NOT NULL,
    "scope" "breaker_scope" NOT NULL,
    "partner_id" UUID,
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "lifted_at" TIMESTAMP(3),
    "lifted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breaker_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loans_partner_id_idx" ON "loans"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "chain_actions_action_key_key" ON "chain_actions"("action_key");

-- CreateIndex
CREATE INDEX "chain_actions_status_next_retry_at_idx" ON "chain_actions"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "chain_actions_status_sent_at_idx" ON "chain_actions"("status", "sent_at");

-- CreateIndex
CREATE INDEX "chain_actions_status_dlq_at_idx" ON "chain_actions"("status", "dlq_at");

-- CreateIndex
CREATE INDEX "partner_guardrails_partner_id_effective_to_idx" ON "partner_guardrails"("partner_id", "effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "fiat_transfers_idempotency_key_key" ON "fiat_transfers"("idempotency_key");

-- CreateIndex
CREATE INDEX "fiat_transfers_loan_id_idx" ON "fiat_transfers"("loan_id");

-- CreateIndex
CREATE INDEX "fiat_transfers_status_provider_idx" ON "fiat_transfers"("status", "provider");

-- CreateIndex
CREATE INDEX "fiat_transfers_chain_action_id_idx" ON "fiat_transfers"("chain_action_id");

-- CreateIndex
CREATE INDEX "fiat_transfers_provider_ref_idx" ON "fiat_transfers"("provider_ref");

-- CreateIndex
CREATE INDEX "fiat_transfers_idempotency_key_idx" ON "fiat_transfers"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "signer_nonces_signer_address_key" ON "signer_nonces"("signer_address");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_nonces_nonce_key" ON "webhook_nonces"("nonce");

-- CreateIndex
CREATE INDEX "webhook_nonces_source_received_at_idx" ON "webhook_nonces"("source", "received_at");

-- CreateIndex
CREATE INDEX "webhook_dead_letters_source_created_at_idx" ON "webhook_dead_letters"("source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "installment_schedules_loan_id_key" ON "installment_schedules"("loan_id");

-- CreateIndex
CREATE INDEX "installment_entries_loan_id_status_idx" ON "installment_entries"("loan_id", "status");

-- CreateIndex
CREATE INDEX "installment_entries_loan_id_accrual_status_idx" ON "installment_entries"("loan_id", "accrual_status");

-- CreateIndex
CREATE INDEX "installment_entries_due_date_status_idx" ON "installment_entries"("due_date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "installment_entries_schedule_id_installment_index_key" ON "installment_entries"("schedule_id", "installment_index");

-- CreateIndex
CREATE INDEX "accrual_snapshots_loan_id_hour_bucket_idx" ON "accrual_snapshots"("loan_id", "hour_bucket");

-- CreateIndex
CREATE UNIQUE INDEX "accrual_snapshots_entry_id_hour_bucket_key" ON "accrual_snapshots"("entry_id", "hour_bucket");

-- CreateIndex
CREATE INDEX "recon_reports_report_date_scope_idx" ON "recon_reports"("report_date", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "recon_reports_report_date_scope_pool_id_key" ON "recon_reports"("report_date", "scope", "pool_id");

-- CreateIndex
CREATE INDEX "recon_incidents_kind_status_idx" ON "recon_incidents"("kind", "status");

-- CreateIndex
CREATE INDEX "recon_incidents_loan_id_status_idx" ON "recon_incidents"("loan_id", "status");

-- CreateIndex
CREATE INDEX "recon_incidents_partner_id_status_idx" ON "recon_incidents"("partner_id", "status");

-- CreateIndex
CREATE INDEX "settlement_checks_loan_id_kind_idx" ON "settlement_checks"("loan_id", "kind");

-- CreateIndex
CREATE INDEX "settlement_checks_kind_passed_checked_at_idx" ON "settlement_checks"("kind", "passed", "checked_at");

-- CreateIndex
CREATE INDEX "tranches_pool_id_tranche_type_idx" ON "tranches"("pool_id", "tranche_type");

-- CreateIndex
CREATE UNIQUE INDEX "tranche_loan_allocations_tranche_id_loan_id_key" ON "tranche_loan_allocations"("tranche_id", "loan_id");

-- CreateIndex
CREATE INDEX "tranche_nav_snapshots_snapshot_date_idx" ON "tranche_nav_snapshots"("snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "tranche_nav_snapshots_tranche_id_snapshot_date_key" ON "tranche_nav_snapshots"("tranche_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "breaker_incidents_trigger_status_idx" ON "breaker_incidents"("trigger", "status");

-- CreateIndex
CREATE INDEX "breaker_incidents_partner_id_status_idx" ON "breaker_incidents"("partner_id", "status");

-- CreateIndex
CREATE INDEX "breaker_audit_logs_trigger_created_at_idx" ON "breaker_audit_logs"("trigger", "created_at");

-- CreateIndex
CREATE INDEX "breaker_audit_logs_partner_id_created_at_idx" ON "breaker_audit_logs"("partner_id", "created_at");

-- CreateIndex
CREATE INDEX "invariant_poll_records_pool_id_block_number_idx" ON "invariant_poll_records"("pool_id", "block_number");

-- CreateIndex
CREATE INDEX "invariant_poll_records_invariant_ok_idx" ON "invariant_poll_records"("invariant_ok");

-- CreateIndex
CREATE UNIQUE INDEX "daily_recon_artifacts_recon_date_key" ON "daily_recon_artifacts"("recon_date");

-- CreateIndex
CREATE INDEX "daily_recon_artifacts_pool_id_recon_date_idx" ON "daily_recon_artifacts"("pool_id", "recon_date");

-- CreateIndex
CREATE INDEX "daily_recon_artifacts_recon_ok_idx" ON "daily_recon_artifacts"("recon_ok");

-- CreateIndex
CREATE INDEX "breaker_overrides_trigger_expires_at_idx" ON "breaker_overrides"("trigger", "expires_at");

-- CreateIndex
CREATE INDEX "breaker_overrides_partner_id_expires_at_idx" ON "breaker_overrides"("partner_id", "expires_at");

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_actions" ADD CONSTRAINT "chain_actions_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_guardrails" ADD CONSTRAINT "partner_guardrails_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiat_transfers" ADD CONSTRAINT "fiat_transfers_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiat_transfers" ADD CONSTRAINT "fiat_transfers_chain_action_id_fkey" FOREIGN KEY ("chain_action_id") REFERENCES "chain_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_schedules" ADD CONSTRAINT "installment_schedules_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_entries" ADD CONSTRAINT "installment_entries_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "installment_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accrual_snapshots" ADD CONSTRAINT "accrual_snapshots_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "installment_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recon_incidents" ADD CONSTRAINT "recon_incidents_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "recon_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tranches" ADD CONSTRAINT "tranches_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "partner_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tranche_loan_allocations" ADD CONSTRAINT "tranche_loan_allocations_tranche_id_fkey" FOREIGN KEY ("tranche_id") REFERENCES "tranches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tranche_loan_allocations" ADD CONSTRAINT "tranche_loan_allocations_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tranche_nav_snapshots" ADD CONSTRAINT "tranche_nav_snapshots_tranche_id_fkey" FOREIGN KEY ("tranche_id") REFERENCES "tranches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaker_audit_logs" ADD CONSTRAINT "breaker_audit_logs_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "breaker_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
