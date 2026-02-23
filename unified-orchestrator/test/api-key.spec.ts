import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { PartnerApiKeyService } from "../src/modules/partner/partner-api-key.service";
import { PartnerAuthGuard } from "../src/common/guards/partner-auth.guard";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { hashApiKey } from "../src/common/utils/api-key.util";
import { ExecutionContext } from "@nestjs/common";

// ─── In-memory mock for partnerApiKey table ───

function createMockPrisma() {
  const keys = new Map<string, any>();

  return {
    keys,
    partnerApiKey: {
      create: jest.fn(async ({ data }: any) => {
        const id = crypto.randomUUID();
        const record = {
          id,
          ...data,
          createdAt: new Date(),
          revokedAt: null,
        };
        keys.set(id, record);
        return record;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const k of keys.values()) {
          if (
            k.keyHash === where.keyHash &&
            (where.revokedAt === null ? k.revokedAt === null : true)
          ) {
            return k;
          }
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = keys.get(where.id);
        if (!existing) throw new Error("key not found");
        const updated = { ...existing, ...data };
        keys.set(where.id, updated);
        return updated;
      }),
    },
  };
}

function mockExecutionContext(
  headers: Record<string, string>,
): ExecutionContext {
  const req: any = {
    header: (name: string) => headers[name.toLowerCase()],
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as any;
}

// ───────────────────────────────────────────────
// PartnerApiKeyService tests
// ───────────────────────────────────────────────

describe("PartnerApiKeyService", () => {
  let service: PartnerApiKeyService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerApiKeyService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(PartnerApiKeyService);
  });

  it("issue() returns plaintext key starting with pk_", async () => {
    const result = await service.issue("partner-123");
    expect(result.plaintext).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(result.last4.length).toBe(4);
    expect(result.id).toBeDefined();
  });

  it("issue() stores hash, not plaintext", async () => {
    const result = await service.issue("partner-123");
    const createCall = mockPrisma.partnerApiKey.create.mock.calls[0][0];
    expect(createCall.data.keyHash).toBe(hashApiKey(result.plaintext));
    expect(createCall.data.keyHash).not.toBe(result.plaintext);
  });

  it("validate() returns partnerId for valid key", async () => {
    const { plaintext } = await service.issue("partner-abc");
    const partnerId = await service.validate(plaintext);
    expect(partnerId).toBe("partner-abc");
  });

  it("validate() returns null for unknown key", async () => {
    const result = await service.validate("pk_nonexistent");
    expect(result).toBeNull();
  });

  it("validate() returns null after revocation", async () => {
    const { id, plaintext } = await service.issue("partner-xyz");
    await service.revoke(id);
    const result = await service.validate(plaintext);
    expect(result).toBeNull();
  });

  it("revoke() sets revokedAt on the key record", async () => {
    const { id } = await service.issue("partner-xyz");
    await service.revoke(id);
    const record = mockPrisma.keys.get(id);
    expect(record.revokedAt).toBeInstanceOf(Date);
  });
});

// ───────────────────────────────────────────────
// PartnerAuthGuard tests
// ───────────────────────────────────────────────

describe("PartnerAuthGuard", () => {
  let guard: PartnerAuthGuard;
  let apiKeyService: PartnerApiKeyService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerApiKeyService,
        PartnerAuthGuard,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    apiKeyService = module.get(PartnerApiKeyService);
    guard = module.get(PartnerAuthGuard);
  });

  it("allows request with valid API key and attaches partnerId", async () => {
    const { plaintext } = await apiKeyService.issue("partner-good");
    const ctx = mockExecutionContext({ "x-api-key": plaintext });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);

    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.partnerId).toBe("partner-good");
  });

  it("rejects request with missing header", async () => {
    const ctx = mockExecutionContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects request with invalid key", async () => {
    const ctx = mockExecutionContext({ "x-api-key": "pk_badkey" });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects request with revoked key", async () => {
    const { id, plaintext } = await apiKeyService.issue("partner-revoked");
    await apiKeyService.revoke(id);
    const ctx = mockExecutionContext({ "x-api-key": plaintext });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
