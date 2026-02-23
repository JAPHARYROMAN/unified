/**
 * mpesa-full-loop.spec.ts
 *
 * Integration tests for the M-Pesa full-loop fiat adapter.
 *
 * Sections:
 *  A. Disbursement state machine — full happy path
 *  B. Repayment state machine — full happy path
 *  C. Security — duplicate webhook does not double-process
 *  D. Security — amount mismatch rejection
 *  E. Security — timestamp freshness rejection
 *  F. Security — nonce replay rejection
 *  G. Activation guard — loan never ACTIVE without disbursement proof
 *  H. Reconciliation — zero mismatches on clean data
 *  I. MpesaAdapter — timestamp parsing (Safaricom format + ISO)
 */

import { FiatDisbursementService } from "./fiat-disbursement.service";
import { FiatRepaymentService } from "./fiat-repayment.service";
import { FiatTransferService } from "./fiat-transfer.service";
import { WebhookNonceService } from "./webhook-nonce.service";
import { MpesaAdapter } from "./adapters/mpesa.adapter";
import { createHmac } from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTransferStore() {
  const store: Record<string, any> = {};
  let seq = 0;

  return {
    _store: store,
    create: jest.fn(async ({ data }: any) => {
      const id = `ft-${++seq}`;
      store[id] = { id, status: "PENDING", attempts: 0, ...data };
      return store[id];
    }),
    findUnique: jest.fn(async ({ where }: any) => {
      if (where.id) return store[where.id] ?? null;
      if (where.idempotencyKey) {
        return Object.values(store).find((r: any) => r.idempotencyKey === where.idempotencyKey) ?? null;
      }
      return null;
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: any) => {
      let r: any = null;
      if (where.id) r = store[where.id];
      if (!r && where.idempotencyKey) {
        r = Object.values(store).find((s: any) => s.idempotencyKey === where.idempotencyKey);
      }
      if (!r) throw new Error(`Not found: ${JSON.stringify(where)}`);
      return r;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: any) => {
      const matches = Object.values(store).filter((r: any) =>
        (!where.idempotencyKey || r.idempotencyKey === where.idempotencyKey) &&
        (!where.providerRef || r.providerRef === where.providerRef) &&
        (!where.loanId || r.loanId === where.loanId) &&
        (!where.direction || r.direction === where.direction),
      );
      if (matches.length === 0) return null;
      // Sort by createdAt desc if requested
      if (orderBy?.createdAt === "desc") {
        matches.sort((a: any, b: any) => b.createdAt - a.createdAt);
      }
      return matches[0];
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = store[where.id];
      if (!r) throw new Error(`Not found: ${where.id}`);
      Object.assign(r, data);
      return r;
    }),
  };
}

