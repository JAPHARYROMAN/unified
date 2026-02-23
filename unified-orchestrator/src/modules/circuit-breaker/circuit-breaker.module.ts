import { Module, forwardRef } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma";
import { OpsModule } from "../ops/ops.module";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { CircuitBreakerMetricsService } from "./circuit-breaker-metrics.service";
import { CircuitBreakerAlertService } from "./circuit-breaker-alert.service";
import { CircuitBreakerScheduler } from "./circuit-breaker.scheduler";
import { BreakerAdminController } from "./breaker-admin.controller";

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    ScheduleModule.forRoot(),
    forwardRef(() => OpsModule),
  ],
  controllers: [BreakerAdminController],
  providers: [
    CircuitBreakerService,
    CircuitBreakerMetricsService,
    CircuitBreakerAlertService,
    CircuitBreakerScheduler,
  ],
  exports: [CircuitBreakerService],
})
export class CircuitBreakerModule {}
