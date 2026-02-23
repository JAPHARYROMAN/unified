/**
 * production-sender.spec.ts
 *
 * Integration tests for the production chain sender infrastructure.
 *
 * Covers:
 *  A. NonceManager — no collision under concurrent load
 *  B. TxRetryClassifier — retry vs DLQ discrimination
 *  C. ChainActionService — markFailed routes correctly, replayFromDlq, gas ceiling
 *  D. ChainActionWorker — idempotency guard, nonce conflict metric, DLQ metric
 *  E. SignerNonceService — reconcile, commit, drift abort
 *  F. TxMetricsService — counter increments
 */

import { NonceManager } from "./nonce-manager";
import { classifyTxError, isNonceConflict } from "./tx-retry-classifier";
import { ChainActionService, GAS_CEILINGS } from "./chain-action.service";
import { ChainActionWorker } from "./chain-action.worker";
import { TxMetricsService } from "./tx-metrics.service";
import { SignerNonceService } from "./signer-nonce.service";
import { ChainActionStatus, ChainActionType } from "@prisma/client";

// ── A. NonceManager concurrency ───────────────────────────────────────────────

describe("A. NonceManager — no nonce collision under concurrent load", () => {
  function makeProvider(startNonce: number) {
    return {
      getTransactionCount: jest.fn().mockResolvedValue(startNonce),
    } as any;
  }

  it("serialises 20 concurrent sends — all nonces unique and sequential", async () => {
    const mgr = new NonceManager(makeProvider(10), "0xSIGNER");
    const nonces: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, () =>
        mgr.withNonce(async (n) => {
          nonces.push(n);
        }),
      ),
    );

    expect(nonces).toHaveLength(20);
    const sorted = [...nonces].sort((a, b) => a - b);
    // All unique
    expect(new Set(nonces).size).toBe(20);
    // Sequential from 10
    expect(sorted[0]).toBe(10);
    expect(sorted[19]).toBe(29);
  });

  it("rolls back nonce on send failure — next caller reuses the same nonce", async () => {
    const mgr = new NonceManager(makeProvider(5), "0xSIGNER");
    const nonces: number[] = [];

    // First call fails
    await expect(
      mgr.withNonce(async (_n) => {
        throw new Error("rpc down");
      }),
    ).rejects.toThrow("rpc down");

    // Second call should reuse nonce 5
    await mgr.withNonce(async (n) => {
      nonces.push(n);
    });

    expect(nonces[0]).toBe(5);
  });

  it("no collision when 50 concurrent sends race", async () => {
    const mgr = new NonceManager(makeProvider(0), "0xSIGNER");
    const nonces: number[] = [];

    await Promise.all(
      Array.from({ length: 50 }, () =>
        mgr.withNonce(async (n) => {
          // Simulate async work
          await new Promise((r) => setTimeout(r, Math.random() * 2));
          nonces.push(n);
        }),
      ),
    );

    expect(new Set(nonces).size).toBe(50);
  });
});

// ── B. TxRetryClassifier ──────────────────────────────────────────────────────

describe("B. TxRetryClassifier — retry vs DLQ discrimination", () => {
  it("nonce too low → RETRY", () => {
    expect(classifyTxError("nonce too low")).toBe("RETRY");
  });
  it("replacement underpriced → RETRY", () => {
    expect(classifyTxError("replacement transaction underpriced")).toBe("RETRY");
  });
  it("timeout → RETRY", () => {
    expect(classifyTxError("ETIMEDOUT: connection timed out")).toBe("RETRY");
  });
  it("execution reverted → DLQ (no retry)", () => {
    expect(classifyTxError("execution reverted: Unauthorized()")).toBe("DLQ");
  });
  it("out of gas → DLQ (no retry)", () => {
    expect(classifyTxError("out of gas")).toBe("DLQ");
  });
  it("unknown error → DLQ (fail-safe)", () => {
    expect(classifyTxError("some completely unknown error")).toBe("DLQ");
  });
  it("isNonceConflict correctly identifies nonce errors", () => {
    expect(isNonceConflict("nonce too low")).toBe(true);
    expect(isNonceConflict("execution reverted")).toBe(false);
  });
});

// ── C. ChainActionService ─────────────────────────────────────────────────────

