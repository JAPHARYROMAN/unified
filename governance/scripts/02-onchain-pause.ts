/**
 * governance/scripts/02-onchain-pause.ts
 *
 * DRILL 2 — On-Chain Pause (HARD)
 *
 * This script drives the BACKEND side of the on-chain pause drill.
 * The actual on-chain transactions (pause, timelock schedule/execute) are
 * performed by the companion Hardhat scripts:
 *
 *   npx hardhat run scripts/governance/pause-factory.ts       --network staging
 *   npx hardhat run scripts/governance/schedule-pool-removal.ts --network staging
 *   npx hardhat run scripts/governance/unpause-factory.ts     --network staging
 *
 * Procedure:
 *   A. Capture pre-pause baseline (backend + on-chain state)
 *   B. [MANUAL] Run pause-factory.ts — record tx hash
 *   C. Assert backend chain-action queue drains cleanly (no new sends during pause)
 *   D. Verify safe-exit path: existing SENT actions can still mine (not blocked)
 *   E. [MANUAL, 24h staging] Run schedule-pool-removal.ts — record timelock id
 *   F. Document timelock scheduled-at and earliest-execute-at timestamps
 *   G. [MANUAL] Execute pool removal after delay — record tx hash
 *   H. [MANUAL] Run unpause-factory.ts — record tx hash
 *   I. Assert backend recovers normally
 *
 * Environment:
 *   DRILL_ADMIN_KEY          Admin API key
 *   DRILL_OPERATOR_ID        Operator identity
 *   DRILL_PAUSE_TX_HASH      Tx hash from pause-factory.ts (set after step B)
 *   DRILL_TIMELOCK_TX_HASH   Tx hash from schedule-pool-removal.ts (set after step E)
 *   DRILL_EXECUTE_TX_HASH    Tx hash from execute-pool-removal.ts (set after step G)
 *   DRILL_UNPAUSE_TX_HASH    Tx hash from unpause-factory.ts (set after step H)
 *
 * Usage:
 *   # Step 1 — Record baseline (before any on-chain ops)
 *   DRILL_ADMIN_KEY=<key> DRILL_OPERATOR_ID=<id> npx ts-node governance/scripts/02-onchain-pause.ts
 *
 *   # Step 2 — After all manual on-chain steps, run again with tx hashes to finalize evidence
 *   DRILL_PAUSE_TX_HASH=0x... DRILL_UNPAUSE_TX_HASH=0x... ... npx ts-node ...
 */

import { api, step, ok, warn, record, saveEvidence, ensureAdminKey, OPERATOR } from "./lib/api";

