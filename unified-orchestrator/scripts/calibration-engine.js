/**
 * Monte Carlo engine — Gaussian copula default model.
 * No external dependencies.
 */
'use strict';

// ─── Seeded PRNG (Mulberry32) ─────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function boxMuller(rand) {
  const u1 = Math.max(rand(), 1e-10);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Rational approximation of Phi^-1 (Beasley-Springer-Moro)
function normInv(p) {
  const a = [-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,
              1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b = [-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,
              6.680131188771972e+01,-1.328068155288572e+01];
  const c = [-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,
             -2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d = [7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p <= pHigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
          ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// Gaussian copula: single systematic factor Z, idiosyncratic e_i per loan
function generateDefaults(rand, loanCount, defaultRatePct, rho) {
  const threshold = normInv(defaultRatePct / 100);
  const Z = boxMuller(rand);
  const sqrtRho = Math.sqrt(rho);
  const sqrtOneMinusRho = Math.sqrt(Math.max(0, 1 - rho));
  let count = 0;
  for (let i = 0; i < loanCount; i++) {
    const e = boxMuller(rand);
    if (sqrtRho * Z + sqrtOneMinusRho * e < threshold) count++;
  }
  return count;
}

// Single simulation path — returns outcome metrics
function runOnce(rand, cfg) {
  const { loanCount, poolExposure, defaultRatePct, rho, recoveryRatePct,
          juniorAllocationBps, coverageFloorBps } = cfg;
  const loanSize     = poolExposure / loanCount;
  const juniorBuffer = poolExposure * juniorAllocationBps / 10000;
  const lgd          = loanSize * (1 - recoveryRatePct / 100);
  const defaultCount = generateDefaults(rand, loanCount, defaultRatePct, rho);
  const totalLoss    = defaultCount * lgd;
  const juniorAbs    = Math.min(totalLoss, juniorBuffer);
  const seniorImpact = Math.max(0, totalLoss - juniorBuffer);
  const bufferPost   = juniorBuffer - juniorAbs;
  const covBps       = (bufferPost / poolExposure) * 10000;
  const fired        = covBps <= coverageFloorBps;
  const floorUsdc    = poolExposure * coverageFloorBps / 10000;
  const breakDur     = fired ? 0 : Math.floor((bufferPost - floorUsdc) / Math.max(lgd, 1));
  return {
    seniorImpaired: seniorImpact > 0,
    juniorDepleted: bufferPost <= 0,
    breakerFired:   fired,
    breakerDuration: Math.max(0, breakDur),
    covBps,
  };
}

// Evaluate one configuration over MC_RUNS paths
function evalConfig(cfg, mcRuns) {
  const seed = 0xDEADBEEF ^
    (cfg.juniorAllocationBps * 31) ^ (cfg.defaultRatePct * 1009) ^
    (Math.round(cfg.rho * 100) * 7919) ^ (cfg.recoveryRatePct * 2053) ^
    (cfg.coverageFloorBps * 4001);
  const rand = mulberry32(seed);

  let si = 0, jd = 0, bf = 0, bdSum = 0, bdN = 0, covSum = 0;
  for (let i = 0; i < mcRuns; i++) {
    const r = runOnce(rand, cfg);
    if (r.seniorImpaired)  si++;
    if (r.juniorDepleted)  jd++;
    if (r.breakerFired)    bf++;
    else { bdSum += r.breakerDuration; bdN++; }
    covSum += r.covBps;
  }

  const sip = si / mcRuns;
  const jdp = jd / mcRuns;
  const bar = bf / mcRuns;
  const abd = bdN > 0 ? bdSum / bdN : 0;
  const acr = covSum / mcRuns;

  // Capital efficiency: adjusted senior yield bps / junior fraction
  const jFrac   = cfg.juniorAllocationBps / 10000;
  const sFrac   = 1 - jFrac;
  const adjYield = 1800 * sFrac * (1 - sip);
  const ces      = jFrac > 0 ? adjYield / jFrac : 0;

  return {
    juniorAllocationBps:    cfg.juniorAllocationBps,
    coverageFloorBps:       cfg.coverageFloorBps,
    defaultRatePct:         cfg.defaultRatePct,
    correlationFactor:      cfg.rho,
    recoveryRatePct:        cfg.recoveryRatePct,
    seniorImpairmentProb:   +sip.toFixed(4),
    juniorDepletionProb:    +jdp.toFixed(4),
    breakerActivationRate:  +bar.toFixed(4),
    avgBreakDuration:       +abd.toFixed(1),
    avgCoverageRatioBps:    +acr.toFixed(1),
    capitalEfficiencyScore: +ces.toFixed(2),
  };
}

module.exports = { evalConfig };
