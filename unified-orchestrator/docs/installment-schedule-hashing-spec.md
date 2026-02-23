# Installment Schedule Hashing Specification

**Version:** 1.0  
**Status:** Normative  
**Scope:** Backend schedule engine ↔ on-chain contract verification

---

## 1. Purpose

The schedule hash (`schedule_hash`) is a SHA-256 digest of the canonical JSON
representation of an installment schedule.  It is:

1. Stored in the database alongside the canonical JSON (`schedule_json`).
2. Passed to the contract via a `CONFIGURE_SCHEDULE` chain action at origination.
3. Verified on-chain when the borrower or protocol interacts with the schedule.
4. Re-verified by `assertHashIntegrity()` after loan activation to detect tampering.

Any implementation that produces the same canonical JSON will produce the same hash.
This spec is the single source of truth for that serialization.

---

## 2. Input Parameters

| Field              | Type    | Description                                                   |
|--------------------|---------|---------------------------------------------------------------|
| `loan_id`          | string  | UUID of the loan (hyphenated lowercase)                       |
| `principal`        | bigint  | Total principal in USDC (6 decimals), e.g. `1000000000`      |
| `interest_rate_bps`| integer | Annual interest rate in basis points, e.g. `1200` = 12% APR  |
| `start_ts`         | integer | Loan activation timestamp as Unix seconds (integer)           |
| `interval_seconds` | integer | Period length in seconds, e.g. `2592000` = 30 days           |
| `installment_count`| integer | Number of installments, e.g. `12`                             |

---

## 3. Schedule Generation Rules

### 3.1 Due Timestamps

```
due_timestamp[i] = start_ts + (i + 1) * interval_seconds
```

Where `i` is the **0-based** installment index (`0 … installment_count - 1`).

### 3.2 Principal Per Installment (Equal-Principal Model)

```
principal_per_installment = floor(principal / installment_count)
remainder                 = principal - principal_per_installment * installment_count
```

- Installments `0 … installment_count - 2` each receive `principal_per_installment`.
- The **last** installment receives `principal_per_installment + remainder`.
- This guarantees `sum(principal_due[i]) == principal` exactly.

### 3.3 Interest Per Installment (Declining Balance)

```
outstanding[i] = principal - principal_per_installment * i
interest[i]    = floor(outstanding[i] * interest_rate_bps * interval_seconds
                       / (10000 * 31536000))
```

- `31536000 = 365 * 86400` (seconds per year).
- All arithmetic is **integer** (bigint). No floating-point at any step.
- Truncation (floor) is applied once at the final division.

### 3.4 Total Due

```
total_due[i] = principal_due[i] + interest[i]
```

---

## 4. Canonical JSON Serialization

### 4.1 Rules

1. **All bigint amounts** encoded as **decimal strings** (no scientific notation, no decimal point).
2. **All timestamps** encoded as **decimal strings** of Unix seconds.
3. `interest_rate_bps`, `interval_seconds`, `installment_count` encoded as **JSON integers**.
4. **Field order is fixed** — see §4.2. Do NOT sort or reorder.
5. **No extra whitespace** — use `JSON.stringify` default compact form.
6. `installments` array ordered by `index` ascending.
7. Per-installment field order: `index`, `due_ts`, `principal`, `interest`, `total`.

### 4.2 Top-Level Field Order

```json
{
  "loan_id":           "<string>",
  "principal":         "<decimal string>",
  "interest_rate_bps": <integer>,
  "start_ts":          "<decimal string>",
  "interval_seconds":  <integer>,
  "installment_count": <integer>,
  "installments":      [ ... ]
}
```

### 4.3 Per-Installment Field Order

```json
{
  "index":     <integer>,
  "due_ts":    "<decimal string>",
  "principal": "<decimal string>",
  "interest":  "<decimal string>",
  "total":     "<decimal string>"
}
```

### 4.4 Example (3-installment, 120 USDC, 12% APR, 30-day interval)

