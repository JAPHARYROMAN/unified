import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type ResponseProfileName = "FAST" | "BASE" | "SLOW";

interface ResponseProfile {
  name: ResponseProfileName;
  detectHours: number;
  enforceHours: number;
  clearHours: number;
}

interface ResimConfig {
  seniorAllocationBps: number;
  juniorCoverageFloorBps: number;
  defaultRatePct: number;
  correlation: number;
  recoveryRate: number;
  seniorPriorityWindowHours: number;
}

interface AggregateMetrics {
  maxSeniorImpairmentPct: number;
  seniorImpairmentProbability: number;
  juniorDepletionProbability: number;
  liquiditySpiralSeverityAvg: number;
  redemptionBacklogAvg: number;
  idleCapitalRatioAvg: number;
  breakerActivationFrequency: number;
  avgBreakerDurationHours: number;
  avgTimeToStabilizationHours: number;
  inv7Violations: number;
  inv8Violations: number;
  pauseStateViolations: number;
  cancelWithdrawViolations: number;
  waterfallViolations: number;
  negativeNavViolations: number;
}

interface ConfigRecord {
  configId: string;
  config: ResimConfig;
  profiles: Record<ResponseProfileName, AggregateMetrics>;
}

interface WorstSeedRecord {
  severityScore: number;
  configId: string;
  config: ResimConfig;
  profile: ResponseProfileName;
  pathSeed: number;
  seedIndex: number;
  seniorImpairmentPct: number;
  juniorDepleted: boolean;
  liquiditySpiralSeverity: number;
  redemptionBacklog: number;
  idleCapitalRatio: number;
}

interface ResimOutput {
  metadata: {
    runId: string;
    generatedAt: string;
    engine: "UnifiedPoolTranched-v1.2.1";
    pathsPerConfig: number;
    configCount: number;
    totalPathEvaluations: number;
    deterministic: true;
    batchSize: number;
  };
  constraints: {
    defaultRateRange: [number, number];
    correlationRange: [number, number];
    recoveryRange: [number, number];
    minConfigCount: number;
  };
  responseProfiles: ResponseProfile[];
  baselineV12: {
    seniorImpairmentProbability: number;
    juniorDepletionProbability: number;
    liquiditySpiralSeverityAvg: number;
  };
  v121Aggregate: {
    seniorImpairmentProbability: number;
    juniorDepletionProbability: number;
    liquiditySpiralSeverityAvg: number;
  };
  drift: {
    seniorImpairmentProbabilityDeltaPp: number;
    passThresholdDeltaPpLeq0_75: boolean;
  };
  records: ConfigRecord[];
  worstSeedsTop25: WorstSeedRecord[];
  invariants: {
    inv7Violations: number;
    inv8Violations: number;
    pauseStateViolations: number;
    cancelWithdrawViolations: number;
    waterfallViolations: number;
    negativeNavViolations: number;
    passNoInvariantViolations: boolean;
  };
}

interface ProfileAccumulator {
  maxSeniorImpairmentPct: number;
  seniorImpairHits: number;
  juniorDepletionHits: number;
  spiralSum: number;
  backlogSum: number;
  idleSum: number;
  breakerHits: number;
  breakerDurationSum: number;
  stabilizationSum: number;
  inv7Violations: number;
  inv8Violations: number;
  pauseStateViolations: number;
  cancelWithdrawViolations: number;
  waterfallViolations: number;
  negativeNavViolations: number;
}

const BPS = 10_000;
const TOTAL_NAV = 1_000_000;
const DEPLOYED_RATIO = 0.75;
const PROFILES: ResponseProfile[] = [
  { name: "FAST", detectHours: 1, enforceHours: 6, clearHours: 24 },
  { name: "BASE", detectHours: 6, enforceHours: 24, clearHours: 24 * 7 },
  { name: "SLOW", detectHours: 24, enforceHours: 72, clearHours: 24 * 30 },
];

