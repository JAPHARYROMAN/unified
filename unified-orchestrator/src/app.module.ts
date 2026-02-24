import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "./modules/config";
import { PrismaModule } from "./modules/prisma";
import { HealthModule } from "./modules/health";
import { PartnerModule } from "./modules/partner";
import { LoanModule } from "./modules/loan";
import { ChainActionModule } from "./modules/chain-action";
import { GuardrailModule } from "./modules/guardrail";
import { OpsModule } from "./modules/ops";
import { FiatModule } from "./modules/fiat/fiat.module";
import { TrancheModule } from "./modules/tranche/tranche.module";
import { RequestLoggerMiddleware } from "./common/middleware/request-logger.middleware";

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([
      {
        name: "default",
        ttl: 60_000,
        limit: 60,
      },
    ]),
    PrismaModule,
    HealthModule,
    PartnerModule,
    LoanModule,
    ChainActionModule,
    GuardrailModule,
    OpsModule,
    FiatModule,
    TrancheModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes("*");
  }
}
