import { IsString, IsOptional, IsNotEmpty, IsInt, Min } from "class-validator";

export class RejectPartnerDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ActivatePartnerDto {
  @IsString()
  @IsNotEmpty()
  poolContract: string;

  @IsInt()
  @Min(1)
  chainId: number;
}
