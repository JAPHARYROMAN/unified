/**
 * governance/scripts/00-preflight.ts
 *
 * Pre-drill environment check.
 * Run before any drill to confirm API connectivity, auth, and baseline state.
 *
 * Usage:
 *   DRILL_ADMIN_KEY=<key> DRILL_OPERATOR_ID=<id> npx ts-node governance/scripts/00-preflight.ts
 */

import { api, step, ok, fail, warn, record, saveEvidence, ensureAdminKey, OPERATOR, BASE_URL } from "./lib/api";

async function main() {
  ensureAdminKey();

  console.log("\n══════════════════════════════════════════════════");
  console.log("  UNIFIED GOVERNANCE DRILL — PRE-FLIGHT CHECK");
  console.log(`  Operator : ${OPERATOR}`);
  console.log(`  API URL  : ${BASE_URL}`);
  console.log("══════════════════════════════════════════════════\n");

  // ── 1. Health check ─────────────────────────────────────────────────────
  step("1. Backend health check");
  let health: any;
  try {
    health = await api("GET", "/health");
  } catch (err: any) {
    fail(`Backend unreachable at ${BASE_URL} — ${err.message}`);
  }
  record("preflight", "health", health);
  ok(`Backend healthy: ${JSON.stringify(health)}`);

  // ── 2. Admin auth ────────────────────────────────────────────────────────
  step("2. Admin API key validation");
  const status: any = await api("GET", "/admin/breaker/status");
  record("preflight", "breaker-status", status);
  ok("Admin auth: accepted");

  // ── 3. Baseline breaker state ────────────────────────────────────────────
  step("3. Baseline circuit-breaker state");
  const { enforcement, openIncidentCount, activeOverrideCount } = status;
  record("preflight", "baseline", { enforcement, openIncidentCount, activeOverrideCount });

  if (enforcement.globalBlock) {
    warn("globalBlock is ALREADY true — breaker may be active from a prior drill. Resolve before continuing.");
  } else {
    ok("globalBlock = false (clean baseline)");
  }
  if (openIncidentCount > 0) {
    warn(`${openIncidentCount} open incident(s) exist — review before proceeding`);
  } else {
    ok("openIncidentCount = 0");
  }

  // ── 4. Ops queue sanity ──────────────────────────────────────────────────
  step("4. Ops chain-action queue");
  const dlq: any = await api("GET", "/admin/ops/dlq?limit=5");
  record("preflight", "dlq-sample", dlq);
  ok(`DLQ sample returned (${Array.isArray(dlq) ? dlq.length : "?"} entries)`);

  // ── 5. Partner list ──────────────────────────────────────────────────────
  step("5. Partner roster");
  const partners: any = await api("GET", "/admin/partners");
  record("preflight", "partners", partners);
  const activeCount = partners.filter((p: any) => p.status === "ACTIVE").length;
  ok(`Partners: total=${partners.length} active=${activeCount}`);

  if (activeCount === 0) {
    warn("No ACTIVE partners found — drills 1 and 4 may require seeding test data");
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════");
  console.log("  PRE-FLIGHT PASSED — environment is ready");
  console.log("══════════════════════════════════════════════════\n");

  saveEvidence("00-preflight");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