describe("C. ChainActionService — retry discrimination + DLQ + gas ceiling", () => {
  function makePrisma() {
    const store: Record<string, any> = {};
    return {
      chainAction: {
        create: jest.fn(async ({ data }: any) => {
          const rec = { id: "action-1", attempts: 0, ...data };
          store[rec.id] = rec;
          return rec;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const existing = store[where.id] ?? { id: where.id, attempts: 0 };
          const updated = {
            ...existing,
            ...data,
            attempts:
              typeof data.attempts === "object" && data.attempts.increment
                ? (existing.attempts ?? 0) + data.attempts.increment
                : data.attempts ?? existing.attempts,
          };
          store[where.id] = updated;
          return updated;
        }),
        findUnique: jest.fn(async ({ where }: any) => store[where.id] ?? null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
  }

  it("logical revert → DLQ immediately (no retry)", async () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    // Seed an action
    await prisma.chainAction.create({ data: { id: "action-1", attempts: 0 } });

    const result = await svc.markFailed("action-1", "execution reverted: Unauthorized()");
    expect(result.status).toBe(ChainActionStatus.DLQ);
  });

  it("nonce too low → RETRY with backoff", async () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    await prisma.chainAction.create({ data: { id: "action-1", attempts: 0 } });

    const result = await svc.markFailed("action-1", "nonce too low");
    expect(result.status).toBe(ChainActionStatus.QUEUED);
    expect(result.nextRetryAt).toBeDefined();
  });

  it("exceeding MAX_RETRIES on transient error → DLQ", async () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    await prisma.chainAction.create({ data: { id: "action-1", attempts: 4 } });

    const result = await svc.markFailed("action-1", "nonce too low");
    expect(result.status).toBe(ChainActionStatus.DLQ);
  });

  it("replayFromDlq moves DLQ action back to QUEUED with audit trail", async () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    await prisma.chainAction.create({
      data: { id: "action-1", status: ChainActionStatus.DLQ, attempts: 3 },
    });

    const result = await svc.replayFromDlq("action-1", "admin@unified.finance");
    expect(result.status).toBe(ChainActionStatus.QUEUED);
    expect(result.attempts).toBe(0);
    expect(result.error).toContain("admin@unified.finance");
  });

  it("replayFromDlq rejects non-DLQ action", async () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    await prisma.chainAction.create({
      data: { id: "action-1", status: ChainActionStatus.MINED },
    });

    await expect(svc.replayFromDlq("action-1", "admin")).rejects.toThrow(
      "not in DLQ",
    );
  });

  it("gas ceiling check returns ceiling when exceeded", () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    const ceiling = svc.checkGasCeiling(
      ChainActionType.CREATE_LOAN,
      GAS_CEILINGS.CREATE_LOAN! + 1n,
    );
    expect(ceiling).toBe(GAS_CEILINGS.CREATE_LOAN);
  });

  it("gas ceiling check returns null when within limit", () => {
    const prisma = makePrisma();
    const svc = new ChainActionService(prisma);

    const ceiling = svc.checkGasCeiling(
      ChainActionType.CREATE_LOAN,
      GAS_CEILINGS.CREATE_LOAN! - 1n,
    );
    expect(ceiling).toBeNull();
  });
});

// ── D. ChainActionWorker — idempotency + metrics ──────────────────────────────

