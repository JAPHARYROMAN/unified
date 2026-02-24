CREATE TABLE "DailyReconArtifactV2" (
    "id" TEXT PRIMARY KEY,
    "date" TIMESTAMP NOT NULL,

    "cashLhs" BIGINT NOT NULL,
    "cashRhs" BIGINT NOT NULL,
    "cashOk" BOOLEAN NOT NULL,

    "claimsLhs" BIGINT NOT NULL,
    "claimsRhs" BIGINT NOT NULL,
    "claimsOk" BOOLEAN NOT NULL,

    "reconOk" BOOLEAN NOT NULL,

    "artifactHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,

    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "DailyReconArtifactV2_date_key"
ON "DailyReconArtifactV2" ("date");

CREATE INDEX "DailyReconArtifactV2_reconOk_idx"
ON "DailyReconArtifactV2" ("reconOk");


CREATE TABLE "AlertEvent" (
    "id" TEXT PRIMARY KEY,
    "severity" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP
);

CREATE INDEX "AlertEvent_severity_idx"
ON "AlertEvent" ("severity");

CREATE INDEX "AlertEvent_resolved_idx"
ON "AlertEvent" ("resolved");
