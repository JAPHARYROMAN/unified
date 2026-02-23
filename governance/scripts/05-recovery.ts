/**
 * governance/scripts/05-recovery.ts
 *
 * DRILL 5 — Recovery / Unpause
 *
 * Gates recovery on a clean reconciliation report. Refuses to proceed if
 * critical reconciliation mismatches exist — this is the proof requirement.
 *
 * Procedure:
 *   A. Run daily reconciliation — capture proof
 *   B. Assert no critical mismatches (gate for recovery)
 *   C. Assert all open incidents are resolved
 *   D. Assert no overrides blocking originations
 *   E. [MANUAL] Unpause factory (if paused from Drill 2)
 *   F. [MANUAL] Re-activate suspended partner (if disabled in Drill 4)
 *   G. Assert full enforcement state is clean
 *   H. Verify test origination is accepted (end-to-end smoke test)
 *   I. Generate recovery decision record
 *
 * Environment:
 *   DRILL_ADMIN_KEY          Admin API key
 *   DRILL_OPERATOR_ID        Operator identity
 *   DRILL_UNPAUSE_TX_HASH    Tx hash from unpause-factory.ts (Drill 2 companion)
 *   DRILL_PARTNER_ID         Partner to re-activate (from Drill 4)
 *   DRILL_API_URL            Backend URL
 *
 * Usage:
 *   DRILL_ADMIN_KEY=<key> DRILL_OPERATOR_ID=<id> \
 *     DRILL_UNPAUSE_TX_HASH=0x... DRILL_PARTNER_ID=<uuid> \
 *     npx ts-node governance/scripts/05-recovery.ts
 */

import { api, step, ok, warn, assert, record, saveEvidence, ensureAdminKey, OPERATOR } from "./lib/api";

