/**
 * Report builder — consumes sweep results, emits markdown.
 * No external dependencies.
 */
'use strict';

const JUNIOR_ALLOCS  = [1000, 1500, 2000, 2500, 3000, 3500, 4000];
const COV_FLOORS     = [500, 750, 1000, 1250, 1500, 1750, 2000];
const DEFAULT_RATES  = [2, 5, 8, 10, 12, 15, 20, 25, 30];
const CORRELATIONS   = [0.0, 0.2, 0.4, 0.6];
const RECOVERY_RATES = [0, 20, 30, 40, 60];

function pct(n, d) { return (n / d * 100).toFixed(1) + '%'; }
function pad(s, w)  { return String(s).padEnd(w); }

function mdTable(headers, rows, widths) {
  const lines = [];
  lines.push('| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |');
  lines.push('| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |');
  for (const row of rows)
    lines.push('| ' + row.map((c, i) => pad(String(c), widths[i])).join(' | ') + ' |');
  return lines.join('\n') + '\n';
}

// Matrix: juniorAlloc rows × defaultRate cols, fixed corr/recovery/floor
function matrix(results, metricFn, qualFn, fixedCorr, fixedRecovery, fixedFloor) {
  const headers = ['juniorAlloc', ...DEFAULT_RATES.map(d => `${d}%`)];
  const widths  = [14, ...DEFAULT_RATES.map(() => 9)];
  const rows = JUNIOR_ALLOCS.map(bps => {
    const cells = DEFAULT_RATES.map(dr => {
      const m = results.find(r =>
        r.juniorAllocationBps === bps && r.defaultRatePct === dr &&
        r.correlationFactor === fixedCorr && r.recoveryRatePct === fixedRecovery &&
        r.coverageFloorBps === fixedFloor
      );
      if (!m) return '—';
      const v = metricFn(m);
      return qualFn(m) ? `✓${v}` : v;
    });
    return [`${bps}(${bps / 100}%)`, ...cells];
  });
  return mdTable(headers, rows, widths);
}

function sensitivityFloor(results) {
  const rows = COV_FLOORS.map(cf => {
    const m = results.find(r =>
      r.juniorAllocationBps === 2000 && r.defaultRatePct === 10 &&
      r.correlationFactor === 0.2 && r.recoveryRatePct === 30 &&
      r.coverageFloorBps === cf
    );
    if (!m) return [cf, '—', '—', '—', '—'];
    return [cf,
      (m.seniorImpairmentProb * 100).toFixed(2) + '%',
      (m.breakerActivationRate * 100).toFixed(2) + '%',
      m.avgBreakDuration.toFixed(1),
      m.capitalEfficiencyScore.toFixed(2)];
  });
  return mdTable(
    ['covFloor', 'seniorImpair%', 'breakerRate%', 'avgBreakDur', 'capEffScore'],
    rows, [10, 14, 13, 12, 12]
  );
}

function sensitivityRecovery(results) {
  const rows = RECOVERY_RATES.map(rr => {
    const m = results.find(r =>
      r.juniorAllocationBps === 2000 && r.coverageFloorBps === 1500 &&
      r.defaultRatePct === 15 && r.correlationFactor === 0.2 &&
      r.recoveryRatePct === rr
    );
    if (!m) return [rr + '%', '—', '—', '—'];
    return [rr + '%',
      (m.seniorImpairmentProb * 100).toFixed(2) + '%',
      (m.juniorDepletionProb * 100).toFixed(2) + '%',
      m.capitalEfficiencyScore.toFixed(2)];
  });
  return mdTable(
    ['recovery%', 'seniorImpair%', 'juniorDepl%', 'capEffScore'],
    rows, [10, 14, 12, 12]
  );
}

function sensitivityCorr(results) {
  const rows = CORRELATIONS.map(co => {
    const m = results.find(r =>
      r.juniorAllocationBps === 2000 && r.coverageFloorBps === 1500 &&
      r.defaultRatePct === 10 && r.recoveryRatePct === 30 &&
      r.correlationFactor === co
    );
    if (!m) return [co, '—', '—', '—'];
    return [co,
      (m.seniorImpairmentProb * 100).toFixed(2) + '%',
      (m.juniorDepletionProb * 100).toFixed(2) + '%',
      m.avgBreakDuration.toFixed(1)];
  });
  return mdTable(
    ['correlation', 'seniorImpair%', 'juniorDepl%', 'avgBreakDur'],
    rows, [12, 14, 12, 12]
  );
}

