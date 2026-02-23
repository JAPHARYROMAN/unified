import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import { Request } from "express";
import { LoanService } from "./loan.service";
import { CreateLoanDto } from "./dto";
import { PartnerAuthGuard } from "../../common/guards/partner-auth.guard";

@UseGuards(PartnerAuthGuard)
@Controller("loans")
export class LoanController {
  constructor(private readonly service: LoanService) {}

  @Post()
  async create(@Req() req: Request, @Body() dto: CreateLoanDto) {
    const partnerId = (req as any).partnerId as string;
    const { loan, chainActionId } = await this.service.createLoan(partnerId, {
      borrowerWallet: dto.borrowerWallet,
      principalUsdc: dto.principalUsdc,
      collateralToken: dto.collateralToken,
      collateralAmount: dto.collateralAmount,
      durationSeconds: dto.durationSeconds,
      interestRateBps: dto.interestRateBps,
    });

    return {
      loanId: loan.id,
      status: loan.status,
      chainActionId,
    };
  }

  @Get(":id")
  async findById(@Param("id", ParseUUIDPipe) id: string) {
    const loan = await this.service.findById(id);
    return this.serialize(loan);
  }

  @Get()
  async findByPartner(@Req() req: Request) {
    const partnerId = (req as any).partnerId as string;
    const loans = await this.service.findByPartner(partnerId);
    return loans.map((l) => this.serialize(l));
  }

  private serialize(loan: any) {
    return {
      id: loan.id,
      partnerId: loan.partnerId,
      borrowerWallet: loan.borrowerWallet,
      principalUsdc: loan.principalUsdc.toString(),
      collateralToken: loan.collateralToken,
      collateralAmount: loan.collateralAmount.toString(),
      durationSeconds: loan.durationSeconds,
      interestRateBps: loan.interestRateBps,
      status: loan.status,
      loanContract: loan.loanContract,
      poolContract: loan.poolContract,
      chainId: loan.chainId,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
    };
  }
}
