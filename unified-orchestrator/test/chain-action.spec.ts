/**
 * chain-action.spec.ts
 *
 * Unit + stress tests for the production chain action sender.
 *
 * Sections:
 *  A. NonceManager — sequential + concurrent correctness (stress test)
 *  B. GasStrategy  — fee estimation and RBF bump
 *  C. ChainActionWorker — sender loop, receipt loop, stuck-tx / RBF, pause
 *  D. ChainActionService — markFailed backoff, atomic increment, requeueAction
 */

import { Test, TestingModule } from "@nestjs/testing";
import {
  ChainActionWorker,
  IChainSender,
} from "../src/modules/chain-action/chain-action.worker";
import { ChainActionService } from "../src/modules/chain-action/chain-action.service";
import { LoanService } from "../src/modules/loan/loan.service";
import { NonceManager } from "../src/modules/chain-action/nonce-manager";
import { GasStrategy } from "../src/modules/chain-action/gas-strategy";
import type { ChainReceipt } from "../src/modules/chain-action/chain-sender.types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockQueuedAction(overrides?: Partial<ReturnType<typeof mockQueuedAction>>) {
  return {
    id: crypto.randomUUID(),
    loanId: crypto.randomUUID(),
    actionKey: null,
    type: "CREATE_LOAN" as const,
    status: "QUEUED" as const,
    payload: {
      borrower: "0xBorrower",
      principal: "1000000",
      pool: "0xPool",
      collateralToken: "0xCollateral",
      collateralAmount: "500000",
      interestRateBps: 500,
      duration: 86400,
    },
    txHash: null,
    nonce: null,
    bumpCount: 0,
    blockNumber: null,
    gasUsed: null,
    revertReason: null,
    error: null,
    attempts: 0,
    nextRetryAt: null,
    sentAt: null,
    minedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    loan: { id: "loan-1" },
    ...overrides,
  };
}

function mockSentAction(overrides?: object) {
  return mockQueuedAction({
    status: "SENT" as const,
    txHash: "0xTxHash1",
    nonce: 42,
    sentAt: new Date(Date.now() - 10_000), // 10 s ago
    ...overrides,
  });
}

