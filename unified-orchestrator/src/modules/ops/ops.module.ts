import { Module, forwardRef } from "@nestjs/common";
import { PrismaModule } from "../prisma";
import { OpsService } from "./ops.service";
import { OpsController } from "./ops.controller";
import { ChainActionModule } from "../chain-action/chain-action.module";

@Module({
  imports: [PrismaModule, forwardRef(() => ChainActionModule)],
  providers: [OpsService],
  controllers: [OpsController],
  exports: [OpsService],
})
export class OpsModule {}