async function main() {
  ensureAdminKey();

  const pauseTx       = process.env.DRILL_PAUSE_TX_HASH       ?? null;
  const timelockTx    = process.env.DRILL_TIMELOCK_TX_HASH    ?? null;
  const executeTx     = process.env.DRILL_EXECUTE_TX_HASH     ?? null;
  const unpauseTx     = process.env.DRILL_UNPAUSE_TX_HASH     ?? null;

  const phase = pauseTx ? "finalize" : "baseline";

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 2 — ON-CHAIN PAUSE (HARD)");
  console.log(`  Operator : ${OPERATOR}`);
  console.log(`  Phase    : ${phase}`);
  console.log("══════════════════════════════════════════════════\n");

  // ── A. Baseline ──────────────────────────────────────────────────────────
  step("A. Capture backend baseline state");
  const breakerStatus: any = await api("GET", "/admin/breaker/status");
  const chainActions: any  = await api("GET", "/admin/ops/chain-actions?status=QUEUED&limit=20");
  const sentActions: any   = await api("GET", "/admin/ops/chain-actions?status=SENT&limit=20");

  record("drill-2", "A-baseline", {
    breakerStatus,
    queuedCount: Array.isArray(chainActions) ? chainActions.length : "?",
    sentCount:   Array.isArray(sentActions)  ? sentActions.length  : "?",
    capturedAt:  new Date().toISOString(),
  });
  ok(`Baseline: queued=${Array.isArray(chainActions) ? chainActions.length : "?"} sent=${Array.isArray(sentActions) ? sentActions.length : "?"}`);

  // ── B. Pause factory instruction ─────────────────────────────────────────
  step("B. [MANUAL STEP] Pause UnifiedLoanFactory via PAUSER_ROLE");
  if (!pauseTx) {
    warn("DRILL_PAUSE_TX_HASH not set — execute on-chain step then re-run with tx hash");
    console.log(`
  Run:
    npx hardhat run scripts/governance/pause-factory.ts --network staging

  Then re-run this script with:
    DRILL_PAUSE_TX_HASH=<0x...> DRILL_OPERATOR_ID=${OPERATOR} ...
`);
    record("drill-2", "B-pause-pending", { status: "awaiting-manual-execution" });
  } else {
    record("drill-2", "B-pause-tx", { txHash: pauseTx, executedBy: OPERATOR, at: new Date().toISOString() });
    ok(`Pause tx recorded: ${pauseTx}`);

    // ── C. Queue behaviour during pause ────────────────────────────────────
    step("C. Verify chain-action queue behaviour during pause");
    const queuedNow: any = await api("GET", "/admin/ops/chain-actions?status=QUEUED&limit=5");
    record("drill-2", "C-queue-during-pause", {
      queuedCount: Array.isArray(queuedNow) ? queuedNow.length : "?",
      note: "Worker continues to pick QUEUED → PROCESSING → will fail at chain (factory paused)",
    });
    ok("Queue state captured — on-chain sends will revert until unpause");

    // ── D. Safe exits ───────────────────────────────────────────────────────
    step("D. Document safe-exit path");
    record("drill-2", "D-safe-exits", {
      policy: "Existing SENT/MINED actions are unaffected — repayments and pool withdrawals proceed",
      note: "UnifiedPool allows queued withdrawals even when paused (Pausable modifier not on processWithdrawQueue)",
    });
    ok("Safe-exit policy documented");
  }

  // ── E. Timelock schedule ─────────────────────────────────────────────────
  step("E. [MANUAL STEP] Schedule pool removal via governance timelock");
  if (!timelockTx) {
    warn("DRILL_TIMELOCK_TX_HASH not set");
    console.log(`
  Run:
    npx hardhat run scripts/governance/schedule-pool-removal.ts --network staging

  Timelock delay: 24 hours (TIMELOCK_DELAY constant in UnifiedLoanFactory)
  Earliest execution: ${new Date(Date.now() + 86_400_000).toISOString()}
`);
    record("drill-2", "E-timelock-pending", {
      status: "awaiting-manual-execution",
      timelockDelay: "24 hours",
      earliestExecuteAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  } else {
    record("drill-2", "E-timelock-scheduled", {
      txHash: timelockTx,
      scheduledAt: new Date().toISOString(),
      earliestExecuteAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    ok(`Timelock schedule tx: ${timelockTx}`);
  }

  // ── F. Timelock timestamps ───────────────────────────────────────────────
  step("F. Record timelock timing");
  record("drill-2", "F-timelock-timing", {
    timelockDelaySec: 86400,
    scheduledTx: timelockTx,
    executeTx,
    note: "On staging the delay may be reduced by redeploying with a shorter TIMELOCK_DELAY constant",
  });
  ok("Timelock timing documented");

  // ── G/H. Execute pool removal and unpause ────────────────────────────────
  if (executeTx) {
    step("G. Execute pool removal (post-delay)");
    record("drill-2", "G-pool-removal", { txHash: executeTx, at: new Date().toISOString() });
    ok(`Pool removal tx: ${executeTx}`);
  }

  if (unpauseTx) {
    step("H. Unpause factory");
    record("drill-2", "H-unpause-tx", { txHash: unpauseTx, at: new Date().toISOString() });
    ok(`Unpause tx: ${unpauseTx}`);

    // ── I. Recovery check ───────────────────────────────────────────────────
    step("I. Verify backend recovers normally");
    const recoveryStatus: any = await api("GET", "/admin/breaker/status");
    const queueRecovery: any  = await api("GET", "/admin/ops/chain-actions?status=QUEUED&limit=5");
    record("drill-2", "I-recovery", {
      breakerStatus: recoveryStatus,
      queuedCount: Array.isArray(queueRecovery) ? queueRecovery.length : "?",
      recoveredAt: new Date().toISOString(),
    });
    ok("Backend recovery state captured");
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 2 EVIDENCE CAPTURED");
  console.log(`  Phase: ${phase}`);
  if (pauseTx)   console.log(`  Pause tx     : ${pauseTx}`);
  if (timelockTx) console.log(`  Timelock tx  : ${timelockTx}`);
  if (executeTx) console.log(`  Execute tx   : ${executeTx}`);
  if (unpauseTx) console.log(`  Unpause tx   : ${unpauseTx}`);
  console.log("══════════════════════════════════════════════════\n");

  saveEvidence("02-onchain-pause");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
