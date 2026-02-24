-- Ops reconciliation + observability parity

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fiat_transfer_status') THEN
    CREATE TYPE fiat_transfer_status AS ENUM (
      'PENDING',
      'FAILED',
      'PAYOUT_INITIATED',
      'PAYOUT_CONFIRMED',
      'CHAIN_RECORD_PENDING',
      'CHAIN_RECORDED',
      'ACTIVATED',
      'REPAYMENT_RECEIVED',
      'CHAIN_REPAY_PENDING',
      'CHAIN_REPAY_CONFIRMED',
      'CONFIRMED',
      'APPLIED_ONCHAIN'
    );
  END IF;
END$$;

-- 1) Extend fiat_transfer_status enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'fiat_transfer_status'
      AND e.enumlabel = 'APPLIED_ONCHAIN'
  ) THEN
    ALTER TYPE "fiat_transfer_status" ADD VALUE 'APPLIED_ONCHAIN';
  END IF;
END
$$;

-- 2) Extend fiat_transfers table for provider filtering and chain linkage
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'fiat_transfers') THEN
    ALTER TABLE "fiat_transfers"
      ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
      ADD COLUMN IF NOT EXISTS "applied_onchain_at" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "chain_action_id" UUID;

    CREATE INDEX IF NOT EXISTS "fiat_transfers_status_provider_idx"
      ON "fiat_transfers"("status", "provider");

    CREATE INDEX IF NOT EXISTS "fiat_transfers_chain_action_id_idx"
      ON "fiat_transfers"("chain_action_id");

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'fiat_transfers_chain_action_id_fkey'
    ) THEN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chain_actions') THEN
        ALTER TABLE "fiat_transfers"
          ADD CONSTRAINT "fiat_transfers_chain_action_id_fkey"
          FOREIGN KEY ("chain_action_id") REFERENCES "chain_actions"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END IF;
  END IF;
END
$$;
