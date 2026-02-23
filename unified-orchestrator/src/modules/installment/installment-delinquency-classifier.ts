import { AccrualStatus } from "@prisma/client";
import {
  DEFAULT_CANDIDATE_DAYS,
  DEFAULT_CLASSIFICATION_DAYS,
  SECONDS_PER_DAY,
} from "./installment.types";


/**
 * DelinquencyClassifier
 *
 * Pure, stateless 5-state machine.  No DB access — takes raw numbers and
 * returns the correct AccrualStatus.
 *
 * State transitions (based on seconds past due after grace window):
 *
 *   secondsPastDue <= 0                  → CURRENT
 *   0 < secondsPastDue <= gracePeriod    → IN_GRACE
 *   grace < spd < 14d                   → DELINQUENT
 *   14d <= spd < 30d                    → DEFAULT_CANDIDATE
 *   spd >= 30d                          → DEFAULTED
 *
 * "secondsPastDue" = nowUnix - dueTimestamp
 * Grace window is applied BEFORE delinquency starts.
 */
export class DelinquencyClassifier {
  /**
   * Classify a single installment entry.
   *
   * @param dueTimestamp  Unix seconds when the installment was due.
   * @param nowUnix       Current time as Unix seconds.
   * @param gracePeriodSeconds  Grace window in seconds (0 = no grace).
   * @returns { accrualStatus, daysPastDue }
   *   daysPastDue is measured from dueTimestamp (ignores grace window).
   */
  static classify(
    dueTimestamp: number,
    nowUnix: number,
    gracePeriodSeconds: number,
  ): { accrualStatus: AccrualStatus; daysPastDue: number } {
    const secondsOverdue = nowUnix - dueTimestamp;

    if (secondsOverdue <= 0) {
      return { accrualStatus: AccrualStatus.CURRENT, daysPastDue: 0 };
    }

    // daysPastDue counts from the due timestamp (not from grace expiry)
    const daysPastDue = Math.floor(secondsOverdue / SECONDS_PER_DAY);

    if (secondsOverdue <= gracePeriodSeconds) {
      return { accrualStatus: AccrualStatus.IN_GRACE, daysPastDue };
    }

    if (daysPastDue < DEFAULT_CANDIDATE_DAYS) {
      return { accrualStatus: AccrualStatus.DELINQUENT, daysPastDue };
    }

    if (daysPastDue < DEFAULT_CLASSIFICATION_DAYS) {
      return { accrualStatus: AccrualStatus.DEFAULT_CANDIDATE, daysPastDue };
    }

    return { accrualStatus: AccrualStatus.DEFAULTED, daysPastDue };
  }

  /**
   * Return the "worst" (most severe) status from a list.
   * Useful for rolling up per-entry statuses to a loan-level status.
   */
  static worst(statuses: string[]): AccrualStatus {
    const SEVERITY: Record<string, number> = {
      CURRENT: 0,
      IN_GRACE: 1,
      DELINQUENT: 2,
      DEFAULT_CANDIDATE: 3,
      DEFAULTED: 4,
    };
    let worstVal = "CURRENT";
    let worstSev = 0;
    for (const s of statuses) {
      const sev = SEVERITY[s] ?? 0;
      if (sev > worstSev) {
        worstSev = sev;
        worstVal = s;
      }
    }
    return worstVal as AccrualStatus;
  }

  /**
   * Compute the penalty accrued for one hour on an overdue installment.
   *
   * Formula (integer arithmetic):
   *   penaltyDelta = floor(overdueP * penaltyAprBps * 1 / (10000 * 8760))
   *
   * Where:
   *   overdueP      = principalDue - principalPaid  (overdue principal only)
   *   penaltyAprBps = annual penalty rate in bps
   *   8760          = hours per year (365 * 24)
   *
   * Returns 0 if the entry is CURRENT or IN_GRACE (no penalty during grace).
   */
  static computeHourlyPenalty(
    accrualStatus: AccrualStatus,
    overduePrincipal: bigint,
    penaltyAprBps: number,
  ): bigint {
    if (
      accrualStatus === AccrualStatus.CURRENT ||
      accrualStatus === AccrualStatus.IN_GRACE
    ) {
      return 0n;
    }

    if (overduePrincipal <= 0n || penaltyAprBps <= 0) {
      return 0n;
    }

    // penalty per hour = principal * bps / (10000 * 8760)
    return (
      (overduePrincipal * BigInt(penaltyAprBps)) /
      (10_000n * 8_760n)
    );
  }
}
