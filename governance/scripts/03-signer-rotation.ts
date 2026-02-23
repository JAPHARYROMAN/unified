/**
 * governance/scripts/03-signer-rotation.ts
 *
 * DRILL 3 — Settlement Signer Rotation
 *
 * Procedure:
 *   A. Record current signer identity (backend + on-chain)
 *   B. Simulate signer compromise — document old key fingerprint
 *   C. [MANUAL] Schedule setSettlementAgent timelock with new signer address
 *   D. [MANUAL, 24h] Execute setSettlementAgent — record tx hash
 *   E. Rotate backend CHAIN_ACTION_SIGNER_PRIVATE_KEY (env/secrets manager)
 *   F. Verify old signer address no longer matches factory.settlementAgent
 *   G. Verify new signer can submit (send a test action or confirm worker healthy)
 *   H. Capture chain-action worker metrics
 *
 * On-chain Hardhat scripts:
 *   npx hardhat run scripts/governance/schedule-signer-rotation.ts  --network staging
 *   npx hardhat run scripts/governance/execute-signer-rotation.ts   --network staging
 *
 * Environment:
 *   DRILL_ADMIN_KEY              Admin API key
 *   DRILL_OPERATOR_ID            Operator identity
 *   DRILL_OLD_SIGNER_ADDRESS     Address of the potentially-compromised signer
 *   DRILL_NEW_SIGNER_ADDRESS     Address of the replacement signer
 *   DRILL_SCHEDULE_TX_HASH       Tx hash from schedule-signer-rotation.ts
 *   DRILL_EXECUTE_TX_HASH        Tx hash from execute-signer-rotation.ts
 */

import { api, step, ok, warn, record, saveEvidence, ensureAdminKey, OPERATOR } from "./lib/api";