describe("D. ChainActionWorker — idempotency guard + nonce conflict metric + DLQ metric", () => {
  function makeAction(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "action-1",
      loanId: "loan-1",
      type: ChainActionType.CREATE_LOAN,
      status: ChainActionStatus.QUEUED,
      payload: { borrower: "0xBORROWER" },
      txHash: null,
      nonce: null,
      bumpCount: 0,
      sentAt: null,
      attempts: 0,
      nextRetryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      loan: { id: "loan-1", loanContract: null, status: "CREATED" },
      ...overrides,
    } as any;
  }

  function makeServices() {
    const chainActions = {
      findQueued: jest.fn().mockResolvedValue([makeAction()]),
      markProcessing: jest.fn().mockResolvedValue({}),
      markSent: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({ status: ChainActionStatus.QUEUED }),
      findSent: jest.fn().mockResolvedValue([]),
      findStuck: jest.fn().mockResolvedValue([]),
      resetStuckProcessing: jest.fn().mockResolvedValue({ count: 0 }),
      isNonceConflict: jest.fn().mockReturnValue(false),
    } as any;

    const loans = {
      transitionToFunding: jest.fn(),
    } as any;

    const metrics = new TxMetricsService();
    const signerNonce = {
      commit: jest.fn().mockResolvedValue(undefined),
    } as any;

    return { chainActions, loans, metrics, signerNonce };
  }

  it("idempotency: action with existing txHash is skipped (not re-sent)", async () => {
    const { chainActions, loans, metrics, signerNonce } = makeServices();
    chainActions.findQueued.mockResolvedValue([
      makeAction({ txHash: "0xEXISTING" }),
    ]);

    const worker = new ChainActionWorker(chainActions, loans, metrics, signerNonce);
    const sender = {
      sendAction: jest.fn(),
      getReceipt: jest.fn(),
      bumpAndReplace: jest.fn(),
      isHealthy: jest.fn(),
    } as any;
    worker.setSender(sender);

    await worker.processBatch();

    expect(sender.sendAction).not.toHaveBeenCalled();
    expect(chainActions.markSent).toHaveBeenCalledWith("action-1", "0xEXISTING", 0);
  });

  it("nonce conflict increments nonce_conflict_total metric", async () => {
    const { chainActions, loans, metrics, signerNonce } = makeServices();
    chainActions.isNonceConflict.mockReturnValue(true);
    chainActions.markFailed.mockResolvedValue({ status: ChainActionStatus.QUEUED });

    const worker = new ChainActionWorker(chainActions, loans, metrics, signerNonce);
    const sender = {
      sendAction: jest.fn().mockRejectedValue(new Error("nonce too low")),
      getReceipt: jest.fn(),
      bumpAndReplace: jest.fn(),
      isHealthy: jest.fn(),
    } as any;
    worker.setSender(sender);

    await worker.processBatch();

    expect(metrics.snapshot().nonce_conflict_total).toBe(1);
    expect(metrics.snapshot().tx_failed_total).toBe(1);
  });

  it("logical revert increments tx_dlq_total metric", async () => {
    const { chainActions, loans, metrics, signerNonce } = makeServices();
    chainActions.isNonceConflict.mockReturnValue(false);
    chainActions.markFailed.mockResolvedValue({ status: ChainActionStatus.DLQ });

    const worker = new ChainActionWorker(chainActions, loans, metrics, signerNonce);
    const sender = {
      sendAction: jest.fn().mockRejectedValue(new Error("execution reverted")),
      getReceipt: jest.fn(),
      bumpAndReplace: jest.fn(),
      isHealthy: jest.fn(),
    } as any;
    worker.setSender(sender);

    await worker.processBatch();

    expect(metrics.snapshot().tx_dlq_total).toBe(1);
  });

  it("successful send increments tx_submitted_total", async () => {
    const { chainActions, loans, metrics, signerNonce } = makeServices();

    const worker = new ChainActionWorker(chainActions, loans, metrics, signerNonce);
    const sender = {
      sendAction: jest.fn().mockResolvedValue({ txHash: "0xNEW", nonce: 42 }),
      getReceipt: jest.fn(),
      bumpAndReplace: jest.fn(),
      isHealthy: jest.fn(),
    } as any;
    worker.setSender(sender);

    await worker.processBatch();

    expect(metrics.snapshot().tx_submitted_total).toBe(1);
    expect(chainActions.markSent).toHaveBeenCalledWith("action-1", "0xNEW", 42);
  });

  it("duplicate webhook: same action enqueued twice — second is skipped by idempotency key", async () => {
    const { chainActions, loans, metrics, signerNonce } = makeServices();

    // Simulate: first call returns action, second returns empty (already processed)
    chainActions.findQueued
      .mockResolvedValueOnce([makeAction()])
      .mockResolvedValueOnce([]);

    const worker = new ChainActionWorker(chainActions, loans, metrics, signerNonce);
    const sender = {
      sendAction: jest.fn().mockResolvedValue({ txHash: "0xTX1", nonce: 1 }),
      getReceipt: jest.fn(),
      bumpAndReplace: jest.fn(),
      isHealthy: jest.fn(),
    } as any;
    worker.setSender(sender);

    await worker.processBatch();
    await worker.processBatch();

    // sendAction called exactly once — second batch was empty
    expect(sender.sendAction).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().tx_submitted_total).toBe(1);
  });
});

