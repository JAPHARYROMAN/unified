/**
 * governance/scripts/01-soft-halt.ts
 *
 * DRILL 1 — Emergency Originations Halt (SOFT / Backend)
 *
 * Procedure:
 *   A. Capture pre-halt baseline
 *   B. Fire the ACTIVE_WITHOUT_DISBURSEMENT_PROOF circuit-breaker trigger (drill)
 *   C. Assert enforcement state: globalBlock = true
 *   D. Verify loan origination is rejected (403)
 *   E. Acknowledge incident (assign to operator)
 *   F. Resolve incident (lift halt)
 *   G. Assert enforcement state restored: globalBlock = false
 *   H. Export audit log segment
 *
 * Environment:
 *   DRILL_ADMIN_KEY     Admin API key
 *   DRILL_OPERATOR_ID   Operator identity for audit trail
 *   DRILL_PARTNER_ID    (optional) ACTIVE partner ID to use for origination check
 *   DRILL_API_URL       Backend URL (default: http://localhost:3000)
 *
 * Usage:
 *   DRILL_ADMIN_KEY=<key> DRILL_OPERATOR_ID=<id> npx ts-node governance/scripts/01-soft-halt.ts
 */

import { api, step, ok, warn, assert, record, saveEvidence, ensureAdminKey, OPERATOR } from "./lib/api";

async function main() {
  ensureAdminKey();

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 1 — EMERGENCY ORIGINATIONS HALT (SOFT)");
  console.log(`  Operator : ${OPERATOR}`);
  console.log("══════════════════════════════════════════════════\n");

  // ── A. Baseline ──────────────────────────────────────────────────────────
  step("A. Capture baseline enforcement state");
  const baseline: any = await api("GET", "/admin/breaker/status");
  record("drill-1", "A-baseline", baseline);
  assert(!baseline.enforcement.globalBlock, "globalBlock must be false at drill start — resolve prior incidents first");
  ok(`Baseline clean: globalBlock=${baseline.enforcement.globalBlock} openIncidents=${baseline.openIncidentCount}`);

  // ── B. Fire drill trigger ────────────────────────────────────────────────
  step("B. Fire ACTIVE_WITHOUT_DISBURSEMENT_PROOF trigger (DRILL)");
  const drillResult: any = await api("POST", "/admin/breaker/drill/fire", {
    trigger: "ACTIVE_WITHOUT_DISBURSEMENT_PROOF",
  });
  record("drill-1", "B-trigger-fired", drillResult);
  ok(`Incident created: id=${drillResult.incidentId} actions=${drillResult.actionsApplied.join(",")}`);
  const incidentId = drillResult.incidentId;

  // ── C. Assert enforcement state ──────────────────────────────────────────
  step("C. Assert globalBlock = true");
  const blocked: any = await api("GET", "/admin/breaker/status");
  record("drill-1", "C-enforcement-blocked", blocked);
  assert(blocked.enforcement.globalBlock === true, "globalBlock must be true after trigger fires");
  ok("✓ globalBlock = true — originations are blocked");

  // ── D. Verify origination rejected ──────────────────────────────────────
  step("D. Verify loan origination is rejected (403)");
  const partnerId = process.env.DRILL_PARTNER_ID;
  if (partnerId) {
    try {
      await api("POST", "/api/v1/loans", {
        borrowerWallet: "0xDrillBorrower0000000000000000000000000000",
        principalUsdc: "1000000",
        collateralToken: "0xDrillCollateral000000000000000000000000",
        collateralAmount: "500000",
        durationSeconds: 86400,
        interestRateBps: 500,
      });
      record("drill-1", "D-origination-check", { blocked: false, error: "Expected 403 — got 200" });
      warn("⚠ Origination was NOT blocked — check CircuitBreakerService.assertOriginationAllowed is wired to LoanController");
    } catch (err: any) {
      if (err.message.includes("403")) {
        record("drill-1", "D-origination-check", { blocked: true, status: 403 });
        ok("✓ Origination correctly blocked (HTTP 403)");
      } else {
        record("drill-1", "D-origination-check", { blocked: "unknown", error: err.message });
        warn(`Origination returned unexpected error: ${err.message}`);
      }
    }
  } else {
    warn("DRILL_PARTNER_ID not set — skipping live origination check (add it for full drill)");
    record("drill-1", "D-origination-check", { skipped: true, reason: "DRILL_PARTNER_ID not provided" });
  }

  // ── E. Acknowledge incident ──────────────────────────────────────────────
  step(`E. Acknowledge incident ${incidentId}`);
  const ack: any = await api("POST", `/admin/breaker/incidents/${incidentId}/acknowledge`);
  record("drill-1", "E-acknowledge", ack);
  assert(ack.status === "ACKNOWLEDGED", `Expected ACKNOWLEDGED, got ${ack.status}`);
  ok(`Incident acknowledged by ${OPERATOR}`);

  // ── F. Resolve incident ──────────────────────────────────────────────────
  step(`F. Resolve incident ${incidentId}`);
  const resolved: any = await api("POST", `/admin/breaker/incidents/${incidentId}/resolve`);
  record("drill-1", "F-resolve", resolved);
  assert(resolved.status === "RESOLVED", `Expected RESOLVED, got ${resolved.status}`);
  ok("Incident resolved — halt lifted");

  // ── G. Assert enforcement restored ───────────────────────────────────────
  step("G. Assert globalBlock = false (restored)");
  const restored: any = await api("GET", "/admin/breaker/status");
  record("drill-1", "G-enforcement-restored", restored);
  assert(restored.enforcement.globalBlock === false, "globalBlock must return to false after resolution");
  ok("✓ globalBlock = false — originations restored");

  // ── H. Export audit log ──────────────────────────────────────────────────
  step("H. Capture audit log (last 50 entries)");
  const audit: any = await api("GET", "/admin/breaker/audit");
  const drillAudit = (Array.isArray(audit) ? audit : []).slice(0, 50);
  record("drill-1", "H-audit-log", drillAudit);
  ok(`Captured ${drillAudit.length} audit log entries`);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 1 COMPLETE — Soft halt exercised end-to-end");
  console.log(`  Incident: ${incidentId}`);
  console.log(`  Duration: ACKNOWLEDGED → RESOLVED`);
  console.log("══════════════════════════════════════════════════\n");

  saveEvidence("01-soft-halt");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
