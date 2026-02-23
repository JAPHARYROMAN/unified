import { BadRequestException, NotFoundException } from "@nestjs/common";
import { OpsService } from "./ops.service";

function createMockChainActions() {
  return {
    findDlq: jest.fn().mockResolvedValue([]),
    replayFromDlq: jest.fn(),
  } as any;
}

function createMockMetrics() {
  return { snapshot: jest.fn().mockReturnValue({}) } as any;
}

function createMockPrisma() {
  return {
    chainAction: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    fiatTransfer: {
      findMany: jest.fn(),
    },
    loan: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    webhookDeadLetter: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

describe("OpsService", () => {
  it("runDailyReconciliation returns zero critical mismatches when data is clean", async () => {
    const prisma = createMockPrisma();

    prisma.fiatTransfer.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === "CONFIRMED" && !where?.direction) {
        // Confirmed disbursement tied to a tx
        return [
          {
            id: "ft1",
            chainAction: { id: "ca1", txHash: "0xabc", status: "MINED" },
          },
        ];
      }

      if (where?.direction === "INBOUND") {
        return [];
      }

      return [];
    });

    prisma.loan.findMany.mockResolvedValue([]);

    const svc = new OpsService(prisma as any, createMockChainActions(), createMockMetrics());
    const summary = await svc.runDailyReconciliation();

    expect(summary.criticalCount).toBe(0);
    expect(summary.reports).toHaveLength(3);
    expect(summary.reports.every((r: any) => r.count === 0)).toBe(true);
  });

  it("getAlerts raises stuck tx and mismatch alerts", async () => {
    const prisma = createMockPrisma();

    prisma.chainAction.findMany.mockResolvedValue([
      {
        id: "a1",
        status: "PROCESSING",
        updatedAt: new Date(Date.now() - 30 * 60_000),
      },
    ]);

    prisma.webhookDeadLetter.count
      .mockResolvedValueOnce(2) // failures
      .mockResolvedValueOnce(1); // signature failures

    prisma.fiatTransfer.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === "CONFIRMED" && !where?.direction) {
        return [
          {
            id: "ft1",
            chainAction: null,
          },
        ];
      }

      if (where?.direction === "INBOUND") {
        return [
          {
            id: "ft2",
            status: "CONFIRMED",
            appliedOnchainAt: null,
            loan: { id: "l2", status: "ACTIVE", partnerId: "p1" },
            chainAction: null,
          },
        ];
      }

      return [];
    });

    prisma.loan.findMany.mockResolvedValue([
      {
        id: "l3",
        status: "ACTIVE",
        partnerId: "p1",
        chainActions: [],
      },
    ]);

    const svc = new OpsService(prisma as any, createMockChainActions(), createMockMetrics());
    const out = await svc.getAlerts();

    const codes = out.alerts.map((a: any) => a.code);
    expect(codes).toContain("STUCK_CHAIN_TX");
    expect(codes).toContain("WEBHOOK_FAILURES");
    expect(codes).toContain("WEBHOOK_SIGNATURE_FAILURES");
    expect(codes).toContain("RECONCILIATION_MISMATCH_THRESHOLD");
  });

  it("requeueChainActionSafely requeues FAILED action", async () => {
    const prisma = createMockPrisma();

    prisma.chainAction.findUnique.mockResolvedValue({
      id: "act-1",
      status: "FAILED",
      txHash: null,
      error: "reverted",
      updatedAt: new Date(),
    });

    prisma.chainAction.update.mockImplementation(async ({ data }: any) => ({
      id: "act-1",
      ...data,
      attempts: 2,
      updatedAt: new Date(),
    }));

    const svc = new OpsService(prisma as any, createMockChainActions(), createMockMetrics());
    const updated = await svc.requeueChainActionSafely("act-1", 15);

    expect(updated.status).toBe("QUEUED");
    expect(updated.error).toContain("manually requeued");
  });

  it("requeueChainActionSafely rejects SENT action with tx hash", async () => {
    const prisma = createMockPrisma();

    prisma.chainAction.findUnique.mockResolvedValue({
      id: "act-2",
      status: "SENT",
      txHash: "0xabc",
      error: null,
      updatedAt: new Date(Date.now() - 60 * 60_000),
    });

    const svc = new OpsService(prisma as any, createMockChainActions(), createMockMetrics());

    await expect(svc.requeueChainActionSafely("act-2", 15)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("getLoanLifecycleTimeline throws for unknown loan", async () => {
    const prisma = createMockPrisma();
    prisma.loan.findUnique.mockResolvedValue(null);

    const svc = new OpsService(prisma as any, createMockChainActions(), createMockMetrics());
    await expect(
      svc.getLoanLifecycleTimeline("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundException);
  });
});