```json
{
  "loan_id": "loan-001",
  "principal": "120000000",
  "interest_rate_bps": 1200,
  "start_ts": "1735689600",
  "interval_seconds": 2592000,
  "installment_count": 3,
  "installments": [
    {"index": 0, "due_ts": "1738281600", "principal": "40000000", "interest": "...", "total": "..."},
    {"index": 1, "due_ts": "1740873600", "principal": "40000000", "interest": "...", "total": "..."},
    {"index": 2, "due_ts": "1743465600", "principal": "40000000", "interest": "...", "total": "..."}
  ]
}
```

---

## 5. Hashing

```
schedule_hash = SHA-256(UTF-8 bytes of canonical JSON)
             → 32 bytes → hex-encoded lowercase string (64 chars)
```

- Input encoding: **UTF-8**.
- Output: lowercase hex, no `0x` prefix.
- The hash is suitable for use as a Solidity `bytes32` after `0x`-prefixing.

### 5.1 Reference Implementation (Node.js)

```typescript
import { createHash } from "crypto";

const scheduleHash = createHash("sha256")
  .update(scheduleJson, "utf8")
  .digest("hex");
```

### 5.2 Solidity Verification

```solidity
bytes32 expectedHash = keccak256(bytes(scheduleJson));
// Note: contracts use keccak256 of the JSON string for gas efficiency.
// The backend stores SHA-256 for cross-chain portability.
// Both are stored; the contract uses its own hash of the transmitted JSON.
```

---

## 6. Persistence

| Column            | Type      | Description                                     |
|-------------------|-----------|-------------------------------------------------|
| `schedule_hash`   | `varchar` | 64-char lowercase hex SHA-256                   |
| `schedule_json`   | `text`    | Canonical JSON string (verbatim, never mutated) |
| `interval_seconds`| `integer` | Config param                                    |
| `start_timestamp` | `bigint`  | Unix seconds (stored as bigint for precision)   |

`schedule_json` is the **canonical source of truth**. The hash can always be
reproduced from it:

```
schedule_hash = SHA-256(schedule_json)
```

---

## 7. Immutability Guarantee

After loan activation, `InstallmentScheduleService.assertHashIntegrity(loanId)` must be called.

It:
1. Loads the stored `schedule_json` and `schedule_hash`.
2. Parses `principal` from `schedule_json` (exact bigint, not derived from DB columns).
3. Regenerates the schedule from stored config params.
4. Compares `regen.scheduleHash === stored.scheduleHash`.
5. On **mismatch**: emits a `CRITICAL` breaker alert and throws `ConflictException`.

The schedule DB row is **never updated** after creation. Any write attempt must be rejected at the application layer.

---

## 8. Migration Policy

Adding new fields to the `InstallmentSchedule` or `InstallmentEntry` DB models
**does not** change the canonical JSON or the hash, because:

- The canonical JSON is built from a fixed set of fields (§4.2, §4.3).
- New DB columns are not included in `buildCanonical()`.
- The stored `schedule_json` is immutable.

To add a new field to the hash (a **breaking change**):
1. Increment the spec version.
2. Add a `version` field to the canonical JSON (new top-level key, before `loan_id`).
3. Migrate all existing schedules to include `"version": 1` in their stored JSON.
4. Deploy atomically with the contract upgrade that reads the new field.

---

## 9. Test Coverage

| Suite | File                                              | Focus                              |
|-------|---------------------------------------------------|------------------------------------|
| A     | `installment.spec.ts`                             | Generation, hash format, verifyHash|
| D     | `installment-schedule-determinism.spec.ts`        | Determinism across all params      |
| R     | `installment-schedule-determinism.spec.ts`        | Rounding, bigint, no floats        |
| M     | `installment-schedule-determinism.spec.ts`        | Migration safety, field order      |
| I     | `installment-schedule-determinism.spec.ts`        | assertHashIntegrity behaviour      |
| C     | `installment-schedule-determinism.spec.ts`        | CONFIGURE_SCHEDULE chain action    |
