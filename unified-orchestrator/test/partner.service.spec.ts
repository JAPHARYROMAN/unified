import { Test, TestingModule } from "@nestjs/testing";
import { PartnerService } from "../src/modules/partner/partner.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";

// ─── In-memory mock store ───

function createMockPrisma() {
  const partners = new Map<string, any>();
  const submissions = new Map<string, any>();
  let subCounter = 0;

  return {
    partners,
    submissions,
    partner: {
      create: jest.fn(async ({ data }: any) => {
        const id = data.id ?? crypto.randomUUID();
        const record = {
          id,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        partners.set(id, record);
        return record;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return partners.get(where.id) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = partners.get(where.id);
        if (!existing) throw new Error("not found");
        const updated = { ...existing, ...data, updatedAt: new Date() };
        partners.set(where.id, updated);
        return updated;
      }),
    },
    partnerSubmission: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        const record = {
          id,
          ...data,
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          notes: null,
        };
        submissions.set(id, record);
        return record;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const sub of submissions.values()) {
          if (sub.partnerId === where.partnerId) return sub;
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = submissions.get(where.id);
        if (!existing) throw new Error("submission not found");
        const updated = { ...existing, ...data };
        submissions.set(where.id, updated);
        return updated;
      }),
    },
    partnerPool: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        return { id, ...data, createdAt: new Date() };
      }),
    },
    partnerApiKey: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        return { id, ...data, createdAt: new Date(), revokedAt: null };
      }),
      findFirst: jest.fn(async () => null),
      update: jest.fn(async ({ where, data }: any) => ({ ...data })),
    },
    $transaction: jest.fn(async (ops: Promise<any>[]) => {
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
  };
}

function createMockApiKeyService() {
  return {
    issue: jest.fn(async (partnerId: string) => ({
      id: crypto.randomUUID(),
      plaintext: `pk_testkey1234567890abcdef`,
      last4: "cdef",
    })),
    revoke: jest.fn(),
    validate: jest.fn(),
  };
}

// ─── Helpers ───

const VALID_REGISTER = {
  legalName: "Acme Finance Ltd",
  jurisdictionCode: 840,
  registrationNumber: "REG-12345",
  complianceEmail: "compliance@acme.com",
  treasuryWallet: "0xabc123",
};

