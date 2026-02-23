import { Module, forwardRef } from "@nestjs/common";
import { ChainActionService } from "./chain-action.service";
import { ChainActionWorker } from "./chain-action.worker";
import { ChainActionAdminController } from "./chain-action.admin.controller";
import { LoanModule } from "../loan/loan.module";
import { TxMetricsService } from "./tx-metrics.service";
import { SignerNonceService } from "./signer-nonce.service";
import { PrismaModule } from "../prisma";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [forwardRef(() => LoanModule), PrismaModule, ConfigModule],
  controllers: [ChainActionAdminController],
  providers: [ChainActionService, ChainActionWorker, TxMetricsService, SignerNonceService],
  exports: [ChainActionService, ChainActionWorker, TxMetricsService, SignerNonceService],
})
export class ChainActionModule {}
