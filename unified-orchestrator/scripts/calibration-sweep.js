#!/usr/bin/env node
/**
 * Unified v1.2 — Capital Structure Calibration Sweep
 * Entry point: runs full parameter sweep, writes JSON + markdown report.
 * No external dependencies — pure Node.js.
 *
 * Usage: node scripts/calibration-sweep.js
 * Output: docs/calibration-results.json
 *         docs/calibration-report.md
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { evalConfig }  = require('./calibration-engine');
const { buildReport } = require('./calibration-report');

// ─── Sweep dimensions ─────────────────────────────────────────────────────────
const JUNIOR_ALLOCS  = [1000, 1500, 2000, 2500, 3000, 3500, 4000];
const COV_FLOORS     = [500, 750, 1000, 1250, 1500, 1750, 2000];
const DEFAULT_RATES  = [2, 5, 8, 10, 12, 15, 20, 25, 30];
const CORRELATIONS   = [0.0, 0.2, 0.4, 0.6];
const RECOVERY_RATES = [0, 20, 30, 40, 60];
const MC_RUNS        = 5_000;

const POOL_EXPOSURE  = 1_000_000;
const LOAN_COUNT     = 50;

const DOCS_DIR = path.join(__dirname, '..', 'docs');

function runSweep() {
  const results = [];
  const total =
    JUNIOR_ALLOCS.length * COV_FLOORS.length * DEFAULT_RATES.length *
    CORRELATIONS.length * RECOVERY_RATES.length;
  let done = 0;

  console.log(`\nUnified v1.2 — Capital Structure Calibration Sweep`);
  console.log(`Configurations: ${total.toLocaleString()} | MC runs/config: ${MC_RUNS.toLocaleString()}`);
  console.log(`Pool: $${POOL_EXPOSURE.toLocaleString()} USDC | Loans: ${LOAN_COUNT}\n`);

  const t0 = Date.now();

  for (const ja of JUNIOR_ALLOCS)
    for (const cf of COV_FLOORS)
      for (const dr of DEFAULT_RATES)
        for (const co of CORRELATIONS)
          for (const rr of RECOVERY_RATES) {
            results.push(evalConfig({
              loanCount:          LOAN_COUNT,
              poolExposure:       POOL_EXPOSURE,
              juniorAllocationBps: ja,
              coverageFloorBps:   cf,
              defaultRatePct:     dr,
              rho:                co,
              recoveryRatePct:    rr,
            }, MC_RUNS));

            done++;
            if (done % 100 === 0 || done === total) {
              const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
              const bar = '█'.repeat(Math.round(done / total * 30)).padEnd(30, '░');
              process.stdout.write(
                `\r  [${bar}] ${done}/${total} (${Math.round(done / total * 100)}%) ${elapsed}s`
              );
            }
          }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n\nSweep complete in ${elapsed}s.\n`);
  return results;
}

function main() {
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

  // Run sweep
  const results = runSweep();

  // Write raw JSON
  const jsonPath = path.join(DOCS_DIR, 'calibration-results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`  JSON written → ${jsonPath}`);

  // Build and write markdown report
  const md = buildReport(results, MC_RUNS);
  const mdPath = path.join(DOCS_DIR, 'calibration-report.md');
  fs.writeFileSync(mdPath, md);
  console.log(`  Report written → ${mdPath}`);

  // Print quick summary to console
  const total = results.length;
  const seniorSafe   = results.filter(r => r.seniorImpairmentProb  < 0.01).length;
  const juniorStable = results.filter(r => r.juniorDepletionProb   < 0.30).length;
  const breakerMgmt  = results.filter(r => r.avgBreakDuration      >= 5).length;
  const sortedByCE   = [...results].sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore);
  const q75          = sortedByCE[Math.floor(sortedByCE.length * 0.25)].capitalEfficiencyScore;
  const capOpt       = results.filter(r => r.capitalEfficiencyScore >= q75).length;
  const intersection = results.filter(r =>
    r.seniorImpairmentProb  < 0.01 &&
    r.juniorDepletionProb   < 0.30 &&
    r.avgBreakDuration      >= 5   &&
    r.capitalEfficiencyScore >= q75
  ).sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore);

  console.log('\n─── Surface Summary ───────────────────────────────────────');
  console.log(`  seniorImpairProb < 1%          : ${seniorSafe.toLocaleString()} / ${total.toLocaleString()} (${(seniorSafe/total*100).toFixed(1)}%)`);
  console.log(`  juniorDepletionProb < 30%      : ${juniorStable.toLocaleString()} / ${total.toLocaleString()} (${(juniorStable/total*100).toFixed(1)}%)`);
  console.log(`  avgBreakDuration >= 5 loans    : ${breakerMgmt.toLocaleString()} / ${total.toLocaleString()} (${(breakerMgmt/total*100).toFixed(1)}%)`);
  console.log(`  capEffScore top quartile (≥${q75.toFixed(0)}): ${capOpt.toLocaleString()} / ${total.toLocaleString()} (${(capOpt/total*100).toFixed(1)}%)`);
  console.log(`  Intersection (all four)        : ${intersection.length.toLocaleString()} / ${total.toLocaleString()} (${(intersection.length/total*100).toFixed(1)}%)`);

  if (intersection.length > 0) {
    const best = intersection[0];
    console.log('\n─── Optimal Configuration ─────────────────────────────────');
    console.log(`  juniorAllocationBps    : ${best.juniorAllocationBps} (${best.juniorAllocationBps/100}%)`);
    console.log(`  coverageFloorBps       : ${best.coverageFloorBps}`);
    console.log(`  seniorImpairmentProb   : ${(best.seniorImpairmentProb*100).toFixed(2)}%`);
    console.log(`  juniorDepletionProb    : ${(best.juniorDepletionProb*100).toFixed(2)}%`);
    console.log(`  avgBreakDuration       : ${best.avgBreakDuration} loans`);
    console.log(`  capitalEfficiencyScore : ${best.capitalEfficiencyScore}`);
    console.log(`  (scenario: defaultRate=${best.defaultRatePct}%, corr=${best.correlationFactor}, recovery=${best.recoveryRatePct}%)`);
  } else {
    console.log('\n  ⚠ No config satisfies all four regions. See report for Pareto frontier.');
  }
  console.log('───────────────────────────────────────────────────────────\n');
}

main();
