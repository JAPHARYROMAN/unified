import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { GuardrailService } from "../src/modules/guardrail/guardrail.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";

// ─── Mock Prisma ───

function createMockPrisma() {
  const partners = new Map<string, any>();
  const guardrails = new Map<string, any>();
  const loans: any[] = [];

  return {
    _partners: partners,
    _guardrails: guardrails,
    _loans: loans,
    partner: {
      findUnique: jest.fn(async ({ where }: any) => {
        return partners.get(where.id) ?? null;
      }),
    },
    partnerGuardrail: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        const record = { id, ...data, createdAt: new Date() };
        guardrails.set(id, record);
        return record;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const g of guardrails.values()) {
          if (
            g.partnerId === where.partnerId &&
            g.effectiveTo === (where.effectiveTo ?? null)
          ) {
            return g;
          }
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return [...guardrails.values()]
          .filter((g) => g.partnerId === where.partnerId)
          .sort(
            (a, b) =>
              new Date(b.effectiveFrom).getTime() -
              new Date(a.effectiveFrom).getTime(),
          );
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [id, g] of guardrails.entries()) {
          if (
            g.partnerId === where.partnerId &&
            g.effectiveTo === (where.effectiveTo ?? null)
          ) {
            guardrails.set(id, { ...g, ...data });
            count++;
          }
        }
        return { count };
      }),
    },
    loan: {
      aggregate: jest.fn(async () => ({
        _sum: { principalUsdc: 0n } as any,
      })),
    },
  };
}

// ─── Helpers ───