function makeMockSender(overrides?: Partial<IChainSender>): IChainSender {
  return {
    sendAction: jest.fn().mockResolvedValue({ txHash: "0xTx", nonce: 0 }),
    bumpAndReplace: jest.fn().mockResolvedValue({ txHash: "0xBumpedTx" }),
    getReceipt: jest.fn().mockResolvedValue(null),
    isHealthy: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ─── A. NonceManager ──────────────────────────────────────────────────────────

describe("A. NonceManager", () => {
  function makeProvider(startNonce = 10) {
    return {
      getTransactionCount: jest.fn().mockResolvedValue(startNonce),
    };
  }

  it("A1: initialises nonce from chain on first call", async () => {
    const provider = makeProvider(5);
    const mgr = new NonceManager(provider as any, "0xAddr");

    let receivedNonce = -1;
    await mgr.withNonce(async (n) => { receivedNonce = n; });

    expect(receivedNonce).toBe(5);
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("A2: fetches nonce from chain exactly once across sequential sends", async () => {
    const provider = makeProvider(20);
    const mgr = new NonceManager(provider as any, "0xAddr");
    const nonces: number[] = [];

    for (let i = 0; i < 5; i++) {
      await mgr.withNonce(async (n) => { nonces.push(n); });
    }

    expect(nonces).toEqual([20, 21, 22, 23, 24]);
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("A3 (STRESS): 100 concurrent sends produce unique sequential nonces — no collisions", async () => {
    const START = 42;
    const COUNT = 100;
    const provider = makeProvider(START);
    const mgr = new NonceManager(provider as any, "0xAddr");

    const nonces: number[] = [];

    // All 100 calls issued simultaneously; mutex must serialise them.
    const tasks = Array.from({ length: COUNT }, () =>
      mgr.withNonce(async (n) => {
        // Simulate variable network latency to stress the ordering.
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        nonces.push(n);
      }),
    );

    await Promise.all(tasks);

    expect(nonces).toHaveLength(COUNT);
    // No duplicates
    expect(new Set(nonces).size).toBe(COUNT);
    // All values fall in the expected range [START, START+COUNT)
    const sorted = [...nonces].sort((a, b) => a - b);
    expect(sorted[0]).toBe(START);
    expect(sorted[COUNT - 1]).toBe(START + COUNT - 1);
    // Provider fetched exactly once
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1);
  });

  it("A4: rolls back nonce when sendFn throws (no double-spend)", async () => {
    const provider = makeProvider(10);
    const mgr = new NonceManager(provider as any, "0xAddr");
    const nonces: number[] = [];

    // First send fails — nonce should roll back to 10
    await expect(
      mgr.withNonce(async (_n) => { throw new Error("rpc timeout"); }),
    ).rejects.toThrow("rpc timeout");

    // Second send should reuse nonce 10
    await mgr.withNonce(async (n) => { nonces.push(n); });
    // Third send should be 11
    await mgr.withNonce(async (n) => { nonces.push(n); });

    expect(nonces).toEqual([10, 11]);
  });

  it("A5: resync() resets nonce to null so next send re-fetches from chain", async () => {
    const provider = makeProvider(7);
    const mgr = new NonceManager(provider as any, "0xAddr");

    await mgr.withNonce(async (_n) => {}); // initialise to 7, commit to 8
    await mgr.resync();

    // Simulate chain advanced to 15 after an out-of-band tx
    provider.getTransactionCount.mockResolvedValue(15);
    let nonce = -1;
    await mgr.withNonce(async (n) => { nonce = n; });

    expect(nonce).toBe(15);
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(2);
  });

  it("A6: 50 sequential + 50 concurrent sends — all nonces unique", async () => {
    const provider = makeProvider(0);
    const mgr = new NonceManager(provider as any, "0xAddr");
    const nonces: number[] = [];

    // 50 sequential
    for (let i = 0; i < 50; i++) {
      await mgr.withNonce(async (n) => { nonces.push(n); });
    }
    // 50 concurrent on top
    await Promise.all(
      Array.from({ length: 50 }, () =>
        mgr.withNonce(async (n) => { nonces.push(n); }),
      ),
    );

    expect(nonces).toHaveLength(100);
    expect(new Set(nonces).size).toBe(100);
    const sorted = [...nonces].sort((a, b) => a - b);
    expect(sorted[0]).toBe(0);
    expect(sorted[99]).toBe(99);
  });
});

// ─── B. GasStrategy ───────────────────────────────────────────────────────────

describe("B. GasStrategy", () => {
  it("B1: returns EIP-1559 fees when provider reports maxFeePerGas", async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 10n,
        gasPrice: null,
      }),
    };
    const gs = new GasStrategy(provider as any);
    const fees = await gs.estimateFees();

    expect(fees.maxFeePerGas).toBe(100n);
    expect(fees.maxPriorityFeePerGas).toBe(10n);
  });

  it("B2: falls back to gasPrice on legacy networks", async () => {
    const provider = {
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        gasPrice: 50n,
      }),
    };
    const gs = new GasStrategy(provider as any);
    const fees = await gs.estimateFees();

    expect(fees.maxFeePerGas).toBe(50n);
    expect(fees.maxPriorityFeePerGas).toBe(50n);
  });

  it("B3: bumpFees returns 1.3× of original (30% bump, ≥ EIP-1559 min 10%)", () => {
    const gs = new GasStrategy(null as any);
    const bumped = gs.bumpFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n });

    expect(bumped.maxFeePerGas).toBe(130n);
    expect(bumped.maxPriorityFeePerGas).toBe(13n);
  });

  it("B4: estimateGasLimit adds 20% buffer", async () => {
    const provider = {
      estimateGas: jest.fn().mockResolvedValue(100_000n),
    };
    const gs = new GasStrategy(provider as any);
    const limit = await gs.estimateGasLimit({ to: "0x1" });

    expect(limit).toBe(120_000n); // 100_000 * 12/10
  });
});

// ─── C. ChainActionWorker ─────────────────────────────────────────────────────

