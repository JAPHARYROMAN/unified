CREATE TABLE "InvariantCheck" (
    "id" TEXT PRIMARY KEY,
    "blockNumber" BIGINT NOT NULL,
    "contract" TEXT NOT NULL,
    "cashOk" BOOLEAN NOT NULL,
    "claimsOk" BOOLEAN NOT NULL,
    "violationCode" INTEGER,
    "txHash" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "InvariantCheck_blockNumber_idx"
ON "InvariantCheck" ("blockNumber");

CREATE INDEX "InvariantCheck_contract_idx"
ON "InvariantCheck" ("contract");
