import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../prisma";
import { ChainActionService } from "../chain-action/chain-action.service";
import { CircuitBreakerAlertService } from "../circuit-breaker/circuit-breaker-alert.service";
import { ChainActionType, BreakerTrigger, BreakerScope, BreakerAction } from "@prisma/client";
import {
  ScheduleParams,
  GeneratedSchedule,
  InstallmentRow,
  CanonicalScheduleJson,
  CanonicalInstallmentRow,
} from "./installment.types";

/**
 * InstallmentScheduleService
 *
 * Deterministic equal-principal schedule generator.
 *
 * Hashing spec (canonical JSON → SHA-256 → bytes32):
 *   - All bigint amounts as decimal strings.
 *   - All timestamps as decimal strings of Unix seconds.
 *   - interestRateBps, intervalSeconds, installmentCount as integers.
 *   - Field order is fixed (loan_id, principal, interest_rate_bps, start_ts,
 *     interval_seconds, installment_count, installments[]).
 *   - Per-installment: index, due_ts, principal, interest, total.
 *   - No extra whitespace (compact JSON.stringify).
 *   - installments sorted by index ascending.
 */
@Injectable()
export class InstallmentScheduleService {
  private readonly logger = new Logger(InstallmentScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chainActions: ChainActionService,
    private readonly alerts: CircuitBreakerAlertService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generate a deterministic schedule from loan parameters.
   * Pure — does NOT persist or enqueue anything.
   */
  generate(params: ScheduleParams): GeneratedSchedule {
    const { loanId, principalUsdc, interestRateBps, startTimestamp, intervalSeconds, installmentCount } = params;

    if (principalUsdc <= 0n) {
      throw new BadRequestException("principalUsdc must be > 0");
    }
    if (interestRateBps < 0 || interestRateBps > 100_000) {
      throw new BadRequestException("interestRateBps out of range [0, 100000]");
    }
    if (intervalSeconds <= 0) {
      throw new BadRequestException("intervalSeconds must be > 0");
    }
    if (installmentCount < 1) {
      throw new BadRequestException("installmentCount must be >= 1");
    }
    if (!Number.isInteger(startTimestamp) || startTimestamp <= 0) {
      throw new BadRequestException("startTimestamp must be a positive integer (Unix seconds)");
    }

    // Equal-principal: floor division, remainder absorbed by last installment
    const principalPerInstallment = principalUsdc / BigInt(installmentCount);
    const remainder = principalUsdc - principalPerInstallment * BigInt(installmentCount);

    const installments: InstallmentRow[] = [];

    for (let idx = 0; idx < installmentCount; idx++) {
      // due_timestamp = startTimestamp + (index + 1) * intervalSeconds
      const dueTimestamp = startTimestamp + (idx + 1) * intervalSeconds;
      const dueDate = new Date(dueTimestamp * 1000);

      // Interest on outstanding principal at start of this period (declining balance)
      const alreadyRepaid = principalPerInstallment * BigInt(idx);
      const outstandingPrincipal = principalUsdc - alreadyRepaid;

      // interest = outstanding * rate_bps * interval_seconds / (10000 * 365 * 86400)
      const interestDue =
        (outstandingPrincipal * BigInt(interestRateBps) * BigInt(intervalSeconds)) /
        (10_000n * 31_536_000n);

      const isLast = idx === installmentCount - 1;
      const principalDue = isLast ? principalPerInstallment + remainder : principalPerInstallment;
      const totalDue = principalDue + interestDue;

      installments.push({ installmentIndex: idx, dueTimestamp, dueDate, principalDue, interestDue, totalDue });
    }

    const { scheduleJson, scheduleHash } = this.buildCanonical({
      loanId,
      principalUsdc,
      interestRateBps,
      startTimestamp,
      intervalSeconds,
      installmentCount,
      installments,
    });

    return {
      loanId,
      scheduleHash,
      scheduleJson,
      totalInstallments: installmentCount,
      principalPerInstallment,
      interestRateBps,
      intervalSeconds,
      startTimestamp,
      installments,
    };
  }

  /**
   * Persist a generated schedule and enqueue a CONFIGURE_SCHEDULE chain action.
   * Idempotent — if a schedule already exists for the loan, returns it unchanged.
   */
  async saveSchedule(schedule: GeneratedSchedule) {
    const existing = await this.prisma.installmentSchedule.findUnique({
      where: { loanId: schedule.loanId },
      include: { installments: { orderBy: { installmentIndex: "asc" } } },
    });

    if (existing) {
      this.logger.debug(`[installment] schedule already exists for loan=${schedule.loanId}`);
      return existing;
    }

    const saved = await this.prisma.installmentSchedule.create({
      data: {
        loanId: schedule.loanId,
        scheduleHash: schedule.scheduleHash,
        scheduleJson: schedule.scheduleJson,
        totalInstallments: schedule.totalInstallments,
        principalPerInstallment: schedule.principalPerInstallment,
        interestRateBps: schedule.interestRateBps,
        intervalSeconds: schedule.intervalSeconds,
        startTimestamp: BigInt(schedule.startTimestamp),
        installments: {
          create: schedule.installments.map((inst) => ({
            loanId: schedule.loanId,
            installmentIndex: inst.installmentIndex,
            dueTimestamp: BigInt(inst.dueTimestamp),
            dueDate: inst.dueDate,
            principalDue: inst.principalDue,
            interestDue: inst.interestDue,
            totalDue: inst.totalDue,
          })),
        },
      },
      include: { installments: { orderBy: { installmentIndex: "asc" } } },
    });

    this.logger.log(
      `[installment] schedule created loan=${schedule.loanId} ` +
        `installments=${schedule.totalInstallments} hash=${schedule.scheduleHash}`,
    );

    // Enqueue CONFIGURE_SCHEDULE chain action so the hash is written on-chain
    await this.chainActions.enqueue(schedule.loanId, ChainActionType.CONFIGURE_SCHEDULE, {
      scheduleHash: schedule.scheduleHash,
      startTimestamp: schedule.startTimestamp,
      intervalSeconds: schedule.intervalSeconds,
      installmentCount: schedule.totalInstallments,
      principalPerInstallment: schedule.principalPerInstallment.toString(),
      interestRateBps: schedule.interestRateBps,
    });

    return saved;
  }

  /**
   * Generate and immediately persist a schedule.
   * Convenience wrapper used at loan origination.
   */
  async generateAndSave(params: ScheduleParams) {
    const schedule = this.generate(params);
    return this.saveSchedule(schedule);
  }

  /**
   * Immutability guard — called after loan activation.
   *
   * Regenerates the schedule from stored config params and compares the hash
   * against the persisted value.  A mismatch fires a CRITICAL alert.
   *
   * Throws ConflictException on mismatch so the caller can halt processing.
   */
  async assertHashIntegrity(loanId: string): Promise<void> {
    const stored = await this.prisma.installmentSchedule.findUnique({
      where: { loanId },
    });

    if (!stored) return; // no schedule — nothing to verify

    const regenParams: ScheduleParams = {
      loanId,
      principalUsdc: stored.principalPerInstallment * BigInt(stored.totalInstallments),
      interestRateBps: stored.interestRateBps,
      startTimestamp: Number(stored.startTimestamp),
      intervalSeconds: stored.intervalSeconds,
      installmentCount: stored.totalInstallments,
    };

    // We need the exact original principal, not the derived one.
    // Re-derive from scheduleJson (canonical source of truth).
    const canonical: CanonicalScheduleJson = JSON.parse(stored.scheduleJson);
    regenParams.principalUsdc = BigInt(canonical.principal);

    const regen = this.generate(regenParams);

    if (regen.scheduleHash !== stored.scheduleHash) {
      const msg =
        `[installment_integrity] HASH MISMATCH loan=${loanId} ` +
        `stored=${stored.scheduleHash} regen=${regen.scheduleHash}`;
      this.logger.error(msg);

      await this.alerts.emitMany([{
        severity: "CRITICAL",
        trigger: BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
        actions: [BreakerAction.BLOCK_ALL_ORIGINATIONS, BreakerAction.OPEN_INCIDENT],
        scope: BreakerScope.PARTNER,
        metricValue: 1,
        threshold: 0,
        incidentId: `hash-mismatch-${loanId}`,
        firedAt: new Date(),
      }]);

      throw new ConflictException(
        `Schedule hash mismatch for loan ${loanId} — origination halted`,
      );
    }

    this.logger.debug(`[installment_integrity] OK loan=${loanId} hash=${stored.scheduleHash}`);
  }

  /**
   * Verify that a set of params produces a given hash.
   * Pure — no DB access.
   */
  verifyHash(params: ScheduleParams, expectedHash: string): boolean {
    return this.generate(params).scheduleHash === expectedHash;
  }

  /**
   * Retrieve the persisted schedule for a loan (with installments).
   */
  async findByLoan(loanId: string) {
    return this.prisma.installmentSchedule.findUnique({
      where: { loanId },
      include: { installments: { orderBy: { installmentIndex: "asc" } } },
    });
  }

  // ── Canonical JSON + hashing ───────────────────────────────────────────────

  /**
   * Build the canonical JSON string and its SHA-256 hash.
   *
   * Field order is FIXED — any change breaks all existing hashes.
   * See CanonicalScheduleJson in installment.types.ts for the full spec.
   */
  buildCanonical(params: {
    loanId: string;
    principalUsdc: bigint;
    interestRateBps: number;
    startTimestamp: number;
    intervalSeconds: number;
    installmentCount: number;
    installments: InstallmentRow[];
  }): { scheduleJson: string; scheduleHash: string } {
    const canonicalInstallments: CanonicalInstallmentRow[] = params.installments
      .slice()
      .sort((a, b) => a.installmentIndex - b.installmentIndex)
      .map((i) => ({
        index: i.installmentIndex,
        due_ts: String(i.dueTimestamp),
        principal: String(i.principalDue),
        interest: String(i.interestDue),
        total: String(i.totalDue),
      }));

    // Field order is intentional — do NOT reorder
    const canonical: CanonicalScheduleJson = {
      loan_id: params.loanId,
      principal: String(params.principalUsdc),
      interest_rate_bps: params.interestRateBps,
      start_ts: String(params.startTimestamp),
      interval_seconds: params.intervalSeconds,
      installment_count: params.installmentCount,
      installments: canonicalInstallments,
    };

    const scheduleJson = JSON.stringify(canonical);
    const scheduleHash = createHash("sha256").update(scheduleJson, "utf8").digest("hex");

    return { scheduleJson, scheduleHash };
  }
}
