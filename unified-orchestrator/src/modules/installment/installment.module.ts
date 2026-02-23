import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma";
import { CircuitBreakerModule } from "../circuit-breaker/circuit-breaker.module";
import { InstallmentScheduleService } from "./installment-schedule.service";
import { InstallmentEvaluationService } from "./installment-evaluation.service";
import { InstallmentAccrualService } from "./installment-accrual.service";
import { InstallmentBreakerFeedService } from "./installment-breaker-feed.service";
import { InstallmentReconciliationService } from "./installment-reconciliation.service";
import { InstallmentReportService } from "./installment-report.service";
import { InstallmentSettlementCheckService } from "./installment-settlement-check.service";
import { InstallmentDriftService } from "./installment-drift.service";
import { InstallmentScheduler } from "./installment.scheduler";

@Module({
  imports: [PrismaModule, CircuitBreakerModule],
  providers: [
    InstallmentScheduleService,
    InstallmentEvaluationService,
    InstallmentAccrualService,
    InstallmentBreakerFeedService,
    InstallmentDriftService,
    InstallmentReconciliationService,
    InstallmentReportService,
    InstallmentSettlementCheckService,
    InstallmentScheduler,
  ],
  exports: [
    InstallmentScheduleService,
    InstallmentEvaluationService,
    InstallmentAccrualService,
    InstallmentBreakerFeedService,
    InstallmentDriftService,
    InstallmentReconciliationService,
    InstallmentReportService,
    InstallmentSettlementCheckService,
  ],
})
export class InstallmentModule {}
