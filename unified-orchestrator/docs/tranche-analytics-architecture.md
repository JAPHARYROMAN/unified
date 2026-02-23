# Unified v1.2 — Tranche Analytics & Reporting Architecture

**Role:** Backend Architect  
**Scope:** Design document only — no implementation.  
**Date:** 2026-02-23

---

## 1. Data Model

### 1.1 New Prisma Models

```prisma
enum TrancheType {
  SENIOR
  JUNIOR
}

enum TrancheStatus {
  ACTIVE
  DEPLETED
  CLOSED
}

model Tranche {
  id              String        @id @default(cuid())
  poolId          String
  pool            PartnerPool   @relation(fields: [poolId], references: [id])
  trancheType     TrancheType
  status          TrancheStatus @default(ACTIVE)

  // Capital structure
  commitmentUsdc  BigInt        // Total committed capital (6 dec)
  deployedUsdc    BigInt        @default(0)  // Currently deployed

  // NAV & yield (updated daily by TrancheNAVService)
  // navUsdc = deployedUsdc - defaultImpactUsdc + cumulativeYieldUsdc
  navUsdc         BigInt        @default(0)
  yieldBps        Int           @default(0)  // Annualised yield in bps
  cumulativeYieldUsdc BigInt    @default(0)

  // Loss accounting
  exposureUsdc    BigInt        @default(0)  // Outstanding principal allocated
  defaultImpactUsdc BigInt      @default(0)  // Realised losses absorbed

  // Waterfall priority (lower = senior)
  waterfallPriority Int         @default(0)

  loans           TrancheLoanAllocation[]
  navSnapshots    TrancheNAVSnapshot[]
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@index([poolId, trancheType])
}

model TrancheLoanAllocation {
  id              String    @id @default(cuid())
  trancheId       String
  tranche         Tranche   @relation(fields: [trancheId], references: [id])
  loanId          String
  loan            Loan      @relation(fields: [loanId], references: [id])

  allocatedUsdc   BigInt    // Principal slice allocated to this tranche
  allocationPct   Int       // Basis points (0–10000) of loan allocated here

  createdAt       DateTime  @default(now())

  @@unique([trancheId, loanId])
}

model TrancheNAVSnapshot {
  id              String    @id @default(cuid())
  trancheId       String
  tranche         Tranche   @relation(fields: [trancheId], references: [id])

  snapshotDate    DateTime  // Midnight UTC
  navUsdc         BigInt
  exposureUsdc    BigInt
  yieldBps        Int
  defaultImpactUsdc BigInt
  coverageRatioBps Int      // juniorBuffer / totalExposure in bps

  createdAt       DateTime  @default(now())

  @@unique([trancheId, snapshotDate])
  @@index([snapshotDate])
}
```

### 1.2 Field Semantics

| Field | Type | Description |
|---|---|---|
| `trancheId` | `String (cuid)` | Unique tranche identifier |
| `trancheType` | `TrancheType` | `SENIOR` or `JUNIOR` |
| `trancheNAV` | `BigInt (USDC 6dec)` | `navUsdc = deployedUsdc - defaultImpactUsdc + cumulativeYieldUsdc`; computed from backend DB state by `TrancheNAVService`; on-chain events update the DB via listeners which feed into the next daily snapshot — not pure event-sourced |
| `trancheYield` | `Int (bps)` | Annualised yield; computed as `cumulativeYield / deployedUsdc` |
| `trancheExposure` | `BigInt (USDC 6dec)` | Sum of `allocatedUsdc` across active loans |
| `trancheDefaultImpact` | `BigInt (USDC 6dec)` | Cumulative realised loss absorbed by this tranche |

---

## 2. Reporting Design

### 2.1 Yield by Tranche (`TrancheYieldReport`)

**Trigger:** Daily cron, midnight UTC  
**Service:** `TrancheReportService.buildYieldReport(date)`

```typescript
interface TrancheYieldReport {
  reportDate:             Date;
  poolId:                 string;
  tranches: Array<{
    trancheId:            string;
    trancheType:          TrancheType;
    deployedUsdc:         bigint;
    navUsdc:              bigint;
    cumulativeYieldUsdc:  bigint;
    annualisedYieldBps:   number;   // (cumulativeYield / deployed) * (365 / daysActive) * 10000
    yieldDeltaUsdc:       bigint;   // yield accrued since last snapshot
  }>;
}
```

**Computation:**
```
annualisedYieldBps = (cumulativeYieldUsdc * 10000n * 365n) / (deployedUsdc * BigInt(daysActive))
```

Persisted to `TrancheNAVSnapshot` with `@@unique([trancheId, snapshotDate])`.

---

### 2.2 Loss Distribution by Tranche (`TrancheLossReport`)

**Trigger:** On default event + daily rollup  
**Service:** `TrancheReportService.buildLossReport(date)`

