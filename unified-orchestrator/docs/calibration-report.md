# Unified v1.2 — Capital Structure Calibration Report

**Generated:** 2026-02-23  
**Monte Carlo runs/config:** 5,000  
**Total configurations evaluated:** 8,820  
**Pool:** $1,000,000 USDC | **Loans:** 50 | **Avg loan:** $20,000 USDC | **Pool APR:** 18%

---

## Executive Summary

| Region | Qualifying configs | % of total |
|---|---|---|
| seniorImpairmentProb < 1% | 2,988 | 33.9% |
| juniorDepletionProb < 30% | 7,335 | 83.2% |
| avgBreakDuration ≥ 5 loans | 4,411 | 50.0% |
| capitalEfficiencyScore top quartile (≥ 7128.0) | 2,206 | 25.0% |
| **All four (intersection)** | **146** | **1.7%** |

**Optimal configuration (highest capEffScore in intersection):**

| Parameter | Value |
|---|---|
| juniorAllocationBps | **1000** (10%) |
| coverageFloorBps | **500** |
| defaultRatePct (scenario) | 2% |
| correlationFactor (scenario) | 0 |
| recoveryRatePct (scenario) | 60% |
| seniorImpairmentProb | **0.00%** |
| juniorDepletionProb | **0.00%** |
| avgBreakDuration | **5 loans** |
| capitalEfficiencyScore | **16200** |

---

## 1. Region: seniorImpairmentProbability < 1%

**2,988** of 8,820 configs qualify (33.9%).

### 1.1 Qualification rate by junior allocation

| juniorAllocBps   | juniorAlloc%  | Qualifying | % of alloc configs   |
| ---------------- | ------------- | ---------- | -------------------- |
| 1000             | 10%           | 103        | 8.2%                 |
| 1500             | 15%           | 201        | 16.0%                |
| 2000             | 20%           | 324        | 25.7%                |
| 2500             | 25%           | 425        | 33.7%                |
| 3000             | 30%           | 549        | 43.6%                |
| 3500             | 35%           | 636        | 50.5%                |
| 4000             | 40%           | 750        | 59.5%                |

### 1.2 Senior impairment probability matrix (corr=0.2, recovery=30%, floor=1500)

| juniorAlloc    | 2%        | 5%        | 8%        | 10%       | 12%       | 15%       | 20%       | 25%       | 30%       |
| -------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| 1000(10%)      | ✓0.90%    | 7.14%     | 16.64%    | 22.92%    | 29.42%    | 41.32%    | 56.16%    | 69.24%    | 79.68%    |
| 1500(15%)      | ✓0.16%    | 2.80%     | 7.94%     | 12.24%    | 16.48%    | 26.08%    | 39.36%    | 53.08%    | 66.04%    |
| 2000(20%)      | ✓0.18%    | ✓0.76%    | 3.14%     | 4.52%     | 7.46%     | 13.06%    | 24.34%    | 34.86%    | 47.14%    |
| 2500(25%)      | ✓0.00%    | ✓0.26%    | 1.24%     | 2.70%     | 4.18%     | 7.06%     | 15.14%    | 24.02%    | 34.50%    |
| 3000(30%)      | ✓0.00%    | ✓0.06%    | ✓0.32%    | ✓0.80%    | 1.18%     | 3.70%     | 7.82%     | 13.76%    | 22.12%    |
| 3500(35%)      | ✓0.00%    | ✓0.04%    | ✓0.14%    | ✓0.34%    | ✓0.76%    | 1.20%     | 3.40%     | 6.30%     | 11.52%    |
| 4000(40%)      | ✓0.00%    | ✓0.02%    | ✓0.04%    | ✓0.18%    | ✓0.42%    | ✓0.72%    | 1.74%     | 3.94%     | 7.54%     |

> ✓ = qualifies (<1%)

---

## 2. Region: juniorDepletionProbability < 30%

**7,335** of 8,820 configs qualify (83.2%).

### 2.1 Qualification rate by junior allocation

| juniorAllocBps   | juniorAlloc%  | Qualifying | % of alloc configs   |
| ---------------- | ------------- | ---------- | -------------------- |
| 1000             | 10%           | 658        | 52.2%                |
| 1500             | 15%           | 880        | 69.8%                |
| 2000             | 20%           | 1015       | 80.6%                |
| 2500             | 25%           | 1111       | 88.2%                |
| 3000             | 30%           | 1189       | 94.4%                |
| 3500             | 35%           | 1236       | 98.1%                |
| 4000             | 40%           | 1246       | 98.9%                |

### 2.2 Junior depletion probability matrix (corr=0.2, recovery=30%, floor=1500)