function makePrisma(transferStore: ReturnType<typeof makeTransferStore>) {
  const nonceStore = new Set<string>();
  return {
    fiatTransfer: transferStore,
    webhookNonce: {
      create: jest.fn(async ({ data }: any) => {
        if (nonceStore.has(data.nonce)) {
          const err: any = new Error("Unique constraint failed");
          err.code = "P2002";
          throw err;
        }
        nonceStore.add(data.nonce);
        return { id: "wn-1", ...data };
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
}

function makeChainActions() {
  const queued: Array<{ loanId: string; type: string; payload: any }> = [];
  return {
    _queued: queued,
    enqueue: jest.fn(async (loanId: string, type: string, payload: any) => {
      queued.push({ loanId, type, payload });
      return { id: `ca-${queued.length}`, loanId, type, status: "QUEUED" };
    }),
  } as any;
}

function makeFiatTransferService(prisma: any) {
  return new FiatTransferService(prisma);
}

// ── A. Disbursement state machine ─────────────────────────────────────────────

describe("A. Disbursement state machine — full happy path", () => {
  it("PENDING → PAYOUT_INITIATED → PAYOUT_CONFIRMED → CHAIN_RECORD_PENDING", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();

    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({
        providerRef: "MPESA-ABCD1234",
        status: "PENDING",
      }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    // Step 1: initiate payout
    const initiated = await svc.initiatePayout({
      loanId: "loan-1",
      loanContract: "0xCONTRACT",
      phoneNumber: "+254700000001",
      amountKes: 100_000n,
      idempotencyKey: "idem-disburse-1",
    });

    expect(initiated.status).toBe("PAYOUT_INITIATED");
    expect(initiated.providerRef).toBe("MPESA-ABCD1234");

    // Step 2: disbursement confirmed webhook
    const confirmed = await svc.handleDisbursementConfirmed(
      "MPESA-ABCD1234",
      "idem-disburse-1",
      { loanContract: "0xCONTRACT", TransactionID: "MPESA-ABCD1234" },
      100_000n,
      new Date(),
    );

    expect(confirmed.status).toBe("CHAIN_RECORD_PENDING");
    expect(confirmed.proofHash).toBeDefined();
    expect(confirmed.refHash).toBeDefined();

    // Chain actions enqueued: RECORD_DISBURSEMENT + ACTIVATE_LOAN
    expect(chainActions._queued).toHaveLength(2);
    expect(chainActions._queued[0].type).toBe("RECORD_DISBURSEMENT");
    expect(chainActions._queued[1].type).toBe("ACTIVATE_LOAN");
  });

  it("CHAIN_RECORD_PENDING → CHAIN_RECORDED on RECORD_DISBURSEMENT confirmed", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-X1", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-2", loanContract: "0xC2", phoneNumber: "+254700000002",
      amountKes: 50_000n, idempotencyKey: "idem-2",
    });

    await svc.handleDisbursementConfirmed("MPESA-X1", "idem-2", { loanContract: "0xC2" }, 50_000n, new Date());

    // Simulate RECORD_DISBURSEMENT confirmed on-chain
    await svc.onRecordDisbursementConfirmed("loan-2");

    const transfer = Object.values(store._store).find((r: any) => r.loanId === "loan-2") as any;
    expect(transfer.status).toBe("CHAIN_RECORDED");
  });

  it("CHAIN_RECORDED → ACTIVATED on ACTIVATE_LOAN confirmed", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-X2", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-3", loanContract: "0xC3", phoneNumber: "+254700000003",
      amountKes: 75_000n, idempotencyKey: "idem-3",
    });

    await svc.handleDisbursementConfirmed("MPESA-X2", "idem-3", { loanContract: "0xC3" }, 75_000n, new Date());
    await svc.onRecordDisbursementConfirmed("loan-3");
    await svc.onActivateLoanConfirmed("loan-3");

    const transfer = Object.values(store._store).find((r: any) => r.loanId === "loan-3") as any;
    expect(transfer.status).toBe("ACTIVATED");
    expect(transfer.appliedOnchainAt).toBeDefined();
  });
});

// ── B. Repayment state machine ────────────────────────────────────────────────

describe("B. Repayment state machine — full happy path", () => {
  it("PENDING → REPAYMENT_RECEIVED → CHAIN_REPAY_PENDING", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();

    const svc = new FiatRepaymentService(fiatTransfers, chainActions);

    const { transfer, duplicate } = await svc.handleRepayment({
      loanId: "loan-10",
      loanContract: "0xCONTRACT10",
      providerRef: "MPESA-REPAY-001",
      idempotencyKey: "idem-repay-1",
      amountKes: 50_000n,
      phoneNumber: "+254700000010",
      rawPayload: { TransactionID: "MPESA-REPAY-001", TransactionAmount: 500 },
    });

    expect(duplicate).toBe(false);
    expect(transfer.status).toBe("CHAIN_REPAY_PENDING");
    expect(transfer.proofHash).toBeDefined();
    expect(transfer.refHash).toBeDefined();

    // REPAY + RECORD_REPAYMENT enqueued
    expect(chainActions._queued).toHaveLength(2);
    expect(chainActions._queued[0].type).toBe("REPAY");
    expect(chainActions._queued[1].type).toBe("RECORD_REPAYMENT");
  });

  it("CHAIN_REPAY_PENDING → CHAIN_REPAY_CONFIRMED on REPAY confirmed", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();

    const svc = new FiatRepaymentService(fiatTransfers, chainActions);

    await svc.handleRepayment({
      loanId: "loan-11",
      loanContract: "0xCONTRACT11",
      providerRef: "MPESA-REPAY-002",
      idempotencyKey: "idem-repay-2",
      amountKes: 30_000n,
      phoneNumber: "+254700000011",
      rawPayload: { TransactionID: "MPESA-REPAY-002" },
    });

    await svc.onRepayConfirmed("loan-11");

    const transfer = Object.values(store._store).find((r: any) => r.loanId === "loan-11") as any;
    expect(transfer.status).toBe("CHAIN_REPAY_CONFIRMED");
    expect(transfer.appliedOnchainAt).toBeDefined();
  });
});

// ── C. Duplicate webhook does not double-process ──────────────────────────────

