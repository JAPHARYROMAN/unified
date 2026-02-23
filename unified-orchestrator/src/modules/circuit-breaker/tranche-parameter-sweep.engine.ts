import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type WithdrawalSensitivity = "LOW" | "MEDIUM" | "HIGH";
export type CorrelationLevel = "LOW" | "MODERATE" | "CLUSTERED";

export interface SweepConfiguration {
  seniorAllocationBps: number;
  juniorCoverageFloorBps: number;
  recoveryRate: number;
  withdrawalSensitivity: WithdrawalSensitivity;
  correlationLevel: CorrelationLevel;
}

export interface SweepMetrics {
  seniorImpairmentProbability: number;
  juniorDepletionProbability: number;
  breakerActivationFrequency: number;
  avgBreakerDuration: number;
  avgTimeToStabilization: number;
  avgJuniorNAVVolatility: number;
  avgSeniorNAVVolatility: number;
  capitalEfficiencyScore: number;
  waterfallViolationCount: number;
  negativeNavCount: number;
}

export interface SweepRecord {
  configuration: SweepConfiguration;
  metrics: SweepMetrics;
}

export interface SweepOutput {
  metadata: {
    runId: string;
    generatedAt: string;
    deterministic: true;
    seedsPerConfiguration: number;
    configurationCount: number;
    totalRuns: number;
    batchSize: number;
  };
  parameterAxes: {
    seniorAllocationBps: number[];
    juniorCoverageFloorBps: number[];
    recoveryRate: number[];
    withdrawalSensitivity: WithdrawalSensitivity[];
    correlationLevel: CorrelationLevel[];
  };
  records: SweepRecord[];
  heatmap: {
    key: string;
    xAxis: "seniorAllocationBps";
    yAxis: "recoveryRate";
    slice: {
      juniorCoverageFloorBps: number;
      withdrawalSensitivity: WithdrawalSensitivity;
      correlationLevel: CorrelationLevel;
    };
    values: Array<{ x: number; y: number; seniorImpairmentProbability: number }>;
  }[];
  contours: Array<{
    juniorCoverageFloorBps: number;
    withdrawalSensitivity: WithdrawalSensitivity;
    correlationLevel: CorrelationLevel;
    points: Array<{ seniorAllocationBps: number; recoveryRate: number; riskScore: number }>;
  }>;
  invariants: {
    totalWaterfallViolations: number;
    totalNegativeNavStates: number;
  };
}

interface SingleRunStats {
  seniorImpaired: boolean;
  juniorDepleted: boolean;
  breakerActivated: boolean;
  breakerDurationSteps: number;
  timeToStabilizationSteps: number;
  juniorVolatility: number;
  seniorVolatility: number;
  capitalEfficiencyScore: number;
  waterfallViolationCount: number;
  negativeNavCount: number;
}

type BreakerState = "NORMAL" | "ACTIVE" | "RECOVERY_MONITOR";

const BPS = 10_000;
const TIMESTEPS = 36;
const BASE_TOTAL_NAV = 100_000;
const BASE_LOAN_BOOK_UTILIZATION = 0.75;

export class TrancheParameterSweepEngine {
  static readonly SENIOR_ALLOCATION_BPS = [6000, 6500, 7000, 7500, 8000, 8500, 9000];
  static readonly JUNIOR_COVERAGE_FLOOR_BPS = [1000, 1500, 2000];
  static readonly RECOVERY_RATE = [0.3, 0.4, 0.5, 0.6];
  static readonly WITHDRAWAL_SENSITIVITY: WithdrawalSensitivity[] = ["LOW", "MEDIUM", "HIGH"];
  static readonly CORRELATION_LEVEL: CorrelationLevel[] = ["LOW", "MODERATE", "CLUSTERED"];

  buildParameterGrid(): SweepConfiguration[] {
    const out: SweepConfiguration[] = [];
    for (const seniorAllocationBps of TrancheParameterSweepEngine.SENIOR_ALLOCATION_BPS) {
      for (const juniorCoverageFloorBps of TrancheParameterSweepEngine.JUNIOR_COVERAGE_FLOOR_BPS) {
        for (const recoveryRate of TrancheParameterSweepEngine.RECOVERY_RATE) {
          for (const withdrawalSensitivity of TrancheParameterSweepEngine.WITHDRAWAL_SENSITIVITY) {
            for (const correlationLevel of TrancheParameterSweepEngine.CORRELATION_LEVEL) {
              out.push({
                seniorAllocationBps,
                juniorCoverageFloorBps,
                recoveryRate,
                withdrawalSensitivity,
                correlationLevel,
              });
            }
          }
        }
      }
    }
    return out;
  }

