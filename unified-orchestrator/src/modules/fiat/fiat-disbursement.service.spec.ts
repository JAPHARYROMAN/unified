import { ConflictException } from "@nestjs/common";
import { FiatDisbursementService } from "./fiat-disbursement.service";
import { FiatTransferService } from "./fiat-transfer.service";
import { MpesaAdapter } from "./adapters/mpesa.adapter";
import { ChainActionService } from "../chain-action/chain-action.service";
import { FiatTransferDirection, FiatTransferStatus, ChainActionType } from "@prisma/client";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTransfer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "transfer-1",
    loanId: "loan-1",
    direction: FiatTransferDirection.OUTBOUND,
    status: FiatTransferStatus.PENDING,
    providerRef: "MPESA-ABCD1234",
    idempotencyKey: "idem-key-1",
    amountKes: 100_00n,
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

function makeChainAction(id: string) {
  return { id } as any;
}

function makeFiatTransferService(stubs: Partial<FiatTransferService> = {}): FiatTransferService {
  return {
    findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(makeTransfer()),
    markConfirmed: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.CONFIRMED, refHash: "deadbeef" })),
    markFailed: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.FAILED })),
    findByProviderRef: jest.fn().mockResolvedValue(makeTransfer()),
    findById: jest.fn(),
    findByLoan: jest.fn(),
    findOutboundByLoan: jest.fn().mockResolvedValue(makeTransfer()),
    findInboundByLoan: jest.fn().mockResolvedValue(makeTransfer()),
    // State machine methods
    markPayoutInitiated: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.PAYOUT_INITIATED })),
    markPayoutConfirmed: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.PAYOUT_CONFIRMED, refHash: "deadbeef", proofHash: "proofhash1" })),
    markChainRecordPending: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.CHAIN_RECORD_PENDING })),
    markChainRecorded: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.CHAIN_RECORDED })),
    markActivated: jest.fn().mockResolvedValue(makeTransfer({ status: FiatTransferStatus.ACTIVATED })),
    ...stubs,
  } as unknown as FiatTransferService;
}

function makeMpesaAdapter(): MpesaAdapter {
  return {
    initiatePayout: jest.fn().mockResolvedValue({ providerRef: "MPESA-ABCD1234", status: "PENDING" }),
  } as unknown as MpesaAdapter;
}

function makeChainActionService(): ChainActionService {
  return {
    enqueue: jest.fn().mockResolvedValue(makeChainAction("action-1")),
  } as unknown as ChainActionService;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("FiatDisbursementService — outbound (10 payouts)", () => {
  let svc: FiatDisbursementService;
  let fiatTransfers: FiatTransferService;
  let chainActions: ChainActionService;
  let mpesa: MpesaAdapter;

  beforeEach(() => {
    fiatTransfers = makeFiatTransferService();
    chainActions = makeChainActionService();
    mpesa = makeMpesaAdapter();
    svc = new FiatDisbursementService(fiatTransfers, chainActions, mpesa);
  });

  it("initiates 10 unique payouts without errors", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await svc.initiatePayout({
        loanId: `loan-${i}`,
        loanContract: `0x${"a".repeat(40)}`,
        phoneNumber: `25470000000${i}`,
        amountKes: BigInt(10_000 + i * 100),
        idempotencyKey: `idem-${i}`,
      });
      expect(result).toBeDefined();
    }
    expect(mpesa.initiatePayout).toHaveBeenCalledTimes(10);
    expect(fiatTransfers.create).toHaveBeenCalledTimes(10);
  });

  it("returns existing record on duplicate idempotencyKey (idempotent)", async () => {
    const existing = makeTransfer({ idempotencyKey: "idem-dup" });
    (fiatTransfers.findByIdempotencyKey as jest.Mock).mockResolvedValue(existing);

    const result = await svc.initiatePayout({
      loanId: "loan-1",
      loanContract: `0x${"a".repeat(40)}`,
      phoneNumber: "254700000001",
      amountKes: 10_000n,
      idempotencyKey: "idem-dup",
    });

    expect(result).toBe(existing);
    expect(mpesa.initiatePayout).not.toHaveBeenCalled();
    expect(fiatTransfers.create).not.toHaveBeenCalled();
  });

  it("on CONFIRMED: advances state machine and enqueues exactly RECORD_DISBURSEMENT + ACTIVATE_LOAN", async () => {
    await svc.handleDisbursementConfirmed("MPESA-ABCD1234", "idem-1", {
      loanContract: "0xLOAN",
    });

    expect(fiatTransfers.markPayoutConfirmed).toHaveBeenCalledTimes(1);
    expect(fiatTransfers.markChainRecordPending).toHaveBeenCalledTimes(1);
    expect(chainActions.enqueue).toHaveBeenCalledTimes(2);

    const calls = (chainActions.enqueue as jest.Mock).mock.calls;
    expect(calls[0][1]).toBe(ChainActionType.RECORD_DISBURSEMENT);
    expect(calls[1][1]).toBe(ChainActionType.ACTIVATE_LOAN);
  });

  it("on CONFIRMED: exactly 1 chain action set per transfer (no duplicates)", async () => {
    for (let i = 0; i < 10; i++) {
      (fiatTransfers.findByProviderRef as jest.Mock).mockResolvedValue(
        makeTransfer({ id: `transfer-${i}`, status: FiatTransferStatus.PAYOUT_INITIATED }),
      );
      await svc.handleDisbursementConfirmed(`MPESA-REF-${i}`, `idem-${i}`, {
        loanContract: "0xLOAN",
      });
    }

    expect(fiatTransfers.markPayoutConfirmed).toHaveBeenCalledTimes(10);
    // 2 chain actions per confirmation = exactly 20
    expect(chainActions.enqueue).toHaveBeenCalledTimes(20);
  });

  it("skips re-confirmation when transfer already past PAYOUT_INITIATED (idempotent webhook)", async () => {
    (fiatTransfers.findByProviderRef as jest.Mock).mockResolvedValue(
      makeTransfer({ status: FiatTransferStatus.CHAIN_RECORD_PENDING }),
    );

    await svc.handleDisbursementConfirmed("MPESA-ABCD1234", "idem-1", {});

    expect(fiatTransfers.markPayoutConfirmed).not.toHaveBeenCalled();
    expect(chainActions.enqueue).not.toHaveBeenCalled();
  });

  it("marks transfer FAILED on disbursement failure callback", async () => {
    await svc.handleDisbursementFailed("MPESA-ABCD1234", "Insufficient funds");
    expect(fiatTransfers.markFailed).toHaveBeenCalledWith("transfer-1", "Insufficient funds");
  });
});
