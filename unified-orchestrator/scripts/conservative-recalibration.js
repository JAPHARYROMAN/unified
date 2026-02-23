#!/usr/bin/env node
/**
 * Unified v1.2 — Conservative Tranche Recalibration (Institutional Launch Profile)
 * Entry point: reads calibration-results.json, applies stress-regime filters,
 * ranks qualifying configurations, and writes the rectified report.
 *
 * Usage:  node scripts/conservative-recalibration.js
 * Input:  docs/calibration-results.json
 * Output: docs/conservative-recalibration-report.md
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { runAnalysis, JUNIOR_ALLOCS, COV_FLOORS,
        STRESS_DEFAULT_RATES, STRESS_CORRELATIONS, STRESS_RECOVERY_RATES,
        MAX_SENIOR_IMPAIR, MAX_JUNIOR_DEPL, MIN_BREAK_DUR, MAX_CORR_SENS,
      } = require('./conservative-analysis');
const { buildReport } = require('./conservative-report-builder');

const DOCS_DIR   = path.join(__dirname, '..', 'docs');
const JSON_PATH  = path.join(DOCS_DIR, 'calibration-results.json');
const REPORT_OUT = path.join(DOCS_DIR, 'conservative-recalibration-report.md');

function pct(v, d = 2) { return (v * 100).toFixed(d) + '%'; }
function pp(v)          { return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp'; }

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error(`\nERROR: ${JSON_PATH} not found.`);
    console.error('Run  node scripts/calibration-sweep.js  first.\n');
    process.exit(1);
  }

  console.log('\nUnified v1.2 — Conservative Tranche Recalibration');
  console.log('─'.repeat(55));
  console.log(`Loading dataset: ${JSON_PATH}`);
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`  ${data.length.toLocaleString()} configurations loaded.`);

  console.log('\nStress regime:');
  console.log(`  defaultRate  : ${STRESS_DEFAULT_RATES.join('%, ')}%`);
  console.log(`  correlation  : ${STRESS_CORRELATIONS.join(', ')}`);
  console.log(`  recovery     : ${STRESS_RECOVERY_RATES.join('%, ')}%`);
  console.log(`  Scenarios/config: ${STRESS_DEFAULT_RATES.length * STRESS_CORRELATIONS.length * STRESS_RECOVERY_RATES.length}`);

  console.log('\nQualification thresholds:');
  console.log(`  seniorImpairmentProb  < ${pct(MAX_SENIOR_IMPAIR)}`);
  console.log(`  juniorDepletionProb   < ${pct(MAX_JUNIOR_DEPL)}`);
  console.log(`  avgBreakDuration     >= ${MIN_BREAK_DUR} loans`);
  console.log(`  corrSensitivity (0.2→0.4) < ${pp(MAX_CORR_SENS)}`);

  console.log('\nRunning analysis...');
  const { qualified, disqualified, ranked } = runAnalysis(data);

  console.log(`\n  (ja × covFloor) pairs evaluated : ${(JUNIOR_ALLOCS.length * COV_FLOORS.length).toLocaleString()}`);
  console.log(`  Qualifying configurations       : ${qualified.length}`);
  console.log(`  Disqualified                    : ${disqualified.length}`);

  // Breakdown by junior allocation
  console.log('\n  Qualifying by junior allocation:');
  for (const ja of JUNIOR_ALLOCS) {
    const q = qualified.filter(c => c.juniorAllocationBps === ja).length;
    const bar = '█'.repeat(q).padEnd(COV_FLOORS.length, '░');
    console.log(`    ${String(ja).padStart(4)} bps (${String(ja/100).padStart(2)}% jr) : [${bar}] ${q}/${COV_FLOORS.length}`);
  }

  if (ranked.length === 0) {
    console.log('\n  ⚠ No configuration satisfies all four criteria.');
    console.log('  See report for nearest candidates.');
  } else {
    const rec = ranked[0];
    console.log('\n─── Primary Recommendation ────────────────────────────');
    console.log(`  Structure      : ${(10000-rec.juniorAllocationBps)/100}/${rec.juniorAllocationBps/100} Senior/Junior`);
    console.log(`  covFloor       : ${rec.coverageFloorBps} bps`);
    console.log(`  meanSIP        : ${pct(rec.meanSIP)}`);
    console.log(`  maxSIP         : ${pct(rec.maxSIP)}`);
    console.log(`  meanJDP        : ${pct(rec.meanJDP)}`);
    console.log(`  maxJDP         : ${pct(rec.maxJDP)}`);
    console.log(`  minBreakDur    : ${rec.minBD.toFixed(1)} loans`);
    console.log(`  maxCorrSens    : ${pp(rec.maxCorrSens)}`);
    console.log(`  meanCES        : ${rec.meanCES.toFixed(0)}`);

    if (ranked.length > 1) {
      console.log('\n─── Backup Configurations ─────────────────────────────');
      for (let i = 1; i < Math.min(4, ranked.length); i++) {
        const b = ranked[i];
        console.log(`  Backup ${i}: ${(10000-b.juniorAllocationBps)/100}/${b.juniorAllocationBps/100} floor=${b.coverageFloorBps}  maxSIP=${pct(b.maxSIP)}  maxCorrSens=${pp(b.maxCorrSens)}  minBD=${b.minBD.toFixed(1)}`);
      }
    }
  }

  console.log('\nBuilding report...');
  const now    = new Date().toISOString().slice(0, 10);
  const report = buildReport(data, qualified, ranked, now);

  fs.writeFileSync(REPORT_OUT, report, 'utf8');
  console.log(`\n  Report written → ${REPORT_OUT}`);
  console.log('─'.repeat(55) + '\n');
}

main();