describe("C. ChainActionWorker", () => {
  let worker: ChainActionWorker;
  let mockService: Record<string, jest.Mock>;
  let mockLoans: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockService = {
      findQueued: jest.fn().mockResolvedValue([]),
      findSent: jest.fn().mockResolvedValue([]),
      findStuck: jest.fn().mockResolvedValue([]),
      markProcessing: jest.fn().mockResolvedValue({}),
      markSent: jest.fn().mockResolvedValue({}),
      markMined: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({}),
      markRetrying: jest.fn().mockResolvedValue({}),
      markSentAfterRetry: jest.fn().mockResolvedValue({}),
      resetStuckProcessing: jest.fn().mockResolvedValue({ count: 0 }),
      countByStatus: jest.fn().mockResolvedValue(0),
    };
    mockLoans = {
      transitionToFunding: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChainActionWorker,
        { provide: ChainActionService, useValue: mockService },
        { provide: LoanService, useValue: mockLoans },
      ],
    }).compile();

    worker = module.get(ChainActionWorker);
  });

  // ── Sender loop ─────────────────────────────────────────────────────────

  it("C1: returns 0 with no sender configured", async () => {
    const count = await worker.processBatch();
    expect(count).toBe(0);
    expect(mockService.findQueued).not.toHaveBeenCalled();
  });

  it("C2: returns 0 when queue is empty", async () => {
    worker.setSender(makeMockSender());
    const count = await worker.processBatch();
    expect(count).toBe(0);
  });

  it("C3: QUEUED → PROCESSING → SENT — full happy path", async () => {
    const action = mockQueuedAction();
    const sender = makeMockSender({
      sendAction: jest.fn().mockResolvedValue({ txHash: "0xHash", nonce: 7 }),
    });

    worker.setSender(sender);
    mockService.findQueued.mockResolvedValueOnce([action]);

    const count = await worker.processBatch();

    expect(count).toBe(1);
    expect(mockService.markProcessing).toHaveBeenCalledWith(action.id);
    expect(sender.sendAction).toHaveBeenCalledWith({
      id: action.id,
      type: action.type,
      payload: action.payload,
    });
    expect(mockService.markSent).toHaveBeenCalledWith(action.id, "0xHash", 7);
    expect(mockService.markFailed).not.toHaveBeenCalled();
  });

  it("C4: idempotency guard — skips send when txHash already present", async () => {
    const action = mockQueuedAction({ txHash: "0xExisting", nonce: 5 });
    const sender = makeMockSender();
    worker.setSender(sender);
    mockService.findQueued.mockResolvedValueOnce([action]);

    await worker.processBatch();

    expect(sender.sendAction).not.toHaveBeenCalled();
    expect(mockService.markSent).toHaveBeenCalledWith(action.id, "0xExisting", 5);
  });

  it("C5: calls markFailed when sender throws, continues next action", async () => {
    const fail = mockQueuedAction({ id: "fail-1" });
    const ok = mockQueuedAction({ id: "ok-2" });
    let call = 0;
    const sender = makeMockSender({
      sendAction: jest.fn().mockImplementation(async () => {
        call++;
        if (call === 1) throw new Error("rpc down");
        return { txHash: "0xOk", nonce: 1 };
      }),
    });

    worker.setSender(sender);
    mockService.findQueued.mockResolvedValueOnce([fail, ok]);

    const count = await worker.processBatch();

    expect(count).toBe(1);
    expect(mockService.markFailed).toHaveBeenCalledWith(fail.id, "rpc down");
    expect(mockService.markSent).toHaveBeenCalledWith(ok.id, "0xOk", 1);
  });

  it("C6: returns 0 and skips send when paused", async () => {
    const action = mockQueuedAction();
    const sender = makeMockSender();
    worker.setSender(sender);
    mockService.findQueued.mockResolvedValueOnce([action]);

    worker.pauseSender();
    const count = await worker.processBatch();

    expect(count).toBe(0);
    expect(sender.sendAction).not.toHaveBeenCalled();
  });

  it("C7: resumeSender re-enables processing", async () => {
    const action = mockQueuedAction();
    worker.setSender(makeMockSender());
    mockService.findQueued.mockResolvedValue([action]);

    worker.pauseSender();
    expect(await worker.processBatch()).toBe(0);

    worker.resumeSender();
    expect(await worker.processBatch()).toBe(1);
  });

  // ── Receipt loop ────────────────────────────────────────────────────────

  it("C8: pollReceipts — still-pending receipt (null) skips markMined", async () => {
    const action = mockSentAction();
    const sender = makeMockSender({ getReceipt: jest.fn().mockResolvedValue(null) });
    worker.setSender(sender);
    mockService.findSent.mockResolvedValueOnce([action]);

    const count = await worker.pollReceipts();

    expect(count).toBe(0);
    expect(mockService.markMined).not.toHaveBeenCalled();
  });

  it("C9: pollReceipts — mined receipt triggers markMined + transitionToFunding", async () => {
    const action = mockSentAction({ type: "CREATE_LOAN" });
    const receipt: ChainReceipt = {
      txHash: "0xTxHash1",
      blockNumber: 100,
      gasUsed: 200_000n,
      status: "success",
      loanContract: "0xLoanClone",
    };
    const sender = makeMockSender({ getReceipt: jest.fn().mockResolvedValue(receipt) });
    worker.setSender(sender);
    mockService.findSent.mockResolvedValueOnce([action]);

    const count = await worker.pollReceipts();

    expect(count).toBe(1);
    expect(mockService.markMined).toHaveBeenCalledWith(action.id, receipt);
    expect(mockLoans.transitionToFunding).toHaveBeenCalledWith(
      action.loanId,
      "0xLoanClone",
    );
  });

  it("C10: pollReceipts — reverted tx marks FAILED, no loan transition", async () => {
    const action = mockSentAction();
    const receipt: ChainReceipt = {
      txHash: "0xTxHash1",
      blockNumber: 101,
      gasUsed: 21_000n,
      status: "reverted",
      revertReason: "Unauthorized()",
    };
    const sender = makeMockSender({ getReceipt: jest.fn().mockResolvedValue(receipt) });
    worker.setSender(sender);
    mockService.findSent.mockResolvedValueOnce([action]);

    await worker.pollReceipts();

    expect(mockService.markMined).toHaveBeenCalledWith(action.id, receipt);
    expect(mockLoans.transitionToFunding).not.toHaveBeenCalled();
  });

  // ── Stuck-tx / RBF loop ──────────────────────────────────────────────────

  it("C11: handleStuckTxs — bumps fees and re-marks SENT with new txHash", async () => {
    const stuckAction = mockSentAction({
      nonce: 10,
      bumpCount: 0,
      sentAt: new Date(Date.now() - 10 * 60_000), // 10 min ago
    });
    const sender = makeMockSender({
      bumpAndReplace: jest.fn().mockResolvedValue({ txHash: "0xBumped" }),
    });
    worker.setSender(sender);
    mockService.findStuck.mockResolvedValueOnce([stuckAction]);

    await worker.handleStuckTxs();

    expect(sender.bumpAndReplace).toHaveBeenCalledWith({
      type: stuckAction.type,
      payload: stuckAction.payload,
      nonce: 10,
    });
    expect(mockService.markRetrying).toHaveBeenCalledWith(
      stuckAction.id,
      "0xBumped",
      1,
    );
    expect(mockService.markSentAfterRetry).toHaveBeenCalledWith(stuckAction.id);
  });

  it("C12: handleStuckTxs — RBF failure marks action permanently FAILED", async () => {
    const stuckAction = mockSentAction({ nonce: 5, bumpCount: 2 });
    const sender = makeMockSender({
      bumpAndReplace: jest.fn().mockRejectedValue(new Error("insufficient funds")),
    });
    worker.setSender(sender);
    mockService.findStuck.mockResolvedValueOnce([stuckAction]);

    await worker.handleStuckTxs();

    expect(mockService.markFailed).toHaveBeenCalledWith(
      stuckAction.id,
      expect.stringContaining("RBF failed"),
    );
    expect(mockService.markRetrying).not.toHaveBeenCalled();
  });

  // ── Startup recovery ─────────────────────────────────────────────────────

  it("C13: startPolling resets orphaned PROCESSING actions on startup", async () => {
    mockService.resetStuckProcessing.mockResolvedValueOnce({ count: 3 });
    worker.setSender(makeMockSender());

    await worker.startPolling(999_999, 999_999); // long intervals — don't fire
    worker.stopPolling();

    expect(mockService.resetStuckProcessing).toHaveBeenCalledTimes(1);
  });

  // ── Stress: 100 concurrent processBatch calls ─────────────────────────────

  it("C14 (STRESS): 100 concurrent actions processed without duplication", async () => {
    const BATCH_SIZE = 10;
    const BATCHES = 10; // 10 × 10 = 100 actions total
    const processedIds = new Set<string>();
    let sendCallCount = 0;

    const sender = makeMockSender({
      sendAction: jest.fn().mockImplementation(async ({ id }) => {
        // Verify no double-process
        expect(processedIds.has(id)).toBe(false);
        processedIds.add(id);
        sendCallCount++;
        return { txHash: `0x${id.slice(0, 8)}`, nonce: sendCallCount };
      }),
    });
    worker.setSender(sender);

    // Each batch call returns a fresh set of 10 unique actions
    for (let b = 0; b < BATCHES; b++) {
      const batch = Array.from({ length: BATCH_SIZE }, () => mockQueuedAction());
      mockService.findQueued.mockResolvedValueOnce(batch);
    }
    // After all batches exhausted, return empty
    mockService.findQueued.mockResolvedValue([]);

    // Fire all batches concurrently
    const results = await Promise.all(
      Array.from({ length: BATCHES }, () => worker.processBatch()),
    );

    const totalSent = results.reduce((s, c) => s + c, 0);
    expect(totalSent).toBe(BATCHES * BATCH_SIZE);
    expect(sendCallCount).toBe(BATCHES * BATCH_SIZE);
  });
});

