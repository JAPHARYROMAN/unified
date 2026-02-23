import { IsInt, Min, Max } from "class-validator";
import { Transform } from "class-transformer";

export class CreateGuardrailDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  minAprBps: number;

  @IsInt()
  @Min(0)
  @Max(10000)
  maxAprBps: number;

  @IsInt()
  @Min(60) // at least 1 minute
  minDurationSec: number;

  @IsInt()
  @Min(60)
  maxDurationSec: number;

  @Transform(({ value }) => BigInt(value), { toClassOnly: true })
  maxLoanUsdc: bigint;

  @Transform(({ value }) => BigInt(value), { toClassOnly: true })
  maxBorrowerOutstandingUsdc: bigint;

  @IsInt()
  @Min(0)
  @Max(10000)
  minReserveRatioBps: number;
}