  runSweep(params: {
    seedCount: number;
    baseSeed: number;
    batchSize?: number;
  }): SweepOutput {
    const grid = this.buildParameterGrid();
    const batchSize = params.batchSize ?? 36;
    const records: SweepRecord[] = [];
    let totalWaterfallViolations = 0;
    let totalNegativeNavStates = 0;

    for (let start = 0; start < grid.length; start += batchSize) {
      const batch = grid.slice(start, start + batchSize);
      for (const configuration of batch) {
        const stats: SingleRunStats[] = [];
        for (let seedIndex = 0; seedIndex < params.seedCount; seedIndex++) {
          const seed = this.mixSeed(params.baseSeed, configuration, seedIndex);
          stats.push(this.simulateConfigurationSeed(configuration, seed));
        }

        const metrics = this.aggregateStats(stats);
        totalWaterfallViolations += metrics.waterfallViolationCount;
        totalNegativeNavStates += metrics.negativeNavCount;
        records.push({ configuration, metrics });
      }
    }

    return {
      metadata: {
        runId: `tranche-sweep-${params.baseSeed}`,
        generatedAt: new Date().toISOString(),
        deterministic: true,
        seedsPerConfiguration: params.seedCount,
        configurationCount: grid.length,
        totalRuns: grid.length * params.seedCount,
        batchSize,
      },
      parameterAxes: {
        seniorAllocationBps: TrancheParameterSweepEngine.SENIOR_ALLOCATION_BPS,
        juniorCoverageFloorBps: TrancheParameterSweepEngine.JUNIOR_COVERAGE_FLOOR_BPS,
        recoveryRate: TrancheParameterSweepEngine.RECOVERY_RATE,
        withdrawalSensitivity: TrancheParameterSweepEngine.WITHDRAWAL_SENSITIVITY,
        correlationLevel: TrancheParameterSweepEngine.CORRELATION_LEVEL,
      },
      records,
      heatmap: this.toHeatmap(records),
      contours: this.toContours(records),
      invariants: {
        totalWaterfallViolations,
        totalNegativeNavStates,
      },
    };
  }

  writeSweepOutput(output: SweepOutput, targetDir: string) {
    fs.mkdirSync(targetDir, { recursive: true });
    const jsonPath = path.join(targetDir, "tranche-parameter-sweep-heatmap.json");
    const csvPath = path.join(targetDir, "tranche-parameter-sweep-heatmap.csv");
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf8");
    fs.writeFileSync(csvPath, this.toCsv(output.records), "utf8");
    return { jsonPath, csvPath };
  }

