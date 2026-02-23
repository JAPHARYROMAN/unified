-- Ops reconciliation + observability parity

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
ALTER TABLE "fiat_transfers"
  ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "applied_onchain_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "chain_action_id" UUID;

CREATE INDEX IF NOT EXISTS "fiat_transfers_status_provider_idx"
  ON "fiat_transfers"("status", "provider");

CREATE INDEX IF NOT EXISTS "fiat_transfers_chain_action_id_idx"
  ON "fiat_transfers"("chain_action_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fiat_transfers_chain_action_id_fkey'
  ) THEN
    ALTER TABLE "fiat_transfers"
      ADD CONSTRAINT "fiat_transfers_chain_action_id_fkey"
      FOREIGN KEY ("chain_action_id") REFERENCES "chain_actions"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
