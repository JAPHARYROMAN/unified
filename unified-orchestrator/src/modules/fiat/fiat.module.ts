import { Module, forwardRef } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MpesaAdapter } from "./adapters/mpesa.adapter";
import { FiatTransferService } from "./fiat-transfer.service";
import { FiatDisbursementService } from "./fiat-disbursement.service";
import { FiatRepaymentService } from "./fiat-repayment.service";
import { WebhookDeadLetterService } from "./webhook-dead-letter.service";
import { WebhookNonceService } from "./webhook-nonce.service";
import { ReconciliationScheduler } from "./reconciliation.scheduler";
import { MpesaWebhookController } from "./mpesa-webhook.controller";
import { ChainActionModule } from "../chain-action/chain-action.module";
import { LoanModule } from "../loan/loan.module";
import { PrismaModule } from "../prisma";
import { OpsModule } from "../ops/ops.module";

@Module({
  imports: [
    ChainActionModule,
    LoanModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    forwardRef(() => OpsModule),
  ],
  controllers: [MpesaWebhookController],
  providers: [
    MpesaAdapter,
    FiatTransferService,
    FiatDisbursementService,
    FiatRepaymentService,
    WebhookDeadLetterService,
    WebhookNonceService,
    ReconciliationScheduler,
  ],
  exports: [FiatTransferService, FiatDisbursementService, FiatRepaymentService, WebhookNonceService],
})
export class FiatModule {}
