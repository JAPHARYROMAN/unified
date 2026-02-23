import { Controller, Post, Get, Param, Body, ParseUUIDPipe } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { PartnerService } from "./partner.service";
import { RegisterPartnerDto } from "./dto/register-partner.dto";
import { SubmitPartnerDto } from "./dto/submit-partner.dto";

@Controller("partners")
export class PartnerController {
  constructor(private readonly service: PartnerService) {}

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post("register")
  async register(@Body() dto: RegisterPartnerDto) {
    const partner = await this.service.register(dto);
    return { partnerId: partner.id, status: partner.status };
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post(":id/submit")
  async submit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SubmitPartnerDto,
  ) {
    const { partner, submission } = await this.service.submit(id, dto.payload);
    return {
      partnerId: partner.id,
      status: partner.status,
      submissionId: submission.id,
    };
  }

  @Get(":id")
  async findById(@Param("id", ParseUUIDPipe) id: string) {
    const partner = await this.service.findById(id);
    return {
      partnerId: partner.id,
      legalName: partner.legalName,
      status: partner.status,
      createdAt: partner.createdAt,
      updatedAt: partner.updatedAt,
    };
  }
}