describe("C. Duplicate webhook does not double-process", () => {
  it("second repayment webhook with same idempotencyKey returns duplicate=true, no double-enqueue", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();

    const svc = new FiatRepaymentService(fiatTransfers, chainActions);

    const params = {
      loanId: "loan-20",
      loanContract: "0xC20",
      providerRef: "MPESA-DUP-001",
      idempotencyKey: "idem-dup-1",
      amountKes: 10_000n,
      phoneNumber: "+254700000020",
      rawPayload: { TransactionID: "MPESA-DUP-001" },
    };

    const first = await svc.handleRepayment(params);
    const second = await svc.handleRepayment(params);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    // Chain actions enqueued exactly once
    expect(chainActions._queued).toHaveLength(2);
  });

  it("second disbursement confirmation with same providerRef is skipped", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-DUP-D1", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-21", loanContract: "0xC21", phoneNumber: "+254700000021",
      amountKes: 20_000n, idempotencyKey: "idem-dup-d1",
    });

    await svc.handleDisbursementConfirmed("MPESA-DUP-D1", "idem-dup-d1", {}, 20_000n, new Date());
    const second = await svc.handleDisbursementConfirmed("MPESA-DUP-D1", "idem-dup-d1", {}, 20_000n, new Date());

    // Second call returns the existing record unchanged
    expect(second.status).toBe("CHAIN_RECORD_PENDING");
    // Chain actions enqueued only once (2 actions from first call)
    expect(chainActions._queued).toHaveLength(2);
  });
});

// ── D. Amount mismatch rejection ──────────────────────────────────────────────

describe("D. Amount mismatch rejection", () => {
  it("disbursement webhook with wrong amount throws BadRequestException", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-AMT-1", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-30", loanContract: "0xC30", phoneNumber: "+254700000030",
      amountKes: 100_000n, idempotencyKey: "idem-amt-1",
    });

    await expect(
      svc.handleDisbursementConfirmed(
        "MPESA-AMT-1",
        "idem-amt-1",
        {},
        99_999n, // wrong amount
        new Date(),
      ),
    ).rejects.toThrow("Amount mismatch");
  });

  it("repayment webhook with wrong amount throws BadRequestException", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();

    const svc = new FiatRepaymentService(fiatTransfers, chainActions);

    await expect(
      svc.handleRepayment({
        loanId: "loan-31",
        loanContract: "0xC31",
        providerRef: "MPESA-AMT-R1",
        idempotencyKey: "idem-amt-r1",
        amountKes: 50_000n,
        phoneNumber: "+254700000031",
        rawPayload: {},
        expectedAmountKes: 60_000n, // mismatch
      }),
    ).rejects.toThrow("Amount mismatch");
  });
});

// ── E. Timestamp freshness rejection ─────────────────────────────────────────

