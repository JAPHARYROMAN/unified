import {
  IsString,
  IsInt,
  IsEmail,
  IsOptional,
  Matches,
  MaxLength,
  Min,
  Max,
  IsNotEmpty,
} from "class-validator";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class RegisterPartnerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string;

  @IsInt()
  @Min(1)
  @Max(999_999)
  jurisdictionCode: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  licenseId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  registrationNumber: string;

  @IsEmail()
  @MaxLength(254)
  complianceEmail: string;

  @IsString()
  @Matches(ETH_ADDRESS_RE, {
    message: "treasuryWallet must be a valid Ethereum address (0x…)",
  })
  treasuryWallet: string;
}
