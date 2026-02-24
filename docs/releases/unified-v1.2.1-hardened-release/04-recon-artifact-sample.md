# §5 Daily Reconciliation — Implementation Status

> **v1.2.1 alignment**: The reconciliation layer mirrors the on-chain split invariant model
> (INV-CASH + INV-CLAIMS). The previously used mixed identity has been deprecated.

## Split Invariant Model

Two independent checks, each mirroring an on-chain invariant exactly:

### INV-CASH
```
cashLhs = srVirtualBalance + jrVirtualBalance
cashRhs = usdcBalance
cashOk  = (cashLhs == cashRhs)
```
Breach → **P0 `RECON_CASH_IDENTITY_BREACH`**

### INV-CLAIMS
```
claimsLhs = principalOutstanding
claimsRhs = totalPrincipalAllocated - totalPrincipalRepaidToPool - totalBadDebt
claimsOk  = (claimsLhs == claimsRhs)
```
Breach → **P0 `RECON_CLAIMS_IDENTITY_BREACH`**

### Combined
```
reconOk = cashOk && claimsOk
```

---

## Signed Artifact Structure (`DailyReconArtifact`)

```typescript
// src/modules/tranche/tranche.types.ts
export interface DailyReconArtifact {
  reconDate:                   string;    // YYYY-MM-DD UTC
  poolId:                      string;
  snapshotBlock:               bigint;
  snapshotBlockHash:           string;
  computedAt:                  string;    // ISO-8601

  // Raw inputs
  srVirtualBalance:            bigint;
  jrVirtualBalance:            bigint;
  principalOutstanding:        bigint;
  totalPrincipalAllocated:     bigint;
  totalPrincipalRepaidToPool:  bigint;
  usdcBalance:                 bigint;
  totalBadDebt:                bigint;

  // INV-CASH: sr.vb + jr.vb == usdcBalance
  cashLhs:                     bigint;
  cashRhs:                     bigint;
  cashOk:                      boolean;

  // INV-CLAIMS: principalOutstanding == allocated - repaid - badDebt
  claimsLhs:                   bigint;
  claimsRhs:                   bigint;
  claimsOk:                    boolean;

  // Combined
  reconOk:                     boolean;   // cashOk && claimsOk

  srNavParityOk:               boolean;
  jrNavParityOk:               boolean;
  srParityDeltaUsdc:           bigint;
  jrParityDeltaUsdc:           bigint;

  signedBy:                    string;    // "unified-orchestrator/recon-service"
  signatureHex:                string;    // HMAC-SHA256, 64-char hex
}
```

---

## Signing

`src/modules/tranche/tranche-recon.service.ts` — deterministic HMAC-SHA256:

```typescript
private sign(artifact: Omit<DailyReconArtifact, "signatureHex">): string {
  const key = this.config.get<string>("RECON_SIGNING_KEY");
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(artifact).sort()) {
    const v = (artifact as any)[k];
    sorted[k] = typeof v === "bigint" ? v.toString() : v;
  }
  const canonical = JSON.stringify(sorted);
  return createHmac("sha256", key ?? "").update(canonical).digest("hex");
}
```

**Properties:**
- Keys sorted lexicographically → canonical JSON is deterministic
- `bigint` fields serialised as decimal strings before hashing
- `computedAt` captured once per run → stable across repeated calls
- Keyed by `RECON_SIGNING_KEY` env var (warns + falls back to empty key if unset)

---

## Prisma Model

File: `prisma/schema.prisma` — model `DailyReconArtifact`

- Unique constraint on `reconDate` (one artifact per UTC day)
- Indexed on `(poolId, reconDate)` and `reconOk`
- Stores `cashLhs`, `cashRhs`, `cashOk`, `claimsLhs`, `claimsRhs`, `claimsOk` as native columns
- All monetary fields stored as `BigInt` (Postgres `BIGINT`)
- Deprecated columns `lhs`, `rhs`, `recon_delta_usdc` removed in migration `20260223193357_split_recon_invariants_v121`

---

## Service — `TrancheReconService`

File: `src/modules/tranche/tranche-recon.service.ts`

| Method | Description |
|---|---|
| `runDailyRecon(poolId, blockNumber, blockHash, usdcBalance)` | Runs INV-CASH + INV-CLAIMS checks, signs artifact, upserts to DB, emits P0 alerts on breach |
| `getLatestArtifact(poolId)` | Returns most recent artifact for a pool |
| `verifySignature(artifact)` | Re-derives HMAC and compares — returns `false` on any field tampering |

---

## Cron Schedule

File: `src/modules/tranche/tranche.scheduler.ts`

Fires at **03:00 UTC** daily via `@Cron("0 3 * * *")`.

---

## Alerts on Breach

Two independent P0 alerts emitted via `logger.error` as structured JSON:

**RECON_CASH_IDENTITY_BREACH**
```json
{
  "env": "production",
  "severity": "P0",
  "triggerId": "RECON_CASH_IDENTITY_BREACH",
  "poolId": "...",
  "cashLhs": "1000000000",
  "cashRhs": "999000000",
  "blockNumber": "21500000",
  "firedAt": "2026-02-23T03:00:00.000Z"
}
```

**RECON_CLAIMS_IDENTITY_BREACH**
```json
{
  "env": "production",
  "severity": "P0",
  "triggerId": "RECON_CLAIMS_IDENTITY_BREACH",
  "poolId": "...",
  "claimsLhs": "500000000",
  "claimsRhs": "300000000",
  "blockNumber": "21500000",
  "firedAt": "2026-02-23T03:00:00.000Z"
}
```

---

## Admin Endpoint

```
GET /admin/tranche/recon/latest?pool_id=<uuid>
```

- Returns `DailyReconArtifact` with `bigint` fields serialised as strings
- Guarded by `ApiKeyGuard` (`X-Admin-Key` header)

---

## Test Coverage

File: `src/modules/tranche/tranche.spec.ts` — Suite B (10 cases, all passing)

```
✓ B1:  cashOk = true when sr.vb + jr.vb == usdcBalance
✓ B2:  cashOk = false when delta injected
✓ B3:  claimsLhs / claimsRhs fields correctly computed
✓ B4:  claimsOk field is boolean
✓ B5:  reconOk == cashOk && claimsOk
✓ B6:  reconOk = true when both invariants hold (all zeros)
✓ B7:  signature is deterministic — same inputs produce same hex
✓ B8:  verifySignature returns true for unmodified artifact
✓ B9:  verifySignature returns false when cashOk field is tampered
✓ B10: different RECON_SIGNING_KEY produces different signature
```

Total suite: **32/32 passing** (A×9, B×10, C×6, D×7)

---

## Database Status

- Migration `20260223192129_baseline_full_schema` — full schema baseline applied
- Migration `20260223193357_split_recon_invariants_v121` — split invariant columns added, deprecated `lhs`/`rhs`/`recon_delta_usdc` removed
- Both applied to `localhost:5432/unified_orchestrator`
- Table `daily_recon_artifacts` is live and in sync with the Prisma schema

---

## Environment Variables Required

| Variable | Description |
|---|---|
| `RECON_SIGNING_KEY` | Secret key for HMAC-SHA256 artifact signing |
| `POOL_CONTRACT_ADDRESS` | Pool contract address (used as `poolId` by scheduler) |
| `RPC_URL` | JSON-RPC endpoint for on-chain `usdcBalance` reads (production) |
