import { FiatRepaymentService } from "./fiat-repayment.service";
import { FiatTransferService } from "./fiat-transfer.service";
import { ChainActionService } from "../chain-action/chain-action.service";
import { FiatTransferDirection, FiatTransferStatus, ChainActionType } from "@prisma/client";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTransfer(overrides: Record<string, unknown> = {}) {
  return {
    id: "transfer-1",
    loanId: "loan-1",
    direction: FiatTransferDirection.INBOUND,
    status: FiatTransferStatus.PENDING,
    providerRef: "MPESA-INBOUND-001",
    idempotencyKey: "idem-inbound-1",
    amountKes: 50_000n,
    phoneNumber: "254700000001",
    refHash: null,
    rawPayload: null,
    confirmedAt: null,
    failedAt: null,
    failureReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function makeFiatTransferService(stubs: Partial<FiatTransferService> = {}): FiatTransferService {
  return {
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(makeTransfer()),
    markConfirmed: jest.fn().mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.CONFIRMED, refHash: "cafebabe" }),
    ),
    markFailed: jest.fn(),
    findByProviderRef: jest.fn(),
    findById: jest.fn(),
    findByLoan: jest.fn(),
    findOutboundByLoan: jest.fn().mockResolvedValue(makeTransfer()),
    findInboundByLoan: jest.fn().mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.CHAIN_REPAY_PENDING }),
    ),
    // State machine methods
    markRepaymentReceived: jest.fn().mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.REPAYMENT_RECEIVED, refHash: "cafebabe", proofHash: "proofhash1" }),
    ),
    markChainRepayPending: jest.fn().mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.CHAIN_REPAY_PENDING }),
    ),
    markChainRepayConfirmed: jest.fn().mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.CHAIN_REPAY_CONFIRMED }),
    ),
    ...stubs,
  } as unknown as FiatTransferService;
}

function makeChainActionService(): ChainActionService {
  return {
    enqueue: jest.fn().mockResolvedValue({ id: "action-1" }),
  } as unknown as ChainActionService;
}

function makeParams(i: number) {
  return {
    loanId: `loan-${i}`,
    loanContract: `0x${"b".repeat(40)}`,
    providerRef: `MPESA-INBOUND-${String(i).padStart(3, "0")}`,
    idempotencyKey: `idem-repay-${i}`,
    amountKes: BigInt(50_000 + i * 500),
    phoneNumber: `25470000000${i}`,
    rawPayload: { loanId: `loan-${i}`, loanContract: `0x${"b".repeat(40)}` },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("FiatRepaymentService — inbound (10 repayments)", () => {
  let svc: FiatRepaymentService;
  let fiatTransfers: FiatTransferService;
  let chainActions: ChainActionService;

  beforeEach(() => {
    fiatTransfers = makeFiatTransferService();
    chainActions = makeChainActionService();
    svc = new FiatRepaymentService(fiatTransfers, chainActions);
  });

  it("processes 10 unique repayments without errors", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await svc.handleRepayment(makeParams(i));
      expect(result.duplicate).toBe(false);
      expect(result.transfer).toBeDefined();
    }
    expect(fiatTransfers.create).toHaveBeenCalledTimes(10);
    expect(fiatTransfers.markRepaymentReceived).toHaveBeenCalledTimes(10);
    expect(fiatTransfers.markChainRepayPending).toHaveBeenCalledTimes(10);
  });

  it("each repayment enqueues exactly REPAY + RECORD_REPAYMENT (1:1 chain action set)", async () => {
    for (let i = 0; i < 10; i++) {
      await svc.handleRepayment(makeParams(i));
    }

    const calls = (chainActions.enqueue as jest.Mock).mock.calls;
    // 10 repayments × 2 actions = 20 total
    expect(calls).toHaveLength(20);

    // Every even call is REPAY, every odd call is RECORD_REPAYMENT
    for (let i = 0; i < 20; i += 2) {
      expect(calls[i][1]).toBe(ChainActionType.REPAY);
      expect(calls[i + 1][1]).toBe(ChainActionType.RECORD_REPAYMENT);
    }
  });

  it("idempotency: repeated webhook with same idempotencyKey returns duplicate=true, no new records", async () => {
    const existing = makeTransfer({ status: FiatTransferStatus.CHAIN_REPAY_PENDING });
    (fiatTransfers.findByIdempotencyKey as jest.Mock).mockResolvedValue(existing);

    const result = await svc.handleRepayment(makeParams(0));

    expect(result.duplicate).toBe(true);
    expect(result.transfer).toBe(existing);
    expect(fiatTransfers.create).not.toHaveBeenCalled();
    expect(fiatTransfers.markRepaymentReceived).not.toHaveBeenCalled();
    expect(chainActions.enqueue).not.toHaveBeenCalled();
  });

  it("idempotency: 10 duplicate webhooks produce zero additional chain actions", async () => {
    const existing = makeTransfer({ status: FiatTransferStatus.CHAIN_REPAY_PENDING });
    (fiatTransfers.findByIdempotencyKey as jest.Mock).mockResolvedValue(existing);

    for (let i = 0; i < 10; i++) {
      const result = await svc.handleRepayment(makeParams(0));
      expect(result.duplicate).toBe(true);
    }

    expect(chainActions.enqueue).not.toHaveBeenCalled();
  });

  it("0 mismatches: each repayment loanId matches the enqueued chain action loanId", async () => {
    for (let i = 0; i < 10; i++) {
      await svc.handleRepayment(makeParams(i));
    }

    const calls = (chainActions.enqueue as jest.Mock).mock.calls;
    for (let i = 0; i < 10; i++) {
      const repayCall = calls[i * 2];
      const recordCall = calls[i * 2 + 1];
      expect(repayCall[0]).toBe(`loan-${i}`);
      expect(recordCall[0]).toBe(`loan-${i}`);
    }
  });

  it("includes a ledger conversion record in REPAY payload", async () => {
    await svc.handleRepayment(makeParams(0));

    const repayCalls = (chainActions.enqueue as jest.Mock).mock.calls.filter(
      (c) => c[1] === ChainActionType.REPAY,
    );
    expect(repayCalls).toHaveLength(1);
    const payload = repayCalls[0][2];
    expect(payload.conversionRecord).toBeDefined();
    expect(payload.conversionRecord.note).toBe("v1.1-desk-conversion");
  });
});