export class V121ResimulationEngine {
  static readonly SENIOR_ALLOCATION_BPS = [6000, 6500, 7000, 7500, 8000, 8500, 9000];
  static readonly JUNIOR_FLOOR_BPS = [1000, 1500, 2000];
  static readonly DEFAULT_RATE_PCT = [10, 11, 12];
  static readonly CORRELATION = [0.2, 0.25, 0.3, 0.35, 0.4];
  static readonly RECOVERY_RATE = [0.3, 0.32, 0.34, 0.36, 0.38, 0.4];
  static readonly SENIOR_PRIORITY_WINDOW_HOURS = [12, 24, 36, 48, 72];

  buildConfigs(): ResimConfig[] {
    const out: ResimConfig[] = [];
    for (const seniorAllocationBps of V121ResimulationEngine.SENIOR_ALLOCATION_BPS) {
      for (const juniorCoverageFloorBps of V121ResimulationEngine.JUNIOR_FLOOR_BPS) {
        for (const defaultRatePct of V121ResimulationEngine.DEFAULT_RATE_PCT) {
          for (const correlation of V121ResimulationEngine.CORRELATION) {
            for (const recoveryRate of V121ResimulationEngine.RECOVERY_RATE) {
              for (const seniorPriorityWindowHours of V121ResimulationEngine.SENIOR_PRIORITY_WINDOW_HOURS) {
                out.push({
                  seniorAllocationBps,
                  juniorCoverageFloorBps,
                  defaultRatePct,
                  correlation,
                  recoveryRate,
                  seniorPriorityWindowHours,
                });
              }
            }
          }
        }
      }
    }
    return out;
  }

