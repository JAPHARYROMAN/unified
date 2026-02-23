import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Headers,
  HttpCode,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { ApplyOverrideDto } from "./dto/apply-override.dto";

/**
 * BreakerAdminController
 *
 * All endpoints require a valid admin API key via X-Admin-Key header.
 * Operator identity is extracted from the header for audit trail.
 *
 * Routes:
 *   GET  /admin/breaker/status          — current enforcement state + open incidents
 *   GET  /admin/breaker/incidents        — all open/acknowledged incidents
 *   POST /admin/breaker/incidents/:id/acknowledge — acknowledge an incident
 *   POST /admin/breaker/incidents/:id/resolve     — resolve/lift an incident
 *   POST /admin/breaker/overrides        — apply time-bound override
 *   POST /admin/breaker/overrides/:id/lift        — lift override early
 *   GET  /admin/breaker/overrides        — list active overrides
 *   GET  /admin/breaker/audit            — recent audit log
 */
@Controller("admin/breaker")
export class BreakerAdminController {
  private readonly logger = new Logger(BreakerAdminController.name);

  constructor(
    private readonly breaker: CircuitBreakerService,
    private readonly config: ConfigService,
  ) {}

  // ── Auth guard ─────────────────────────────────────────────────────────────

  private assertAdmin(headers: Record<string, string | string[] | undefined>): string {
    const adminKey = this.config.get<string>("ADMIN_API_KEY");

    if (!adminKey) {
      this.logger.error("[admin_auth] ADMIN_API_KEY not configured — fail-closed");
      throw new ForbiddenException("Admin API not configured");
    }

    const provided = headers["x-admin-key"];
    if (!provided || provided !== adminKey) {
      throw new ForbiddenException("Invalid admin key");
    }

    return headers["x-operator-id"] as string ?? "admin";
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  @Get("status")
  async getStatus(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers);

    const [state, incidents, overrides] = await Promise.all([
      this.breaker.getEnforcementState(),
      this.breaker.getOpenIncidents(),
      this.breaker.getActiveOverrides(),
    ]);

    return {
      generatedAt: new Date(),
      enforcement: {
        globalBlock: state.globalBlock,
        globalFreeze: state.globalFreeze,
        requireManualApproval: state.requireManualApproval,
        blockedPartnerIds: [...state.blockedPartnerIds],
        tightenedPartnerIds: [...state.tightenedPartnerIds],
        evaluatedAt: state.evaluatedAt,
      },
      openIncidentCount: incidents.length,
      activeOverrideCount: overrides.length,
    };
  }

  // ── Incidents ──────────────────────────────────────────────────────────────

  @Get("incidents")
  async getIncidents(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers);
    return this.breaker.getAllIncidents(200);
  }

  @Post("incidents/:id/acknowledge")
  @HttpCode(200)
  async acknowledgeIncident(
    @Param("id") id: string,
    @Headers() headers: Record<string, string>,
  ) {
    const operator = this.assertAdmin(headers);
    return this.breaker.acknowledgeIncident(id, operator);
  }

  @Post("incidents/:id/resolve")
  @HttpCode(200)
  async resolveIncident(
    @Param("id") id: string,
    @Headers() headers: Record<string, string>,
  ) {
    const operator = this.assertAdmin(headers);
    return this.breaker.resolveIncident(id, operator);
  }

  // ── Overrides ──────────────────────────────────────────────────────────────

  @Get("overrides")
  async getOverrides(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers);
    return this.breaker.getActiveOverrides();
  }

  @Post("overrides")
  @HttpCode(201)
  async applyOverride(
    @Body() dto: ApplyOverrideDto,
    @Headers() headers: Record<string, string>,
  ) {
    const operator = this.assertAdmin(headers);
    return this.breaker.applyOverride({
      trigger: dto.trigger,
      scope: dto.scope,
      partnerId: dto.partnerId,
      reason: dto.reason,
      operator,
      expiresInMinutes: dto.expiresInMinutes,
    });
  }

  @Post("overrides/:id/lift")
  @HttpCode(200)
  async liftOverride(
    @Param("id") id: string,
    @Headers() headers: Record<string, string>,
  ) {
    const operator = this.assertAdmin(headers);
    return this.breaker.liftOverride(id, operator);
  }

  // ── Audit log ──────────────────────────────────────────────────────────────

  @Get("audit")
  async getAuditLog(@Headers() headers: Record<string, string>) {
    this.assertAdmin(headers);
    return this.breaker.getAuditLog(500);
  }

  // ── Governance drill ───────────────────────────────────────────────────────

  /**
   * POST /admin/breaker/drill/fire
   *
   * Manually fire a circuit-breaker trigger for governance drill purposes.
   * Creates a real BreakerIncident so the full incident lifecycle can be
   * rehearsed end-to-end. The audit log entry is prefixed GOVERNANCE_DRILL.
   *
   * Body: { "trigger": "<BreakerTrigger enum value>" }
   * Header x-operator-id is required and recorded in the audit trail.
   */
  @Post("drill/fire")
  @HttpCode(201)
  async fireDrill(
    @Body() body: { trigger: string },
    @Headers() headers: Record<string, string>,
  ) {
    const operator = this.assertAdmin(headers);
    if (!body?.trigger) {
      throw new Error('Body must include "trigger" field');
    }
    this.logger.warn(
      `[governance_drill] operator=${operator} trigger=${body.trigger}`,
    );
    return this.breaker.fireDrillTrigger(body.trigger as any, operator);
  }
}
