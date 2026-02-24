import {
  BreakerAction,
  BreakerScope,
  BreakerTrigger,
} from "@prisma/client";

// ── Trigger definitions ────────────────────────────────────────────────────────

export interface TriggerDefinition {
  trigger: BreakerTrigger;
  /** Human-readable description */
  description: string;
  /** Alert severity when this trigger fires */
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  /** Scope this trigger applies to */
  scope: BreakerScope;
  /** Actions to apply when trigger fires */
  actions: BreakerAction[];
  /** Threshold value (semantics depend on trigger) */
  threshold: number;
}

// ── Evaluation result ──────────────────────────────────────────────────────────

export interface TriggerEvalResult {
  trigger: BreakerTrigger;
  fired: boolean;
  metricValue: number;
  threshold: number;
  scope: BreakerScope;
  /** Set for partner-scoped triggers */
  partnerId?: string;
  /** Whether an active override suppressed this trigger */
  suppressed: boolean;
}

// ── Enforcement state ──────────────────────────────────────────────────────────

export interface EnforcementState {
  /** Global origination block (HARD STOP) */
  globalBlock: boolean;
  /** Global freeze (softer than block — policy default) */
  globalFreeze: boolean;
  /** Global manual-mode flag */
  requireManualApproval: boolean;
  /** Per-partner origination blocks */
  blockedPartnerIds: Set<string>;
  /** Per-partner tightened terms flag */
  tightenedPartnerIds: Set<string>;
  /** Timestamp of last evaluation */
  evaluatedAt: Date;
}

// ── Alert payload ──────────────────────────────────────────────────────────────

export interface BreakerAlert {
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  trigger: BreakerTrigger;
  actions: BreakerAction[];
  scope: BreakerScope;
  partnerId?: string;
  metricValue: number;
  threshold: number;
  incidentId: string;
  firedAt: Date;
}

// ── Trigger catalogue (static config) ─────────────────────────────────────────

export const TRIGGER_CATALOGUE: TriggerDefinition[] = [
  {
    trigger: BreakerTrigger.ACTIVE_WITHOUT_DISBURSEMENT_PROOF,
    description: "Loans marked ACTIVE with no confirmed disbursement proof",
    severity: "CRITICAL",
    scope: BreakerScope.GLOBAL,
    actions: [
      BreakerAction.BLOCK_ALL_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0,
  },
  {
    trigger: BreakerTrigger.FIAT_CONFIRMED_NO_CHAIN_RECORD,
    description: "Fiat transfers confirmed but no on-chain record exists",
    severity: "CRITICAL",
    scope: BreakerScope.GLOBAL,
    actions: [
      BreakerAction.BLOCK_ALL_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0,
  },
  {
    trigger: BreakerTrigger.PARTNER_DEFAULT_RATE_30D,
    description: "Partner 30-day default rate exceeds 8%",
    severity: "HIGH",
    scope: BreakerScope.PARTNER,
    actions: [
      BreakerAction.BLOCK_PARTNER_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0.08,
  },
  {
    trigger: BreakerTrigger.PARTNER_DELINQUENCY_14D,
    description: "Partner 14-day delinquency rate exceeds 15%",
    severity: "MEDIUM",
    scope: BreakerScope.PARTNER,
    actions: [
      BreakerAction.BLOCK_PARTNER_ORIGINATIONS,
      BreakerAction.TIGHTEN_TERMS,
    ],
    threshold: 0.15,
  },
  {
    trigger: BreakerTrigger.POOL_LIQUIDITY_RATIO,
    description: "Pool liquidity ratio below 25%",
    severity: "HIGH",
    scope: BreakerScope.POOL,
    actions: [
      BreakerAction.FREEZE_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0.25,
  },
  {
    trigger: BreakerTrigger.POOL_NAV_DRAWDOWN_7D,
    description: "Pool NAV 7-day drawdown exceeds 2%",
    severity: "HIGH",
    scope: BreakerScope.POOL,
    actions: [
      BreakerAction.FREEZE_ORIGINATIONS,
      BreakerAction.TIGHTEN_TERMS,
    ],
    threshold: 0.02,
  },
  // ── v1.2.1 monitoring triggers ─────────────────────────────────────────────
  {
    trigger: BreakerTrigger.JUNIOR_TRANCHE_DEPLETION,
    description: "Junior tranche fully depleted (subordinationBps == 0)",
    severity: "CRITICAL",
    scope: BreakerScope.POOL,
    actions: [
      BreakerAction.BLOCK_ALL_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0,
  },
  {
    trigger: BreakerTrigger.SENIOR_TRANCHE_DRAWDOWN,
    description: "Senior tranche absorbed losses (badDebt > 0)",
    severity: "CRITICAL",
    scope: BreakerScope.POOL,
    actions: [
      BreakerAction.BLOCK_ALL_ORIGINATIONS,
      BreakerAction.OPEN_INCIDENT,
    ],
    threshold: 0,
  },
];