  simulateConfigurationSeed(configuration: SweepConfiguration, seed: number): SingleRunStats {
    const rng = this.mulberry32(seed);

    let seniorNav = BigInt(Math.floor((BASE_TOTAL_NAV * configuration.seniorAllocationBps) / BPS));
    let juniorNav = BigInt(BASE_TOTAL_NAV) - seniorNav;
    let seniorLossAbsorbed = 0n;
    let juniorLossAbsorbed = 0n;
    const recoveryQueue = new Map<number, bigint[]>();
    const seniorSeries: number[] = [Number(seniorNav)];
    const juniorSeries: number[] = [Number(juniorNav)];
    let breakerState: BreakerState = "NORMAL";
    let breakerActivated = false;
    let breakerDurationSteps = 0;
    let timeToStabilizationSteps = 0;
    let stabilityCounter = 0;
    let firstActivationStep: number | null = null;
    let waterfallViolationCount = 0;
    let negativeNavCount = 0;

    const sensitivityMultiplier =
      configuration.withdrawalSensitivity === "LOW"
        ? 0.6
        : configuration.withdrawalSensitivity === "MEDIUM"
          ? 1
          : 1.45;
    const correlationMultiplier =
      configuration.correlationLevel === "LOW"
        ? 0.85
        : configuration.correlationLevel === "MODERATE"
          ? 1.15
          : 1.55;

    let liquidityRatioBps = 2400;
    let queuePressureBps = 300;

    for (let t = 1; t <= TIMESTEPS; t++) {
      const shockNoise = (rng() - 0.5) * 0.006;
      const clusterShock =
        configuration.correlationLevel === "CLUSTERED" && (t % 9 === 0 || t % 10 === 0) ? 0.02 : 0;
      const baseDefaultRate = 0.008 * correlationMultiplier + shockNoise + clusterShock;
      const boundedDefaultRate = Math.min(Math.max(baseDefaultRate, 0.001), 0.25);

      const withdrawalPulse =
        ((queuePressureBps / BPS) * 0.015 + boundedDefaultRate * 0.8) * sensitivityMultiplier;
      queuePressureBps = Math.min(8000, Math.max(0, Math.round(queuePressureBps + withdrawalPulse * BPS - 120)));
      liquidityRatioBps = Math.max(
        500,
        Math.min(3000, Math.round(liquidityRatioBps - queuePressureBps / 55 + (configuration.recoveryRate * 100))),
      );

      const stressedUtilization = BASE_LOAN_BOOK_UTILIZATION + (queuePressureBps / BPS) * 0.08;
      const exposure = Number(seniorNav + juniorNav) * Math.min(stressedUtilization, 0.95);
      const grossLoss = BigInt(Math.floor(exposure * boundedDefaultRate));
      const netLoss = BigInt(Math.floor(Number(grossLoss) * (1 - configuration.recoveryRate)));
      const waterfall = this.applyWaterfallLoss(juniorNav, seniorNav, netLoss);
      juniorNav = waterfall.juniorNav;
      seniorNav = waterfall.seniorNav;
      juniorLossAbsorbed += waterfall.juniorAbsorbed;
      seniorLossAbsorbed += waterfall.seniorAbsorbed;

      if (waterfall.juniorAbsorbed + waterfall.seniorAbsorbed + waterfall.residual !== netLoss) {
        waterfallViolationCount += 1;
      }
      if (waterfall.residual !== 0n) {
        waterfallViolationCount += 1;
      }

      const recoveryLag = 2 + Math.floor(rng() * 4);
      const recoveryAmount = BigInt(Math.floor(Number(grossLoss) * configuration.recoveryRate * 0.75));
      const bucket = recoveryQueue.get(t + recoveryLag) ?? [];
      bucket.push(recoveryAmount);
      recoveryQueue.set(t + recoveryLag, bucket);

      const recoveries = recoveryQueue.get(t) ?? [];
      let totalRecovery = 0n;
      for (const r of recoveries) totalRecovery += r;
      if (recoveries.length > 0) {
        const recovery = this.applyRecoveryReverseImpairment(
          juniorNav,
          seniorNav,
          juniorLossAbsorbed,
          seniorLossAbsorbed,
          totalRecovery,
        );
        juniorNav = recovery.juniorNav;
        seniorNav = recovery.seniorNav;
        juniorLossAbsorbed = recovery.juniorLossAbsorbed;
        seniorLossAbsorbed = recovery.seniorLossAbsorbed;
        if (recovery.juniorRecovered + recovery.seniorRecovered + recovery.residual !== totalRecovery) {
          waterfallViolationCount += 1;
        }
      }

      if (juniorNav < 0n || seniorNav < 0n) negativeNavCount += 1;
      if (juniorNav < 0n) juniorNav = 0n;
      if (seniorNav < 0n) seniorNav = 0n;

      const seniorImpairmentBps = Number((seniorLossAbsorbed * BigInt(BPS)) / BigInt(Math.max(1, BASE_TOTAL_NAV)));
      const juniorCoverageBps = Number(
        (juniorNav * BigInt(BPS)) / BigInt(Math.max(1, Number(seniorNav + juniorNav))),
      );

      const breach =
        seniorImpairmentBps > 150 || // >1.5% absorbed at senior
        juniorCoverageBps < configuration.juniorCoverageFloorBps ||
        liquidityRatioBps < 1300;

      if (breach && breakerState === "NORMAL") {
        breakerState = "ACTIVE";
        breakerActivated = true;
        firstActivationStep = t;
      }

      if (breakerState === "ACTIVE") {
        breakerDurationSteps += 1;
      }

      const stable = liquidityRatioBps >= 1800 && juniorCoverageBps >= configuration.juniorCoverageFloorBps;
      if (breakerState !== "NORMAL" && stable) {
        stabilityCounter += 1;
      } else {
        stabilityCounter = 0;
      }

      if (breakerState === "ACTIVE" && stabilityCounter >= 3) {
        breakerState = "RECOVERY_MONITOR";
      } else if (breakerState === "RECOVERY_MONITOR" && stabilityCounter >= 6) {
        breakerState = "NORMAL";
        if (firstActivationStep !== null && timeToStabilizationSteps === 0) {
          timeToStabilizationSteps = t - firstActivationStep;
        }
      }

      seniorSeries.push(Number(seniorNav));
      juniorSeries.push(Number(juniorNav));
    }

    const seniorStart = seniorSeries[0];
    const seniorEnd = seniorSeries[seniorSeries.length - 1];
    const efficiencyYield = 0.035 + configuration.recoveryRate * 0.06 + (BPS - configuration.seniorAllocationBps) / 1_000_000;
    const protection = seniorStart > 0 ? Math.max(0, Math.min(1, seniorEnd / seniorStart)) : 0;
    const capitalEfficiencyScore = efficiencyYield * (0.5 + 0.5 * protection) * 100;

    return {
      seniorImpaired: seniorLossAbsorbed > 0n,
      juniorDepleted: juniorNav === 0n,
      breakerActivated,
      breakerDurationSteps,
      timeToStabilizationSteps,
      juniorVolatility: this.computeVolatility(juniorSeries),
      seniorVolatility: this.computeVolatility(seniorSeries),
      capitalEfficiencyScore,
      waterfallViolationCount,
      negativeNavCount,
    };
  }

