# Unified v1.1 — Capital Circuit Breaker Engine

## Overview

The Circuit Breaker Engine continuously evaluates risk triggers and applies enforcement actions with full auditability. It is designed to be **fail-closed**: if a metric cannot be computed, the trigger is treated as fired.

---

## Architecture

```
CircuitBreakerScheduler          (cron: 5min / 1hr / daily)
        │
        ▼
CircuitBreakerMetricsService     (pure DB reads, no side effects)
        │
        ▼
CircuitBreakerService            (evaluation + incident + audit log)
        │
        ├─► BreakerIncident      (Prisma model — one per firing)
        ├─► BreakerAuditLog      (Prisma model — append-only)
        └─► CircuitBreakerAlertService  (structured log emission)

LoanService.createLoan()
        │
        └─► CircuitBreakerService.assertOriginationAllowed(partnerId)
                │
                └─► ForbiddenException if blocked
```

---

## Triggers (v1.1 baseline)

| Trigger | Threshold | Scope | Severity | Actions |
|---|---|---|---|---|
| `ACTIVE_WITHOUT_DISBURSEMENT_PROOF` | > 0 | GLOBAL | CRITICAL | BLOCK_ALL_ORIGINATIONS, OPEN_INCIDENT |
| `FIAT_CONFIRMED_NO_CHAIN_RECORD` | > 0 | GLOBAL | CRITICAL | BLOCK_ALL_ORIGINATIONS, OPEN_INCIDENT |
| `PARTNER_DEFAULT_RATE_30D` | > 8% | PARTNER | HIGH | BLOCK_PARTNER_ORIGINATIONS, OPEN_INCIDENT |
| `PARTNER_DELINQUENCY_14D` | > 15% | PARTNER | MEDIUM | BLOCK_PARTNER_ORIGINATIONS, TIGHTEN_TERMS |
| `POOL_LIQUIDITY_RATIO` | < 25% | POOL | HIGH | FREEZE_ORIGINATIONS, OPEN_INCIDENT |
| `POOL_NAV_DRAWDOWN_7D` | > 2% | POOL | HIGH | FREEZE_ORIGINATIONS, TIGHTEN_TERMS |

### Threshold semantics

- **Settlement integrity** (`ACTIVE_WITHOUT_DISBURSEMENT_PROOF`, `FIAT_CONFIRMED_NO_CHAIN_RECORD`): count of anomalous records. Any value > 0 fires immediately — **HARD STOP**.
- **Partner default rate**: defaulted / (active + repaid + defaulted) in the last 30 days.
- **Partner delinquency**: defaulted / active loans in the last 14 days.
- **Pool liquidity ratio**: (pool capacity − outstanding) / pool capacity. Fires when ratio drops *below* threshold.
- **Pool NAV drawdown**: defaulted principal in 7 days / total active principal. Fires when drawdown *exceeds* threshold.

---

## Evaluation Schedule

| Cadence | Triggers evaluated | Cron |
|---|---|---|
| Every 5 minutes | Settlement integrity | `*/5 * * * *` |
| Every hour | Credit + liquidity | `0 * * * *` |
| Daily 03:00 UTC | Full reconciliation report | `0 3 * * *` |

---

## Enforcement Actions

| Action | Effect |
|---|---|
| `BLOCK_ALL_ORIGINATIONS` | `assertOriginationAllowed` throws `ForbiddenException` for **all** partners |
| `FREEZE_ORIGINATIONS` | Same as BLOCK — treated identically in enforcement state |
| `BLOCK_PARTNER_ORIGINATIONS` | `assertOriginationAllowed` throws for the **specific partner** only |
| `TIGHTEN_TERMS` | Partner added to `tightenedPartnerIds` set (guardrail enforcement layer reads this) |
| `REQUIRE_MANUAL_APPROVAL` | `requireManualApproval` flag set in enforcement state |
| `OPEN_INCIDENT` | `BreakerIncident` record created (idempotent — one open incident per trigger per partner) |

