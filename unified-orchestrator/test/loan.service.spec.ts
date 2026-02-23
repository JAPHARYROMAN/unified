import { Test, TestingModule } from "@nestjs/testing";
import { LoanService } from "../src/modules/loan/loan.service";
import { ChainActionService } from "../src/modules/chain-action/chain-action.service";
import { GuardrailService } from "../src/modules/guardrail/guardrail.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";

// ─── Mock factories ───

function createMockPrisma() {
  const partners = new Map<string, any>();
  const loans = new Map<string, any>();
  const pools = new Map<string, any>();

  return {
    _partners: partners,
    _loans: loans,
    _pools: pools,
    partner: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const p = partners.get(where.id);
        if (!p) return null;
        if (include?.pools) {
          const partnerPools = [...pools.values()].filter(
            (pp) => pp.partnerId === where.id,
          );
          return { ...p, pools: partnerPools };
        }
        return p;
      }),
    },
    loan: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        const record = {
          id,
          ...data,
          loanContract: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        loans.set(id, record);
        return record;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return loans.get(where.id) ?? null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return [...loans.values()].filter(
          (l) => l.partnerId === where.partnerId,
        );
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = loans.get(where.id);
        if (!existing) throw new Error("loan not found");
        const updated = { ...existing, ...data, updatedAt: new Date() };
        loans.set(where.id, updated);
        return updated;
      }),
    },
    chainAction: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        return {
          id,
          ...data,
          attempts: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
    },
  };
}

function createMockChainActionService() {
  return {
    enqueue: jest.fn(async (loanId: string, type: string, payload: any) => ({
      id: crypto.randomUUID(),
      loanId,
      type,
      status: "QUEUED",
      payload,
      createdAt: new Date(),
    })),
  };
}

function createMockGuardrailService() {
  return {
    enforce: jest.fn(async () => {
      /* no-op by default — guardrails pass */
    }),
    findActive: jest.fn(async () => null),
  };
}

// ─── Helpers ───