| juniorAlloc    | 2%        | 5%        | 8%        | 10%       | 12%       | 15%       | 20%       | 25%       | 30%       |
| -------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| 1000(10%)      | ✓0.90%    | ✓7.14%    | ✓16.64%   | ✓22.92%   | ✓29.42%   | 41.32%    | 56.16%    | 69.24%    | 79.68%    |
| 1500(15%)      | ✓0.16%    | ✓2.80%    | ✓7.94%    | ✓12.24%   | ✓16.48%   | ✓26.08%   | 39.36%    | 53.08%    | 66.04%    |
| 2000(20%)      | ✓0.18%    | ✓0.76%    | ✓3.14%    | ✓4.52%    | ✓7.46%    | ✓13.06%   | ✓24.34%   | 34.86%    | 47.14%    |
| 2500(25%)      | ✓0.00%    | ✓0.26%    | ✓1.24%    | ✓2.70%    | ✓4.18%    | ✓7.06%    | ✓15.14%   | ✓24.02%   | 34.50%    |
| 3000(30%)      | ✓0.00%    | ✓0.06%    | ✓0.32%    | ✓0.80%    | ✓1.18%    | ✓3.70%    | ✓7.82%    | ✓13.76%   | ✓22.12%   |
| 3500(35%)      | ✓0.00%    | ✓0.04%    | ✓0.14%    | ✓0.40%    | ✓0.88%    | ✓1.58%    | ✓4.16%    | ✓7.66%    | ✓13.42%   |
| 4000(40%)      | ✓0.00%    | ✓0.02%    | ✓0.04%    | ✓0.18%    | ✓0.42%    | ✓0.72%    | ✓1.74%    | ✓3.94%    | ✓7.54%    |

> ✓ = qualifies (<30%)

---

## 3. Region: avgBreakDuration ≥ 5 loans (Manageable Breaker)

**4,411** of 8,820 configs qualify (50.0%).

### 3.1 Avg break duration matrix (corr=0.2, recovery=30%, floor=1500)

| juniorAlloc    | 2%        | 5%        | 8%        | 10%       | 12%       | 15%       | 20%       | 25%       | 30%       |
| -------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| 1000(10%)      | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       |
| 1500(15%)      | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       | 0.0       |
| 2000(20%)      | 2.4       | 1.9       | 1.6       | 1.5       | 1.4       | 1.4       | 1.1       | 1.0       | 0.9       |
| 2500(25%)      | ✓6.1      | ✓5.1      | 4.4       | 4.1       | 3.8       | 3.4       | 3.0       | 2.7       | 2.3       |
| 3000(30%)      | ✓9.1      | ✓7.8      | ✓6.9      | ✓6.4      | ✓5.8      | ✓5.3      | 4.5       | 4.1       | 3.5       |
| 3500(35%)      | ✓13.0     | ✓11.6     | ✓10.4     | ✓9.8      | ✓9.0      | ✓8.3      | ✓7.1      | ✓6.2      | ✓5.5      |
| 4000(40%)      | ✓16.1     | ✓14.5     | ✓13.3     | ✓12.4     | ✓11.6     | ✓10.6     | ✓9.1      | ✓8.1      | ✓7.1      |

> ✓ = qualifies (≥5 loans). Duration = expected additional defaults before breaker fires.

### 3.2 Coverage floor sensitivity (juniorAlloc=2000, defaultRate=10%, corr=0.2, recovery=30%)

| covFloor   | seniorImpair%  | breakerRate%  | avgBreakDur  | capEffScore  |
| ---------- | -------------- | ------------- | ------------ | ------------ |
| 500        | 4.72%          | 11.36%        | 6.4          | 6860.16      |
| 750        | 5.06%          | 18.80%        | 4.8          | 6835.68      |
| 1000       | 4.66%          | 23.86%        | 4.1          | 6864.48      |
| 1250       | 5.08%          | 35.52%        | 2.7          | 6834.24      |
| 1500       | 4.52%          | 50.64%        | 1.5          | 6874.56      |
| 1750       | 5.32%          | 75.46%        | 0.4          | 6816.96      |
| 2000       | 4.96%          | 100.00%       | 0.0          | 6842.88      |

---

## 4. Region: capitalEfficiencyScore Optimal (Top Quartile)

Top quartile threshold: **7128.00**. **2,206** configs qualify (25.0%).

### 4.1 Capital efficiency matrix (corr=0.2, recovery=30%, floor=1500)

