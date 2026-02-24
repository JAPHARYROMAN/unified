# Unified v1.2.1 — Monitoring, NAV Engine & Reconciliation Spec

**Agent:** C  
**Branch:** `agent-c/v1.2.1-monitoring`  
**Role:** Backend / Analytics Architect  
**Date:** 2026-02-23  
**Status:** Specification — implementation-ready

---

## Table of Contents

1. [Tranche-Separated NAV Engine](#1-tranche-separated-nav-engine)
2. [Invariant Poller Service](#2-invariant-poller-service)
3. [Coverage & Subordination Dashboard](#3-coverage--subordination-dashboard)
4. [Stress & Breaker Alert Playbook](#4-stress--breaker-alert-playbook)
5. [Daily Reconciliation](#5-daily-reconciliation)
6. [Deployment Instructions](#6-deployment-instructions)

---

## 1. Tranche-Separated NAV Engine

### 1.1 Computation Model

All USDC amounts are `BigInt` with 6 decimal places. NAV is **backend-computed** from DB state — not pure event-sourced — because fiat (KES) transfers have no on-chain representation.

#### Per-Tranche NAV

```
virtualBalance       = commitmentUsdc - defaultImpactUsdc + cumulativeYieldUsdc
principalOutstanding = SUM(allocatedUsdc) over active TrancheLoanAllocations
badDebt              = defaultImpactUsdc   (cumulative realised losses absorbed)
NAV                  = virtualBalance
```

> **Invariant:** `sr.virtualBalance + jr.virtualBalance + principalOutstanding == usdcBalance + totalBadDebt`
> Verified daily by the reconciliation artifact (§5).

#### Contract Parity

`virtualBalance` must match the contract's `tranche.virtualBalance` output exactly. The poller (§2) reads both and diffs them on every block. Any divergence ≥ 1 USDC (1_000_000 raw units) is a P0 alert.

### 1.2 TypeScript Interfaces

```typescript
interface TrancheNAVState {
  trancheId:              string;
  trancheType:            'SENIOR' | 'JUNIOR';
  poolId:                 string;
  computedAt:             Date;

  commitmentUsdc:         bigint;
  deployedUsdc:           bigint;
  cumulativeYieldUsdc:    bigint;
  defaultImpactUsdc:      bigint;

  virtualBalance:         bigint;   // commitmentUsdc - defaultImpactUsdc + cumulativeYieldUsdc
  principalOutstanding:   bigint;   // SUM(allocatedUsdc) over active loans
  badDebt:                bigint;   // = defaultImpactUsdc
  nav:                    bigint;   // = virtualBalance

  contractVirtualBalance: bigint;   // read from UnifiedPoolTranched
  parityDeltaUsdc:        bigint;   // nav - contractVirtualBalance (must be 0n)
  parityOk:               boolean;
}

interface PoolNAVState {
  poolId:               string;
  computedAt:           Date;
  blockNumber:          bigint;
  senior:               TrancheNAVState;
  junior:               TrancheNAVState;

  totalNAV:             bigint;   // senior.nav + junior.nav
  totalPrincipalOut:    bigint;   // senior.principalOutstanding + junior.principalOutstanding
  totalBadDebt:         bigint;   // senior.badDebt + junior.badDebt
  usdcBalance:          bigint;   // on-chain USDC.balanceOf(poolAddress)

  reconOk:              boolean;  // lhs == rhs
  reconDeltaUsdc:       bigint;   // deviation (must be 0n)
}
```

### 1.3 NAV Service

**Class:** `TrancheNAVService` | **Schedule:** `@Cron('0 1 * * *')` — daily 01:00 UTC

```typescript
class TrancheNAVService {
  async snapshotAll(): Promise<void>
  async computePoolNAV(poolId: string, blockNumber: bigint): Promise<PoolNAVState>
  async computeTrancheNAV(trancheId: string, blockNumber: bigint): Promise<TrancheNAVState>
  private async readContractVirtualBalance(trancheId: string, blockNumber: bigint): Promise<bigint>
}
```

**Annualised yield:**
```
annualisedYieldBps = (cumulativeYieldUsdc * 10_000n * 365n) / (commitmentUsdc * BigInt(daysActive))
```

**Snapshot upsert** (idempotent):
```typescript
await prisma.trancheNAVSnapshot.upsert({
  where:  { trancheId_snapshotDate: { trancheId, snapshotDate: midnight } },
  create: { trancheId, snapshotDate: midnight, navUsdc, exposureUsdc,
            yieldBps, defaultImpactUsdc, coverageRatioBps },
  update: { navUsdc, exposureUsdc, yieldBps, defaultImpactUsdc, coverageRatioBps },
});
```

---

## 2. Invariant Poller Service

### 2.1 Architecture

```
BlockListener (ethers.js provider.on('block'))
        │
        ▼
InvariantPollerService.onBlock(blockNumber, blockHash)
        │
        ├─► contract.checkInvariants()          → { ok, code, message }
        ├─► contract.paused()                   → boolean
        ├─► contract.stressMode()               → boolean
        ├─► contract.seniorPriorityActive()     → boolean
        ├─► TrancheNAVService.computePoolNAV()  → PoolNAVState (parity check)
        │
        ├─► [if P0] InvariantPollerAlertService.page()
        ├─► [persist] InvariantPollRecord
        └─► [if stressMode] CircuitBreakerService.emit(STRESS_MODE_ACTIVE)
```

### 2.2 TypeScript Interfaces

```typescript
interface BlockPollRecord {
  blockNumber:          bigint;
  blockHash:            string;
  polledAt:             Date;
  poolId:               string;

  invariantOk:          boolean;
  invariantCode:        number;   // 0 = healthy; contract-defined error codes otherwise
  paused:               boolean;
  stressMode:           boolean;
  seniorPriorityActive: boolean;

  navParityOk:          boolean;
  navParityDeltaUsdc:   bigint;

  alertEmitted:         boolean;
  alertSeverity:        'P0' | 'P1' | 'P2' | null;
}
```

### 2.3 Prisma Model

```prisma
model InvariantPollRecord {
  id                   String   @id @default(cuid())
  poolId               String
  blockNumber          BigInt
  blockHash            String
  polledAt             DateTime

  invariantOk          Boolean
  invariantCode        Int
  paused               Boolean
  stressMode           Boolean
  seniorPriorityActive Boolean

  navParityOk          Boolean
  navParityDeltaUsdc   BigInt   @default(0)

  alertEmitted         Boolean  @default(false)
  alertSeverity        String?

  createdAt            DateTime @default(now())

  @@index([poolId, blockNumber])
  @@index([invariantOk])
}
```

### 2.4 Service Logic

```typescript
async onBlock(blockNumber: bigint, blockHash: string): Promise<void> {
  const [invariant, paused, stressMode, seniorPriority, navState] = await Promise.all([
    this.contract.checkInvariants(),
    this.contract.paused(),
    this.contract.stressMode(),
    this.contract.seniorPriorityActive(),
    this.navService.computePoolNAV(this.poolId, blockNumber),
  ]);

  const navParityOk    = navState.reconOk && navState.senior.parityOk && navState.junior.parityOk;
  const navParityDelta = navState.reconDeltaUsdc;

  let severity: 'P0' | 'P1' | null = null;
  if (!invariant.ok || !navParityOk || paused) severity = 'P0';
  else if (stressMode)                         severity = 'P1';

  await this.prisma.invariantPollRecord.create({ data: {
    poolId: this.poolId, blockNumber, blockHash, polledAt: new Date(),
    invariantOk: invariant.ok, invariantCode: invariant.code,
    paused, stressMode, seniorPriorityActive: seniorPriority,
    navParityOk, navParityDeltaUsdc: navParityDelta,
    alertEmitted: severity !== null, alertSeverity: severity,
  }});

  if (severity === 'P0') await this.alert.page('P0', { blockNumber, invariant, navParityDelta });
  if (severity === 'P1') await this.alert.warn('P1', { blockNumber, stressMode });
}
```

### 2.5 Fail-Closed Guarantee

If any RPC call throws, the block is treated as a **P0 invariant failure** — no silent skips:

```typescript
try {
  await this.onBlock(blockNumber, blockHash);
} catch (err) {
  await this.alert.page('P0', { reason: 'POLLER_RPC_ERROR', blockNumber, error: err.message });
  await this.prisma.invariantPollRecord.create({
    data: { poolId: this.poolId, blockNumber, blockHash, polledAt: new Date(),
            invariantOk: false, invariantCode: -1, paused: false,
            stressMode: false, seniorPriorityActive: false,
            navParityOk: false, navParityDeltaUsdc: 0n,
            alertEmitted: true, alertSeverity: 'P0' },
  });
}
```

---

## 3. Coverage & Subordination Dashboard

### 3.1 Definitions

```
// Coverage — commitment-based (NOT NAV-based)
juniorBuffer      = juniorCommitmentUsdc - juniorDefaultImpactUsdc
coverageRatioBps  = (juniorBuffer * 10_000n) / seniorExposureUsdc

// Subordination — NAV-based
subordinationBps  = (juniorNAV * 10_000n) / totalNAV

// Thresholds (from recommended governance config)
COVERAGE_FLOOR_BPS          = 750    // governance parameter
COVERAGE_WARNING_BPS        = 1500   // 2× floor
SUBORDINATION_MIN_BPS       = 3000   // junior floor invariant
SUBORDINATION_WARNING_BPS   = 4500   // 1.5× min
```

### 3.2 Status Bands

```typescript
interface CoverageState {
  poolId:               string;
  computedAt:           Date;
  blockNumber:          bigint;

  juniorBuffer:         bigint;   // commitment-based
  seniorExposureUsdc:   bigint;
  juniorNAV:            bigint;
  totalNAV:             bigint;

  coverageRatioBps:     number;
  subordinationBps:     number;

  // HEALTHY  = coverageRatioBps >= 1500
  // WARNING  = coverageRatioBps >= 750 && < 1500
  // BREAKER_ZONE = coverageRatioBps < 750  (breaker fires)
  coverageStatus:       'HEALTHY' | 'WARNING' | 'BREAKER_ZONE';

  // HEALTHY      = subordinationBps >= 4500
  // WARNING      = subordinationBps >= 3000 && < 4500
  // FLOOR_BREACH = subordinationBps < 3000  (invariant violation)
  subordinationStatus:  'HEALTHY' | 'WARNING' | 'FLOOR_BREACH';
}
```

### 3.3 Dashboard API Endpoints

All require `X-Admin-Key` header.

```
GET  /admin/tranche/coverage              → CoverageState (live)
GET  /admin/tranche/coverage/history?days=30  → CoverageState[] (daily snapshots)
GET  /admin/tranche/nav                   → PoolNAVState (live)
GET  /admin/tranche/nav/history?days=30   → TrancheNAVSnapshot[]
GET  /admin/tranche/subordination         → { subordinationBps, status, history }
GET  /admin/tranche/poll/latest           → BlockPollRecord
GET  /admin/tranche/poll/failures?limit=50 → BlockPollRecord[] (invariantOk=false)
GET  /admin/tranche/recon/latest          → DailyReconArtifact
```

### 3.4 Metric Grid (refreshed every 30 seconds)

| Metric | Warning | Critical |
|---|---|---|
| `coverageRatioBps` | < 1500 bps | < 750 bps |
| `subordinationBps` | < 4500 bps | < 3000 bps |
| `invariantOk` | — | `false` |
| `paused` | — | `true` |
| `stressMode` | `true` | — |
| `seniorPriorityActive` | `true` | — |
| `navParityDeltaUsdc` | > 0 | > 1_000_000 |
| `reconDeltaUsdc` | > 0 | > 1_000_000 |
| `seniorImpairmentUsdc` | — | > 0 |

---

## 4. Stress & Breaker Alert Playbook

### 4.1 Alert Severity Matrix

| Severity | Condition | Trigger ID | Immediate Action |
|---|---|---|---|
| **P0** | `invariantOk == false` | `INVARIANT_FAILURE` | Page on-call + ops lead. Halt all originations. |
| **P0** | `seniorImpairmentUsdc > 0` | `SENIOR_TRANCHE_DRAWDOWN` | Page credit committee. Freeze pool. |
| **P0** | `paused == true` (unexpected) | `GLOBAL_HARD_STOP` | Page on-call. Investigate before unpausing. |
| **P0** | `navParityDeltaUsdc > 1_000_000` | `NAV_PARITY_BREACH` | Page on-call. No settlements until resolved. |
| **P0** | Poller RPC error | `POLLER_RPC_ERROR` | Page on-call. Treat as invariant failure. |
| **P1** | `stressMode == true` | `STRESS_MODE_ACTIVE` | Notify credit committee. Monitor coverage hourly. |
| **P1** | `coverageRatioBps < 1500` | `COVERAGE_WARNING` | Notify ops. Review origination pipeline. |
| **P1** | `subordinationBps < 4500` | `SUBORDINATION_WARNING` | Notify credit committee. Freeze new originations. |
| **P2** | `seniorPriorityActive == true` | `SENIOR_PRIORITY_ACTIVE` | Notify ops. Confirm expected (stress mode side-effect). |

### 4.2 Alert Payload Schema

```typescript
interface TrancheAlert {
  env:          string;
  severity:     'P0' | 'P1' | 'P2';
  triggerId:    string;
  poolId:       string;
  blockNumber:  bigint;
  metricKey:    string;
  metricValue:  number | bigint;
  threshold:    number | bigint;
  message:      string;
  firedAt:      string;   // ISO 8601
  incidentId:   string | null;
}
```

Emitted as structured JSON: `logger.error` (P0), `logger.warn` (P1/P2).

### 4.3 P0 Runbook — Invariant Failure

1. `GET /admin/tranche/poll/failures?limit=5` — confirm block range and `invariantCode`
2. `GET /admin/breaker/status` — confirm `globalBlock: true`
3. Cross-reference `invariantCode` with contract error code table
4. If NAV parity: `GET /admin/tranche/nav` — inspect `parityDeltaUsdc` per tranche
5. If balance sheet: `GET /admin/tranche/recon/latest` — inspect `reconDeltaUsdc`
6. **Do not resolve** until root cause identified and DB state matches on-chain
7. `POST /admin/breaker/incidents/:id/resolve`
8. Verify: `GET /admin/tranche/poll/latest` → `invariantOk: true`

> **Do NOT apply an override for `INVARIANT_FAILURE` without explicit sign-off from engineering lead and credit committee.**

### 4.4 P0 Runbook — Senior Impairment

1. `GET /admin/tranche/nav` — confirm `senior.badDebt > 0`
2. `GET /admin/tranche/coverage` — confirm `coverageRatioBps == 0`
3. Immediately notify credit committee and senior investors per investor agreement
4. Confirm `SENIOR_TRANCHE_DRAWDOWN` incident is OPEN
5. Initiate loss recovery (collateral claims, legal)
6. Do not resolve until full loss accounting is signed off

### 4.5 P0 Runbook — NAV Parity Breach

1. `GET /admin/tranche/nav` — inspect `senior.parityDeltaUsdc` and `junior.parityDeltaUsdc`
2. `GET /admin/tranche/recon/latest` — check `reconOk` and `reconDeltaUsdc`
3. Check event listener logs for missed events (default write-off, yield accrual)
4. If event replay needed: `TrancheNAVService.recomputeFromEvents(poolId, fromBlock)`
5. No settlements or disbursements until parity restored (delta == 0n)

### 4.6 P1 Runbook — Stress Mode

1. `GET /admin/tranche/coverage` — check `coverageRatioBps` and `subordinationBps`
2. If `coverageRatioBps < 1500`: escalate to P0 coverage runbook
3. Monitor coverage every 30 minutes until `stressMode == false`
4. No new originations until stress mode clears

### 4.7 P1 Runbook — Coverage Warning

1. `GET /admin/tranche/coverage/history?days=7` — assess rate of decline
2. If declining > 200 bps/day: escalate to P0, freeze originations
3. If `coverageRatioBps < 750` (floor): breaker fires automatically

### 4.8 New BreakerTrigger Values (v1.2.1)

```prisma
// Additions to BreakerTrigger enum in schema.prisma
enum BreakerTrigger {
  // ... existing values ...
  INVARIANT_FAILURE
  SENIOR_TRANCHE_DRAWDOWN
  JUNIOR_TRANCHE_DEPLETION
  NAV_PARITY_BREACH
  STRESS_MODE_ACTIVE
  COVERAGE_WARNING
  SUBORDINATION_WARNING
  POLLER_RPC_ERROR
}
```

---

## 5. Daily Reconciliation

### 5.1 Balance Sheet Identity

Verified daily at 03:00 UTC:

```
sr.virtualBalance + jr.virtualBalance + principalOutstanding
  == usdcBalance + totalBadDebt
```

- `sr.virtualBalance` = `sr.commitmentUsdc - sr.defaultImpactUsdc + sr.cumulativeYieldUsdc`
- `jr.virtualBalance` = `jr.commitmentUsdc - jr.defaultImpactUsdc + jr.cumulativeYieldUsdc`
- `principalOutstanding` = SUM of active `TrancheLoanAllocation.allocatedUsdc`
- `usdcBalance` = on-chain `USDC.balanceOf(poolAddress)` at snapshot block
- `totalBadDebt` = `sr.defaultImpactUsdc + jr.defaultImpactUsdc`

### 5.2 Signed Artifact

```typescript
interface DailyReconArtifact {
  reconDate:            string;    // 'YYYY-MM-DD'
  poolId:               string;
  snapshotBlock:        bigint;
  snapshotBlockHash:    string;
  computedAt:           string;    // ISO 8601

  srVirtualBalance:     bigint;
  jrVirtualBalance:     bigint;
  principalOutstanding: bigint;
  usdcBalance:          bigint;
  totalBadDebt:         bigint;

  lhs:                  bigint;    // sr.vb + jr.vb + principalOut
  rhs:                  bigint;    // usdcBalance + totalBadDebt
  reconOk:              boolean;
  reconDeltaUsdc:       bigint;    // lhs - rhs (must be 0n)

  srNavParityOk:        boolean;
  jrNavParityOk:        boolean;
  srParityDeltaUsdc:    bigint;
  jrParityDeltaUsdc:    bigint;

  signedBy:             string;    // 'unified-orchestrator/recon-service'
  signatureHex:         string;    // HMAC-SHA256(canonicalJson, RECON_SIGNING_KEY)
}
```

**Signing:** HMAC-SHA256 over canonical JSON (keys sorted, BigInt as decimal strings), keyed by `RECON_SIGNING_KEY` env var.

### 5.3 Prisma Model

```prisma
model DailyReconArtifact {
  id                   String   @id @default(cuid())
  reconDate            DateTime @unique
  poolId               String
  snapshotBlock        BigInt
  snapshotBlockHash    String

  srVirtualBalance     BigInt
  jrVirtualBalance     BigInt
  principalOutstanding BigInt
  usdcBalance          BigInt
  totalBadDebt         BigInt

  lhs                  BigInt
  rhs                  BigInt
  reconOk              Boolean
  reconDeltaUsdc       BigInt

  srNavParityOk        Boolean
  jrNavParityOk        Boolean
  srParityDeltaUsdc    BigInt
  jrParityDeltaUsdc    BigInt

  signedBy             String
  signatureHex         String

  createdAt            DateTime @default(now())

  @@index([poolId, reconDate])
  @@index([reconOk])
}
```

### 5.4 Reconciliation Service

```typescript
class TrancheReconService {
  // Cron: @Cron('0 3 * * *')
  async runDailyRecon(poolId: string): Promise<DailyReconArtifact> {
    const block    = await this.provider.getBlock('latest');
    const navState = await this.navService.computePoolNAV(poolId, BigInt(block.number));

    const lhs = navState.senior.virtualBalance
              + navState.junior.virtualBalance
              + navState.totalPrincipalOut;
    const rhs = navState.usdcBalance + navState.totalBadDebt;

    const artifact = {
      reconDate:            todayMidnightUTC(),
      poolId,
      snapshotBlock:        BigInt(block.number),
      snapshotBlockHash:    block.hash,
      computedAt:           new Date().toISOString(),
      srVirtualBalance:     navState.senior.virtualBalance,
      jrVirtualBalance:     navState.junior.virtualBalance,
      principalOutstanding: navState.totalPrincipalOut,
      usdcBalance:          navState.usdcBalance,
      totalBadDebt:         navState.totalBadDebt,
      lhs, rhs,
      reconOk:              lhs === rhs,
      reconDeltaUsdc:       lhs - rhs,
      srNavParityOk:        navState.senior.parityOk,
      jrNavParityOk:        navState.junior.parityOk,
      srParityDeltaUsdc:    navState.senior.parityDeltaUsdc,
      jrParityDeltaUsdc:    navState.junior.parityDeltaUsdc,
      signedBy:             'unified-orchestrator/recon-service',
      signatureHex:         this.sign(artifact),
    };

    await this.prisma.dailyReconArtifact.upsert({
      where:  { reconDate: artifact.reconDate },
      create: artifact,
      update: artifact,
    });

    if (!artifact.reconOk) {
      await this.alert.page('P0', {
        triggerId:   'RECON_IDENTITY_BREACH',
        reconDelta:  artifact.reconDeltaUsdc,
        blockNumber: artifact.snapshotBlock,
      });
    }

    return artifact;
  }

  private sign(artifact: Omit<DailyReconArtifact, 'signatureHex'>): string {
    const canonical = JSON.stringify(artifact, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
      Object.keys(artifact).sort()
    );
    return createHmac('sha256', process.env.RECON_SIGNING_KEY!)
      .update(canonical)
      .digest('hex');
  }
}
```

---

## 6. Deployment Instructions

### 6.1 Branch & Commit

```bash
git checkout -b agent-c/v1.2.1-monitoring
# implement services, add Prisma models, register module
git add .
git commit -m "feat(monitoring): NAV engine, invariant poller, coverage dashboard, recon service"
git push origin agent-c/v1.2.1-monitoring
```

### 6.2 Prisma Migration

```bash
# Add InvariantPollRecord and DailyReconArtifact models + BreakerTrigger enum values
npx prisma migrate dev --name add_monitoring_v1_2_1
npx prisma generate
```

### 6.3 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RECON_SIGNING_KEY` | **Yes** | HMAC key for daily recon artifact signatures. Min 32 bytes. |
| `POOL_CONTRACT_ADDRESS` | **Yes** | `UnifiedPoolTranched` contract address |
| `RPC_URL` | **Yes** | Ethereum/EVM RPC endpoint for block listener and contract reads |
| `ADMIN_API_KEY` | **Yes** | Existing — required for dashboard endpoints |
| `POLLER_PARITY_THRESHOLD_USDC` | No | Default: `1_000_000` (1 USDC). Raise only with credit committee approval. |

### 6.4 Module Registration

```typescript
// src/modules/tranche/tranche.module.ts
@Module({
  imports:   [PrismaModule, CircuitBreakerModule, EthersModule],
  providers: [
    TrancheNAVService,
    TrancheReconService,
    InvariantPollerService,
    TrancheReportService,
    TrancheStressService,
    TrancheScheduler,
  ],
  exports: [TrancheNAVService, TrancheReconService, TrancheReportService, TrancheStressService],
})
export class TrancheModule {}
```

### 6.5 Cron Schedule

| Job | Cron | Service | Action |
|---|---|---|---|
| NAV snapshot | `0 1 * * *` | `TrancheNAVService` | `snapshotAll()` |
| Yield report | `0 2 * * *` | `TrancheReportService` | `buildYieldReport()` |
| Coverage report | `0 2 * * *` | `TrancheReportService` | `buildCoverageRatioReport()` |
| Daily recon | `0 3 * * *` | `TrancheReconService` | `runDailyRecon()` |
| Block poller | event-driven | `InvariantPollerService` | `onBlock()` per block |

### 6.6 Verification Checklist

- [ ] `InvariantPollRecord` rows created for every block
- [ ] `DailyReconArtifact` created at 03:00 UTC with `reconOk: true`
- [ ] `GET /admin/tranche/coverage` returns correct `coverageRatioBps`
- [ ] `GET /admin/tranche/poll/latest` returns `invariantOk: true`
- [ ] P0 alert fires when `checkInvariants()` returns `ok: false` in test
- [ ] P1 alert fires when `stressMode: true` in test
- [ ] Recon signature verifies with `RECON_SIGNING_KEY`
- [ ] Poller fail-closed: RPC error → P0 alert + failed poll record persisted

---

*Spec authored by Agent C. Branch: `agent-c/v1.2.1-monitoring`.*
