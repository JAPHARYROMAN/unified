import { Module } from "@nestjs/common";
import { PartnerService } from "./partner.service";
import { PartnerApiKeyService } from "./partner-api-key.service";
import { PartnerController } from "./partner.controller";
import { AdminPartnerController } from "./admin-partner.controller";
import { PartnerAuthGuard } from "../../common/guards/partner-auth.guard";

@Module({
  controllers: [PartnerController, AdminPartnerController],
  providers: [PartnerService, PartnerApiKeyService, PartnerAuthGuard],
  exports: [PartnerService, PartnerApiKeyService, PartnerAuthGuard],
})
export class PartnerModule {}