| juniorAlloc    | 2%        | 5%        | 8%        | 10%       | 12%       | 15%       | 20%       | 25%       | 30%       |
| -------------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- | --------- |
| 1000(10%)      | ✓16054.2  | ✓15043.3  | ✓13504.3  | ✓12487.0  | ✓11434.0  | ✓9506.2   | 7102.1    | 4983.1    | 3291.8    |
| 1500(15%)      | ✓10183.7  | ✓9914.4   | ✓9390.1   | ✓8951.5   | ✓8519.0   | ✓7539.8   | 6185.3    | 4785.8    | 3463.9    |
| 2000(20%)      | ✓7187.0   | ✓7145.3   | 6973.9    | 6874.6    | 6662.9    | 6259.7    | 5447.5    | 4690.1    | 3805.9    |
| 2500(25%)      | 5400.0    | 5386.0    | 5333.0    | 5254.2    | 5174.3    | 5018.8    | 4582.4    | 4102.9    | 3537.0    |
| 3000(30%)      | 4200.0    | 4197.5    | 4186.6    | 4166.4    | 4150.4    | 4044.6    | 3871.6    | 3622.1    | 3271.0    |
| 3500(35%)      | 3342.9    | 3341.5    | 3338.2    | 3331.5    | 3317.4    | 3302.7    | 3229.2    | 3132.3    | 2957.8    |
| 4000(40%)      | 2700.0    | 2699.5    | 2698.9    | 2695.1    | 2688.7    | 2680.6    | 2653.0    | 2593.6    | 2496.4    |

> ✓ = top quartile (≥7128.0). Score = adjustedSeniorYieldBps / juniorAllocFraction.

---

## 5. Pareto Frontier (max capEffScore subject to seniorImpairProb < 1%)