```typescript
interface TrancheLossReport {
  reportDate:             Date;
  poolId:                 string;
  totalDefaultedUsdc:     bigint;
  tranches: Array<{
    trancheId:            string;
    trancheType:          TrancheType;
    lossAbsorbedUsdc:     bigint;   // defaultImpactUsdc
    lossSharePct:         number;   // lossAbsorbed / totalDefaulted * 100
    remainingBufferUsdc:  bigint;   // commitmentUsdc - defaultImpactUsdc
  }>;
  waterfallOrder:         string[]; // trancheIds sorted by waterfallPriority desc (junior first)
}
```

**Waterfall rule:** Junior tranches absorb losses first (highest `waterfallPriority`). Senior tranches are only impacted after junior is fully depleted.

---

### 2.3 Coverage Ratio (`CoverageRatioReport`)

**Definition:**
```
coverageRatioBps = juniorBuffer / totalExposure * 10000
juniorBuffer     = juniorCommitment - juniorDefaultImpact   // commitment-based, NOT juniorNAV
```

> **Buffer is commitment-based, not NAV-based.** `juniorNAV` includes accrued yield and fluctuates with mark-to-market — it does not represent loss-absorbing capacity. The buffer is committed capital minus realised losses, consistent with standard structured finance OC test conventions.

```typescript
interface CoverageRatioReport {
  reportDate:         Date;
  poolId:             string;
  totalExposureUsdc:  bigint;
  juniorBufferUsdc:   bigint;   // = juniorCommitment - juniorDefaultImpact (NOT juniorNAV)
  seniorExposureUsdc: bigint;
  coverageRatioBps:   number;   // e.g. 2000 = 20% junior coverage
  isAdequate:         boolean;  // coverageRatioBps >= JUNIOR_COVERAGE_FLOOR_BPS (default: 1000)
}
```

Persisted as `coverageRatioBps` on `TrancheNAVSnapshot`.

> **Liquidity ratio per tranche** (liquid assets / upcoming redemptions) is **out of scope for v1.2**. These tranches are closed-end term loan pools with no on-demand redemption; a liquidity ratio is not meaningful until tranche redemption windows are introduced (deferred to v1.3).

---

### 2.4 Stress Simulation Model (`TrancheStressSimulation`)

**Trigger:** On-demand or weekly scheduled  
**Service:** `TrancheStressService.simulate(poolId, defaultScenarios)`

```typescript
interface StressScenario {
  defaultRatePct:          number;  // e.g. 5, 10, 20
  totalExposureUsdc:       bigint;
  defaultedUsdc:           bigint;  // totalExposure * defaultRatePct / 100
  juniorAbsorption:        bigint;  // min(defaultedUsdc, juniorBuffer); buffer = commitment - defaultImpact, NOT juniorNAV
  seniorImpact:            bigint;  // max(0, defaultedUsdc - juniorBuffer)
  juniorBufferPostStress:  bigint;  // juniorBuffer - juniorAbsorption (renamed from juniorNAVPostStress — commitment-based)
  seniorNAVPostStress:     bigint;
  coverageRatioPostStress: number;  // bps
  juniorDepleted:          boolean;
  seniorImpaired:          boolean;
}

interface TrancheStressSimulation {
  poolId:        string;
  ranAt:         Date;
  juniorBuffer:  bigint;
  seniorExposure: bigint;
  scenarios:     StressScenario[];
}
```

`TrancheStressService.simulate()` is **read-only** — it never writes to the database. Outputs are ephemeral or optionally archived to a `StressSimulationLog` table if an audit trail is required.

---

## 3. Circuit Breaker Extensions

### 3.1 Junior Depletion Threshold Trigger

| Property | Value |
|---|---|
| **Trigger ID** | `JUNIOR_TRANCHE_DEPLETION` |
| **Condition** | `coverageRatioBps <= JUNIOR_COVERAGE_FLOOR_BPS` (floor: **1000 bps = 10%**) |
| **Severity** | `CRITICAL` |
| **Scope** | `POOL` |
| **Actions** | `HALT_NEW_DISBURSEMENTS`, `FREEZE_POOL` |
| **Evaluation cadence** | Immediately on any default write-off (primary) + after every `TrancheNAVSnapshot` write (safety net) |

```typescript
{
  id:          "JUNIOR_TRANCHE_DEPLETION",
  description: "Junior tranche buffer below minimum coverage floor",
  severity:    "CRITICAL",
  scope:       "POOL",
  threshold:   1000,           // bps
  metric:      "coverageRatioBps",
  actions:     ["HALT_NEW_DISBURSEMENTS", "FREEZE_POOL"],
}
```

---

### 3.2 Senior Drawdown Alert Trigger

| Property | Value |
|---|---|
| **Trigger ID** | `SENIOR_TRANCHE_DRAWDOWN` |
| **Condition** | `seniorImpactUsdc > 0` (any loss reaches senior tranche) |
| **Severity** | `CRITICAL` |
| **Scope** | `POOL` |
| **Actions** | `HALT_ALL_DISBURSEMENTS`, `FREEZE_POOL` |
| **Evaluation cadence** | Immediately on default write-off — not deferred to daily cron |