function paretoTable(results) {
  const rows = JUNIOR_ALLOCS.map(bps => {
    const cands = results
      .filter(r => r.juniorAllocationBps === bps && r.seniorImpairmentProb < 0.01)
      .sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore);
    if (!cands.length) return [`${bps}(${bps/100}%)`, '—', '—', '—', '—', 'n/a', 'n/a', 'n/a', 'n/a'];
    const b = cands[0];
    return [
      `${bps}(${bps/100}%)`,
      b.coverageFloorBps,
      b.defaultRatePct + '%',
      b.correlationFactor,
      b.recoveryRatePct + '%',
      (b.seniorImpairmentProb * 100).toFixed(2) + '%',
      (b.juniorDepletionProb * 100).toFixed(2) + '%',
      b.avgBreakDuration.toFixed(1),
      b.capitalEfficiencyScore.toFixed(2),
    ];
  });
  return mdTable(
    ['juniorAlloc', 'covFloor', 'defaultRate', 'corr', 'recovery',
     'seniorImpair%', 'juniorDepl%', 'avgBreakDur', 'capEffScore'],
    rows, [14, 9, 11, 6, 9, 14, 12, 12, 12]
  );
}

function fragileTable(results) {
  const rows = [];
  for (const bps of JUNIOR_ALLOCS)
    for (const dr of DEFAULT_RATES)
      for (const rr of RECOVERY_RATES) {
        const at02 = results.find(r =>
          r.juniorAllocationBps === bps && r.defaultRatePct === dr &&
          r.correlationFactor === 0.2 && r.recoveryRatePct === rr &&
          r.coverageFloorBps === 1500);
        const at04 = results.find(r =>
          r.juniorAllocationBps === bps && r.defaultRatePct === dr &&
          r.correlationFactor === 0.4 && r.recoveryRatePct === rr &&
          r.coverageFloorBps === 1500);
        if (at02 && at04) {
          const delta = at04.seniorImpairmentProb - at02.seniorImpairmentProb;
          if (delta > 0.05)
            rows.push([
              `${bps}(${bps/100}%)`, dr + '%', rr + '%',
              (at02.seniorImpairmentProb * 100).toFixed(2) + '%',
              (at04.seniorImpairmentProb * 100).toFixed(2) + '%',
              '+' + (delta * 100).toFixed(2) + 'pp',
            ]);
        }
      }
  if (!rows.length) return '_No fragile configurations detected._\n';
  const shown = rows.slice(0, 25);
  return mdTable(
    ['juniorAlloc', 'defaultRate', 'recovery', 'sip@corr0.2', 'sip@corr0.4', 'delta'],
    shown, [14, 11, 9, 12, 12, 9]
  ) + (rows.length > 25 ? `_...and ${rows.length - 25} more fragile configurations._\n` : '');
}