function seedPartner(prisma: ReturnType<typeof createMockPrisma>) {
  const id = crypto.randomUUID();
  const partner = {
    id,
    legalName: "Test Partner",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  prisma._partners.set(id, partner);
  return partner;
}

function seedGuardrail(
  prisma: ReturnType<typeof createMockPrisma>,
  partnerId: string,
  overrides?: Partial<{
    minAprBps: number;
    maxAprBps: number;
    minDurationSec: number;
    maxDurationSec: number;
    maxLoanUsdc: bigint;
    maxBorrowerOutstandingUsdc: bigint;
    minReserveRatioBps: number;
    effectiveTo: Date | null;
  }>,
) {
  const id = crypto.randomUUID();
  const g = {
    id,
    partnerId,
    minAprBps: 100,
    maxAprBps: 2000,
    minDurationSec: 3600,
    maxDurationSec: 31536000,
    maxLoanUsdc: 50000n,
    maxBorrowerOutstandingUsdc: 100000n,
    minReserveRatioBps: 0,
    effectiveFrom: new Date(),
    effectiveTo: null,
    createdAt: new Date(),
    ...overrides,
  };
  prisma._guardrails.set(id, g);
  return g;
}

const VALID_PARAMS = {
  interestRateBps: 500,
  durationSeconds: 86400,
  principalUsdc: 1000n,
  borrowerWallet: "0xBorrower1234567890",
};

// ─── GuardrailService.enforce tests ───

describe("GuardrailService", () => {
  let service: GuardrailService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuardrailService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(GuardrailService);
  });

  // ──────── Passthrough when no guardrails ────────

  it("passes through when no guardrails are configured", async () => {
    const partner = seedPartner(mockPrisma);
    // no guardrail seeded
    await expect(
      service.enforce(partner.id, VALID_PARAMS),
    ).resolves.toBeUndefined();
  });

  // ──────── APR enforcement ────────

  it("rejects loan with APR below minimum", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { minAprBps: 200 });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, interestRateBps: 100 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects loan with APR above maximum", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { maxAprBps: 400 });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, interestRateBps: 500 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows APR at exact min boundary", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { minAprBps: 500 });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, interestRateBps: 500 }),
    ).resolves.toBeUndefined();
  });

  it("allows APR at exact max boundary", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { maxAprBps: 500 });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, interestRateBps: 500 }),
    ).resolves.toBeUndefined();
  });

  // ──────── Duration enforcement ────────

  it("rejects loan with duration below minimum", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { minDurationSec: 86400 });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, durationSeconds: 3600 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects loan with duration above maximum", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { maxDurationSec: 3600 });

    await expect(
      service.enforce(partner.id, {
        ...VALID_PARAMS,
        durationSeconds: 86400,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ──────── Principal cap enforcement ────────

  it("rejects loan with principal above guardrail max", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { maxLoanUsdc: 500n });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, principalUsdc: 1000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows principal at exact guardrail max", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, { maxLoanUsdc: 1000n });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, principalUsdc: 1000n }),
    ).resolves.toBeUndefined();
  });

  // ──────── Borrower exposure enforcement ────────

  it("rejects when projected borrower exposure exceeds max", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, {
      maxBorrowerOutstandingUsdc: 5000n,
    });

    // Simulate existing outstanding of 4500
    mockPrisma.loan.aggregate.mockResolvedValueOnce({
      _sum: { principalUsdc: 4500n },
    });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, principalUsdc: 1000n }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows borrower exposure at exact max", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, {
      maxBorrowerOutstandingUsdc: 5000n,
    });

    mockPrisma.loan.aggregate.mockResolvedValueOnce({
      _sum: { principalUsdc: 4000n },
    });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, principalUsdc: 1000n }),
    ).resolves.toBeUndefined();
  });

  it("treats null aggregate sum as 0 exposure", async () => {
    const partner = seedPartner(mockPrisma);
    seedGuardrail(mockPrisma, partner.id, {
      maxBorrowerOutstandingUsdc: 5000n,
    });

    mockPrisma.loan.aggregate.mockResolvedValueOnce({
      _sum: { principalUsdc: null } as any,
    });

    await expect(
      service.enforce(partner.id, { ...VALID_PARAMS, principalUsdc: 1000n }),
    ).resolves.toBeUndefined();
  });

  // ──────── GuardrailService.create tests ────────

  describe("create", () => {
    const VALID_GUARDRAIL_PARAMS = {
      minAprBps: 100,
      maxAprBps: 2000,
      minDurationSec: 3600,
      maxDurationSec: 31536000,
      maxLoanUsdc: 50000n,
      maxBorrowerOutstandingUsdc: 100000n,
      minReserveRatioBps: 500,
    };

    it("creates guardrail for existing partner", async () => {
      const partner = seedPartner(mockPrisma);

      const result = await service.create(partner.id, VALID_GUARDRAIL_PARAMS);

      expect(result.partnerId).toBe(partner.id);
      expect(result.minAprBps).toBe(100);
      expect(result.maxAprBps).toBe(2000);
      expect(result.effectiveTo).toBeUndefined();
      expect(mockPrisma.partnerGuardrail.create).toHaveBeenCalled();
    });

    it("rejects if partner not found", async () => {
      await expect(
        service.create(
          "00000000-0000-0000-0000-000000000000",
          VALID_GUARDRAIL_PARAMS,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects if minAprBps > maxAprBps", async () => {
      const partner = seedPartner(mockPrisma);
      await expect(
        service.create(partner.id, {
          ...VALID_GUARDRAIL_PARAMS,
          minAprBps: 3000,
          maxAprBps: 1000,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if minDurationSec > maxDurationSec", async () => {
      const partner = seedPartner(mockPrisma);
      await expect(
        service.create(partner.id, {
          ...VALID_GUARDRAIL_PARAMS,
          minDurationSec: 99999,
          maxDurationSec: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("closes previous active guardrail when creating new one", async () => {
      const partner = seedPartner(mockPrisma);

      // Seed an existing active guardrail
      seedGuardrail(mockPrisma, partner.id);

      // Create new one — should close old
      await service.create(partner.id, VALID_GUARDRAIL_PARAMS);

      expect(mockPrisma.partnerGuardrail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            partnerId: partner.id,
            effectiveTo: null,
          },
          data: expect.objectContaining({
            effectiveTo: expect.any(Date),
          }),
        }),
      );
    });
  });
});
