import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  Headers,
  ParseUUIDPipe,
  BadRequestException,
  UseGuards,
} from "@nestjs/common";
import { PartnerStatus } from "@prisma/client";
import { PartnerService } from "./partner.service";
import { PartnerApiKeyService } from "./partner-api-key.service";
import { RejectPartnerDto, ActivatePartnerDto } from "./dto";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";

const VALID_STATUSES = new Set<string>(Object.values(PartnerStatus));

@UseGuards(ApiKeyGuard)
@Controller("admin/partners")
export class AdminPartnerController {
  constructor(
    private readonly service: PartnerService,
    private readonly apiKeyService: PartnerApiKeyService,
  ) {}

  // ── Listing ──────────────────────────────────────────────────────────────

  @Get()
  async list(@Query("status") status?: string) {
    let parsed: PartnerStatus | undefined;
    if (status !== undefined) {
      if (!VALID_STATUSES.has(status)) {
        throw new BadRequestException(
          `Invalid status filter. Valid values: ${[...VALID_STATUSES].join(", ")}`,
        );
      }
      parsed = status as PartnerStatus;
    }
    const partners = await this.service.findAll(parsed);
    return partners.map((p) => ({
      partnerId: p.id,
      legalName: p.legalName,
      jurisdictionCode: p.jurisdictionCode,
      registrationNumber: p.registrationNumber,
      complianceEmail: p.complianceEmail,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));
  }

  @Get(":id")
  async findById(@Param("id", ParseUUIDPipe) id: string) {
    const p = await this.service.findById(id);
    return {
      partnerId: p.id,
      legalName: p.legalName,
      jurisdictionCode: p.jurisdictionCode,
      registrationNumber: p.registrationNumber,
      complianceEmail: p.complianceEmail,
      treasuryWallet: p.treasuryWallet,
      status: p.status,
      rejectionReason: p.rejectionReason,
      maxLoanSizeUsdc: p.maxLoanSizeUsdc.toString(),
      reserveRatioBps: p.reserveRatioBps,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  // ── State transitions ────────────────────────────────────────────────────

  @Post(":id/start-review")
  async startReview(@Param("id", ParseUUIDPipe) id: string) {
    const partner = await this.service.startReview(id);
    return { partnerId: partner.id, status: partner.status };
  }

  @Post(":id/approve")
  async approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("x-admin-subject") adminSubject?: string,
  ) {
    const subject = adminSubject?.trim() || "unknown-admin";
    const partner = await this.service.approve(id, subject);
    return { partnerId: partner.id, status: partner.status };
  }

  @Post(":id/reject")
  async reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RejectPartnerDto,
    @Headers("x-admin-subject") adminSubject?: string,
  ) {
    const subject = adminSubject?.trim() || "unknown-admin";
    const partner = await this.service.reject(id, dto.reason, subject);
    return {
      partnerId: partner.id,
      status: partner.status,
      rejectionReason: partner.rejectionReason,
    };
  }

  @Post(":id/activate")
  async activate(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ActivatePartnerDto,
  ) {
    const result = await this.service.activate(
      id,
      dto.poolContract,
      dto.chainId,
      this.apiKeyService,
    );
    return {
      partnerId: result.partner.id,
      status: result.partner.status,
      pool: {
        id: result.pool.id,
        poolContract: result.pool.poolContract,
        chainId: result.pool.chainId,
      },
      apiKey: {
        id: result.apiKey.id,
        key: result.apiKey.key,
        last4: result.apiKey.last4,
      },
    };
  }

  @Post(":id/suspend")
  async suspend(@Param("id", ParseUUIDPipe) id: string) {
    const partner = await this.service.suspend(id);
    return { partnerId: partner.id, status: partner.status };
  }
}
