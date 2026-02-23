import { Module } from "@nestjs/common";
import { GuardrailService } from "./guardrail.service";
import { AdminGuardrailController } from "./admin-guardrail.controller";

@Module({
  controllers: [AdminGuardrailController],
  providers: [GuardrailService],
  exports: [GuardrailService],
})
export class GuardrailModule {}