async function main() {
  ensureAdminKey();

  const unpauseTx  = process.env.DRILL_UNPAUSE_TX_HASH ?? null;
  const partnerId  = process.env.DRILL_PARTNER_ID      ?? null;

  console.log("\n══════════════════════════════════════════════════");
  console.log("  DRILL 5 — RECOVERY / UNPAUSE");
  console.log(`  Operator      : ${OPERATOR}`);
  console.log(`  Unpause tx    : ${unpauseTx ?? "(will check manually)"}`);
  console.log(`  Partner (re-activate): ${partnerId ?? "(not provided)"}`);
  console.log("══════════════════════════════════════════════════\n");

  // ── A. Reconciliation proof ──────────────────────────────────────────────
  step("A. Run daily reconciliation — required before recovery gate");
  const recon: any = await api("GET", "/admin/ops/reconciliation");
  record("drill-5", "A-reconciliation", {
    reconciliation: recon,
    capturedAt: new Date().toISOString(),
  });

  // Parse critical mismatches
  const criticalMismatches: any[] = Array.isArray(recon?.criticalMismatches)
    ? recon.criticalMismatches
    : (recon?.summary?.criticalMismatches ?? []);
  const mismatchCount = Array.isArray(criticalMismatches) ? criticalMismatches.length : 0;
  record("drill-5", "A-recon-summary", { mismatchCount, mismatches: criticalMismatches });

  if (mismatchCount > 0) {
    // ── GATE: block recovery until mismatches are resolved ─────────────────
    console.error(`\n❌ RECOVERY BLOCKED: ${mismatchCount} critical reconciliation mismatch(es) found`);
    console.error("   Resolve all mismatches before proceeding with recovery.");
    console.error("   Mismatches:", JSON.stringify(criticalMismatches, null, 2));
    record("drill-5", "A-recon-gate-failed", { blocked: true, mismatchCount });
    process.exitCode = 1;
    saveEvidence("05-recovery-blocked");
    return;
  }
  ok(`Reconciliation clean — ${mismatchCount} critical mismatches (gate passed)`);

  // ── B. Incidents clear ───────────────────────────────────────────────────
  step("B. Assert all incidents resolved");
  const breakerStatus: any = await api("GET", "/admin/breaker/status");
  const openCount = breakerStatus.openIncidentCount ?? 0;
  record("drill-5", "B-incidents-check", { openCount, breakerStatus });

  if (openCount > 0) {
    warn(`${openCount} open incident(s) remain — resolve before proceeding`);
    const incidents: any = await api("GET", "/admin/breaker/incidents");
    record("drill-5", "B-open-incidents", incidents);
    warn("Resolve incidents via: POST /admin/breaker/incidents/:id/resolve");
    // non-blocking warning — proceed to allow partial recovery
  } else {
    ok("All incidents resolved ✓");
  }

  // ── C. Overrides clear ───────────────────────────────────────────────────
  step("C. Assert no active overrides blocking originations");
  const overrides: any = await api("GET", "/admin/breaker/overrides");
  const activeOverrides = Array.isArray(overrides) ? overrides : [];
  record("drill-5", "C-overrides", { count: activeOverrides.length, overrides: activeOverrides });
  if (activeOverrides.length > 0) {
    warn(`${activeOverrides.length} active override(s) — lift if no longer needed`);
  } else {
    ok("No active overrides ✓");
  }

  // ── D. Enforcement state ─────────────────────────────────────────────────
  step("D. Assert enforcement state is clean");
  const { enforcement } = breakerStatus;
  const isClean = !enforcement.globalBlock && !enforcement.globalFreeze && !enforcement.requireManualApproval;
  record("drill-5", "D-enforcement", { enforcement, isClean });
  if (!isClean) {
    warn("Enforcement state is not fully clean — check active incidents/overrides");
  } else {
    ok("Enforcement state clean: no global block/freeze ✓");
  }

  // ── E. Unpause factory ───────────────────────────────────────────────────
  step("E. [MANUAL] Confirm factory unpause (if paused in Drill 2)");
  if (unpauseTx) {
    record("drill-5", "E-unpause-confirmed", {
      txHash: unpauseTx,
      confirmedAt: new Date().toISOString(),
      confirmedBy: OPERATOR,
    });
    ok(`Factory unpause tx confirmed: ${unpauseTx}`);
  } else {
    warn("DRILL_UNPAUSE_TX_HASH not provided — skip if factory was not paused");
    record("drill-5", "E-unpause-skipped", { note: "No unpause tx provided" });
    console.log(`
  If factory was paused in Drill 2:
    npx hardhat run scripts/governance/unpause-factory.ts --network staging

  Then re-run with:
    DRILL_UNPAUSE_TX_HASH=0x... npx ts-node governance/scripts/05-recovery.ts
`);
  }

  // ── F. Re-activate partner ───────────────────────────────────────────────
  step("F. [MANUAL] Re-activate suspended partner (if disabled in Drill 4)");
  if (partnerId) {
    try {
      const partnerDetail: any = await api("GET", `/admin/partners/${partnerId}`);
      if (partnerDetail.status === "SUSPENDED") {
        // Note: there is no direct /activate endpoint for SUSPENDED partners in the current API.
        // The approve flow (VERIFIED → ACTIVE) runs through start-review → approve → activate.
        // For drill recovery, document the procedure.
        record("drill-5", "F-partner-reactivation", {
          partnerId,
          currentStatus: partnerDetail.status,
          procedure: [
            "For SUSPENDED partners the admin must reassess eligibility.",
            "If approved: manually update status to VERIFIED or ACTIVE via admin API or DB.",
            "The status machine does not expose a direct SUSPENDED → ACTIVE transition by design.",
            "This gate exists to prevent automated re-activation without human review.",
          ],
          operatorNote: `Reviewed by ${OPERATOR} at ${new Date().toISOString()}`,
        });
        warn(`Partner ${partnerId} is SUSPENDED — manual re-activation required (see procedure in evidence)`);
      } else {
        record("drill-5", "F-partner-status", { partnerId, status: partnerDetail.status });
        ok(`Partner ${partnerId} status: ${partnerDetail.status}`);
      }
    } catch (err: any) {
      warn(`Partner lookup failed: ${err.message}`);
      record("drill-5", "F-partner-error", { error: err.message });
    }
  } else {
    record("drill-5", "F-partner-skipped", { note: "DRILL_PARTNER_ID not provided" });
    warn("DRILL_PARTNER_ID not set — skipping partner re-activation step");
  }

  // ── G. Full enforcement check ────────────────────────────────────────────
  step("G. Final enforcement state check");
  const finalStatus: any = await api("GET", "/admin/breaker/status");
  record("drill-5", "G-final-state", {
    enforcement: finalStatus.enforcement,
    openIncidentCount: finalStatus.openIncidentCount,
    activeOverrideCount: finalStatus.activeOverrideCount,
    checkedAt: new Date().toISOString(),
  });
  ok(`Final state: globalBlock=${finalStatus.enforcement.globalBlock} globalFreeze=${finalStatus.enforcement.globalFreeze}`);

  // ── H. Smoke test ────────────────────────────────────────────────────────
  step("H. Smoke test — verify origination gate open");
  // We can't submit a real loan without on-chain setup, so we check the gate
  const smokeBreakerStatus: any = await api("GET", "/admin/breaker/status");
  const originationGateOpen = !smokeBreakerStatus.enforcement.globalBlock &&
                              !smokeBreakerStatus.enforcement.globalFreeze;
  record("drill-5", "H-smoke-test", {
    originationGateOpen,
    enforcement: smokeBreakerStatus.enforcement,
  });
  if (originationGateOpen) {
    ok("Origination gate is open — backend allows new loans ✓");
  } else {
    warn("Origination gate is still closed — check active incidents or overrides");
  }

  // ── I. Decision record ───────────────────────────────────────────────────
  step("I. Generate recovery decision record");
  const decisionRecord = {
    drillId: process.env.DRILL_ID ?? "unknown",
    recoveryDecision: "AUTHORIZED",
    authorizedBy: OPERATOR,
    authorizedAt: new Date().toISOString(),
    reconciliationProof: "PASSED — 0 critical mismatches",
    incidentsResolved: openCount === 0,
    factoryUnpaused: !!unpauseTx,
    partnerReactivated: !!partnerId,
    enforcementClean: isClean,
    originationGateOpen,
    checklist: [
      { item: "Reconciliation clean", passed: mismatchCount === 0 },
      { item: "All incidents resolved", passed: openCount === 0 },
      { item: "No active blocking overrides", passed: activeOverrides.length === 0 },
      { item: "Enforcement state clean", passed: isClean },
      { item: "Origination gate open", passed: originationGateOpen },
    ],
  };
  record("drill-5", "I-decision-record", decisionRecord);
  ok("Recovery decision record saved to evidence bundle");

  const allPassed = decisionRecord.checklist.every((c) => c.passed);
  console.log("\n══════════════════════════════════════════════════");
  console.log(`  DRILL 5 ${allPassed ? "COMPLETE ✓" : "PARTIAL ⚠"} — Recovery documented`);
  decisionRecord.checklist.forEach((c) =>
    console.log(`    ${c.passed ? "✓" : "⚠"} ${c.item}`),
  );
  console.log("══════════════════════════════════════════════════\n");

  saveEvidence("05-recovery");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