```typescript
{
  id:          "SENIOR_TRANCHE_DRAWDOWN",
  description: "Losses have breached junior buffer and impacted senior tranche",
  severity:    "CRITICAL",
  scope:       "POOL",
  threshold:   0,              // any non-zero senior impact
  metric:      "seniorImpactUsdc",
  actions:     ["HALT_ALL_DISBURSEMENTS", "FREEZE_POOL"],
}
```

---

## 4. Pilot Simulation — 5% / 10% / 20% Default Scenarios

**Assumptions:**

| Parameter | Value |
|---|---|
| Pool total exposure | $1,000,000 USDC |
| Junior commitment | $200,000 USDC (20% of pool) |
| Senior commitment | $800,000 USDC (80% of pool) |
| Junior buffer (no prior losses) | $200,000 USDC |
| `JUNIOR_COVERAGE_FLOOR_BPS` | 1000 (10% of total exposure = $100,000) |

| Scenario | Defaulted | Junior Absorbs | Senior Impact | Junior NAV Post | Senior NAV Post | Coverage Ratio | Junior Depleted | Senior Impaired | Breaker Fired |
|---|---|---|---|---|---|---|---|---|---|
| **5%** | $50,000 | $50,000 | $0 | $150,000 | $800,000 | 1500 bps | No | No | — |
| **10%** | $100,000 | $100,000 | $0 | $100,000 | $800,000 | 1000 bps | No | No | `JUNIOR_DEPLETION` (at floor) |
| **20%** | $200,000 | $200,000 | $0 | $0 | $800,000 | 0 bps | **Yes** | No | `JUNIOR_DEPLETION` |
| **25%** *(extended)* | $250,000 | $200,000 | $50,000 | $0 | $750,000 | 0 bps | **Yes** | **Yes** | `JUNIOR_DEPLETION` + `SENIOR_DRAWDOWN` |

> The 25% scenario is included to illustrate the `SENIOR_DRAWDOWN` trigger path. At exactly 10% defaults the junior buffer hits the floor — the breaker fires at `coverageRatioBps <= JUNIOR_COVERAGE_FLOOR_BPS`.

---

## 5. Service Architecture

```
TrancheReportService
  ├── buildYieldReport(date)          → TrancheYieldReport
  ├── buildLossReport(date)           → TrancheLossReport
  └── buildCoverageRatioReport(date)  → CoverageRatioReport

TrancheStressService
  └── simulate(poolId, scenarios[])   → TrancheStressSimulation  (read-only)

TrancheNAVService  (daily cron)
  └── snapshotAll()                   → upserts TrancheNAVSnapshot rows

TrancheModule
  ├── providers: [TrancheReportService, TrancheStressService, TrancheNAVService]
  ├── imports:   [PrismaModule, CircuitBreakerModule]
  └── exports:   [TrancheReportService, TrancheStressService]

TrancheScheduler  (cron jobs)
  ├── @Cron('0 1 * * *')  snapshotAll()
  ├── @Cron('0 2 * * *')  buildYieldReport()
  └── @Cron('0 2 * * *')  buildCoverageRatioReport()
                           → if !isAdequate → circuitBreaker.emit(JUNIOR_DEPLETION)
```

---

## 6. Key Design Decisions

- **BigInt throughout** — all USDC amounts use 6-decimal `BigInt`, consistent with the existing `principalUsdc` convention across the codebase.
- **Waterfall via `waterfallPriority`** — integer ordering avoids hardcoded SENIOR/JUNIOR loss logic and supports N-tranche structures in future.
- **`@@unique([trancheId, snapshotDate])`** — idempotent daily snapshots; safe to re-run without duplication.
- **NAV is backend-computed, not pure event-sourced** — `TrancheNAVService` computes NAV from DB state (`deployedUsdc - defaultImpactUsdc + cumulativeYieldUsdc`). On-chain events update the DB via event listeners; they do not directly set NAV. Pure event-sourcing is not viable because fiat (KES) transfers have no on-chain representation.
- **Coverage buffer is commitment-based** — `juniorBuffer = juniorCommitment - juniorDefaultImpact`. Using `juniorNAV` would incorrectly inflate the buffer with accrued yield, which carries no loss-absorbing capacity.
- **Both breakers wire to the default write-off handler** — `JUNIOR_TRANCHE_DEPLETION` and `SENIOR_TRANCHE_DRAWDOWN` both evaluate immediately when a write-off updates `defaultImpactUsdc`. The daily cron is a safety-net re-evaluation, not the primary trigger path.
- **Liquidity ratio deferred to v1.3** — not applicable to closed-end term loan pools; revisit when tranche redemption windows are introduced.
- **Breaker fires on snapshot write (safety net)** — coverage ratio check is also co-located with NAV snapshot persistence as a secondary evaluation path.
- **Stress simulation is read-only** — `TrancheStressService.simulate()` never writes to DB; outputs are ephemeral or archived to a separate `StressSimulationLog` table if an audit trail is needed.
- **`claimLoanCollateral` integration** — the proxy function added to `UnifiedPool` fits naturally into the loss accounting flow: after `claimCollateral()` executes on-chain, the backend event listener updates `tranche.defaultImpactUsdc` and triggers a coverage ratio re-evaluation.