describe("PartnerService — state transitions", () => {
  let service: PartnerService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let mockApiKeyService: ReturnType<typeof createMockApiKeyService>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    mockApiKeyService = createMockApiKeyService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(PartnerService);
  });

  // ──────────────── Registration ────────────────

  it("register creates a DRAFT partner", async () => {
    const result = await service.register(VALID_REGISTER);
    expect(result.status).toBe("DRAFT");
    expect(result.legalName).toBe("Acme Finance Ltd");
    expect(result.id).toBeDefined();
  });

  // ──────────────── Submit ────────────────

  it("submit moves DRAFT → SUBMITTED and stores submission", async () => {
    const partner = await service.register(VALID_REGISTER);
    const { partner: updated, submission } = await service.submit(partner.id, {
      docs: ["kyc.pdf"],
    });
    expect(updated.status).toBe("SUBMITTED");
    expect(submission.submittedPayload).toEqual({ docs: ["kyc.pdf"] });
  });

  it("submit rejects non-DRAFT partner", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    // Now SUBMITTED — try to submit again
    await expect(service.submit(partner.id, { docs: [] })).rejects.toThrow(
      BadRequestException,
    );
  });

  // ──────────────── Start Review ────────────────

  it("startReview moves SUBMITTED → UNDER_REVIEW", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    const result = await service.startReview(partner.id);
    expect(result.status).toBe("UNDER_REVIEW");
  });

  it("startReview rejects DRAFT partner", async () => {
    const partner = await service.register(VALID_REGISTER);
    await expect(service.startReview(partner.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ──────────────── Approve ────────────────

  it("approve moves UNDER_REVIEW → VERIFIED", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    const result = await service.approve(partner.id, "admin@acme.com");
    expect(result.status).toBe("VERIFIED");
  });

  it("approve rejects SUBMITTED (must be UNDER_REVIEW)", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await expect(service.approve(partner.id, "admin@acme.com")).rejects.toThrow(
      BadRequestException,
    );
  });

  // ──────────────── Reject ────────────────

  it("reject moves UNDER_REVIEW → REJECTED with reason", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    const result = await service.reject(
      partner.id,
      "Incomplete documents",
      "admin",
    );
    expect(result.status).toBe("REJECTED");
    expect(result.rejectionReason).toBe("Incomplete documents");
  });

  it("reject from SUBMITTED fails", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await expect(service.reject(partner.id, "reason", "admin")).rejects.toThrow(
      BadRequestException,
    );
  });

  // ──────────────── Activate ────────────────

  it("activate moves VERIFIED → ACTIVE, creates pool, and issues API key", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    await service.approve(partner.id, "admin");
    const result = await service.activate(
      partner.id,
      "0xPoolAddress",
      1,
      mockApiKeyService,
    );
    expect(result.partner.status).toBe("ACTIVE");
    expect(result.pool.poolContract).toBe("0xPoolAddress");
    expect(result.pool.chainId).toBe(1);
    expect(result.apiKey.key).toMatch(/^pk_/);
    expect(result.apiKey.last4).toBe("cdef");
    expect(mockApiKeyService.issue).toHaveBeenCalledWith(partner.id);
  });

  it("activate rejects UNDER_REVIEW (must be VERIFIED)", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    await expect(
      service.activate(partner.id, "0xPool", 1, mockApiKeyService),
    ).rejects.toThrow(BadRequestException);
  });

  it("activate rejects DRAFT", async () => {
    const partner = await service.register(VALID_REGISTER);
    await expect(
      service.activate(partner.id, "0xPool", 1, mockApiKeyService),
    ).rejects.toThrow(BadRequestException);
  });

  // ──────────────── Suspend ────────────────

  it("suspend moves ACTIVE → SUSPENDED", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    await service.approve(partner.id, "admin");
    await service.activate(partner.id, "0xPool", 1, mockApiKeyService);
    const result = await service.suspend(partner.id);
    expect(result.status).toBe("SUSPENDED");
  });

  it("suspend moves VERIFIED → SUSPENDED", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    await service.approve(partner.id, "admin");
    const result = await service.suspend(partner.id);
    expect(result.status).toBe("SUSPENDED");
  });

  it("suspend rejects DRAFT", async () => {
    const partner = await service.register(VALID_REGISTER);
    await expect(service.suspend(partner.id)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ──────────────── Not found ────────────────

  it("throws NotFoundException for unknown partner", async () => {
    await expect(
      service.findById("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(NotFoundException);
  });

  // ──────────────── Full happy path ────────────────

  it("completes full lifecycle: DRAFT → SUBMITTED → UNDER_REVIEW → VERIFIED → ACTIVE", async () => {
    const partner = await service.register(VALID_REGISTER);
    expect(partner.status).toBe("DRAFT");

    const { partner: p2 } = await service.submit(partner.id, {
      documents: ["license.pdf"],
    });
    expect(p2.status).toBe("SUBMITTED");

    const p3 = await service.startReview(partner.id);
    expect(p3.status).toBe("UNDER_REVIEW");

    const p4 = await service.approve(partner.id, "compliance-officer");
    expect(p4.status).toBe("VERIFIED");

    const { partner: p5, apiKey } = await service.activate(
      partner.id,
      "0xDeadBeef",
      1,
      mockApiKeyService,
    );
    expect(p5.status).toBe("ACTIVE");
    expect(apiKey.key).toBeDefined();
  });

  // ──────────────── Rejection + resubmit path ────────────────

  it("rejected partner cannot be approved or activated directly", async () => {
    const partner = await service.register(VALID_REGISTER);
    await service.submit(partner.id, { docs: [] });
    await service.startReview(partner.id);
    await service.reject(partner.id, "Bad docs", "admin");

    await expect(service.approve(partner.id, "admin")).rejects.toThrow(
      BadRequestException,
    );

    await expect(
      service.activate(partner.id, "0xPool", 1, mockApiKeyService),
    ).rejects.toThrow(BadRequestException);
  });
});
