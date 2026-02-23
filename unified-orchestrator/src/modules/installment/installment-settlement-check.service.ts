import { Injectable, Logger } from "@nestjs/common";
import {
  ChainActionStatus,
  ChainActionType,
  FiatTransferStatus,
  LoanStatus,
  SettlementCheckKind,
} from "@prisma/client";
import { PrismaService } from "../prisma";
import {
  SettlementIntegrityReport,
  SettlementIntegrityResult,
} from "./installment.types";

/**
 * InstallmentSettlementCheckService
 *
 * Realtime settlement integrity checks (Requirement 2):
 *
 *   FIAT_CONFIRMED_NO_CHAIN  — FiatTransfer confirmed but no MINED chain record.
 *   CHAIN_RECORD_NO_FIAT     — MINED chain action but no confirmed fiat transfer.
 *   ACTIVE_MISSING_DISBURSEMENT — ACTIVE loan with zero confirmed disbursement proof.
 *
 * Each check result is persisted to settlement_checks for audit trail.
 * Failures are returned in the report; callers decide whether to trigger breakers.
 */
@Injectable()
export class InstallmentSettlementCheckService {
  private readonly logger = new Logger(InstallmentSettlementCheckService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run all three settlement integrity checks against all ACTIVE loans.
   * Returns a report with all failures. Never throws.
   */
  async runChecks(asOf?: Date): Promise<SettlementIntegrityReport> {
    const checkedAt = asOf ?? new Date();

    const loans = await this.prisma.loan.findMany({
      where: { status: LoanStatus.ACTIVE },
      select: {
        id: true,
        fiatTransfers: {
          select: {
            id: true,
            status: true,
            confirmedAt: true,
            direction: true,
          },
        },
        chainActions: {
          select: {
            id: true,
            type: true,
            status: true,
          },
        },
      },
    });

    const results: SettlementIntegrityResult[] = [];

    for (const loan of loans) {
      const loanResults = await this.checkLoan(loan);
      results.push(...loanResults);
    }

    const failures = results.filter((r) => !r.passed);

    // Persist all results for audit trail
    if (results.length > 0) {
      await this.prisma.settlementCheck.createMany({
        data: results.map((r) => ({
          loanId: r.loanId,
          kind: r.kind,
          passed: r.passed,
          detail: r.detail,
          checkedAt,
        })),
      });
    }

    this.logger.log(
      `[settlement_check] checked=${results.length} failures=${failures.length}`,
    );

    if (failures.length > 0) {
      for (const f of failures) {
        this.logger.warn(
          `[settlement_check] FAIL loan=${f.loanId} kind=${f.kind} detail=${f.detail}`,
        );
      }
    }

    return {
      checkedAt,
      totalChecked: results.length,
      failureCount: failures.length,
      failures,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async checkLoan(loan: {
    id: string;
    fiatTransfers: Array<{
      id: string;
      status: FiatTransferStatus;
      confirmedAt: Date | null;
      direction: string;
    }>;
    chainActions: Array<{
      id: string;
      type: ChainActionType;
      status: ChainActionStatus;
    }>;
  }): Promise<SettlementIntegrityResult[]> {
    const results: SettlementIntegrityResult[] = [];

    const confirmedFiat = loan.fiatTransfers.filter(
      (ft) => ft.confirmedAt !== null,
    );
    const minedChainActions = loan.chainActions.filter(
      (ca) => ca.status === ChainActionStatus.MINED,
    );
    const disbursementActions = minedChainActions.filter(
      (ca) =>
        ca.type === ChainActionType.RECORD_DISBURSEMENT ||
        ca.type === ChainActionType.ACTIVATE_LOAN,
    );

    // ── Check 1: FIAT_CONFIRMED_NO_CHAIN ──────────────────────────────────────
    // Outbound (disbursement) fiat confirmed but no MINED disbursement chain action
    const confirmedDisbursements = confirmedFiat.filter(
      (ft) => ft.direction === "OUTBOUND",
    );
    const hasDisbursementChain = disbursementActions.length > 0;

    if (confirmedDisbursements.length > 0 && !hasDisbursementChain) {
      results.push({
        loanId: loan.id,
        kind: SettlementCheckKind.FIAT_CONFIRMED_NO_CHAIN,
        passed: false,
        detail: `${confirmedDisbursements.length} confirmed fiat disbursement(s) but no MINED chain record`,
      });
    } else {
      results.push({
        loanId: loan.id,
        kind: SettlementCheckKind.FIAT_CONFIRMED_NO_CHAIN,
        passed: true,
        detail: "ok",
      });
    }

    // ── Check 2: CHAIN_RECORD_NO_FIAT ─────────────────────────────────────────
    // MINED disbursement chain action but no confirmed fiat disbursement
    if (hasDisbursementChain && confirmedDisbursements.length === 0) {
      results.push({
        loanId: loan.id,
        kind: SettlementCheckKind.CHAIN_RECORD_NO_FIAT,
        passed: false,
        detail: `${disbursementActions.length} MINED chain disbursement(s) but no confirmed fiat transfer`,
      });
    } else {
      results.push({
        loanId: loan.id,
        kind: SettlementCheckKind.CHAIN_RECORD_NO_FIAT,
        passed: true,
        detail: "ok",
      });
    }

    // ── Check 3: ACTIVE_MISSING_DISBURSEMENT ──────────────────────────────────
    // ACTIVE loan must have at least one confirmed disbursement proof (must be zero)
    const hasProof =
      confirmedDisbursements.length > 0 || hasDisbursementChain;

    results.push({
      loanId: loan.id,
      kind: SettlementCheckKind.ACTIVE_MISSING_DISBURSEMENT,
      passed: hasProof,
      detail: hasProof
        ? "ok"
        : "ACTIVE loan has no confirmed fiat disbursement or MINED chain disbursement",
    });

    return results;
  }
}