  private aggregateStats(stats: SingleRunStats[]): SweepMetrics {
    const n = Math.max(1, stats.length);
    const sum = <T>(pick: (x: SingleRunStats) => T) =>
      stats.reduce((acc, cur) => acc + Number(pick(cur)), 0);
    return {
      seniorImpairmentProbability: sum((x) => (x.seniorImpaired ? 1 : 0)) / n,
      juniorDepletionProbability: sum((x) => (x.juniorDepleted ? 1 : 0)) / n,
      breakerActivationFrequency: sum((x) => (x.breakerActivated ? 1 : 0)) / n,
      avgBreakerDuration: sum((x) => x.breakerDurationSteps) / n,
      avgTimeToStabilization: sum((x) => x.timeToStabilizationSteps) / n,
      avgJuniorNAVVolatility: sum((x) => x.juniorVolatility) / n,
      avgSeniorNAVVolatility: sum((x) => x.seniorVolatility) / n,
      capitalEfficiencyScore: sum((x) => x.capitalEfficiencyScore) / n,
      waterfallViolationCount: sum((x) => x.waterfallViolationCount),
      negativeNavCount: sum((x) => x.negativeNavCount),
    };
  }

  private toHeatmap(records: SweepRecord[]): SweepOutput["heatmap"] {
    const heatmaps: SweepOutput["heatmap"] = [];
    for (const juniorCoverageFloorBps of TrancheParameterSweepEngine.JUNIOR_COVERAGE_FLOOR_BPS) {
      for (const withdrawalSensitivity of TrancheParameterSweepEngine.WITHDRAWAL_SENSITIVITY) {
        for (const correlationLevel of TrancheParameterSweepEngine.CORRELATION_LEVEL) {
          const values = records
            .filter(
              (r) =>
                r.configuration.juniorCoverageFloorBps === juniorCoverageFloorBps &&
                r.configuration.withdrawalSensitivity === withdrawalSensitivity &&
                r.configuration.correlationLevel === correlationLevel,
            )
            .map((r) => ({
              x: r.configuration.seniorAllocationBps,
              y: r.configuration.recoveryRate,
              seniorImpairmentProbability: r.metrics.seniorImpairmentProbability,
            }));

          heatmaps.push({
            key: `${juniorCoverageFloorBps}-${withdrawalSensitivity}-${correlationLevel}`,
            xAxis: "seniorAllocationBps",
            yAxis: "recoveryRate",
            slice: { juniorCoverageFloorBps, withdrawalSensitivity, correlationLevel },
            values,
          });
        }
      }
    }
    return heatmaps;
  }

