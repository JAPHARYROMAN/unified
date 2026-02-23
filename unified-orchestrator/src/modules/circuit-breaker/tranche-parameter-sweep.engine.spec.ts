import * as fs from "fs";
import * as path from "path";
import { TrancheParameterSweepEngine } from "./tranche-parameter-sweep.engine";

describe("Unified v1.2 — Tranche Parameter Sweep & Heatmap Engine", () => {
  it("runs deterministic grid sweep, enforces invariants, and exports JSON+CSV", () => {
    const engine = new TrancheParameterSweepEngine();
    const seedsPerConfiguration = 100;
    const output = engine.runSweep({
      seedCount: seedsPerConfiguration,
      baseSeed: 1_202_602_23,
      batchSize: 36,
    });

    const expectedConfigurations =
      7 * // seniorAllocationBps
      3 * // juniorCoverageFloorBps
      4 * // recoveryRate
      3 * // withdrawalSensitivity
      3; // correlationLevel

    expect(output.metadata.seedsPerConfiguration).toBe(seedsPerConfiguration);
    expect(output.metadata.configurationCount).toBe(expectedConfigurations);
    expect(output.records).toHaveLength(expectedConfigurations);
    expect(output.metadata.totalRuns).toBe(expectedConfigurations * seedsPerConfiguration);
    expect(output.invariants.totalWaterfallViolations).toBe(0);
    expect(output.invariants.totalNegativeNavStates).toBe(0);

    // Determinism check: same config + seed => identical run stats.
    const deterministicConfig = {
      seniorAllocationBps: 7500,
      juniorCoverageFloorBps: 1500,
      recoveryRate: 0.5,
      withdrawalSensitivity: "MEDIUM" as const,
      correlationLevel: "MODERATE" as const,
    };
    const runA = engine.simulateConfigurationSeed(deterministicConfig, 42_4242);
    const runB = engine.simulateConfigurationSeed(deterministicConfig, 42_4242);
    expect(runA).toEqual(runB);

    const exportDir = path.resolve(__dirname, "../../../../docs/simulations/tranche-parameter-sweep");
    const files = engine.writeSweepOutput(output, exportDir);
    expect(fs.existsSync(files.jsonPath)).toBe(true);
    expect(fs.existsSync(files.csvPath)).toBe(true);

    const csv = fs.readFileSync(files.csvPath, "utf8");
    const lines = csv.split("\n");
    // header + 756 configuration rows
    expect(lines.length).toBe(expectedConfigurations + 1);
  });
});