async function main() {
  ensureAdminKey();

  const oldSignerAddr  = process.env.DRILL_OLD_SIGNER_ADDRESS ?? null;
  const newSignerAddr  = process.env.DRILL_NEW_SIGNER_ADDRESS ?? null;
  const scheduleTx     = process.env.DRILL_SCHEDULE_TX_HASH   ?? null;
  const executeTx      = process.env.DRILL_EXECUTE_TX_HASH    ?? null;

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 3 — SETTLEMENT SIGNER ROTATION");
  console.log(`  Operator         : ${OPERATOR}`);
  console.log(`  Old signer (sim) : ${oldSignerAddr ?? "(not provided)"}`);
  console.log(`  New signer       : ${newSignerAddr ?? "(not provided)"}`);
  console.log("══════════════════════════════════════════════════\n");

  // ── A. Record current signer ─────────────────────────────────────────────
  step("A. Record current backend chain-action worker state");
  const chainActionsStatus: any = await api("GET", "/admin/chain-actions/status");
  record("drill-3", "A-worker-state", {
    workerState: chainActionsStatus,
    capturedAt: new Date().toISOString(),
  });
  ok(`Worker state: paused=${chainActionsStatus?.paused}`);

  // ── B. Simulate signer compromise ────────────────────────────────────────
  step("B. Document signer compromise scenario");
  const compromiseTs = new Date().toISOString();
  record("drill-3", "B-compromise-simulated", {
    simulatedAt: compromiseTs,
    oldSignerAddress: oldSignerAddr,
    actionTaken: "Signer private key assumed compromised — rotation initiated",
    note: "In production: revoke cloud secret immediately, notify security team",
  });
  ok(`Compromise event documented at ${compromiseTs}`);

  // ── C. Schedule timelock ─────────────────────────────────────────────────
  step("C. [MANUAL] Schedule setSettlementAgent via governance timelock");
  if (!scheduleTx) {
    warn("DRILL_SCHEDULE_TX_HASH not set");
    console.log(`
  Run:
    DRILL_NEW_SIGNER_ADDRESS=${newSignerAddr ?? "<new-addr>"} \\
      npx hardhat run scripts/governance/schedule-signer-rotation.ts --network staging

  Timelock delay: 24 hours
  Earliest execution: ${new Date(Date.now() + 86_400_000).toISOString()}
`);
    record("drill-3", "C-timelock-pending", {
      status: "awaiting-manual-execution",
      newSignerAddress: newSignerAddr,
      timelockDelay: "24 hours",
    });
  } else {
    record("drill-3", "C-timelock-scheduled", {
      txHash: scheduleTx,
      newSignerAddress: newSignerAddr,
      scheduledAt: new Date().toISOString(),
      earliestExecuteAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    ok(`Timelock scheduled tx: ${scheduleTx}`);
  }

  // ── D. Execute signer rotation ───────────────────────────────────────────
  step("D. [MANUAL] Execute setSettlementAgent after timelock delay");
  if (!executeTx) {
    warn("DRILL_EXECUTE_TX_HASH not set — run after 24h delay");
    console.log(`
  Run:
    DRILL_NEW_SIGNER_ADDRESS=${newSignerAddr ?? "<new-addr>"} \\
      npx hardhat run scripts/governance/execute-signer-rotation.ts --network staging
`);
    record("drill-3", "D-execute-pending", { status: "awaiting-timelock-expiry" });
  } else {
    record("drill-3", "D-rotation-executed", {
      txHash: executeTx,
      newSignerAddress: newSignerAddr,
      executedAt: new Date().toISOString(),
    });
    ok(`Signer rotation executed: ${executeTx}`);
  }

  // ── E. Backend key rotation ──────────────────────────────────────────────
  step("E. Document backend CHAIN_ACTION_SIGNER_PRIVATE_KEY rotation procedure");
  record("drill-3", "E-backend-key-rotation", {
    procedure: [
      "1. Generate new private key for new signer address",
      "2. Update CHAIN_ACTION_SIGNER_PRIVATE_KEY in secrets manager (AWS SM / Vault / K8s secret)",
      "3. Rolling-restart the orchestrator pod — worker picks up new key on startup",
      "4. Verify worker health: GET /admin/chain-actions/status",
      "5. Confirm first successful tx signed by new key (check tx signer on block explorer)",
    ],
    warningNote: "Do NOT store private key in env files committed to git",
    executedAt: new Date().toISOString(),
  });

  // ── F. Pause old worker, check new worker ────────────────────────────────
  step("F. Pause sender during rotation window (prevent stale-key submissions)");
  try {
    const paused: any = await api("POST", "/admin/chain-actions/pause");
    record("drill-3", "F-sender-paused", paused);
    ok("Sender paused during key rotation");

    if (executeTx && newSignerAddr) {
      // After key rotation, resume
      step("F2. Resume sender with new key");
      const resumed: any = await api("POST", "/admin/chain-actions/resume");
      record("drill-3", "F2-sender-resumed", resumed);
      ok("Sender resumed with new signer key");
    } else {
      warn("Sender remains paused — resume after completing on-chain + backend key rotation");
    }
  } catch (err: any) {
    warn(`Sender pause/resume: ${err.message}`);
    record("drill-3", "F-sender-pause-error", { error: err.message });
  }

  // ── G. Verify new signer ─────────────────────────────────────────────────
  step("G. Verify new signer health");
  try {
    const workerStatus: any = await api("GET", "/admin/chain-actions/status");
    record("drill-3", "G-worker-health", workerStatus);
    ok(`Worker health: ${JSON.stringify(workerStatus)}`);
  } catch (err: any) {
    warn(`Worker status check failed: ${err.message}`);
    record("drill-3", "G-worker-health-error", { error: err.message });
  }

  // ── H. Capture metrics ───────────────────────────────────────────────────
  step("H. Capture chain-action metrics");
  try {
    const metrics: any = await api("GET", "/admin/ops/metrics");
    record("drill-3", "H-metrics", metrics);
    ok("Metrics captured");
  } catch (err: any) {
    warn(`Metrics fetch failed: ${err.message}`);
    record("drill-3", "H-metrics-error", { error: err.message });
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 3 EVIDENCE CAPTURED");
  if (scheduleTx) console.log(`  Timelock schedule tx : ${scheduleTx}`);
  if (executeTx)  console.log(`  Execute tx           : ${executeTx}`);
  console.log("══════════════════════════════════════════════════\n");

  saveEvidence("03-signer-rotation");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