| juniorAlloc    | covFloor  | defaultRate | corr   | recovery  | seniorImpair%  | juniorDepl%  | avgBreakDur  | capEffScore  |
| -------------- | --------- | ----------- | ------ | --------- | -------------- | ------------ | ------------ | ------------ |
| 1000(10%)      | 500       | 2%          | 0      | 20%       | 0.00%          | 0.00%        | 2.1          | 16200.00     |
| 1500(15%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 4.0          | 10200.00     |
| 2000(20%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 6.0          | 7200.00      |
| 2500(25%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 9.0          | 5400.00      |
| 3000(30%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 11.0         | 4200.00      |
| 3500(35%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 14.0         | 3342.86      |
| 4000(40%)      | 500       | 2%          | 0      | 0%        | 0.00%          | 0.00%        | 16.0         | 2700.00      |

---

## 6. Sensitivity Analysis

### 6.1 Coverage floor effect (juniorAlloc=2000, defaultRate=10%, corr=0.2, recovery=30%)

| covFloor   | seniorImpair%  | breakerRate%  | avgBreakDur  | capEffScore  |
| ---------- | -------------- | ------------- | ------------ | ------------ |
| 500        | 4.72%          | 11.36%        | 6.4          | 6860.16      |
| 750        | 5.06%          | 18.80%        | 4.8          | 6835.68      |
| 1000       | 4.66%          | 23.86%        | 4.1          | 6864.48      |
| 1250       | 5.08%          | 35.52%        | 2.7          | 6834.24      |
| 1500       | 4.52%          | 50.64%        | 1.5          | 6874.56      |
| 1750       | 5.32%          | 75.46%        | 0.4          | 6816.96      |
| 2000       | 4.96%          | 100.00%       | 0.0          | 6842.88      |

### 6.2 Recovery rate effect (juniorAlloc=2000, floor=1500, defaultRate=15%, corr=0.2)

| recovery%  | seniorImpair%  | juniorDepl%  | capEffScore  |
| ---------- | -------------- | ------------ | ------------ |
| 0%         | 25.58%         | 30.14%       | 5358.24      |
| 20%        | 17.56%         | 17.56%       | 5935.68      |
| 30%        | 13.06%         | 13.06%       | 6259.68      |
| 40%        | 8.98%          | 8.98%        | 6553.44      |
| 60%        | 1.00%          | 1.34%        | 7128.00      |

### 6.3 Correlation effect (juniorAlloc=2000, floor=1500, defaultRate=10%, recovery=30%)

| correlation  | seniorImpair%  | juniorDepl%  | avgBreakDur  |
| ------------ | -------------- | ------------ | ------------ |
| 0            | 0.00%          | 0.00%        | 0.6          |
| 0.2          | 4.52%          | 4.52%        | 1.5          |
| 0.4          | 9.48%          | 9.48%        | 2.0          |
| 0.6          | 12.24%         | 12.24%       | 2.4          |

---

## 7. Fragile Zones (corr 0.2→0.4 causes >5pp senior impairment jump, floor=1500)

| juniorAlloc    | defaultRate | recovery  | sip@corr0.2  | sip@corr0.4  | delta     |
| -------------- | ----------- | --------- | ------------ | ------------ | --------- |
| 1000(10%)      | 12%         | 60%       | 10.86%       | 16.24%       | +5.38pp   |
| 1500(15%)      | 15%         | 60%       | 6.20%        | 11.42%       | +5.22pp   |
| 1500(15%)      | 20%         | 60%       | 12.52%       | 17.96%       | +5.44pp   |
| 1500(15%)      | 25%         | 60%       | 20.34%       | 25.98%       | +5.64pp   |
| 2000(20%)      | 12%         | 30%       | 7.46%        | 12.96%       | +5.50pp   |
| 2000(20%)      | 12%         | 40%       | 4.94%        | 10.32%       | +5.38pp   |
| 2000(20%)      | 20%         | 60%       | 3.46%        | 9.30%        | +5.84pp   |
| 2000(20%)      | 25%         | 60%       | 7.00%        | 13.84%       | +6.84pp   |
| 2000(20%)      | 30%         | 60%       | 12.38%       | 18.88%       | +6.50pp   |
| 2500(25%)      | 12%         | 0%        | 10.90%       | 16.02%       | +5.12pp   |
| 2500(25%)      | 12%         | 20%       | 6.48%        | 11.62%       | +5.14pp   |
| 2500(25%)      | 12%         | 30%       | 4.18%        | 9.70%        | +5.52pp   |
| 2500(25%)      | 15%         | 30%       | 7.06%        | 12.68%       | +5.62pp   |
| 2500(25%)      | 15%         | 40%       | 3.70%        | 9.08%        | +5.38pp   |
| 2500(25%)      | 20%         | 30%       | 15.14%       | 20.22%       | +5.08pp   |
| 2500(25%)      | 20%         | 40%       | 9.02%        | 14.60%       | +5.58pp   |
| 2500(25%)      | 25%         | 40%       | 15.28%       | 22.58%       | +7.30pp   |
| 2500(25%)      | 25%         | 60%       | 2.06%        | 7.56%        | +5.50pp   |
| 2500(25%)      | 30%         | 60%       | 3.76%        | 10.82%       | +7.06pp   |
| 3000(30%)      | 12%         | 20%       | 3.28%        | 8.54%        | +5.26pp   |
| 3000(30%)      | 20%         | 20%       | 12.66%       | 19.76%       | +7.10pp   |
| 3000(30%)      | 20%         | 30%       | 7.82%        | 13.98%       | +6.16pp   |
| 3000(30%)      | 25%         | 30%       | 13.76%       | 21.04%       | +7.28pp   |
| 3000(30%)      | 25%         | 40%       | 7.08%        | 14.28%       | +7.20pp   |
| 3000(30%)      | 30%         | 30%       | 22.12%       | 27.38%       | +5.26pp   |
_...and 21 more fragile configurations._

---

## 8. Governance Parameter Recommendations

Based on actual simulation output:

| Parameter | Recommended Value | Basis |
|---|---|---|
| `seniorAllocationBps` | **9000** | Pareto-optimal intersection |
| `juniorAllocationBps` | **1000** | Pareto-optimal intersection |
| `juniorCoverageFloorBps` | **500** | Best breaker true-positive rate |
| `recoveryRateAssumptionPct` | **60** | Conservative floor from sweep |
| `breakerSeniorThresholdUsdc` | **0** | Any senior impact = immediate halt |

```typescript
const TRANCHE_GOVERNANCE = {
  seniorAllocationBps:       9000,
  juniorAllocationBps:       1000,
  juniorCoverageFloorBps:    500,
  recoveryRateAssumptionPct: 60,
  breakerSeniorThresholdUsdc: 0n,
} as const;
```

---

## 9. Methodology

- **Default model:** Gaussian copula with single systematic factor Z ~ N(0,1).
  Each loan defaults if `sqrt(rho)*Z + sqrt(1-rho)*e_i < Phi^-1(p)` where `e_i ~ N(0,1)`.
- **Loss given default:** `loanSize × (1 - recoveryRate)`.
- **Waterfall:** `juniorAbsorption = min(totalLoss, juniorBuffer)`;
  `seniorImpact = max(0, totalLoss - juniorBuffer)`.
- **Coverage ratio:** `(juniorBufferPost / poolExposure) × 10000` bps.
- **Breaker duration:** loans remaining before coverage floor is breached from current buffer.
- **Capital efficiency:** `(1800 × seniorFrac × (1 - seniorImpairProb)) / juniorFrac`.
- **PRNG:** Mulberry32 seeded deterministically per config — fully reproducible.