### Enforcement state derivation

`CircuitBreakerService.getEnforcementState()` reads all **OPEN** incidents and derives:

```typescript
{
  globalBlock: boolean,          // any BLOCK_ALL_ORIGINATIONS action
  globalFreeze: boolean,         // any FREEZE_ORIGINATIONS action
  requireManualApproval: boolean,
  blockedPartnerIds: Set<string>,
  tightenedPartnerIds: Set<string>,
  evaluatedAt: Date,
}
```

Resolving an incident removes it from the enforcement state immediately.

---

## Alerting

Alerts are emitted as structured JSON log lines consumed by the log aggregator.

| Severity | Triggers | Log level |
|---|---|---|
| CRITICAL | Settlement integrity | `logger.error` |
| HIGH | Liquidity, partner default | `logger.warn` |
| MEDIUM | Partner delinquency | `logger.warn` |

Alert payload:
```json
{
  "env": "production",
  "severity": "CRITICAL",
  "trigger": "FIAT_CONFIRMED_NO_CHAIN_RECORD",
  "actions": ["BLOCK_ALL_ORIGINATIONS", "OPEN_INCIDENT"],
  "scope": "GLOBAL",
  "partnerId": null,
  "metricValue": 3,
  "threshold": 0,
  "incidentId": "...",
  "firedAt": "2026-02-23T03:00:00.000Z"
}
```

---

## Admin API

All endpoints require:
- `X-Admin-Key: <ADMIN_API_KEY>` header
- `X-Operator-Id: <operator>` header (used in audit trail)

`ADMIN_API_KEY` **must** be set in environment. If missing, all admin endpoints return `403 Forbidden` — **no fail-open**.

### Endpoints

```
GET  /admin/breaker/status
     → { enforcement, openIncidentCount, activeOverrideCount }

GET  /admin/breaker/incidents
     → BreakerIncident[] (OPEN + ACKNOWLEDGED, newest first)

POST /admin/breaker/incidents/:id/acknowledge
     → Updates status to ACKNOWLEDGED, writes audit log

POST /admin/breaker/incidents/:id/resolve
     → Updates status to RESOLVED, removes from enforcement state

GET  /admin/breaker/overrides
     → BreakerOverride[] (active, non-expired, non-lifted)

POST /admin/breaker/overrides
     Body: { trigger, scope, partnerId?, reason, expiresInMinutes }
     → Creates time-bound override (max 7 days / 10080 minutes)
     → Writes audit log

POST /admin/breaker/overrides/:id/lift
     → Sets liftedAt, writes audit log

GET  /admin/breaker/audit
     → BreakerAuditLog[] (newest first, limit 500)
```

---

## Overrides

Overrides suppress a specific trigger for a time-bound window. They do **not** retroactively clear existing incidents — incidents must be resolved separately.

**Constraints:**
- `expiresInMinutes` must be between 1 and 10080 (7 days)
- Every override creation and lift is written to `BreakerAuditLog`
- Expired overrides are automatically ignored (no cleanup job needed — filtered by `expiresAt > now`)

**Workflow for planned maintenance:**
1. `POST /admin/breaker/overrides` with `trigger`, `scope`, `reason`, `expiresInMinutes`
2. Perform maintenance
3. `POST /admin/breaker/overrides/:id/lift` to restore enforcement early (optional)

---

## Auditability

Every state change writes an immutable `BreakerAuditLog` entry:

| Event | Logged |
|---|---|
| Trigger fires | trigger, action, metricValue, threshold, operator=system |
| Incident acknowledged | incidentId, operator, note |
| Incident resolved | incidentId, operator, note |
| Override applied | trigger, scope, partnerId, expiresAt, reason, operator |
| Override lifted | trigger, scope, partnerId, operator |

Audit logs are **append-only** — no update or delete operations.