function seedActivePartner(
  prisma: ReturnType<typeof createMockPrisma>,
  overrides?: any,
) {
  const id = crypto.randomUUID();
  const partner = {
    id,
    legalName: "Test Partner",
    jurisdictionCode: 840,
    registrationNumber: "REG-1",
    complianceEmail: "c@t.com",
    treasuryWallet: "0xTreasury",
    status: "ACTIVE",
    maxLoanSizeUsdc: 0n,
    reserveRatioBps: 0,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  prisma._partners.set(id, partner);
  return partner;
}

function seedPool(
  prisma: ReturnType<typeof createMockPrisma>,
  partnerId: string,
) {
  const id = crypto.randomUUID();
  const pool = {
    id,
    partnerId,
    poolContract: "0xPool123",
    chainId: 1,
    createdAt: new Date(),
  };
  prisma._pools.set(id, pool);
  return pool;
}

const VALID_LOAN_PARAMS = {
  borrowerWallet: "0xBorrower1234567890",
  principalUsdc: 1000n,
  collateralToken: "0xCollateral",
  collateralAmount: 500n,
  durationSeconds: 86400,
  interestRateBps: 500,
};

// ─── Tests ───

describe("LoanService", () => {
  let service: LoanService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockChainActions: ReturnType<typeof createMockChainActionService>;
  let mockGuardrails: ReturnType<typeof createMockGuardrailService>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    mockChainActions = createMockChainActionService();
    mockGuardrails = createMockGuardrailService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ChainActionService, useValue: mockChainActions },
        { provide: GuardrailService, useValue: mockGuardrails },
      ],
    }).compile();

    service = module.get(LoanService);
  });

  // ──────────────── Partner ACTIVE enforcement ────────────────

  it("rejects loan creation if partner is not ACTIVE", async () => {
    const partner = seedActivePartner(mockPrisma, { status: "VERIFIED" });
    seedPool(mockPrisma, partner.id);

    await expect(
      service.createLoan(partner.id, VALID_LOAN_PARAMS),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects loan creation if partner is SUSPENDED", async () => {
    const partner = seedActivePartner(mockPrisma, { status: "SUSPENDED" });
    seedPool(mockPrisma, partner.id);

    await expect(
      service.createLoan(partner.id, VALID_LOAN_PARAMS),
    ).rejects.toThrow(ForbiddenException);
  });

  it("rejects if partner not found", async () => {
    await expect(
      service.createLoan(
        "00000000-0000-0000-0000-000000000000",
        VALID_LOAN_PARAMS,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  // ──────────────── Pool enforcement ────────────────

  it("rejects if partner has no linked pool", async () => {
    const partner = seedActivePartner(mockPrisma);
    // No pool seeded

    await expect(
      service.createLoan(partner.id, VALID_LOAN_PARAMS),
    ).rejects.toThrow(BadRequestException);
  });

  // ──────────────── Max loan size ────────────────

  it("rejects if principal exceeds max_loan_size_usdc", async () => {
    const partner = seedActivePartner(mockPrisma, { maxLoanSizeUsdc: 500n });
    seedPool(mockPrisma, partner.id);

    await expect(
      service.createLoan(partner.id, {
        ...VALID_LOAN_PARAMS,
        principalUsdc: 1000n,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows loan at exactly max_loan_size_usdc", async () => {
    const partner = seedActivePartner(mockPrisma, { maxLoanSizeUsdc: 1000n });
    seedPool(mockPrisma, partner.id);

    const result = await service.createLoan(partner.id, {
      ...VALID_LOAN_PARAMS,
      principalUsdc: 1000n,
    });
    expect(result.loan.status).toBe("CREATED");
  });

  it("skips max loan check when maxLoanSizeUsdc is 0 (uncapped)", async () => {
    const partner = seedActivePartner(mockPrisma, { maxLoanSizeUsdc: 0n });
    seedPool(mockPrisma, partner.id);

    const result = await service.createLoan(partner.id, VALID_LOAN_PARAMS);
    expect(result.loan.status).toBe("CREATED");
  });

  // ──────────────── Borrower wallet validation ────────────────

  it("rejects if borrower wallet is too short", async () => {
    const partner = seedActivePartner(mockPrisma);
    seedPool(mockPrisma, partner.id);

    await expect(
      service.createLoan(partner.id, {
        ...VALID_LOAN_PARAMS,
        borrowerWallet: "0x1",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // ──────────────── Successful creation ────────────────

  it("creates loan with CREATED status and enqueues chain action", async () => {
    const partner = seedActivePartner(mockPrisma);
    seedPool(mockPrisma, partner.id);

    const result = await service.createLoan(partner.id, VALID_LOAN_PARAMS);

    expect(result.loan.status).toBe("CREATED");
    expect(result.loan.partnerId).toBe(partner.id);
    expect(result.loan.borrowerWallet).toBe(VALID_LOAN_PARAMS.borrowerWallet);
    expect(result.loan.poolContract).toBe("0xPool123");
    expect(result.chainActionId).toBeDefined();
    expect(mockChainActions.enqueue).toHaveBeenCalledWith(
      result.loan.id,
      "CREATE_LOAN",
      expect.objectContaining({
        borrower: VALID_LOAN_PARAMS.borrowerWallet,
        pool: "0xPool123",
      }),
    );
  });

  // ──────────────── Read ────────────────

  it("findById returns loan with chain actions", async () => {
    const partner = seedActivePartner(mockPrisma);
    seedPool(mockPrisma, partner.id);
    const { loan } = await service.createLoan(partner.id, VALID_LOAN_PARAMS);

    // Mock findUnique to include chainActions
    mockPrisma.loan.findUnique.mockResolvedValueOnce({
      ...mockPrisma._loans.get(loan.id),
      chainActions: [],
    });

    const found = await service.findById(loan.id);
    expect(found.id).toBe(loan.id);
  });

  it("findById throws NotFoundException for unknown loan", async () => {
    mockPrisma.loan.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.findById("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundException);
  });

  // ──────────────── Transition to FUNDING ────────────────

  it("transitionToFunding sets status=FUNDING and stores contract address", async () => {
    const partner = seedActivePartner(mockPrisma);
    seedPool(mockPrisma, partner.id);
    const { loan } = await service.createLoan(partner.id, VALID_LOAN_PARAMS);

    const updated = await service.transitionToFunding(
      loan.id,
      "0xLoanContract",
    );
    expect(updated.status).toBe("FUNDING");
    expect(updated.loanContract).toBe("0xLoanContract");
  });
});