describe("E. Timestamp freshness — MpesaAdapter parsing", () => {
  it("parses Safaricom 14-digit timestamp format correctly", () => {
    const secret = "test-secret";
    const payload = {
      ResultCode: "0",
      TransactionID: "MPESA-TS-001",
      OriginatorConversationID: "idem-ts-1",
      TransactionAmount: 100,
      MSISDN: "+254700000040",
      TransactionDate: "20240115143022", // YYYYMMDDHHmmss
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("hex");

    const config = { get: jest.fn().mockReturnValue(secret) } as any;
    const adapter = new MpesaAdapter(config);

    const result = adapter.verifyWebhookSignature(rawBody, { "x-mpesa-signature": sig });

    expect(result.valid).toBe(true);
    expect(result.webhookTimestamp).toBeInstanceOf(Date);
    expect(result.webhookTimestamp!.getFullYear()).toBe(2024);
    expect(result.webhookTimestamp!.getMonth()).toBe(0); // January
    expect(result.webhookTimestamp!.getDate()).toBe(15);
  });

  it("parses ISO timestamp format correctly", () => {
    const secret = "test-secret";
    const payload = {
      ResultCode: "0",
      TransactionID: "MPESA-TS-002",
      OriginatorConversationID: "idem-ts-2",
      TransactionAmount: 200,
      MSISDN: "+254700000041",
      webhookTimestamp: "2024-06-15T10:30:00Z",
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("hex");

    const config = { get: jest.fn().mockReturnValue(secret) } as any;
    const adapter = new MpesaAdapter(config);

    const result = adapter.verifyWebhookSignature(rawBody, { "x-mpesa-signature": sig });

    expect(result.valid).toBe(true);
    expect(result.webhookTimestamp).toBeInstanceOf(Date);
    expect(result.webhookTimestamp!.getFullYear()).toBe(2024);
  });

  it("stale timestamp (>5 min) is surfaced — controller must reject it", () => {
    const secret = "test-secret";
    const staleDate = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const payload = {
      ResultCode: "0",
      TransactionID: "MPESA-TS-003",
      OriginatorConversationID: "idem-ts-3",
      TransactionAmount: 300,
      MSISDN: "+254700000042",
      webhookTimestamp: staleDate.toISOString(),
    };
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("hex");

    const config = { get: jest.fn().mockReturnValue(secret) } as any;
    const adapter = new MpesaAdapter(config);

    const result = adapter.verifyWebhookSignature(rawBody, { "x-mpesa-signature": sig });

    expect(result.valid).toBe(true);
    // Timestamp is surfaced — controller checks freshness
    const ageMs = Date.now() - result.webhookTimestamp!.getTime();
    expect(ageMs).toBeGreaterThan(5 * 60 * 1000);
  });
});

// ── F. Nonce replay rejection ─────────────────────────────────────────────────

describe("F. WebhookNonceService — replay rejection", () => {
  it("first claim returns true, second claim returns false", async () => {
    const prisma = makePrisma(makeTransferStore());
    const svc = new WebhookNonceService(prisma);

    const first = await svc.claim("nonce-abc-123", "mpesa");
    const second = await svc.claim("nonce-abc-123", "mpesa");

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("different nonces are both accepted", async () => {
    const prisma = makePrisma(makeTransferStore());
    const svc = new WebhookNonceService(prisma);

    expect(await svc.claim("nonce-1", "mpesa")).toBe(true);
    expect(await svc.claim("nonce-2", "mpesa")).toBe(true);
    expect(await svc.claim("nonce-3", "mpesa")).toBe(true);
  });
});

// ── G. Activation guard — loan never ACTIVE without disbursement proof ────────

describe("G. Activation guard — loan never ACTIVE without disbursement proof", () => {
  it("onActivateLoanConfirmed is a no-op when status is not CHAIN_RECORDED", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-GUARD-1", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-40", loanContract: "0xC40", phoneNumber: "+254700000040",
      amountKes: 10_000n, idempotencyKey: "idem-guard-1",
    });

    await svc.handleDisbursementConfirmed("MPESA-GUARD-1", "idem-guard-1", {}, 10_000n, new Date());
    // Status is CHAIN_RECORD_PENDING — NOT CHAIN_RECORDED yet

    // Attempt to activate before recording — should be a no-op (guard fires)
    await svc.onActivateLoanConfirmed("loan-40");

    const transfer = Object.values(store._store).find((r: any) => r.loanId === "loan-40") as any;
    // Must NOT be ACTIVATED
    expect(transfer.status).not.toBe("ACTIVATED");
    expect(transfer.status).toBe("CHAIN_RECORD_PENDING");
  });

  it("full sequence: only ACTIVATED after CHAIN_RECORDED", async () => {
    const store = makeTransferStore();
    const prisma = makePrisma(store);
    const fiatTransfers = makeFiatTransferService(prisma);
    const chainActions = makeChainActions();
    const mpesa = {
      initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-GUARD-2", status: "PENDING" }),
    } as any;

    const svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);

    await svc.initiatePayout({
      loanId: "loan-41", loanContract: "0xC41", phoneNumber: "+254700000041",
      amountKes: 20_000n, idempotencyKey: "idem-guard-2",
    });

    await svc.handleDisbursementConfirmed("MPESA-GUARD-2", "idem-guard-2", {}, 20_000n, new Date());
    await svc.onRecordDisbursementConfirmed("loan-41"); // → CHAIN_RECORDED
    await svc.onActivateLoanConfirmed("loan-41");       // → ACTIVATED

    const transfer = Object.values(store._store).find((r: any) => r.loanId === "loan-41") as any;
    expect(transfer.status).toBe("ACTIVATED");
  });
});

// ── H. Reconciliation — zero mismatches on clean data ────────────────────────

describe("H. Reconciliation — zero mismatches on clean data", () => {
  it("runDailyReconciliation returns criticalCount=0 when data is clean", async () => {
    const { OpsService } = await import("../ops/ops.service");

    const prisma = {
      fiatTransfer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      loan: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      chainAction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      webhookDeadLetter: {
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;

    const mockChainActions = {
      findDlq: jest.fn().mockResolvedValue([]),
      replayFromDlq: jest.fn(),
    } as any;

    const mockMetrics = { snapshot: jest.fn().mockReturnValue({}) } as any;

    const svc = new OpsService(prisma, mockChainActions, mockMetrics);
    const summary = await svc.runDailyReconciliation();

    expect(summary.criticalCount).toBe(0);
    expect(summary.reports).toHaveLength(3);
    expect(summary.reports.every((r: any) => r.count === 0)).toBe(true);
  });
});
