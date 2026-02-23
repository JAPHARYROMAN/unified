import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  ParseUUIDPipe,
  UseGuards,
} from "@nestjs/common";
import { GuardrailService } from "./guardrail.service";
import { CreateGuardrailDto } from "./dto";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";

@UseGuards(ApiKeyGuard)
@Controller("admin/partners")
export class AdminGuardrailController {
  constructor(private readonly service: GuardrailService) {}

  @Post(":id/guardrails")
  async create(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateGuardrailDto,
  ) {
    const guardrail = await this.service.create(id, {
      minAprBps: dto.minAprBps,
      maxAprBps: dto.maxAprBps,
      minDurationSec: dto.minDurationSec,
      maxDurationSec: dto.maxDurationSec,
      maxLoanUsdc: dto.maxLoanUsdc,
      maxBorrowerOutstandingUsdc: dto.maxBorrowerOutstandingUsdc,
      minReserveRatioBps: dto.minReserveRatioBps,
    });

    return this.serialize(guardrail);
  }

  @Get(":id/guardrails")
  async list(@Param("id", ParseUUIDPipe) id: string) {
    const guardrails = await this.service.findByPartner(id);
    return guardrails.map((g) => this.serialize(g));
  }

  private serialize(g: any) {
    return {
      id: g.id,
      partnerId: g.partnerId,
      minAprBps: g.minAprBps,
      maxAprBps: g.maxAprBps,
      minDurationSec: g.minDurationSec,
      maxDurationSec: g.maxDurationSec,
      maxLoanUsdc: g.maxLoanUsdc.toString(),
      maxBorrowerOutstandingUsdc: g.maxBorrowerOutstandingUsdc.toString(),
      minReserveRatioBps: g.minReserveRatioBps,
      effectiveFrom: g.effectiveFrom,
      effectiveTo: g.effectiveTo,
    };
  }
}