// ─── D. ChainActionService ────────────────────────────────────────────────────

describe("D. ChainActionService — markFailed backoff", () => {
  function makeService(attempts: number) {
    const mockPrisma = {
      chainAction: {
        update: jest.fn().mockImplementation(async ({ data }) => data),
        findUnique: jest.fn().mockResolvedValue({ id: "a1", attempts }),
      },
    };
    return { mockPrisma };
  }

  it("D1: requeues with exponential backoff when under max retries", async () => {
    const { mockPrisma } = makeService(1);
    // Simulate atomic increment: update returns the new attempts value
    mockPrisma.chainAction.update.mockImplementationOnce(async () => ({
      attempts: 2,
    }));

    const { ChainActionService: CAS } = await import(
      "../src/modules/chain-action/chain-action.service"
    );
    const svc = new CAS(mockPrisma as any);
    await svc.markFailed("a1", "network error");

    // Second update: QUEUED with nextRetryAt
    const requeueCall = mockPrisma.chainAction.update.mock.calls[1][0];
    expect(requeueCall.data.status).toBe("QUEUED");
    expect(requeueCall.data.nextRetryAt).toBeDefined();
    // Backoff = 2^2 * 1000 = 4000 ms
    const backoffMs = requeueCall.data.nextRetryAt.getTime() - Date.now();
    expect(backoffMs).toBeGreaterThan(3500);
    expect(backoffMs).toBeLessThan(5000);
  });

  it("D2: permanently FAILED when max retries (5) reached", async () => {
    const { mockPrisma } = makeService(4);
    mockPrisma.chainAction.update.mockImplementationOnce(async () => ({
      attempts: 5,
    }));

    const { ChainActionService: CAS } = await import(
      "../src/modules/chain-action/chain-action.service"
    );
    const svc = new CAS(mockPrisma as any);
    await svc.markFailed("a1", "permanent error");

    const failCall = mockPrisma.chainAction.update.mock.calls[1][0];
    expect(failCall.data.status).toBe("FAILED");
  });

  it("D3: requeueAction refuses to requeue MINED actions", async () => {
    const mockPrisma = {
      chainAction: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "a1", status: "MINED", txHash: "0x1", error: null }),
        update: jest.fn(),
      },
    };

    const { ChainActionService: CAS } = await import(
      "../src/modules/chain-action/chain-action.service"
    );
    const svc = new CAS(mockPrisma as any);

    await expect(svc.requeueAction("a1")).rejects.toThrow(
      "Cannot requeue a MINED action",
    );
    expect(mockPrisma.chainAction.update).not.toHaveBeenCalled();
  });

  it("D4: requeueAction refuses SENT actions that already have txHash", async () => {
    const mockPrisma = {
      chainAction: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "a1", status: "SENT", txHash: "0xExists", error: null }),
        update: jest.fn(),
      },
    };

    const { ChainActionService: CAS } = await import(
      "../src/modules/chain-action/chain-action.service"
    );
    const svc = new CAS(mockPrisma as any);

    await expect(svc.requeueAction("a1")).rejects.toThrow(
      "Cannot requeue a SENT action with a txHash",
    );
  });

  it("D5: requeueAction succeeds for FAILED actions (idempotent)", async () => {
    const mockPrisma = {
      chainAction: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "a1", status: "FAILED", txHash: null, error: "old error" }),
        update: jest.fn().mockResolvedValue({ id: "a1", status: "QUEUED" }),
      },
    };

    const { ChainActionService: CAS } = await import(
      "../src/modules/chain-action/chain-action.service"
    );
    const svc = new CAS(mockPrisma as any);
    await svc.requeueAction("a1");

    expect(mockPrisma.chainAction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "QUEUED" }),
      }),
    );
  });
});
