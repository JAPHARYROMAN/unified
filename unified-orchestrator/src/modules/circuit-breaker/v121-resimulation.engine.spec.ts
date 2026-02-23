import * as fs from "fs";
import * as path from "path";
import { V121ResimulationEngine } from "./v121-resimulation.engine";

describe("UNIFIED v1.2.1 — Stress Re-Simulation & Calibration Equivalence", () => {
  it("produces full artifact bundle with acceptance checks", () => {
    const engine = new V121ResimulationEngine();
    const output = engine.run({
      pathsPerConfig: 5000,
      baseSeed: 1_202_602_23,
      batchSize: 90,
    });

    expect(output.metadata.configCount).toBeGreaterThanOrEqual(8820);
    expect(output.metadata.pathsPerConfig).toBe(5000);
    expect(output.constraints.defaultRateRange).toEqual([10, 12]);
    expect(output.constraints.correlationRange).toEqual([0.2, 0.4]);
    expect(output.constraints.recoveryRange).toEqual([0.3, 0.4]);
    expect(output.responseProfiles.map((x) => x.name)).toEqual(["FAST", "BASE", "SLOW"]);

    expect(output.drift.seniorImpairmentProbabilityDeltaPp).toBeLessThanOrEqual(0.75);
    expect(output.invariants.passNoInvariantViolations).toBe(true);
    expect(output.invariants.inv7Violations).toBe(0);
    expect(output.invariants.inv8Violations).toBe(0);
    expect(output.worstSeedsTop25).toHaveLength(25);

    const targetDir = path.resolve(__dirname, "../../../../docs/simulations/v1.2.1-resimulation");
    const files = engine.writeArtifacts(output, targetDir);
    expect(fs.existsSync(files.outputJson)).toBe(true);
    expect(fs.existsSync(files.replayJson)).toBe(true);
    expect(fs.existsSync(files.auditManifestJson)).toBe(true);
    expect(fs.existsSync(files.invariantReportMd)).toBe(true);
    expect(fs.existsSync(files.stressReportMd)).toBe(true);
  });
});

