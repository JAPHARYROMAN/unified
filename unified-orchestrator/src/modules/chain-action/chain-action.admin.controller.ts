import { Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ChainActionStatus } from "@prisma/client";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { ChainActionWorker } from "./chain-action.worker";
import { ChainActionService } from "./chain-action.service";

/**
 * Admin endpoints for the chain action sender.
 *
 * All routes are protected by the API-key guard (x-api-key header).
 *
 * POST /admin/chain-actions/pause   — Stop the sender loop (maintenance mode).
 * POST /admin/chain-actions/resume  — Restart the sender loop.
 * GET  /admin/chain-actions/status  — Queue depth + pause state.
 */
@UseGuards(ApiKeyGuard)
@Controller("admin/chain-actions")
export class ChainActionAdminController {
  constructor(
    private readonly worker: ChainActionWorker,
    private readonly chainActions: ChainActionService,
  ) {}

  @Post("pause")
  pause() {
    this.worker.pauseSender();
    return { paused: true, at: new Date() };
  }

  @Post("resume")
  resume() {
    this.worker.resumeSender();
    return { paused: false, at: new Date() };
  }

  @Get("status")
  async status() {
    const [queued, processing, sent, retrying, mined, failed] =
      await Promise.all([
        this.chainActions.countByStatus(ChainActionStatus.QUEUED),
        this.chainActions.countByStatus(ChainActionStatus.PROCESSING),
        this.chainActions.countByStatus(ChainActionStatus.SENT),
        this.chainActions.countByStatus(ChainActionStatus.RETRYING),
        this.chainActions.countByStatus(ChainActionStatus.MINED),
        this.chainActions.countByStatus(ChainActionStatus.FAILED),
      ]);

    return {
      paused: this.worker.isPaused,
      queue: { queued, processing, sent, retrying, mined, failed },
      at: new Date(),
    };
  }
}
