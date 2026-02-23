import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma";
import { LoanStatus } from "@prisma/client";

@Injectable()
export class GuardrailService {
  private readonly logger = new Logger(GuardrailService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new guardrail set for a partner.
   * Auto-closes any previously active guardrail by setting effective_to = now.
   */
  async create(
    partnerId: string,
    params: {
      minAprBps: number;
      maxAprBps: number;
      minDurationSec: number;
      maxDurationSec: number;
      maxLoanUsdc: bigint;
      maxBorrowerOutstandingUsdc: bigint;
      minReserveRatioBps: number;
    },
  ) {
    // Validate ranges
    if (params.minAprBps > params.maxAprBps) {
      throw new BadRequestException("minAprBps must be <= maxAprBps");
    }
    if (params.minDurationSec > params.maxDurationSec) {
      throw new BadRequestException("minDurationSec must be <= maxDurationSec");
    }

    // Verify partner exists
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
    });
    if (!partner) {
      throw new NotFoundException(`Partner ${partnerId} not found`);
    }

    const now = new Date();

    // Close current active guardrail (if any)
    await this.prisma.partnerGuardrail.updateMany({
      where: {
        partnerId,
        effectiveTo: null,
      },
      data: {
        effectiveTo: now,
      },
    });

    // Create new guardrail
    const guardrail = await this.prisma.partnerGuardrail.create({
      data: {
        partnerId,
        minAprBps: params.minAprBps,
        maxAprBps: params.maxAprBps,
        minDurationSec: params.minDurationSec,
        maxDurationSec: params.maxDurationSec,
        maxLoanUsdc: params.maxLoanUsdc,
        maxBorrowerOutstandingUsdc: params.maxBorrowerOutstandingUsdc,
        minReserveRatioBps: params.minReserveRatioBps,
        effectiveFrom: now,
      },
    });

    this.logger.log(
      `Guardrail ${guardrail.id} created for partner ${partnerId}`,
    );
    return guardrail;
  }

  /**
   * Return full guardrail history for a partner (newest first).
   */
  async findByPartner(partnerId: string) {
    return this.prisma.partnerGuardrail.findMany({
      where: { partnerId },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /**
   * Return the currently active guardrail for a partner (effectiveTo is null).
   */
  async findActive(partnerId: string) {
    return this.prisma.partnerGuardrail.findFirst({
      where: {
        partnerId,
        effectiveTo: null,
      },
    });
  }

  /**
   * Validate loan params against active guardrails.
   * Throws BadRequestException on violation.
   */
  async enforce(
    partnerId: string,
    params: {
      interestRateBps: number;
      durationSeconds: number;
      principalUsdc: bigint;
      borrowerWallet: string;
    },
  ) {
    const guardrail = await this.findActive(partnerId);
    if (!guardrail) {
      // No guardrails configured — pass through
      return;
    }

    // APR check
    if (params.interestRateBps < guardrail.minAprBps) {
      throw new BadRequestException(
        `APR ${params.interestRateBps} bps is below guardrail minimum ${guardrail.minAprBps} bps`,
      );
    }
    if (params.interestRateBps > guardrail.maxAprBps) {
      throw new BadRequestException(
        `APR ${params.interestRateBps} bps exceeds guardrail maximum ${guardrail.maxAprBps} bps`,
      );
    }

    // Duration check
    if (params.durationSeconds < guardrail.minDurationSec) {
      throw new BadRequestException(
        `Duration ${params.durationSeconds}s is below guardrail minimum ${guardrail.minDurationSec}s`,
      );
    }
    if (params.durationSeconds > guardrail.maxDurationSec) {
      throw new BadRequestException(
        `Duration ${params.durationSeconds}s exceeds guardrail maximum ${guardrail.maxDurationSec}s`,
      );
    }

    // Principal cap
    if (params.principalUsdc > guardrail.maxLoanUsdc) {
      throw new BadRequestException(
        `Principal ${params.principalUsdc} exceeds guardrail max loan ${guardrail.maxLoanUsdc}`,
      );
    }

    // Borrower outstanding exposure
    const outstandingAgg = await this.prisma.loan.aggregate({
      where: {
        partnerId,
        borrowerWallet: params.borrowerWallet,
        status: {
          in: [LoanStatus.FUNDING, LoanStatus.ACTIVE, LoanStatus.DEFAULTED],
        },
      },
      _sum: { principalUsdc: true },
    });

    const currentExposure = outstandingAgg._sum.principalUsdc ?? 0n;
    const projectedExposure = currentExposure + params.principalUsdc;

    if (projectedExposure > guardrail.maxBorrowerOutstandingUsdc) {
      throw new BadRequestException(
        `Borrower exposure ${projectedExposure} would exceed guardrail max ${guardrail.maxBorrowerOutstandingUsdc} (current: ${currentExposure})`,
      );
    }

    // Reserve ratio check (soft / stub for v1)
    if (guardrail.minReserveRatioBps > 0) {
      this.logger.debug(
        `Reserve ratio guardrail: ${guardrail.minReserveRatioBps} bps (stub pass for v1)`,
      );
    }
  }
}
