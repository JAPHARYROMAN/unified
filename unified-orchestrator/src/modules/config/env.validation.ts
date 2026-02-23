import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";
import { Transform } from "class-transformer";

export enum Environment {
  Development = "development",
  Staging = "staging",
  Production = "production",
  Test = "test",
}

/** Returns true when we are NOT running in Jest / unit-test mode. */
const notTest = (o: EnvironmentVariables) => o.NODE_ENV !== Environment.Test;

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  /**
   * Admin API key — protects /admin/* routes.
   * Required at startup; no fail-open fallback.
   */
  @IsString()
  @MinLength(16)
  ADMIN_API_KEY: string;

  /**
   * Comma-separated list of allowed CORS origins.
   * Example: https://app.unified.finance,https://admin.unified.finance
   */
  @IsString()
  @MinLength(1)
  CORS_ORIGINS: string;

  // ── Chain action sender ────────────────────────────────────────────────────
  // Required in all non-test environments. Missing values cause a startup
  // failure rather than a silently non-functional sender (no fail-open).

  /** JSON-RPC endpoint for the signer (Polygon mainnet or Amoy testnet). */
  @ValidateIf(notTest)
  @IsString()
  @MinLength(1)
  CHAIN_ACTION_RPC_URL?: string;

  /** Deployed UnifiedLoanFactory contract address. */
  @ValidateIf(notTest)
  @IsString()
  @MinLength(1)
  CHAIN_ACTION_FACTORY_ADDRESS?: string;

  /** Private key of the funded deployer / relayer wallet. */
  @ValidateIf(notTest)
  @IsString()
  @MinLength(32)
  CHAIN_ACTION_SIGNER_PRIVATE_KEY?: string;

  /** Legacy: kept for backward compatibility; no longer gates the worker. */
  @IsOptional()
  @IsString()
  E2E_MODE?: string;
}
