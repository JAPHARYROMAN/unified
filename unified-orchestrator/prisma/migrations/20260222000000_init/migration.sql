-- CreateEnum
CREATE TYPE "partner_status" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'VERIFIED', 'ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "health_checks" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "jurisdiction_code" INTEGER NOT NULL,
    "license_id" TEXT,
    "registration_number" TEXT NOT NULL,
    "compliance_email" TEXT NOT NULL,
    "treasury_wallet" TEXT NOT NULL,
    "status" "partner_status" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_submissions" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "submitted_payload" JSONB NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "notes" TEXT,

    CONSTRAINT "partner_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_api_keys" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "partner_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_pools" (
    "id" UUID NOT NULL,
    "partner_id" UUID NOT NULL,
    "pool_contract" TEXT NOT NULL,
    "chain_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_pools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_api_keys_key_hash_idx" ON "partner_api_keys"("key_hash");

-- AddForeignKey
ALTER TABLE "partner_submissions" ADD CONSTRAINT "partner_submissions_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_api_keys" ADD CONSTRAINT "partner_api_keys_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_pools" ADD CONSTRAINT "partner_pools_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
