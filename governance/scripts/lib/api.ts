/**
 * governance/scripts/lib/api.ts
 *
 * Shared HTTP client, step logger, and evidence writer for governance drills.
 *
 * Usage:
 *   import { api, step, evidence } from "./lib/api";
 *
 * Environment:
 *   DRILL_API_URL      Backend base URL (default: http://localhost:3000)
 *   DRILL_ADMIN_KEY    Admin API key (maps to ADMIN_API_KEY in the app)
 *   DRILL_OPERATOR_ID  Operator identity recorded in audit trail
 *   DRILL_ID           Unique drill identifier (default: ISO timestamp)
 */

import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

export const BASE_URL   = process.env.DRILL_API_URL     ?? "http://localhost:3000";
export const ADMIN_KEY  = process.env.DRILL_ADMIN_KEY   ?? "";
export const OPERATOR   = process.env.DRILL_OPERATOR_ID ?? "drill-operator";
export const DRILL_ID   = process.env.DRILL_ID          ?? new Date().toISOString().replace(/[:.]/g, "-");

const EVIDENCE_DIR = path.join(
  __dirname, "..", "..", "evidence",
  DRILL_ID,
);

// ── Console logger ────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";

function ts(): string {
  return new Date().toISOString();
}

export function step(msg: string): void {
  console.log(`${CYAN}[${ts()}]${RESET} ${BOLD}▶ ${msg}${RESET}`);
}

export function ok(msg: string): void {
  console.log(`${GREEN}[${ts()}]${RESET} ✓ ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}[${ts()}]${RESET} ⚠ ${msg}`);
}

export function fail(msg: string): never {
  console.error(`${RED}[${ts()}]${RESET} ✗ ${msg}`);
  process.exit(1);
}

export function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) fail(`ASSERTION FAILED: ${msg}`);
}

// ── HTTP client ───────────────────────────────────────────────────────────────

export async function api<T = unknown>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key":    ADMIN_KEY,
    "x-admin-key":  ADMIN_KEY,
    "x-operator-id": OPERATOR,
    "x-admin-subject": OPERATOR,
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
  }

  return data as T;
}

// ── Evidence writer ───────────────────────────────────────────────────────────

let _entries: Array<{
  ts: string;
  drill: string;
  step: string;
  data: unknown;
}> = [];

export function record(drill: string, stepName: string, data: unknown): void {
  _entries.push({ ts: ts(), drill, step: stepName, data });
}

export function saveEvidence(drillName: string): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const outPath = path.join(EVIDENCE_DIR, `${drillName}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ drillId: DRILL_ID, drillName, entries: _entries }, null, 2));
  ok(`Evidence written → ${outPath}`);
  _entries = [];
}

export function ensureAdminKey(): void {
  if (!ADMIN_KEY) {
    fail("DRILL_ADMIN_KEY environment variable is required");
  }
}