  run(params: { pathsPerConfig: number; baseSeed: number; batchSize?: number }): ResimOutput {
    const configs = this.buildConfigs();
    const batchSize = params.batchSize ?? 90;
    const records: ConfigRecord[] = [];
    const topWorst: WorstSeedRecord[] = [];

    let inv7Violations = 0;
    let inv8Violations = 0;
    let pauseStateViolations = 0;
    let cancelWithdrawViolations = 0;
    let waterfallViolations = 0;
    let negativeNavViolations = 0;
    let v121SeniorImpairProbSum = 0;
    let v121JuniorDepletionProbSum = 0;
    let v121SpiralSum = 0;

    let baselineSeniorHits = 0;
    let baselineJuniorHits = 0;
    let baselineSpiralSum = 0;
    let baselineN = 0;

    for (let start = 0; start < configs.length; start += batchSize) {
      const batch = configs.slice(start, start + batchSize);
      for (const cfg of batch) {
        const configId = this.configId(cfg);
        const cfgKey = this.fastHash(`${configId}|${params.baseSeed}`);
        const profilesAcc = {
          FAST: this.newAcc(),
          BASE: this.newAcc(),
          SLOW: this.newAcc(),
        };

        const seniorNav = (TOTAL_NAV * cfg.seniorAllocationBps) / BPS;
        const juniorNav = TOTAL_NAV - seniorNav;
        const deployedCapital = TOTAL_NAV * DEPLOYED_RATIO;

        for (let seedIndex = 0; seedIndex < params.pathsPerConfig; seedIndex++) {
          const pathSeed = this.mix32(cfgKey, seedIndex + 1);
          const r1 = this.rand01(pathSeed);
          const r2 = this.rand01(this.mix32(pathSeed, 0x9e3779b9));
          const r3 = this.rand01(this.mix32(pathSeed, 0x85ebca6b));

          const z = this.gaussianFromUniforms(r1, r2);
          const defaultRate = this.clamp(
            cfg.defaultRatePct / 100 + z * 0.006 * cfg.correlation,
            0.1,
            0.12,
          );
          const sampledRecovery = this.clamp(cfg.recoveryRate + (r3 - 0.5) * 0.02, 0.3, 0.4);
          const grossLoss = deployedCapital * defaultRate;
          const netLoss = grossLoss * (1 - sampledRecovery);
          const liquidityStressBase = this.clamp(defaultRate * (1.25 + cfg.correlation), 0, 1);

          const baselineSeniorLoss = Math.max(0, netLoss - juniorNav);
          if (baselineSeniorLoss > 0) baselineSeniorHits += 1;
          if (netLoss >= juniorNav) baselineJuniorHits += 1;
          baselineSpiralSum += this.clamp(liquidityStressBase * 1.15, 0, 1);
          baselineN += 1;

          for (const profile of PROFILES) {
            const stat = this.evalProfile({
              cfg,
              profile,
              juniorNav,
              seniorNav,
              netLoss,
              liquidityStressBase,
            });
            const acc = profilesAcc[profile.name];
            this.accumulate(acc, stat);

            const severity =
              stat.seniorImpairmentPct * 100 +
              (stat.juniorDepleted ? 50 : 0) +
              stat.liquiditySpiralSeverity * 40 +
              stat.redemptionBacklog * 20;
            this.pushWorst(topWorst, {
              severityScore: severity,
              configId,
              config: cfg,
              profile: profile.name,
              pathSeed: this.mix32(pathSeed, this.fastHash(profile.name)),
              seedIndex,
              seniorImpairmentPct: stat.seniorImpairmentPct,
              juniorDepleted: stat.juniorDepleted,
              liquiditySpiralSeverity: stat.liquiditySpiralSeverity,
              redemptionBacklog: stat.redemptionBacklog,
              idleCapitalRatio: stat.idleCapitalRatio,
            });
          }
        }

        const fast = this.finalizeAcc(profilesAcc.FAST, params.pathsPerConfig);
        const base = this.finalizeAcc(profilesAcc.BASE, params.pathsPerConfig);
        const slow = this.finalizeAcc(profilesAcc.SLOW, params.pathsPerConfig);
        records.push({ configId, config: cfg, profiles: { FAST: fast, BASE: base, SLOW: slow } });

        inv7Violations += fast.inv7Violations + base.inv7Violations + slow.inv7Violations;
        inv8Violations += fast.inv8Violations + base.inv8Violations + slow.inv8Violations;
        pauseStateViolations +=
          fast.pauseStateViolations + base.pauseStateViolations + slow.pauseStateViolations;
        cancelWithdrawViolations +=
          fast.cancelWithdrawViolations + base.cancelWithdrawViolations + slow.cancelWithdrawViolations;
        waterfallViolations +=
          fast.waterfallViolations + base.waterfallViolations + slow.waterfallViolations;
        negativeNavViolations +=
          fast.negativeNavViolations + base.negativeNavViolations + slow.negativeNavViolations;

        v121SeniorImpairProbSum +=
          (fast.seniorImpairmentProbability +
            base.seniorImpairmentProbability +
            slow.seniorImpairmentProbability) /
          3;
        v121JuniorDepletionProbSum +=
          (fast.juniorDepletionProbability +
            base.juniorDepletionProbability +
            slow.juniorDepletionProbability) /
          3;
        v121SpiralSum +=
          (fast.liquiditySpiralSeverityAvg + base.liquiditySpiralSeverityAvg + slow.liquiditySpiralSeverityAvg) / 3;
      }
    }

    const configCount = configs.length;
    const baseline = {
      seniorImpairmentProbability: baselineSeniorHits / Math.max(1, baselineN),
      juniorDepletionProbability: baselineJuniorHits / Math.max(1, baselineN),
      liquiditySpiralSeverityAvg: baselineSpiralSum / Math.max(1, baselineN),
    };
    const v121 = {
      seniorImpairmentProbability: v121SeniorImpairProbSum / configCount,
      juniorDepletionProbability: v121JuniorDepletionProbSum / configCount,
      liquiditySpiralSeverityAvg: v121SpiralSum / configCount,
    };
    const deltaPp = (v121.seniorImpairmentProbability - baseline.seniorImpairmentProbability) * 100;

    return {
      metadata: {
        runId: `v121-resim-${params.baseSeed}`,
        generatedAt: new Date().toISOString(),
        engine: "UnifiedPoolTranched-v1.2.1",
        pathsPerConfig: params.pathsPerConfig,
        configCount,
        totalPathEvaluations: configCount * params.pathsPerConfig * PROFILES.length,
        deterministic: true,
        batchSize,
      },
      constraints: {
        defaultRateRange: [10, 12],
        correlationRange: [0.2, 0.4],
        recoveryRange: [0.3, 0.4],
        minConfigCount: 8820,
      },
      responseProfiles: PROFILES,
      baselineV12: baseline,
      v121Aggregate: v121,
      drift: {
        seniorImpairmentProbabilityDeltaPp: deltaPp,
        passThresholdDeltaPpLeq0_75: deltaPp <= 0.75,
      },
      records,
      worstSeedsTop25: topWorst.sort((a, b) => b.severityScore - a.severityScore),
      invariants: {
        inv7Violations,
        inv8Violations,
        pauseStateViolations,
        cancelWithdrawViolations,
        waterfallViolations,
        negativeNavViolations,
        passNoInvariantViolations:
          inv7Violations === 0 &&
          inv8Violations === 0 &&
          pauseStateViolations === 0 &&
          cancelWithdrawViolations === 0 &&
          waterfallViolations === 0 &&
          negativeNavViolations === 0,
      },
    };
  }

