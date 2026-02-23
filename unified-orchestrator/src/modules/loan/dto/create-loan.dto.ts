import { IsString, IsNotEmpty, IsInt, Min, Max } from "class-validator";
import { Transform } from "class-transformer";

export class CreateLoanDto {
  @IsString()
  @IsNotEmpty()
  borrowerWallet: string;

  @Transform(({ value }) => BigInt(value), { toClassOnly: true })
  principalUsdc: bigint;

  @IsString()
  @IsNotEmpty()
  collateralToken: string;

  @Transform(({ value }) => BigInt(value), { toClassOnly: true })
  collateralAmount: bigint;

  @IsInt()
  @Min(60) // at least 1 minute
  durationSeconds: number;

  @IsInt()
  @Min(1)
  @Max(10000) // max 100%
  interestRateBps: number;
}