// ── E. SignerNonceService ─────────────────────────────────────────────────────

describe("E. SignerNonceService — reconcile + commit + drift abort", () => {
  function makePrisma(dbNonce: number | null) {
    const store: Record<string, any> = {};
    if (dbNonce !== null) {
      store["0xSIGNER"] = { signerAddress: "0xSIGNER", chainId: 137, nonce: dbNonce };
    }
    return {
      signerNonce: {
        findUnique: jest.fn(async ({ where }: any) => store[where.signerAddress] ?? null),
        create: jest.fn(async ({ data }: any) => {
          store[data.signerAddress] = data;
          return data;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          store[where.signerAddress] = { ...store[where.signerAddress], ...data };
          return store[where.signerAddress];
        }),
        upsert: jest.fn(async ({ where, update, create }: any) => {
          if (store[where.signerAddress]) {
            store[where.signerAddress] = { ...store[where.signerAddress], ...update };
          } else {
            store[where.signerAddress] = { signerAddress: where.signerAddress, ...create };
          }
          return store[where.signerAddress];
        }),
      },
    } as any;
  }

  function makeProvider(rpcNonce: number) {
    return {
      getTransactionCount: jest.fn().mockResolvedValue(rpcNonce),
    } as any;
  }

  it("seeds from RPC when no DB record exists", async () => {
    const prisma = makePrisma(null);
    const svc = new SignerNonceService(prisma, {} as any);

    const nonce = await svc.reconcile(makeProvider(7), "0xSIGNER", 137);
    expect(nonce).toBe(7);
    expect(prisma.signerNonce.create).toHaveBeenCalled();
  });

  it("adopts RPC nonce when RPC > DB (forward drift)", async () => {
    const prisma = makePrisma(5);
    const svc = new SignerNonceService(prisma, {} as any);

    const nonce = await svc.reconcile(makeProvider(7), "0xSIGNER", 137);
    expect(nonce).toBe(7);
  });

  it("keeps DB nonce when DB > RPC (pending txns)", async () => {
    const prisma = makePrisma(10);
    const svc = new SignerNonceService(prisma, {} as any);

    const nonce = await svc.reconcile(makeProvider(8), "0xSIGNER", 137);
    expect(nonce).toBe(10);
  });

  it("aborts startup when drift > threshold", async () => {
    const prisma = makePrisma(0);
    const svc = new SignerNonceService(prisma, {} as any);

    await expect(
      svc.reconcile(makeProvider(100), "0xSIGNER", 137),
    ).rejects.toThrow(/ABORT.*drift/i);
  });

  it("commit persists nonce+1 to DB", async () => {
    const prisma = makePrisma(5);
    const svc = new SignerNonceService(prisma, {} as any);

    await svc.commit("0xSIGNER", 5);
    expect(prisma.signerNonce.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { nonce: 6 },
      }),
    );
  });
});

// ── F. TxMetricsService ───────────────────────────────────────────────────────

describe("F. TxMetricsService — counter increments", () => {
  it("all counters start at zero", () => {
    const m = new TxMetricsService();
    const s = m.snapshot();
    expect(s.tx_submitted_total).toBe(0);
    expect(s.tx_confirmed_total).toBe(0);
    expect(s.tx_failed_total).toBe(0);
    expect(s.tx_dlq_total).toBe(0);
    expect(s.nonce_conflict_total).toBe(0);
    expect(s.rbf_bump_total).toBe(0);
  });

  it("increments each counter independently", () => {
    const m = new TxMetricsService();
    m.incSubmitted();
    m.incSubmitted();
    m.incConfirmed();
    m.incFailed();
    m.incFailed();
    m.incFailed();
    m.incDlq();
    m.incNonceConflict();
    m.incNonceConflict();
    m.incRbfBump();

    const s = m.snapshot();
    expect(s.tx_submitted_total).toBe(2);
    expect(s.tx_confirmed_total).toBe(1);
    expect(s.tx_failed_total).toBe(3);
    expect(s.tx_dlq_total).toBe(1);
    expect(s.nonce_conflict_total).toBe(2);
    expect(s.rbf_bump_total).toBe(1);
  });
});