---

## Fail-Closed Guarantees

| Scenario | Behavior |
|---|---|
| Metric DB query throws | Treated as trigger fired (fail-closed value returned) |
| `ADMIN_API_KEY` not set | All admin endpoints return 403 |
| No incidents in DB | `assertOriginationAllowed` passes (correct default) |
| Incident resolved | Enforcement state immediately clean |
| Override expired | Automatically excluded from active override set |
| Override already lifted | `liftOverride` throws — no double-lift |

---

## Database Models

```prisma
model BreakerIncident {
  id             String                @id @default(uuid())
  trigger        BreakerTrigger
  scope          BreakerScope
  partnerId      String?
  metricValue    Float
  threshold      Float
  actionsApplied BreakerAction[]
  status         BreakerIncidentStatus @default(OPEN)
  acknowledgedAt DateTime?
  acknowledgedBy String?
  resolvedAt     DateTime?
  resolvedBy     String?
  createdAt      DateTime              @default(now())
  updatedAt      DateTime              @updatedAt
}

model BreakerAuditLog {
  id          String          @id @default(uuid())
  incidentId  String?
  trigger     BreakerTrigger?
  action      BreakerAction?
  scope       BreakerScope
  partnerId   String?
  metricValue Float?
  threshold   Float?
  operator    String          @default("system")
  note        String?
  createdAt   DateTime        @default(now())
}

model BreakerOverride {
  id        String         @id @default(uuid())
  trigger   BreakerTrigger
  scope     BreakerScope
  partnerId String?
  reason    String
  operator  String
  expiresAt DateTime
  liftedAt  DateTime?
  liftedBy  String?
  createdAt DateTime       @default(now())
}
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_API_KEY` | **Yes** | Secret key for admin endpoints. Missing = fail-closed (403 on all admin routes) |
| `NODE_ENV` | No | Included in alert payloads for environment identification |

---

## Runbook: Settlement Integrity Hard Stop

**Symptom:** All originations blocked. Alert: `FIAT_CONFIRMED_NO_CHAIN_RECORD` or `ACTIVE_WITHOUT_DISBURSEMENT_PROOF`.

**Steps:**
1. `GET /admin/breaker/status` — confirm `globalBlock: true`
2. `GET /admin/breaker/incidents` — identify the open incident(s)
3. Investigate the root cause via `GET /ops/alerts` and `GET /ops/fiat-transfers`
4. If a chain action is stuck: `POST /ops/requeue/:actionId`
5. Once root cause resolved and DB state is clean: `POST /admin/breaker/incidents/:id/resolve`
6. Verify: `GET /admin/breaker/status` → `globalBlock: false`

**Do NOT apply an override for settlement integrity triggers without explicit sign-off from the engineering lead.**

---

## Runbook: Partner Default Spike

**Symptom:** Specific partner originations blocked. Alert: `PARTNER_DEFAULT_RATE_30D`.

**Steps:**
1. `GET /admin/breaker/incidents` — confirm partner ID and metric value
2. Review partner loan book for systemic issues
3. If false positive (data lag): apply temporary override with short expiry
   ```
   POST /admin/breaker/overrides
   { "trigger": "PARTNER_DEFAULT_RATE_30D", "scope": "PARTNER",
     "partnerId": "<id>", "reason": "Data lag — investigating",
     "expiresInMinutes": 60 }
   ```
4. Once confirmed resolved: `POST /admin/breaker/incidents/:id/resolve`

---

## Runbook: Liquidity Ratio Breach

**Symptom:** All originations frozen. Alert: `POOL_LIQUIDITY_RATIO`.

**Steps:**
1. Confirm pool capacity vs. outstanding principal
2. If pool capacity needs updating: update `partner.maxLoanSizeUsdc` via admin
3. Once ratio recovers above 25%: `POST /admin/breaker/incidents/:id/resolve`
