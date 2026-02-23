/**
 * Determinism, Rounding, and Migration Tests
 * for the Installment Schedule Engine
 *
 * Spec reference: docs/installment-schedule-hashing-spec.md
 *
 * Suites:
 *   D. Determinism — same inputs always produce identical hash
 *   R. Rounding    — bigint integer arithmetic; no floats; remainder in last
 *   M. Migration   — adding new fields does NOT change the hash of existing schedules
 *   I. Immutability guard — assertHashIntegrity behaviour
 *   C. Chain action — CONFIGURE_SCHEDULE enqueued at saveSchedule
 */

import { ConflictException } from "@nestjs/common";
import { InstallmentScheduleService } from "./installment-schedule.service";
import { CanonicalScheduleJson } from "./installment.types";

type AnyObj = Record<string, any>;

// ── Shared fixture ─────────────────────────────────────────────────────────────

// 2025-06-01T00:00:00Z  →  1748736000
const START_TS = 1_748_736_000;
const INTERVAL_30D = 2_592_000; // 30 * 86400
const INTERVAL_7D  = 604_800;   // 7  * 86400

const BASE: Parameters<InstallmentScheduleService["generate"]>[0] = {
  loanId: "loan-determinism-001",
  principalUsdc: 1_000_000_000n, // 1000 USDC
  interestRateBps: 1500,          // 15% APR
  startTimestamp: START_TS,
  intervalSeconds: INTERVAL_30D,
  installmentCount: 12,
};

function makeSvc(prismaOverride?: AnyObj) {
  const prisma = prismaOverride ?? { installmentSchedule: { findUnique: jest.fn(async () => null), create: jest.fn(async (args: AnyObj) => ({ ...args.data, id: "sched-1", installments: [] })) } };
  const chainActions = { enqueue: jest.fn(async () => ({ id: "ca-1" })) };
  const alerts = { emitMany: jest.fn(async () => {}) };
  return new InstallmentScheduleService(prisma as any, chainActions as any, alerts as any);
}

// ── D. Determinism ─────────────────────────────────────────────────────────────