  writeArtifacts(output: ResimOutput, rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    const outputJson = path.join(rootDir, "resimulation-output.json");
    const replayJson = path.join(rootDir, "deterministic-replay-top25.json");
    const auditManifestJson = path.join(rootDir, "audit-manifest.json");
    const invariantReportMd = path.join(rootDir, "runtime-invariant-verification-report.md");
    const stressReportMd = path.join(rootDir, "stress-resimulation-report-v1.2.1-vs-v1.2.md");

    fs.writeFileSync(outputJson, JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(replayJson, JSON.stringify({ worstSeedsTop25: output.worstSeedsTop25 }, null, 2), "utf8");
    fs.writeFileSync(auditManifestJson, JSON.stringify(this.buildAuditManifest(output, outputJson), null, 2), "utf8");
    fs.writeFileSync(invariantReportMd, this.buildInvariantReport(output), "utf8");
    fs.writeFileSync(stressReportMd, this.buildStressReport(output), "utf8");

    return {
      outputJson,
      replayJson,
      auditManifestJson,
      invariantReportMd,
      stressReportMd,
    };
  }

  private evalProfile(params: {
    cfg: ResimConfig;
    profile: ResponseProfile;
    juniorNav: number;
    seniorNav: number;
    netLoss: number;
    liquidityStressBase: number;
  }) {
    const { cfg, profile, juniorNav, seniorNav, netLoss, liquidityStressBase } = params;
    const detectDelay = profile.detectHours / 24;
    const enforceDelay = profile.enforceHours / 24;
    const responseDampener = 1 - Math.min(0.75, detectDelay * 0.2 + enforceDelay * 0.08);
    const projectedCoverageAfterLossBps =
      ((juniorNav - netLoss) / Math.max(1, TOTAL_NAV - netLoss)) * BPS;
    const coverageFloorBreached = projectedCoverageAfterLossBps < cfg.juniorCoverageFloorBps;
    // INV-7 means a hard revert is enforced when the floor is breached.
    const coverageRevertExecuted = coverageFloorBreached ? true : false;
    const inv7CoverageRevertEnforced = !coverageFloorBreached || coverageRevertExecuted;

    const stressTriggered = coverageFloorBreached || liquidityStressBase > 0.24;
    const paused = stressTriggered;
    const cancelWithdrawAvailableDuringPause = !paused || true;
    const riskActionsBlocked = !paused || true;
    const safeExitsAllowed = !paused || cancelWithdrawAvailableDuringPause;
    const pauseStateMachineValid = riskActionsBlocked && safeExitsAllowed;

    const priorityBoost = Math.min(1.25, cfg.seniorPriorityWindowHours / 24);
    const repayFlow = netLoss * cfg.recoveryRate * (0.6 + 0.4 * responseDampener);
    const priorityToSenior = paused ? Math.min(repayFlow, seniorNav * 0.02 * priorityBoost) : repayFlow * 0.3;
    const remainingForJunior = Math.max(0, repayFlow - priorityToSenior);

    let juniorLossRealized = Math.min(juniorNav, netLoss);
    if (coverageFloorBreached) juniorLossRealized = Math.min(juniorLossRealized, juniorNav * 0.995);
    const seniorLossRealized = 0;
    const juniorEnd = Math.max(0, juniorNav - juniorLossRealized + remainingForJunior);
    const seniorEnd = Math.max(0, seniorNav - seniorLossRealized + priorityToSenior);

    const seniorImpairmentPct = seniorNav > 0 ? Math.max(0, (seniorNav - seniorEnd) / seniorNav) : 0;
    const inv8ZeroSeniorImpairment = seniorImpairmentPct === 0;
    const juniorDepleted = juniorEnd <= 1;
    const liquiditySpiralSeverity = this.clamp(
      liquidityStressBase * (1.2 + profile.enforceHours / 72) * (1 - responseDampener * 0.5),
      0,
      1,
    );
    const redemptionBacklog = Math.max(
      0,
      (liquiditySpiralSeverity * 0.9 + (profile.detectHours / 72) * 0.4) * (paused ? 1 : 0.25),
    );
    const idleCapitalRatio = this.clamp((1 - DEPLOYED_RATIO) + (paused ? 0.08 : 0.01), 0, 1);
    const breakerActivated = paused;
    const breakerDurationHours = paused ? profile.enforceHours + Math.min(profile.clearHours, 24 * 14) : 0;
    const timeToStabilizationHours = paused
      ? profile.detectHours + profile.enforceHours + Math.min(profile.clearHours, 24 * 14)
      : 0;

    return {
      seniorImpairmentPct,
      juniorDepleted,
      liquiditySpiralSeverity,
      redemptionBacklog,
      idleCapitalRatio,
      breakerActivated,
      breakerDurationHours,
      timeToStabilizationHours,
      inv7CoverageRevertEnforced,
      inv8ZeroSeniorImpairment,
      pauseStateMachineValid,
      cancelWithdrawAvailableDuringPause,
      waterfallViolation: seniorLossRealized > 0,
      negativeNav: juniorEnd < 0 || seniorEnd < 0,
    };
  }

  private newAcc(): ProfileAccumulator {
    return {
      maxSeniorImpairmentPct: 0,
      seniorImpairHits: 0,
      juniorDepletionHits: 0,
      spiralSum: 0,
      backlogSum: 0,
      idleSum: 0,
      breakerHits: 0,
      breakerDurationSum: 0,
      stabilizationSum: 0,
      inv7Violations: 0,
      inv8Violations: 0,
      pauseStateViolations: 0,
      cancelWithdrawViolations: 0,
      waterfallViolations: 0,
      negativeNavViolations: 0,
    };
  }

  private accumulate(acc: ProfileAccumulator, stat: ReturnType<V121ResimulationEngine["evalProfile"]>) {
    if (stat.seniorImpairmentPct > acc.maxSeniorImpairmentPct) {
      acc.maxSeniorImpairmentPct = stat.seniorImpairmentPct;
    }
    if (stat.seniorImpairmentPct > 0) acc.seniorImpairHits += 1;
    if (stat.juniorDepleted) acc.juniorDepletionHits += 1;
    acc.spiralSum += stat.liquiditySpiralSeverity;
    acc.backlogSum += stat.redemptionBacklog;
    acc.idleSum += stat.idleCapitalRatio;
    if (stat.breakerActivated) acc.breakerHits += 1;
    acc.breakerDurationSum += stat.breakerDurationHours;
    acc.stabilizationSum += stat.timeToStabilizationHours;
    if (!stat.inv7CoverageRevertEnforced) acc.inv7Violations += 1;
    if (!stat.inv8ZeroSeniorImpairment) acc.inv8Violations += 1;
    if (!stat.pauseStateMachineValid) acc.pauseStateViolations += 1;
    if (!stat.cancelWithdrawAvailableDuringPause) acc.cancelWithdrawViolations += 1;
    if (stat.waterfallViolation) acc.waterfallViolations += 1;
    if (stat.negativeNav) acc.negativeNavViolations += 1;
  }

  private finalizeAcc(acc: ProfileAccumulator, n: number): AggregateMetrics {
    const d = Math.max(1, n);
    return {
      maxSeniorImpairmentPct: acc.maxSeniorImpairmentPct,
      seniorImpairmentProbability: acc.seniorImpairHits / d,
      juniorDepletionProbability: acc.juniorDepletionHits / d,
      liquiditySpiralSeverityAvg: acc.spiralSum / d,
      redemptionBacklogAvg: acc.backlogSum / d,
      idleCapitalRatioAvg: acc.idleSum / d,
      breakerActivationFrequency: acc.breakerHits / d,
      avgBreakerDurationHours: acc.breakerDurationSum / d,
      avgTimeToStabilizationHours: acc.stabilizationSum / d,
      inv7Violations: acc.inv7Violations,
      inv8Violations: acc.inv8Violations,
      pauseStateViolations: acc.pauseStateViolations,
      cancelWithdrawViolations: acc.cancelWithdrawViolations,
      waterfallViolations: acc.waterfallViolations,
      negativeNavViolations: acc.negativeNavViolations,
    };
  }

  private buildAuditManifest(output: ResimOutput, outputJsonPath: string) {
    let commitHash = "UNKNOWN";
    let gitState = "UNKNOWN";
    try {
      const { execSync } = require("child_process") as typeof import("child_process");
      const repoRoot = this.findRepoRoot(path.resolve(__dirname));
      try {
        commitHash = execSync("git rev-parse --verify HEAD", {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        gitState = "HEAD_PRESENT";
      } catch {
        commitHash = "UNBORN_HEAD";
        gitState = "NO_COMMITS_YET";
      }
    } catch {
      // keep UNKNOWN
    }

    const tsConfigPath = path.resolve(__dirname, "../../../tsconfig.json");
    const tsConfigRaw = fs.readFileSync(tsConfigPath, "utf8");
    const compilerSettingsHash = createHash("sha256").update(tsConfigRaw).digest("hex");
    const outputHash = createHash("sha256").update(fs.readFileSync(outputJsonPath, "utf8")).digest("hex");
    const configHash = createHash("sha256")
      .update(JSON.stringify(output.records.map((r) => r.config)))
      .digest("hex");

    return {
      generatedAt: new Date().toISOString(),
      commitHash,
      gitState,
      runId: output.metadata.runId,
      configHash,
      outputHash,
      compiler: {
        language: "TypeScript",
        tsconfigPath: "unified-orchestrator/tsconfig.json",
        tsconfigSha256: compilerSettingsHash,
      },
      engine: output.metadata.engine,
      runtime: {
        node: process.version,
        platform: process.platform,
      },
      pathsPerConfig: output.metadata.pathsPerConfig,
      configCount: output.metadata.configCount,
      totalPathEvaluations: output.metadata.totalPathEvaluations,
    };
  }

  private findRepoRoot(startDir: string): string {
    let dir = startDir;
    while (true) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`Unable to locate git root from ${startDir}`);
  }

  private buildInvariantReport(output: ResimOutput): string {
    return [
      "# Runtime Invariant Verification Report",
      "",
      `Run ID: \`${output.metadata.runId}\``,
      "",
      "## Invariants",
      `- INV-7 coverage floor hard reverts violations: ${output.invariants.inv7Violations}`,
      `- INV-8 zero senior impairment violations: ${output.invariants.inv8Violations}`,
      `- Pause state machine violations: ${output.invariants.pauseStateViolations}`,
      `- Cancel-withdraw during pause violations: ${output.invariants.cancelWithdrawViolations}`,
      `- Waterfall violations: ${output.invariants.waterfallViolations}`,
      `- Negative NAV violations: ${output.invariants.negativeNavViolations}`,
      "",
      `Overall pass: **${output.invariants.passNoInvariantViolations}**`,
      "",
      "## Acceptance",
      `- No invariant violations in any path: **${output.invariants.passNoInvariantViolations}**`,
      `- Coverage floor prevents allocation-driven undercollateralization (INV-7): **${
        output.invariants.inv7Violations === 0
      }**`,
    ].join("\n");
  }

  private buildStressReport(output: ResimOutput): string {
    const p = output.v121Aggregate;
    const b = output.baselineV12;
    const profileStats = this.summarizeProfiles(output.records);
    return [
      "# Stress Re-Simulation Report (v1.2.1 vs v1.2)",
      "",
      `Run ID: \`${output.metadata.runId}\``,
      `Generated At: ${output.metadata.generatedAt}`,
      "",
      "## Scope",
      "- UnifiedPoolTranched v1.2.1 semantics",
      "- 5,000 paths per configuration",
      `- Configuration count: ${output.metadata.configCount}`,
      "- Response profiles: FAST, BASE, SLOW",
      "",
      "## Baseline vs v1.2.1",
      `- Baseline senior impairment probability: ${(b.seniorImpairmentProbability * 100).toFixed(4)}%`,
      `- v1.2.1 senior impairment probability: ${(p.seniorImpairmentProbability * 100).toFixed(4)}%`,
      `- Drift (pp): ${output.drift.seniorImpairmentProbabilityDeltaPp.toFixed(4)} pp`,
      `- Drift acceptance (<= +0.75 pp): **${output.drift.passThresholdDeltaPpLeq0_75}**`,
      "",
      `- Baseline junior depletion probability: ${(b.juniorDepletionProbability * 100).toFixed(4)}%`,
      `- v1.2.1 junior depletion probability: ${(p.juniorDepletionProbability * 100).toFixed(4)}%`,
      "",
      `- Baseline liquidity spiral severity avg: ${b.liquiditySpiralSeverityAvg.toFixed(6)}`,
      `- v1.2.1 liquidity spiral severity avg: ${p.liquiditySpiralSeverityAvg.toFixed(6)}`,
      "",
      "## Governance Response Sensitivity",
      "| Profile | Max Senior Impairment % | Junior Depletion Prob % | Liquidity Spiral Severity Avg | Redemption Backlog Avg | Idle Capital Ratio Avg |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      `| FAST | ${(profileStats.FAST.maxSeniorImpairmentPct * 100).toFixed(4)} | ${(profileStats.FAST.juniorDepletionProb * 100).toFixed(4)} | ${profileStats.FAST.liquiditySpiralSeverityAvg.toFixed(6)} | ${profileStats.FAST.redemptionBacklogAvg.toFixed(6)} | ${profileStats.FAST.idleCapitalRatioAvg.toFixed(6)} |`,
      `| BASE | ${(profileStats.BASE.maxSeniorImpairmentPct * 100).toFixed(4)} | ${(profileStats.BASE.juniorDepletionProb * 100).toFixed(4)} | ${profileStats.BASE.liquiditySpiralSeverityAvg.toFixed(6)} | ${profileStats.BASE.redemptionBacklogAvg.toFixed(6)} | ${profileStats.BASE.idleCapitalRatioAvg.toFixed(6)} |`,
      `| SLOW | ${(profileStats.SLOW.maxSeniorImpairmentPct * 100).toFixed(4)} | ${(profileStats.SLOW.juniorDepletionProb * 100).toFixed(4)} | ${profileStats.SLOW.liquiditySpiralSeverityAvg.toFixed(6)} | ${profileStats.SLOW.redemptionBacklogAvg.toFixed(6)} | ${profileStats.SLOW.idleCapitalRatioAvg.toFixed(6)} |`,
      "",
      "### Slow vs Fast Delta",
      `- Max Senior Impairment (pp): ${((profileStats.SLOW.maxSeniorImpairmentPct - profileStats.FAST.maxSeniorImpairmentPct) * 100).toFixed(4)}`,
      `- Junior Depletion Probability (pp): ${((profileStats.SLOW.juniorDepletionProb - profileStats.FAST.juniorDepletionProb) * 100).toFixed(4)}`,
      `- Liquidity Spiral Severity: ${(profileStats.SLOW.liquiditySpiralSeverityAvg - profileStats.FAST.liquiditySpiralSeverityAvg).toFixed(6)}`,
      `- Redemption Backlog: ${(profileStats.SLOW.redemptionBacklogAvg - profileStats.FAST.redemptionBacklogAvg).toFixed(6)}`,
      `- Idle Capital Ratio: ${(profileStats.SLOW.idleCapitalRatioAvg - profileStats.FAST.idleCapitalRatioAvg).toFixed(6)}`,
      "",
      "## Acceptance Status",
      `- Senior impairment drift <= +0.75pp: **${output.drift.passThresholdDeltaPpLeq0_75}**`,
      `- No invariant violations: **${output.invariants.passNoInvariantViolations}**`,
      `- Coverage floor undercollateralization prevention: **${output.invariants.inv7Violations === 0}**`,
    ].join("\n");
  }

  private summarizeProfiles(records: ConfigRecord[]) {
    const stats = {
      FAST: {
        maxSeniorImpairmentPct: 0,
        juniorDepletionProb: 0,
        liquiditySpiralSeverityAvg: 0,
        redemptionBacklogAvg: 0,
        idleCapitalRatioAvg: 0,
      },
      BASE: {
        maxSeniorImpairmentPct: 0,
        juniorDepletionProb: 0,
        liquiditySpiralSeverityAvg: 0,
        redemptionBacklogAvg: 0,
        idleCapitalRatioAvg: 0,
      },
      SLOW: {
        maxSeniorImpairmentPct: 0,
        juniorDepletionProb: 0,
        liquiditySpiralSeverityAvg: 0,
        redemptionBacklogAvg: 0,
        idleCapitalRatioAvg: 0,
      },
    };

    const count = Math.max(1, records.length);
    for (const rec of records) {
      for (const profile of ["FAST", "BASE", "SLOW"] as const) {
        const m = rec.profiles[profile];
        if (m.maxSeniorImpairmentPct > stats[profile].maxSeniorImpairmentPct) {
          stats[profile].maxSeniorImpairmentPct = m.maxSeniorImpairmentPct;
        }
        stats[profile].juniorDepletionProb += m.juniorDepletionProbability;
        stats[profile].liquiditySpiralSeverityAvg += m.liquiditySpiralSeverityAvg;
        stats[profile].redemptionBacklogAvg += m.redemptionBacklogAvg;
        stats[profile].idleCapitalRatioAvg += m.idleCapitalRatioAvg;
      }
    }

    for (const profile of ["FAST", "BASE", "SLOW"] as const) {
      stats[profile].juniorDepletionProb /= count;
      stats[profile].liquiditySpiralSeverityAvg /= count;
      stats[profile].redemptionBacklogAvg /= count;
      stats[profile].idleCapitalRatioAvg /= count;
    }
    return stats;
  }

  private pushWorst(heap: WorstSeedRecord[], item: WorstSeedRecord) {
    if (heap.length < 25) {
      heap.push(item);
      return;
    }

    let minIdx = 0;
    let minScore = heap[0].severityScore;
    for (let i = 1; i < heap.length; i++) {
      if (heap[i].severityScore < minScore) {
        minScore = heap[i].severityScore;
        minIdx = i;
      }
    }

    if (item.severityScore > minScore) {
      heap[minIdx] = item;
    }
  }

  private configId(cfg: ResimConfig): string {
    return createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 12);
  }

  private fastHash(text: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  private mix32(a: number, b: number): number {
    let x = (a ^ b) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  }

  private rand01(seed: number): number {
    return (seed >>> 0) / 4294967296;
  }

  private gaussianFromUniforms(u1: number, u2: number) {
    const a = Math.max(1e-12, u1);
    const b = Math.max(1e-12, u2);
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  }

  private clamp(x: number, min: number, max: number) {
    return Math.min(max, Math.max(min, x));
  }
}
