#!/usr/bin/env node
'use strict';
/**
 * Diagnostic: for each (juniorAlloc, covFloor) pair, report which criteria
 * pass/fail under the stress regime, and show the actual values.
 */
const fs   = require('fs');
const path = require('path');

const JSON_PATH = path.join(__dirname, '..', 'docs', 'calibration-results.json');
const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));

const STRESS_DEFAULT_RATES  = [10, 12];
const STRESS_CORRELATIONS   = [0.2, 0.4];
const STRESS_RECOVERY_RATES = [30, 40];
const JUNIOR_ALLOCS = [1000, 1500, 2000, 2500, 3000, 3500, 4000];
const COV_FLOORS    = [500, 750, 1000, 1250, 1500, 1750, 2000];

function lookup(ja, cf, dr, co, rr) {
  return data.find(r =>
    r.juniorAllocationBps === ja && r.coverageFloorBps === cf &&
    r.defaultRatePct === dr && r.correlationFactor === co &&
    r.recoveryRatePct === rr
  ) || null;
}

function getStressRows(ja, cf) {
  const rows = [];
  for (const dr of STRESS_DEFAULT_RATES)
    for (const co of STRESS_CORRELATIONS)
      for (const rr of STRESS_RECOVERY_RATES) {
        const r = lookup(ja, cf, dr, co, rr);
        if (r) rows.push(r);
      }
  return rows;
}

function mean(arr) { return arr.reduce((a,b)=>a+b,0)/arr.length; }

// For each (ja, cf), compute worst-case values across stress scenarios
console.log('\n=== WORST-CASE VALUES ACROSS STRESS REGIME ===');
console.log('(defaultRate ∈ {10,12}%, corr ∈ {0.2,0.4}, recovery ∈ {30,40}%)\n');
console.log('ja    cf    maxSIP%   maxJDP%   minBD   maxCorrSens(pp)');
console.log('-'.repeat(65));

for (const ja of JUNIOR_ALLOCS) {
  for (const cf of COV_FLOORS) {
    const rows = getStressRows(ja, cf);
    if (!rows.length) { console.log(`${ja}  ${cf}  NO DATA`); continue; }

    const maxSIP = Math.max(...rows.map(r => r.seniorImpairmentProb));
    const maxJDP = Math.max(...rows.map(r => r.juniorDepletionProb));
    const minBD  = Math.min(...rows.map(r => r.avgBreakDuration));

    let maxCS = 0;
    for (const dr of STRESS_DEFAULT_RATES)
      for (const rr of STRESS_RECOVERY_RATES) {
        const at02 = lookup(ja, cf, dr, 0.2, rr);
        const at04 = lookup(ja, cf, dr, 0.4, rr);
        if (at02 && at04) maxCS = Math.max(maxCS, at04.seniorImpairmentProb - at02.seniorImpairmentProb);
      }

    const sipOk = maxSIP < 0.01;
    const jdpOk = maxJDP < 0.20;
    const bdOk  = minBD  >= 5;
    const csOk  = maxCS  < 0.03;
    const all   = sipOk && jdpOk && bdOk && csOk;

    console.log(
      `${String(ja).padStart(4)}  ${String(cf).padStart(4)}  ` +
      `${(maxSIP*100).toFixed(2).padStart(7)}% ${sipOk?'✓':'✗'}  ` +
      `${(maxJDP*100).toFixed(2).padStart(7)}% ${jdpOk?'✓':'✗'}  ` +
      `${minBD.toFixed(1).padStart(5)} ${bdOk?'✓':'✗'}  ` +
      `${(maxCS*100).toFixed(2).padStart(7)}pp ${csOk?'✓':'✗'}  ` +
      (all ? '  ← ALL PASS' : '')
    );
  }
}

// Summary: per-criterion pass counts
console.log('\n=== PER-CRITERION PASS COUNTS ===');
let sipPass=0, jdpPass=0, bdPass=0, csPass=0, allPass=0;
for (const ja of JUNIOR_ALLOCS) {
  for (const cf of COV_FLOORS) {
    const rows = getStressRows(ja, cf);
    if (!rows.length) continue;
    const maxSIP = Math.max(...rows.map(r => r.seniorImpairmentProb));
    const maxJDP = Math.max(...rows.map(r => r.juniorDepletionProb));
    const minBD  = Math.min(...rows.map(r => r.avgBreakDuration));
    let maxCS = 0;
    for (const dr of STRESS_DEFAULT_RATES)
      for (const rr of STRESS_RECOVERY_RATES) {
        const at02 = lookup(ja, cf, dr, 0.2, rr);
        const at04 = lookup(ja, cf, dr, 0.4, rr);
        if (at02 && at04) maxCS = Math.max(maxCS, at04.seniorImpairmentProb - at02.seniorImpairmentProb);
      }
    if (maxSIP < 0.01) sipPass++;
    if (maxJDP < 0.20) jdpPass++;
    if (minBD  >= 5)   bdPass++;
    if (maxCS  < 0.03) csPass++;
    if (maxSIP < 0.01 && maxJDP < 0.20 && minBD >= 5 && maxCS < 0.03) allPass++;
  }
}
const total = JUNIOR_ALLOCS.length * COV_FLOORS.length;
console.log(`  seniorImpair < 1%    : ${sipPass}/${total}`);
console.log(`  juniorDepl   < 20%   : ${jdpPass}/${total}`);
console.log(`  breakDur     >= 5    : ${bdPass}/${total}`);
console.log(`  corrSens     < 3pp   : ${csPass}/${total}`);
console.log(`  ALL FOUR             : ${allPass}/${total}`);

// Show actual corrSens values for largest junior allocs
console.log('\n=== ACTUAL corrSens VALUES (max across stress scenarios) ===');
console.log('ja    cf    dr=10%,rr=30%  dr=10%,rr=40%  dr=12%,rr=30%  dr=12%,rr=40%');
console.log('-'.repeat(75));
for (const ja of [2000, 2500, 3000, 3500, 4000]) {
  for (const cf of [1000, 1250, 1500]) {
    const vals = [];
    for (const dr of STRESS_DEFAULT_RATES)
      for (const rr of STRESS_RECOVERY_RATES) {
        const at02 = lookup(ja, cf, dr, 0.2, rr);
        const at04 = lookup(ja, cf, dr, 0.4, rr);
        vals.push(at02 && at04 ? (at04.seniorImpairmentProb - at02.seniorImpairmentProb) : null);
      }
    console.log(
      `${String(ja).padStart(4)}  ${String(cf).padStart(4)}  ` +
      vals.map(v => v === null ? '    —    ' : `${(v*100).toFixed(3).padStart(7)}pp`).join('  ')
    );
  }
}

// Show actual minBD values
console.log('\n=== ACTUAL minBreakDuration VALUES across stress scenarios ===');
console.log('ja    cf    values per scenario (dr/co/rr)');
console.log('-'.repeat(75));
for (const ja of [2000, 2500, 3000, 3500, 4000]) {
  for (const cf of [1000, 1250, 1500]) {
    const rows = getStressRows(ja, cf);
    const bdVals = rows.map(r => r.avgBreakDuration.toFixed(1));
    const minBD  = Math.min(...rows.map(r => r.avgBreakDuration));
    console.log(`${String(ja).padStart(4)}  ${String(cf).padStart(4)}  min=${minBD.toFixed(1)}  [${bdVals.join(', ')}]`);
  }
}