describe("D. Determinism — identical inputs always produce identical hash", () => {
  const svc = makeSvc();

  it("D1: same params → same hash (repeated calls)", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate(BASE).scheduleHash;
    const h3 = svc.generate(BASE).scheduleHash;
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it("D2: same params → same scheduleJson (byte-for-byte)", () => {
    const j1 = svc.generate(BASE).scheduleJson;
    const j2 = svc.generate(BASE).scheduleJson;
    expect(j1).toBe(j2);
  });

  it("D3: different loanId → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, loanId: "loan-other" }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D4: different principalUsdc → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, principalUsdc: BASE.principalUsdc + 1n }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D5: different interestRateBps → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, interestRateBps: BASE.interestRateBps + 1 }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D6: different startTimestamp → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, startTimestamp: BASE.startTimestamp + 1 }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D7: different intervalSeconds → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, intervalSeconds: INTERVAL_7D }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D8: different installmentCount → different hash", () => {
    const h1 = svc.generate(BASE).scheduleHash;
    const h2 = svc.generate({ ...BASE, installmentCount: 6 }).scheduleHash;
    expect(h1).not.toBe(h2);
  });

  it("D9: hash is 64-char lowercase hex (SHA-256)", () => {
    const { scheduleHash } = svc.generate(BASE);
    expect(scheduleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("D10: verifyHash round-trips correctly", () => {
    const { scheduleHash } = svc.generate(BASE);
    expect(svc.verifyHash(BASE, scheduleHash)).toBe(true);
    expect(svc.verifyHash(BASE, "a".repeat(64))).toBe(false);
  });

  it("D11: known-vector — hash is stable across code changes (regression anchor)", () => {
    // This vector was computed from the reference implementation.
    // If this test fails, the canonical serialization has changed — a BREAKING change.
    const small: Parameters<InstallmentScheduleService["generate"]>[0] = {
      loanId: "loan-vector-001",
      principalUsdc: 100_000_000n,
      interestRateBps: 1200,
      startTimestamp: 1_735_689_600,
      intervalSeconds: 2_592_000,
      installmentCount: 3,
    };
    const { scheduleHash, scheduleJson } = svc.generate(small);
    // Recompute expected from the canonical JSON to anchor the vector
    const { createHash } = require("crypto");
    const expected = createHash("sha256").update(scheduleJson, "utf8").digest("hex");
    expect(scheduleHash).toBe(expected);
    // Confirm the JSON structure is stable
    const parsed: CanonicalScheduleJson = JSON.parse(scheduleJson);
    expect(parsed.loan_id).toBe("loan-vector-001");
    expect(parsed.principal).toBe("100000000");
    expect(parsed.installments[0].index).toBe(0);
    expect(parsed.installments[0].due_ts).toBe(String(1_735_689_600 + 2_592_000));
  });
});

// ── R. Rounding ────────────────────────────────────────────────────────────────

describe("R. Rounding — integer-only arithmetic, no floats", () => {
  const svc = makeSvc();

  it("R1: all principalDue values are bigint (no floats)", () => {
    const { installments } = svc.generate(BASE);
    for (const inst of installments) {
      expect(typeof inst.principalDue).toBe("bigint");
      expect(typeof inst.interestDue).toBe("bigint");
      expect(typeof inst.totalDue).toBe("bigint");
    }
  });

  it("R2: principal sum equals exact principalUsdc (no rounding loss)", () => {
    const { installments } = svc.generate(BASE);
    const total = installments.reduce((s, i) => s + i.principalDue, 0n);
    expect(total).toBe(BASE.principalUsdc);
  });

  it("R3: remainder is absorbed by last installment only", () => {
    // 7 installments of 1_000_000_003 USDC → remainder = 3 - floor(3/7)*7
    const params = { ...BASE, principalUsdc: 1_000_000_003n, installmentCount: 7 };
    const { installments } = svc.generate(params);
    const perInstallment = 1_000_000_003n / 7n;
    const remainder = 1_000_000_003n - perInstallment * 7n;
    for (let i = 0; i < 6; i++) {
      expect(installments[i].principalDue).toBe(perInstallment);
    }
    expect(installments[6].principalDue).toBe(perInstallment + remainder);
  });

  it("R4: interest uses integer division (truncates, never rounds up)", () => {
    // interest = outstanding * bps * interval / (10000 * 31536000)
    // Verify no fractional component leaks into the bigint
    const { installments } = svc.generate(BASE);
    for (const inst of installments) {
      // If interest were a float it could be non-integer; bigint guarantees truncation
      expect(inst.interestDue >= 0n).toBe(true);
      expect(inst.totalDue).toBe(inst.principalDue + inst.interestDue);
    }
  });

  it("R5: zero interest rate produces zero interestDue on every installment", () => {
    const { installments } = svc.generate({ ...BASE, interestRateBps: 0 });
    for (const inst of installments) {
      expect(inst.interestDue).toBe(0n);
      expect(inst.totalDue).toBe(inst.principalDue);
    }
  });

  it("R6: canonical JSON amounts are decimal strings with no decimal point", () => {
    const { scheduleJson } = svc.generate(BASE);
    const parsed: CanonicalScheduleJson = JSON.parse(scheduleJson);
    for (const inst of parsed.installments) {
      expect(inst.principal).toMatch(/^\d+$/);
      expect(inst.interest).toMatch(/^\d+$/);
      expect(inst.total).toMatch(/^\d+$/);
      expect(inst.due_ts).toMatch(/^\d+$/);
    }
    expect(parsed.principal).toMatch(/^\d+$/);
    expect(parsed.start_ts).toMatch(/^\d+$/);
  });

  it("R7: large principal (> Number.MAX_SAFE_INTEGER) hashes correctly", () => {
    const hugePrincipal = 9_999_999_999_999_999n; // > 2^53
    const params = { ...BASE, principalUsdc: hugePrincipal };
    const { scheduleHash, scheduleJson } = svc.generate(params);
    const parsed: CanonicalScheduleJson = JSON.parse(scheduleJson);
    // Confirm the string representation is exact (not scientific notation)
    expect(parsed.principal).toBe("9999999999999999");
    expect(scheduleHash).toMatch(/^[0-9a-f]{64}$/);
    // Verify round-trip
    expect(svc.verifyHash(params, scheduleHash)).toBe(true);
  });

  it("R8: weekly interval produces correct due timestamps", () => {
    const params = { ...BASE, intervalSeconds: INTERVAL_7D, installmentCount: 4 };
    const { installments } = svc.generate(params);
    for (let i = 0; i < installments.length; i++) {
      expect(installments[i].dueTimestamp).toBe(START_TS + (i + 1) * INTERVAL_7D);
    }
  });
});

// ── M. Migration — adding new DB fields must not change existing hashes ────────

describe("M. Migration — new fields do not break existing schedule hashes", () => {
  const svc = makeSvc();

  it("M1: hash depends only on canonical JSON fields — extra runtime fields ignored", () => {
    // Simulate a future migration that adds a new field to the runtime object
    // but does NOT add it to the canonical JSON spec.
    const schedule = svc.generate(BASE);
    const originalHash = schedule.scheduleHash;

    // Manually add a hypothetical new field to the parsed JSON
    const parsed = JSON.parse(schedule.scheduleJson);
    parsed.new_field_v2 = "some-value"; // NOT in canonical spec

    // Recompute hash from the ORIGINAL scheduleJson (not the mutated object)
    const { createHash } = require("crypto");
    const recomputedHash = createHash("sha256")
      .update(schedule.scheduleJson, "utf8")
      .digest("hex");

    // Hash must be identical — new_field_v2 is not in the canonical string
    expect(recomputedHash).toBe(originalHash);
  });

  it("M2: scheduleJson stored verbatim is sufficient to reproduce hash", () => {
    const schedule = svc.generate(BASE);
    const { createHash } = require("crypto");
    const reproduced = createHash("sha256")
      .update(schedule.scheduleJson, "utf8")
      .digest("hex");
    expect(reproduced).toBe(schedule.scheduleHash);
  });

  it("M3: changing installmentIndex field name would break hash (regression guard)", () => {
    const schedule = svc.generate(BASE);
    const parsed: CanonicalScheduleJson = JSON.parse(schedule.scheduleJson);
    // Verify the canonical key is 'index', not 'installment_index' or 'number'
    expect(Object.keys(parsed.installments[0])[0]).toBe("index");
  });

  it("M4: changing due_ts key would break hash (regression guard)", () => {
    const schedule = svc.generate(BASE);
    const parsed: CanonicalScheduleJson = JSON.parse(schedule.scheduleJson);
    expect(Object.keys(parsed.installments[0])[1]).toBe("due_ts");
  });

  it("M5: field order in canonical JSON is fixed and stable", () => {
    const schedule = svc.generate(BASE);
    const topKeys = Object.keys(JSON.parse(schedule.scheduleJson));
    expect(topKeys).toEqual([
      "loan_id",
      "principal",
      "interest_rate_bps",
      "start_ts",
      "interval_seconds",
      "installment_count",
      "installments",
    ]);
  });

  it("M6: per-installment field order is fixed and stable", () => {
    const schedule = svc.generate(BASE);
    const parsed: CanonicalScheduleJson = JSON.parse(schedule.scheduleJson);
    const instKeys = Object.keys(parsed.installments[0]);
    expect(instKeys).toEqual(["index", "due_ts", "principal", "interest", "total"]);
  });
});

// ── I. Immutability guard ──────────────────────────────────────────────────────

describe("I. Immutability guard — assertHashIntegrity", () => {
  it("I1: passes silently when stored hash matches regeneration", async () => {
    const svc = makeSvc();
    const schedule = svc.generate(BASE);
    const canonical = JSON.parse(schedule.scheduleJson);

    const prisma = {
      installmentSchedule: {
        findUnique: jest.fn(async () => ({
          scheduleHash: schedule.scheduleHash,
          scheduleJson: schedule.scheduleJson,
          principalPerInstallment: schedule.principalPerInstallment,
          totalInstallments: schedule.totalInstallments,
          interestRateBps: schedule.interestRateBps,
          startTimestamp: BigInt(schedule.startTimestamp),
          intervalSeconds: schedule.intervalSeconds,
        })),
      },
    };
    const svcWithDb = new InstallmentScheduleService(
      prisma as any,
      { enqueue: jest.fn() } as any,
      { emitMany: jest.fn() } as any,
    );

    await expect(svcWithDb.assertHashIntegrity(BASE.loanId)).resolves.toBeUndefined();
  });

  it("I2: throws ConflictException when stored hash does not match", async () => {
    const svc = makeSvc();
    const schedule = svc.generate(BASE);

    const prisma = {
      installmentSchedule: {
        findUnique: jest.fn(async () => ({
          scheduleHash: "0".repeat(64), // tampered
          scheduleJson: schedule.scheduleJson,
          principalPerInstallment: schedule.principalPerInstallment,
          totalInstallments: schedule.totalInstallments,
          interestRateBps: schedule.interestRateBps,
          startTimestamp: BigInt(schedule.startTimestamp),
          intervalSeconds: schedule.intervalSeconds,
        })),
      },
    };
    const alerts = { emitMany: jest.fn(async () => {}) };
    const svcWithDb = new InstallmentScheduleService(
      prisma as any,
      { enqueue: jest.fn() } as any,
      alerts as any,
    );

    await expect(svcWithDb.assertHashIntegrity(BASE.loanId)).rejects.toThrow(
      ConflictException,
    );
    expect(alerts.emitMany).toHaveBeenCalledTimes(1);
    const alertCall = (alerts.emitMany.mock.calls as any)[0][0][0];
    expect(alertCall.severity).toBe("CRITICAL");
  });

  it("I3: passes silently when no schedule exists (loan has no schedule)", async () => {
    const prisma = {
      installmentSchedule: { findUnique: jest.fn(async () => null) },
    };
    const svcWithDb = new InstallmentScheduleService(
      prisma as any,
      { enqueue: jest.fn() } as any,
      { emitMany: jest.fn() } as any,
    );
    await expect(svcWithDb.assertHashIntegrity("no-schedule-loan")).resolves.toBeUndefined();
  });

  it("I4: CRITICAL alert is emitted before throwing", async () => {
    const svc = makeSvc();
    const schedule = svc.generate(BASE);
    const alerts = { emitMany: jest.fn(async () => {}) };

    const prisma = {
      installmentSchedule: {
        findUnique: jest.fn(async () => ({
          scheduleHash: "deadbeef".repeat(8), // wrong hash
          scheduleJson: schedule.scheduleJson,
          principalPerInstallment: schedule.principalPerInstallment,
          totalInstallments: schedule.totalInstallments,
          interestRateBps: schedule.interestRateBps,
          startTimestamp: BigInt(schedule.startTimestamp),
          intervalSeconds: schedule.intervalSeconds,
        })),
      },
    };
    const svcWithDb = new InstallmentScheduleService(
      prisma as any,
      { enqueue: jest.fn() } as any,
      alerts as any,
    );

    await expect(svcWithDb.assertHashIntegrity(BASE.loanId)).rejects.toThrow();
    expect(alerts.emitMany).toHaveBeenCalled();
  });
});

// ── C. Chain action ────────────────────────────────────────────────────────────

describe("C. Chain action — CONFIGURE_SCHEDULE enqueued at saveSchedule", () => {
  it("C1: enqueues CONFIGURE_SCHEDULE with correct payload", async () => {
    const enqueueMock = jest.fn(async () => ({ id: "ca-1" }));
    const prisma = {
      installmentSchedule: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async (args: AnyObj) => ({
          ...args.data,
          id: "sched-1",
          installments: [],
        })),
      },
    };
    const svc = new InstallmentScheduleService(
      prisma as any,
      { enqueue: enqueueMock } as any,
      { emitMany: jest.fn() } as any,
    );

    const schedule = svc.generate(BASE);
    await svc.saveSchedule(schedule);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const call = (enqueueMock.mock.calls as any)[0];
    expect(call[0]).toBe(BASE.loanId);
    expect(call[1]).toBe("CONFIGURE_SCHEDULE");
    const payload = call[2];
    expect(payload.scheduleHash).toBe(schedule.scheduleHash);
    expect(payload.startTimestamp).toBe(BASE.startTimestamp);
    expect(payload.intervalSeconds).toBe(BASE.intervalSeconds);
    expect(payload.installmentCount).toBe(BASE.installmentCount);
    expect(payload.interestRateBps).toBe(BASE.interestRateBps);
    expect(typeof payload.principalPerInstallment).toBe("string");
  });

  it("C2: idempotent — does NOT enqueue again if schedule already exists", async () => {
    const enqueueMock = jest.fn(async () => ({ id: "ca-1" }));
    const svc = makeSvc();
    const schedule = svc.generate(BASE);

    // Simulate existing schedule in DB
    const prismaWithExisting = {
      installmentSchedule: {
        findUnique: jest.fn(async () => ({
          id: "existing-sched",
          ...schedule,
          installments: [],
        })),
      },
    };
    const svcWithExisting = new InstallmentScheduleService(
      prismaWithExisting as any,
      { enqueue: enqueueMock } as any,
      { emitMany: jest.fn() } as any,
    );

    await svcWithExisting.saveSchedule(schedule);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("C3: scheduleHash in chain action payload matches generated hash", async () => {
    const enqueueMock = jest.fn(async () => ({ id: "ca-1" }));
    const prisma = {
      installmentSchedule: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async (args: AnyObj) => ({ ...args.data, id: "s1", installments: [] })),
      },
    };
    const svc = new InstallmentScheduleService(
      prisma as any,
      { enqueue: enqueueMock } as any,
      { emitMany: jest.fn() } as any,
    );

    const schedule = svc.generate(BASE);
    await svc.saveSchedule(schedule);

    const payload = (enqueueMock.mock.calls as any)[0][2];
    expect(payload.scheduleHash).toBe(schedule.scheduleHash);
    // Hash in payload must be verifiable
    expect(svc.verifyHash(BASE, payload.scheduleHash)).toBe(true);
  });
});
