import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { PartnerAuthGuard } from "./partner-auth.guard";
import { PartnerApiKeyService } from "../../modules/partner/partner-api-key.service";

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  const req: Record<string, unknown> = {
    header: (name: string) => headers[name.toLowerCase()],
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(resolvedPartnerId: string | null): PartnerAuthGuard {
  const apiKeyService = {
    validate: jest.fn().mockResolvedValue(resolvedPartnerId),
  } as unknown as PartnerApiKeyService;
  return new PartnerAuthGuard(apiKeyService);
}

describe("PartnerAuthGuard", () => {
  it("throws 401 when x-api-key header is missing", async () => {
    const guard = makeGuard("partner-uuid");
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("throws 401 when key is invalid or revoked", async () => {
    const guard = makeGuard(null);
    const ctx = makeContext({ "x-api-key": "bad-key" });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("returns true and attaches partnerId when key is valid", async () => {
    const guard = makeGuard("partner-uuid-123");
    const req: Record<string, unknown> = {
      header: (name: string) =>
        name.toLowerCase() === "x-api-key" ? "valid-key" : undefined,
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req["partnerId"]).toBe("partner-uuid-123");
  });
});
