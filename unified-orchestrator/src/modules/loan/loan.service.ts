import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Logger,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../prisma";
import { ChainActionService } from "../chain-action/chain-action.service";
import { GuardrailService } from "../guardrail/guardrail.service";
import { CircuitBreakerService } from "../circuit-breaker";
import {
  PartnerStatus,
  LoanStatus,
  ChainActionType,
  Prisma,
} from "@prisma/client";

@Injectable()
export class LoanService {
  private readonly logger = new Logger(LoanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chainActions: ChainActionService,
    private readonly guardrails: GuardrailService,
    @Optional() private readonly circuitBreaker?: CircuitBreakerService,
  ) {}

  // ──────────────────── Create loan ────────────────────

  async createLoan(
    partnerId: string,
    params: {
      borrowerWallet: string;
      principalUsdc: bigint;
      collateralToken: string;
      collateralAmount: bigint;
      durationSeconds: number;
      interestRateBps: number;
    },
  ) {
    // 0. Circuit-breaker enforcement
    if (this.circuitBreaker) {
      await this.circuitBreaker.assertOriginationAllowed(partnerId);
    }

    // 1. Load partner & enforce ACTIVE
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: { pools: true },
    });
    if (!partner) throw new NotFoundException(`Partner ${partnerId} not found`);
    if (partner.status !== PartnerStatus.ACTIVE) {
      throw new ForbiddenException(
        "Partner is not ACTIVE — cannot originate loans",
      );
    }

    // 2. Confirm partner has a linked pool
    if (partner.pools.length === 0) {
      throw new BadRequestException("Partner has no linked pool");
    }
    const pool = partner.pools[0]; // use first pool for v1

    // 3. Enforce max_loan_size_usdc
    if (
      partner.maxLoanSizeUsdc > 0n &&
      params.principalUsdc > partner.maxLoanSizeUsdc
    ) {
      throw new BadRequestException(
        `Principal ${params.principalUsdc} exceeds max loan size ${partner.maxLoanSizeUsdc}`,
      );
    }

    // 4. Reserve ratio policy (stub for v1 — just check it's configured)
    if (partner.reserveRatioBps > 0) {
      // In v2 this would read pool on-chain balance and validate
      this.logger.debug(
        `Reserve ratio check: ${partner.reserveRatioBps} bps (stub pass)`,
      );
    }

    // 5. Validate borrower wallet
    if (!params.borrowerWallet || params.borrowerWallet.length < 10) {
      throw new BadRequestException("Invalid borrower wallet address");
    }

    // 6. Enforce partner guardrails (APR, duration, principal, borrower exposure)
    await this.guardrails.enforce(partnerId, {
      interestRateBps: params.interestRateBps,
      durationSeconds: params.durationSeconds,
      principalUsdc: params.principalUsdc,
      borrowerWallet: params.borrowerWallet,
    });

    // 7. Insert loan row
    const loan = await this.prisma.loan.create({
      data: {
        partnerId,
        borrowerWallet: params.borrowerWallet,
        principalUsdc: params.principalUsdc,
        collateralToken: params.collateralToken,
        collateralAmount: params.collateralAmount,
        durationSeconds: params.durationSeconds,
        interestRateBps: params.interestRateBps,
        status: LoanStatus.CREATED,
        poolContract: pool.poolContract,
        chainId: pool.chainId,
      },
    });

    // 8. Enqueue chain action
    const action = await this.chainActions.enqueue(
      loan.id,
      ChainActionType.CREATE_LOAN,
      {
        factory: "UnifiedLoanFactory",
        borrower: params.borrowerWallet,
        principal: params.principalUsdc.toString(),
        collateralToken: params.collateralToken,
        collateralAmount: params.collateralAmount.toString(),
        duration: params.durationSeconds,
        interestRateBps: params.interestRateBps,
        pool: pool.poolContract,
        chainId: pool.chainId,
      },
    );

    this.logger.log(
      `Loan ${loan.id} created → chain action ${action.id} queued`,
    );
    return { loan, chainActionId: action.id };
  }

  // ──────────────────── Read ────────────────────

  async findById(id: string) {
    const loan = await this.prisma.loan.findUnique({
      where: { id },
      include: { chainActions: true },
    });
    if (!loan) throw new NotFoundException(`Loan ${id} not found`);
    return loan;
  }

  async findByPartner(partnerId: string) {
    return this.prisma.loan.findMany({
      where: { partnerId },
      orderBy: { createdAt: "desc" },
    });
  }

  // ──────────────────── Status updates ────────────────────

  async transitionToFunding(loanId: string, loanContract: string) {
    return this.prisma.loan.update({
      where: { id: loanId },
      data: {
        status: LoanStatus.FUNDING,
        loanContract,
      },
    });
  }
}
