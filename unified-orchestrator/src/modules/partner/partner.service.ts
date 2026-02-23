import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "../prisma";
import { PartnerStatus, Prisma } from "@prisma/client";
import { RegisterPartnerDto } from "./dto/register-partner.dto";

// ─── Valid state transitions ───
const TRANSITIONS: Record<string, PartnerStatus> = {
  "DRAFT->SUBMITTED": PartnerStatus.SUBMITTED,
  "SUBMITTED->UNDER_REVIEW": PartnerStatus.UNDER_REVIEW,
  "UNDER_REVIEW->VERIFIED": PartnerStatus.VERIFIED,
  "UNDER_REVIEW->REJECTED": PartnerStatus.REJECTED,
  "VERIFIED->ACTIVE": PartnerStatus.ACTIVE,
  "ACTIVE->SUSPENDED": PartnerStatus.SUSPENDED,
  "VERIFIED->SUSPENDED": PartnerStatus.SUSPENDED,
};

@Injectable()
export class PartnerService {
  private readonly logger = new Logger(PartnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────── helpers ────────────────────

  private async findOrFail(id: string) {
    const partner = await this.prisma.partner.findUnique({ where: { id } });
    if (!partner) throw new NotFoundException(`Partner ${id} not found`);
    return partner;
  }

  private assertTransition(from: PartnerStatus, to: PartnerStatus) {
    const key = `${from}->${to}`;
    if (!TRANSITIONS[key]) {
      throw new BadRequestException(`Invalid transition: ${from} → ${to}`);
    }
  }

  // ──────────────────── public endpoints ────────────────────

  async register(dto: RegisterPartnerDto) {
    const partner = await this.prisma.partner.create({
      data: {
        legalName: dto.legalName,
        jurisdictionCode: dto.jurisdictionCode,
        licenseId: dto.licenseId ?? null,
        registrationNumber: dto.registrationNumber,
        complianceEmail: dto.complianceEmail,
        treasuryWallet: dto.treasuryWallet,
        status: PartnerStatus.DRAFT,
      },
    });
    this.logger.log(`Partner registered: ${partner.id}`);
    return partner;
  }

  async submit(id: string, payload: Record<string, unknown>) {
    const partner = await this.findOrFail(id);

    // Validate required fields exist in draft
    this.validateDraftFields(partner);

    this.assertTransition(partner.status, PartnerStatus.SUBMITTED);

    const [updated, submission] = await this.prisma.$transaction([
      this.prisma.partner.update({
        where: { id },
        data: { status: PartnerStatus.SUBMITTED },
      }),
      this.prisma.partnerSubmission.create({
        data: {
          partnerId: id,
          submittedPayload: payload as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.logger.log(`Partner ${id} submitted (submission ${submission.id})`);
    return { partner: updated, submission };
  }

  // ──────────────────── admin endpoints ────────────────────

  async startReview(id: string) {
    const partner = await this.findOrFail(id);
    this.assertTransition(partner.status, PartnerStatus.UNDER_REVIEW);

    return this.prisma.partner.update({
      where: { id },
      data: { status: PartnerStatus.UNDER_REVIEW },
    });
  }

  async approve(id: string, adminSubject: string) {
    const partner = await this.findOrFail(id);
    this.assertTransition(partner.status, PartnerStatus.VERIFIED);

    // Mark latest submission as reviewed
    const latestSub = await this.prisma.partnerSubmission.findFirst({
      where: { partnerId: id },
      orderBy: { submittedAt: "desc" },
    });

    if (latestSub) {
      await this.prisma.partnerSubmission.update({
        where: { id: latestSub.id },
        data: { reviewedAt: new Date(), reviewedBy: adminSubject },
      });
    }

    return this.prisma.partner.update({
      where: { id },
      data: { status: PartnerStatus.VERIFIED, rejectionReason: null },
    });
  }

  async reject(id: string, reason: string, adminSubject: string) {
    const partner = await this.findOrFail(id);
    this.assertTransition(partner.status, PartnerStatus.REJECTED);

    const latestSub = await this.prisma.partnerSubmission.findFirst({
      where: { partnerId: id },
      orderBy: { submittedAt: "desc" },
    });

    if (latestSub) {
      await this.prisma.partnerSubmission.update({
        where: { id: latestSub.id },
        data: { reviewedAt: new Date(), reviewedBy: adminSubject, notes: reason },
      });
    }

    return this.prisma.partner.update({
      where: { id },
      data: { status: PartnerStatus.REJECTED, rejectionReason: reason },
    });
  }

  async activate(
    id: string,
    poolContract: string,
    chainId: number,
    apiKeyService: {
      issue(
        partnerId: string,
      ): Promise<{ id: string; plaintext: string; last4: string }>;
    },
  ) {
    const partner = await this.findOrFail(id);
    this.assertTransition(partner.status, PartnerStatus.ACTIVE);

    // Create pool mapping
    const pool = await this.prisma.partnerPool.create({
      data: { partnerId: id, poolContract, chainId },
    });

    // Issue API key (hash stored, plaintext returned once)
    const { id: keyId, plaintext, last4 } = await apiKeyService.issue(id);

    // Transition to ACTIVE
    const updated = await this.prisma.partner.update({
      where: { id },
      data: { status: PartnerStatus.ACTIVE },
    });

    this.logger.log(
      `Partner ${id} activated — pool=${poolContract} chain=${chainId}`,
    );
    return {
      partner: updated,
      pool,
      apiKey: { id: keyId, key: plaintext, last4 },
    };
  }

  async suspend(id: string, reason?: string) {
    const partner = await this.findOrFail(id);
    this.assertTransition(partner.status, PartnerStatus.SUSPENDED);

    return this.prisma.partner.update({
      where: { id },
      data: {
        status: PartnerStatus.SUSPENDED,
        rejectionReason: reason ?? null,
      },
    });
  }

  // ──────────────────── read ────────────────────

  async findById(id: string) {
    return this.findOrFail(id);
  }

  async findAll(status?: PartnerStatus) {
    return this.prisma.partner.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
    });
  }

  // ──────────────────── validation ────────────────────

  private validateDraftFields(partner: {
    legalName: string;
    registrationNumber: string;
    complianceEmail: string;
    treasuryWallet: string;
  }) {
    const missing: string[] = [];
    if (!partner.legalName) missing.push("legalName");
    if (!partner.registrationNumber) missing.push("registrationNumber");
    if (!partner.complianceEmail) missing.push("complianceEmail");
    if (!partner.treasuryWallet) missing.push("treasuryWallet");

    if (missing.length > 0) {
      throw new BadRequestException(
        `Cannot submit — missing required fields: ${missing.join(", ")}`,
      );
    }
  }
}
