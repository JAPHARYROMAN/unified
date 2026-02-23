import { ExecutionContext, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiKeyGuard } from "./api-key.guard";

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) => headers[name.toLowerCase()],
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(adminApiKey: string | undefined): ApiKeyGuard {
  const config = { get: (_key: string) => adminApiKey } as unknown as ConfigService;
  return new ApiKeyGuard(config);
}

describe("ApiKeyGuard — fail-closed", () => {
  it("throws 500 when ADMIN_API_KEY is not configured", () => {
    const guard = makeGuard(undefined);
    const ctx = makeContext({ "x-api-key": "anything" });
    expect(() => guard.canActivate(ctx)).toThrow(InternalServerErrorException);
  });

  it("throws 401 when no x-api-key header is provided", () => {
    const guard = makeGuard("super-secret-admin-key-1234");
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("throws 401 when x-api-key is wrong", () => {
    const guard = makeGuard("super-secret-admin-key-1234");
    const ctx = makeContext({ "x-api-key": "wrong-key" });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("returns true when x-api-key matches ADMIN_API_KEY", () => {
    const key = "super-secret-admin-key-1234";
    const guard = makeGuard(key);
    const ctx = makeContext({ "x-api-key": key });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("never allows through when ADMIN_API_KEY is empty string", () => {
    const guard = makeGuard("");
    const ctx = makeContext({ "x-api-key": "" });
    // empty string is falsy — treated as not configured
    expect(() => guard.canActivate(ctx)).toThrow(InternalServerErrorException);
  });
});
