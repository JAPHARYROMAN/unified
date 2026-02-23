import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    let dbStatus = "up";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "down";
    }

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      database: dbStatus,
    };
  }
}
