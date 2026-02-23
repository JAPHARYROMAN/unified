import { Module, forwardRef } from "@nestjs/common";
import { LoanService } from "./loan.service";
import { LoanController } from "./loan.controller";
import { ChainActionModule } from "../chain-action/chain-action.module";
import { PartnerModule } from "../partner/partner.module";
import { GuardrailModule } from "../guardrail/guardrail.module";
import { CircuitBreakerModule } from "../circuit-breaker";

@Module({
  imports: [
    forwardRef(() => ChainActionModule),
    PartnerModule,
    GuardrailModule,
    CircuitBreakerModule,
  ],
  controllers: [LoanController],
  providers: [LoanService],
  exports: [LoanService],
})
export class LoanModule {}