  private toContours(records: SweepRecord[]): SweepOutput["contours"] {
    const contours: SweepOutput["contours"] = [];
    for (const juniorCoverageFloorBps of TrancheParameterSweepEngine.JUNIOR_COVERAGE_FLOOR_BPS) {
      for (const withdrawalSensitivity of TrancheParameterSweepEngine.WITHDRAWAL_SENSITIVITY) {
        for (const correlationLevel of TrancheParameterSweepEngine.CORRELATION_LEVEL) {
          const points = records
            .filter(
              (r) =>
                r.configuration.juniorCoverageFloorBps === juniorCoverageFloorBps &&
                r.configuration.withdrawalSensitivity === withdrawalSensitivity &&
                r.configuration.correlationLevel === correlationLevel,
            )
            .map((r) => ({
              seniorAllocationBps: r.configuration.seniorAllocationBps,
              recoveryRate: r.configuration.recoveryRate,
              riskScore:
                r.metrics.seniorImpairmentProbability * 0.4 +
                r.metrics.juniorDepletionProbability * 0.3 +
                r.metrics.breakerActivationFrequency * 0.2 +
                r.metrics.avgSeniorNAVVolatility * 0.1,
            }));
          contours.push({
            juniorCoverageFloorBps,
            withdrawalSensitivity,
            correlationLevel,
            points,
          });
        }
      }
    }
    return contours;
  }

  private toCsv(records: SweepRecord[]): string {
    const header = [
      "seniorAllocationBps",
      "juniorCoverageFloorBps",
      "recoveryRate",
      "withdrawalSensitivity",
      "correlationLevel",
      "seniorImpairmentProbability",
      "juniorDepletionProbability",
      "breakerActivationFrequency",
      "avgBreakerDuration",
      "avgTimeToStabilization",
      "avgJuniorNAVVolatility",
      "avgSeniorNAVVolatility",
      "capitalEfficiencyScore",
      "waterfallViolationCount",
      "negativeNavCount",
    ];
    const rows = records.map((r) =>
      [
        r.configuration.seniorAllocationBps,
        r.configuration.juniorCoverageFloorBps,
        r.configuration.recoveryRate.toFixed(2),
        r.configuration.withdrawalSensitivity,
        r.configuration.correlationLevel,
        r.metrics.seniorImpairmentProbability.toFixed(6),
        r.metrics.juniorDepletionProbability.toFixed(6),
        r.metrics.breakerActivationFrequency.toFixed(6),
        r.metrics.avgBreakerDuration.toFixed(6),
        r.metrics.avgTimeToStabilization.toFixed(6),
        r.metrics.avgJuniorNAVVolatility.toFixed(6),
        r.metrics.avgSeniorNAVVolatility.toFixed(6),
        r.metrics.capitalEfficiencyScore.toFixed(6),
        r.metrics.waterfallViolationCount,
        r.metrics.negativeNavCount,
      ].join(","),
    );
    return [header.join(","), ...rows].join("\n");
  }

  private mixSeed(baseSeed: number, cfg: SweepConfiguration, seedIndex: number): number {
    const key = JSON.stringify({ baseSeed, cfg, seedIndex });
    const digest = createHash("sha256").update(key).digest();
    return digest.readUInt32LE(0);
  }

  private mulberry32(seed: number) {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let x = Math.imul(t ^ (t >>> 15), t | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  private applyWaterfallLoss(juniorNav: bigint, seniorNav: bigint, loss: bigint) {
    let remaining = loss;
    const juniorAbsorbed = remaining > juniorNav ? juniorNav : remaining;
    remaining -= juniorAbsorbed;
    const seniorAbsorbed = remaining > seniorNav ? seniorNav : remaining;
    remaining -= seniorAbsorbed;
    return {
      juniorNav: juniorNav - juniorAbsorbed,
      seniorNav: seniorNav - seniorAbsorbed,
      juniorAbsorbed,
      seniorAbsorbed,
      residual: remaining,
    };
  }

  private applyRecoveryReverseImpairment(
    juniorNav: bigint,
    seniorNav: bigint,
    juniorLossAbsorbed: bigint,
    seniorLossAbsorbed: bigint,
    recovery: bigint,
  ) {
    let remaining = recovery;
    const seniorRecovered = remaining > seniorLossAbsorbed ? seniorLossAbsorbed : remaining;
    remaining -= seniorRecovered;
    const juniorRecovered = remaining > juniorLossAbsorbed ? juniorLossAbsorbed : remaining;
    remaining -= juniorRecovered;
    return {
      juniorNav: juniorNav + juniorRecovered,
      seniorNav: seniorNav + seniorRecovered,
      juniorRecovered,
      seniorRecovered,
      juniorLossAbsorbed: juniorLossAbsorbed - juniorRecovered,
      seniorLossAbsorbed: seniorLossAbsorbed - seniorRecovered,
      residual: remaining,
    };
  }

  private computeVolatility(series: number[]): number {
    if (series.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      if (prev <= 0) continue;
      returns.push((cur - prev) / prev);
    }
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (returns.length - 1);
    return Math.sqrt(Math.max(variance, 0));
  }
}