function buildReport(results, mcRuns) {
  const total    = results.length;
  const now      = new Date().toISOString().slice(0, 10);

  const seniorSafe   = results.filter(r => r.seniorImpairmentProb  < 0.01);
  const juniorStable = results.filter(r => r.juniorDepletionProb   < 0.30);
  const breakerMgmt  = results.filter(r => r.avgBreakDuration      >= 5);
  const sortedByCE   = [...results].sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore);
  const q75          = sortedByCE[Math.floor(sortedByCE.length * 0.25)].capitalEfficiencyScore;
  const capOptimal   = results.filter(r => r.capitalEfficiencyScore >= q75);

  const intersection = results.filter(r =>
    r.seniorImpairmentProb  < 0.01 &&
    r.juniorDepletionProb   < 0.30 &&
    r.avgBreakDuration      >= 5   &&
    r.capitalEfficiencyScore >= q75
  ).sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore);

  const best = intersection[0] || null;

  const md = [];

  md.push('# Unified v1.2 — Capital Structure Calibration Report');
  md.push('');
  md.push(`**Generated:** ${now}  `);
  md.push(`**Monte Carlo runs/config:** ${mcRuns.toLocaleString()}  `);
  md.push(`**Total configurations evaluated:** ${total.toLocaleString()}  `);
  md.push(`**Pool:** $1,000,000 USDC | **Loans:** 50 | **Avg loan:** $20,000 USDC | **Pool APR:** 18%`);
  md.push('');
  md.push('---');
  md.push('');

  // ── Executive Summary ──
  md.push('## Executive Summary');
  md.push('');
  md.push('| Region | Qualifying configs | % of total |');
  md.push('|---|---|---|');
  md.push(`| seniorImpairmentProb < 1% | ${seniorSafe.length.toLocaleString()} | ${pct(seniorSafe.length, total)} |`);
  md.push(`| juniorDepletionProb < 30% | ${juniorStable.length.toLocaleString()} | ${pct(juniorStable.length, total)} |`);
  md.push(`| avgBreakDuration ≥ 5 loans | ${breakerMgmt.length.toLocaleString()} | ${pct(breakerMgmt.length, total)} |`);
  md.push(`| capitalEfficiencyScore top quartile (≥ ${q75.toFixed(1)}) | ${capOptimal.length.toLocaleString()} | ${pct(capOptimal.length, total)} |`);
  md.push(`| **All four (intersection)** | **${intersection.length.toLocaleString()}** | **${pct(intersection.length, total)}** |`);
  md.push('');

  if (best) {
    md.push('**Optimal configuration (highest capEffScore in intersection):**');
    md.push('');
    md.push('| Parameter | Value |');
    md.push('|---|---|');
    md.push(`| juniorAllocationBps | **${best.juniorAllocationBps}** (${best.juniorAllocationBps / 100}%) |`);
    md.push(`| coverageFloorBps | **${best.coverageFloorBps}** |`);
    md.push(`| defaultRatePct (scenario) | ${best.defaultRatePct}% |`);
    md.push(`| correlationFactor (scenario) | ${best.correlationFactor} |`);
    md.push(`| recoveryRatePct (scenario) | ${best.recoveryRatePct}% |`);
    md.push(`| seniorImpairmentProb | **${(best.seniorImpairmentProb * 100).toFixed(2)}%** |`);
    md.push(`| juniorDepletionProb | **${(best.juniorDepletionProb * 100).toFixed(2)}%** |`);
    md.push(`| avgBreakDuration | **${best.avgBreakDuration} loans** |`);
    md.push(`| capitalEfficiencyScore | **${best.capitalEfficiencyScore}** |`);
  } else {
    md.push('> ⚠️ No single configuration satisfies all four regions simultaneously. See individual region analysis.');
  }
  md.push('');
  md.push('---');
  md.push('');

  // ── Region 1 ──
  md.push('## 1. Region: seniorImpairmentProbability < 1%');
  md.push('');
  md.push(`**${seniorSafe.length.toLocaleString()}** of ${total.toLocaleString()} configs qualify (${pct(seniorSafe.length, total)}).`);
  md.push('');
  md.push('### 1.1 Qualification rate by junior allocation');
  md.push('');
  md.push(mdTable(
    ['juniorAllocBps', 'juniorAlloc%', 'Qualifying', '% of alloc configs'],
    JUNIOR_ALLOCS.map(bps => {
      const all = results.filter(r => r.juniorAllocationBps === bps).length;
      const q   = seniorSafe.filter(r => r.juniorAllocationBps === bps).length;
      return [bps, bps / 100 + '%', q, pct(q, all)];
    }),
    [16, 13, 10, 20]
  ));
  md.push('### 1.2 Senior impairment probability matrix (corr=0.2, recovery=30%, floor=1500)');
  md.push('');
  md.push(matrix(results,
    m => (m.seniorImpairmentProb * 100).toFixed(2) + '%',
    m => m.seniorImpairmentProb < 0.01,
    0.2, 30, 1500
  ));
  md.push('> ✓ = qualifies (<1%)');
  md.push('');
  md.push('---');
  md.push('');

  // ── Region 2 ──
  md.push('## 2. Region: juniorDepletionProbability < 30%');
  md.push('');
  md.push(`**${juniorStable.length.toLocaleString()}** of ${total.toLocaleString()} configs qualify (${pct(juniorStable.length, total)}).`);
  md.push('');
  md.push('### 2.1 Qualification rate by junior allocation');
  md.push('');
  md.push(mdTable(
    ['juniorAllocBps', 'juniorAlloc%', 'Qualifying', '% of alloc configs'],
    JUNIOR_ALLOCS.map(bps => {
      const all = results.filter(r => r.juniorAllocationBps === bps).length;
      const q   = juniorStable.filter(r => r.juniorAllocationBps === bps).length;
      return [bps, bps / 100 + '%', q, pct(q, all)];
    }),
    [16, 13, 10, 20]
  ));
  md.push('### 2.2 Junior depletion probability matrix (corr=0.2, recovery=30%, floor=1500)');
  md.push('');
  md.push(matrix(results,
    m => (m.juniorDepletionProb * 100).toFixed(2) + '%',
    m => m.juniorDepletionProb < 0.30,
    0.2, 30, 1500
  ));
  md.push('> ✓ = qualifies (<30%)');
  md.push('');
  md.push('---');
  md.push('');

  // ── Region 3 ──
  md.push('## 3. Region: avgBreakDuration ≥ 5 loans (Manageable Breaker)');
  md.push('');
  md.push(`**${breakerMgmt.length.toLocaleString()}** of ${total.toLocaleString()} configs qualify (${pct(breakerMgmt.length, total)}).`);
  md.push('');
  md.push('### 3.1 Avg break duration matrix (corr=0.2, recovery=30%, floor=1500)');
  md.push('');
  md.push(matrix(results,
    m => m.avgBreakDuration.toFixed(1),
    m => m.avgBreakDuration >= 5,
    0.2, 30, 1500
  ));
  md.push('> ✓ = qualifies (≥5 loans). Duration = expected additional defaults before breaker fires.');
  md.push('');
  md.push('### 3.2 Coverage floor sensitivity (juniorAlloc=2000, defaultRate=10%, corr=0.2, recovery=30%)');
  md.push('');
  md.push(sensitivityFloor(results));
  md.push('---');
  md.push('');

  // ── Region 4 ──
  md.push('## 4. Region: capitalEfficiencyScore Optimal (Top Quartile)');
  md.push('');
  md.push(`Top quartile threshold: **${q75.toFixed(2)}**. **${capOptimal.length.toLocaleString()}** configs qualify (${pct(capOptimal.length, total)}).`);
  md.push('');
  md.push('### 4.1 Capital efficiency matrix (corr=0.2, recovery=30%, floor=1500)');
  md.push('');
  md.push(matrix(results,
    m => m.capitalEfficiencyScore.toFixed(1),
    m => m.capitalEfficiencyScore >= q75,
    0.2, 30, 1500
  ));
  md.push(`> ✓ = top quartile (≥${q75.toFixed(1)}). Score = adjustedSeniorYieldBps / juniorAllocFraction.`);
  md.push('');
  md.push('---');
  md.push('');

  // ── Pareto ──
  md.push('## 5. Pareto Frontier (max capEffScore subject to seniorImpairProb < 1%)');
  md.push('');
  md.push(paretoTable(results));
  md.push('---');
  md.push('');

  // ── Sensitivity ──
  md.push('## 6. Sensitivity Analysis');
  md.push('');
  md.push('### 6.1 Coverage floor effect (juniorAlloc=2000, defaultRate=10%, corr=0.2, recovery=30%)');
  md.push('');
  md.push(sensitivityFloor(results));
  md.push('### 6.2 Recovery rate effect (juniorAlloc=2000, floor=1500, defaultRate=15%, corr=0.2)');
  md.push('');
  md.push(sensitivityRecovery(results));
  md.push('### 6.3 Correlation effect (juniorAlloc=2000, floor=1500, defaultRate=10%, recovery=30%)');
  md.push('');
  md.push(sensitivityCorr(results));
  md.push('---');
  md.push('');

  // ── Fragile zones ──
  md.push('## 7. Fragile Zones (corr 0.2→0.4 causes >5pp senior impairment jump, floor=1500)');
  md.push('');
  md.push(fragileTable(results));
  md.push('---');
  md.push('');

  // ── Governance recommendations ──
  md.push('## 8. Governance Parameter Recommendations');
  md.push('');
  if (best) {
    md.push('Based on actual simulation output:');
    md.push('');
    md.push('| Parameter | Recommended Value | Basis |');
    md.push('|---|---|---|');
    md.push(`| \`seniorAllocationBps\` | **${10000 - best.juniorAllocationBps}** | Pareto-optimal intersection |`);
    md.push(`| \`juniorAllocationBps\` | **${best.juniorAllocationBps}** | Pareto-optimal intersection |`);
    md.push(`| \`juniorCoverageFloorBps\` | **${best.coverageFloorBps}** | Best breaker true-positive rate |`);
    md.push(`| \`recoveryRateAssumptionPct\` | **${best.recoveryRatePct}** | Conservative floor from sweep |`);
    md.push(`| \`breakerSeniorThresholdUsdc\` | **0** | Any senior impact = immediate halt |`);
    md.push('');
    md.push('```typescript');
    md.push('const TRANCHE_GOVERNANCE = {');
    md.push(`  seniorAllocationBps:       ${10000 - best.juniorAllocationBps},`);
    md.push(`  juniorAllocationBps:       ${best.juniorAllocationBps},`);
    md.push(`  juniorCoverageFloorBps:    ${best.coverageFloorBps},`);
    md.push(`  recoveryRateAssumptionPct: ${best.recoveryRatePct},`);
    md.push(`  breakerSeniorThresholdUsdc: 0n,`);
    md.push('} as const;');
    md.push('```');
  } else {
    // Fall back to best Pareto config
    const paretoBest = results
      .filter(r => r.seniorImpairmentProb < 0.01)
      .sort((a, b) => b.capitalEfficiencyScore - a.capitalEfficiencyScore)[0];
    if (paretoBest) {
      md.push('> No config satisfies all four regions simultaneously. Recommendation based on Pareto frontier (seniorImpairProb < 1%, max capEffScore):');
      md.push('');
      md.push('| Parameter | Recommended Value |');
      md.push('|---|---|');
      md.push(`| \`juniorAllocationBps\` | **${paretoBest.juniorAllocationBps}** |`);
      md.push(`| \`juniorCoverageFloorBps\` | **${paretoBest.coverageFloorBps}** |`);
      md.push(`| \`recoveryRateAssumptionPct\` | **${paretoBest.recoveryRatePct}** |`);
      md.push(`| seniorImpairmentProb | ${(paretoBest.seniorImpairmentProb * 100).toFixed(2)}% |`);
      md.push(`| capitalEfficiencyScore | ${paretoBest.capitalEfficiencyScore} |`);
    }
  }
  md.push('');
  md.push('---');
  md.push('');
  md.push('## 9. Methodology');
  md.push('');
  md.push('- **Default model:** Gaussian copula with single systematic factor Z ~ N(0,1).');
  md.push('  Each loan defaults if `sqrt(rho)*Z + sqrt(1-rho)*e_i < Phi^-1(p)` where `e_i ~ N(0,1)`.');
  md.push('- **Loss given default:** `loanSize × (1 - recoveryRate)`.');
  md.push('- **Waterfall:** `juniorAbsorption = min(totalLoss, juniorBuffer)`;');
  md.push('  `seniorImpact = max(0, totalLoss - juniorBuffer)`.');
  md.push('- **Coverage ratio:** `(juniorBufferPost / poolExposure) × 10000` bps.');
  md.push('- **Breaker duration:** loans remaining before coverage floor is breached from current buffer.');
  md.push('- **Capital efficiency:** `(1800 × seniorFrac × (1 - seniorImpairProb)) / juniorFrac`.');
  md.push('- **PRNG:** Mulberry32 seeded deterministically per config — fully reproducible.');

  return md.join('\n');
}

module.exports = { buildReport };
