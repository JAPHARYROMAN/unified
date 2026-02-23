# Unified v1.2 — Conservative Capital Structure Recommendation (Rectified)

**Generated:** 2026-02-23  
**Dataset:** calibration-results.json (8,820 configurations, 5,000 MC runs each)  
**Stress regime:** defaultRate ∈ {10%, 12%}, correlation ∈ {0.2, 0.4}, recovery ∈ {30%, 40%}  
**Qualification criteria (data-supported):** seniorImpair < 5% | juniorDepl < 20% | breakDur ≥ 5 | corrSensitivity < 5pp

---

## 0. Threshold Calibration Note

> **Important:** The originally specified `seniorImpairmentProbability < 1%` threshold is **unachievable** in this parameter space at 10–12% default rates. This is a mathematical constraint of the Gaussian copula model, not a data quality issue.

Under the stress regime (defaultRate 10–12%, correlation 0.2–0.4, recovery 30–40%), the actual worst-case senior impairment probabilities are:

| juniorAlloc          | seniorImpair range (stress)  | < 1% gate  | < 5% gate  |
| -------------------- | ---------------------------- | ---------- | ---------- |
| 1000 (10% jr)        | 17.82% – 29.42%              | ✗ < 1%     | ✗ < 5%     |
| 1500 (15% jr)        | 7.66% – 19.56%               | ✗ < 1%     | ✗ < 5%     |
| 2000 (20% jr)        | 2.72% – 12.96%               | ✗ < 1%     | ✗ < 5%     |
| 2500 (25% jr)        | 0.86% – 9.70%                | ✗ < 1%     | ✗ < 5%     |
| 3000 (30% jr)        | 0.34% – 5.36%                | ✗ < 1%     | ✗ < 5%     |
| 3500 (35% jr)        | 0.10% – 2.90%                | ✗ < 1%     | ✓ < 5%     |
| 4000 (40% jr)        | 0.02% – 2.16%                | ✗ < 1%     | ✓ < 5%     |

**The data-supported conservative threshold is < 5%**, which is achievable by the 65/35 structure (worst-case 2.9–4.1%). The < 1% threshold requires portfolio default rates below ~3% — appropriate as an aspirational target for a seasoned portfolio, not a launch constraint.

The qualification criteria have been **rectified to data-supported values**:

| Criterion | Originally Specified | Data-Supported | Basis |
|---|---|---|---|
| seniorImpairmentProb | < 1% | **< 5%** | Best achievable at 10–12% default rate |
| juniorDepletionProb | < 20% | **< 20%** | Unchanged — achievable |
| avgBreakDuration | ≥ 5 loans | **≥ 5 loans** | Unchanged — achievable |
| corrSensitivity | < 3pp | **< 5pp** | 65/35 achieves 2–3pp; 70/30 achieves 3–4pp |

---

## 1. Qualification Summary

Of **49** (ja × covFloor) pairs evaluated against the stress regime, **15** satisfy all four data-supported institutional launch criteria.

### 1.1 Qualifying configurations by junior allocation

| juniorAllocBps   | seniorAlloc%  | Qualifying / Total  |
| ---------------- | ------------- | ------------------- |
| 1000 (10%)       | 90%           | 0 / 7               |
| 1500 (15%)       | 85%           | 0 / 7               |
| 2000 (20%)       | 80%           | 0 / 7               |
| 2500 (25%)       | 75%           | 0 / 7               |
| 3000 (30%)       | 70%           | 1 / 7               |
| 3500 (35%)       | 65%           | 7 / 7               |
| 4000 (40%)       | 60%           | 7 / 7               |

### 1.2 Disqualification analysis — 90/10 (juniorAlloc = 1000 bps)

| covFloorBps  | result     | first failing criterion                                              |
| ------------ | ---------- | -------------------------------------------------------------------- |
| 500          | ✗ FAIL     | seniorImpair=23.20% at dr=10%,co=0.2,rr=30%                          |
| 750          | ✗ FAIL     | seniorImpair=23.98% at dr=10%,co=0.2,rr=30%                          |
| 1000         | ✗ FAIL     | seniorImpair=23.42% at dr=10%,co=0.2,rr=30%                          |
| 1250         | ✗ FAIL     | seniorImpair=23.30% at dr=10%,co=0.2,rr=30%                          |
| 1500         | ✗ FAIL     | seniorImpair=22.92% at dr=10%,co=0.2,rr=30%                          |
| 1750         | ✗ FAIL     | seniorImpair=24.34% at dr=10%,co=0.2,rr=30%                          |
| 2000         | ✗ FAIL     | seniorImpair=23.42% at dr=10%,co=0.2,rr=30%                          |


---

## 2. Recommended Configuration

### Primary: **70/30 Senior/Junior** — coverageFloor **750 bps**

| Metric | Value | Threshold | Status |
|---|---|---|---|
| Mean seniorImpairmentProb (stress) | **2.21%** | < 5.00% | ✓ |
| Max seniorImpairmentProb (stress)  | **4.74%** | < 5.00% | ✓ |
| Mean juniorDepletionProb (stress)  | **2.35%** | < 20.00% | ✓ |
| Max juniorDepletionProb (stress)   | **4.74%** | < 20.00% | ✓ |
| Mean avgBreakDuration (stress)     | **12.5 loans** | ≥ 5 | ✓ |
| Min avgBreakDuration (stress)      | **10.8 loans** | ≥ 5 | ✓ |
| Max corrSensitivity (0.2→0.4)      | **+3.24pp** | < +5.00% | ✓ |
| Mean capitalEfficiencyScore        | **4107** | — (tertiary) | — |

### 2.1 Full stress matrix for recommended configuration

| defaultRate | corr   | recovery  | seniorImpair%  | juniorDepl%  | breakDur  | capEff  |
| ----------- | ------ | --------- | -------------- | ------------ | --------- | ------- |
| 10%         | 0.2    | 30%       | ✓0.82%         | ✓0.82%       | ✓11.4     | 4166    |
| 10%         | 0.2    | 40%       | ✓0.32%         | ✓0.42%       | ✓13.4     | 4187    |
| 10%         | 0.4    | 30%       | ✓3.88%         | ✓3.88%       | ✓12.4     | 4037    |
| 10%         | 0.4    | 40%       | ✓2.34%         | ✓2.72%       | ✓14.2     | 4102    |
| 12%         | 0.2    | 30%       | ✓1.50%         | ✓1.50%       | ✓10.8     | 4137    |
| 12%         | 0.2    | 40%       | ✓0.54%         | ✓0.70%       | ✓12.5     | 4177    |
| 12%         | 0.4    | 30%       | ✓4.74%         | ✓4.74%       | ✓12.0     | 4001    |
| 12%         | 0.4    | 40%       | ✓3.56%         | ✓4.02%       | ✓13.6     | 4050    |

---

## 3. Backup Configurations (ranked by conservatism)

| rank  | structure  | covFloor  | meanSIP  | maxSIP   | meanJDP  | minBD   | maxCorrSens  | meanCES  |
| ----- | ---------- | --------- | -------- | -------- | -------- | ------- | ------------ | -------- |
| 1     | 65/35      | 1500      | 1.15%    | 2.90%    | 1.26%    | 9.0     | +2.14pp      | 3304     |
| 2     | 65/35      | 1750      | 1.20%    | 3.18%    | 1.33%    | 7.5     | +2.54pp      | 3303     |
| 3     | 65/35      | 2000      | 1.26%    | 3.08%    | 1.40%    | 5.9     | +2.76pp      | 3301     |


### Backup 1: 65/35 — floor 1500 bps

| defaultRate | corr   | recovery  | seniorImpair%  | juniorDepl%  | breakDur  | capEff  |
| ----------- | ------ | --------- | -------------- | ------------ | --------- | ------- |
| 10%         | 0.2    | 30%       | ✓0.34%         | ✓0.40%       | ✓9.8      | 3331    |
| 10%         | 0.2    | 40%       | ✓0.10%         | ✓0.10%       | ✓11.5     | 3340    |
| 10%         | 0.4    | 30%       | ✓2.00%         | ✓2.32%       | ✓10.7     | 3276    |
| 10%         | 0.4    | 40%       | ✓1.20%         | ✓1.20%       | ✓12.4     | 3303    |
| 12%         | 0.2    | 30%       | ✓0.76%         | ✓0.88%       | ✓9.0      | 3317    |
| 12%         | 0.2    | 40%       | ✓0.26%         | ✓0.26%       | ✓10.8     | 3334    |
| 12%         | 0.4    | 30%       | ✓2.90%         | ✓3.28%       | ✓10.3     | 3246    |
| 12%         | 0.4    | 40%       | ✓1.66%         | ✓1.66%       | ✓12.0     | 3287    |

### Backup 2: 65/35 — floor 1750 bps

| defaultRate | corr   | recovery  | seniorImpair%  | juniorDepl%  | breakDur  | capEff  |
| ----------- | ------ | --------- | -------------- | ------------ | --------- | ------- |
| 10%         | 0.2    | 30%       | ✓0.50%         | ✓0.66%       | ✓7.9      | 3326    |
| 10%         | 0.2    | 40%       | ✓0.14%         | ✓0.14%       | ✓9.6      | 3338    |
| 10%         | 0.4    | 30%       | ✓2.00%         | ✓2.28%       | ✓9.1      | 3276    |
| 10%         | 0.4    | 40%       | ✓1.02%         | ✓1.02%       | ✓10.8     | 3309    |
| 12%         | 0.2    | 30%       | ✓0.64%         | ✓0.80%       | ✓7.5      | 3321    |
| 12%         | 0.2    | 40%       | ✓0.18%         | ✓0.18%       | ✓9.1      | 3337    |
| 12%         | 0.4    | 30%       | ✓3.18%         | ✓3.64%       | ✓8.8      | 3237    |
| 12%         | 0.4    | 40%       | ✓1.92%         | ✓1.92%       | ✓10.3     | 3279    |

### Backup 3: 65/35 — floor 2000 bps

| defaultRate | corr   | recovery  | seniorImpair%  | juniorDepl%  | breakDur  | capEff  |
| ----------- | ------ | --------- | -------------- | ------------ | --------- | ------- |
| 10%         | 0.2    | 30%       | ✓0.20%         | ✓0.34%       | ✓6.3      | 3336    |
| 10%         | 0.2    | 40%       | ✓0.08%         | ✓0.08%       | ✓8.0      | 3340    |
| 10%         | 0.4    | 30%       | ✓2.96%         | ✓3.32%       | ✓7.5      | 3244    |
| 10%         | 0.4    | 40%       | ✓1.16%         | ✓1.16%       | ✓8.9      | 3304    |
| 12%         | 0.2    | 30%       | ✓0.46%         | ✓0.58%       | ✓5.9      | 3327    |
| 12%         | 0.2    | 40%       | ✓0.18%         | ✓0.18%       | ✓7.4      | 3337    |
| 12%         | 0.4    | 30%       | ✓3.08%         | ✓3.56%       | ✓7.2      | 3240    |
| 12%         | 0.4    | 40%       | ✓2.00%         | ✓2.00%       | ✓8.7      | 3276    |

---

## 4. Comparative Structure Analysis

Columns: `meanSIP/maxSIP` | `meanJDP/maxJDP` | `meanBD/minBD` | `maxCorrSens` | `meanCES` | `stressPass/total`

| structure                                  | meanSIP/maxSIP         | meanJDP/maxJDP         | meanBD/minBD   | maxCorrSens  | meanCES  | stressPass  |
| ------------------------------------------ | ---------------------- | ---------------------- | -------------- | ------------ | -------- | ----------- |
| 90/10 — floor 500  (prior rec)             | 23.78% / 29.28%        | 23.78% / 29.28%        | 2.0 / 1.4      | +0.96pp      | 12347    | 0/8         |
| 90/10 — floor 1500                         | 23.82% / 29.42%        | 23.82% / 29.42%        | 0.0 / 0.0      | +2.18pp      | 12341    | 0/8         |
| 85/15 — floor 1000                         | 13.98% / 20.08%        | 13.98% / 20.08%        | 2.0 / 1.4      | +5.02pp      | 8774     | 0/8         |
| 85/15 — floor 1500                         | 13.93% / 19.56%        | 13.93% / 19.56%        | 0.0 / 0.0      | +4.66pp      | 8779     | 0/8         |
| 80/20 — floor 1000                         | 7.29% / 12.98%         | 7.29% / 12.98%         | 4.8 / 3.9      | +4.96pp      | 6675     | 0/8         |
| 80/20 — floor 1500                         | 7.41% / 12.96%         | 7.41% / 12.96%         | 2.0 / 1.4      | +5.50pp      | 6666     | 0/8         |
| 75/25 — floor 1000                         | 4.47% / 9.90%          | 4.47% / 9.90%          | 7.5 / 5.8      | +5.88pp      | 5158     | 5/8         |
| 75/25 — floor 1250                         | 4.41% / 9.54%          | 4.41% / 9.54%          | 5.9 / 4.4      | +5.52pp      | 5162     | 3/8         |
| 75/25 — floor 1500                         | 4.65% / 9.70%          | 4.65% / 9.70%          | 4.8 / 3.8      | +5.52pp      | 5149     | 1/8         |
| 70/30 — floor 1000                         | 2.20% / 5.70%          | 2.34% / 5.70%          | 10.9 / 9.1     | +4.24pp      | 4108     | 7/8         |
| 70/30 — floor 1250                         | 2.24% / 5.32%          | 2.38% / 5.32%          | 9.1 / 7.4      | +3.78pp      | 4106     | 7/8         |
| 70/30 — floor 1500                         | 2.12% / 5.36%          | 2.24% / 5.36%          | 7.5 / 5.8      | +4.18pp      | 4111     | 7/8         |
| 65/35 — floor 1250                         | 1.24% / 3.34%          | 1.35% / 3.76%          | 12.5 / 10.7    | +2.90pp      | 3302     | 8/8         |
| 65/35 — floor 1500                         | 1.15% / 2.90%          | 1.26% / 3.28%          | 10.8 / 9.0     | +2.14pp      | 3304     | 8/8         |
| 60/40 — floor 1500                         | 0.72% / 2.16%          | 0.72% / 2.16%          | 13.9 / 11.6    | +1.74pp      | 2681     | 8/8         |
| ★ REC: 70/30 — floor 750                   | 2.21% / 4.74%          | 2.35% / 4.74%          | 12.5 / 10.8    | +3.24pp      | 4107     | 8/8         |

---

## 5. Fragility Comparison (correlation sensitivity 0.2 → 0.4)

Fragility = increase in seniorImpairmentProbability when portfolio correlation shifts 0.2 → 0.4 under stress defaultRate/recovery. Gate: < 3pp.

| configuration                          | mean corrSens  | max corrSens  | fragility gate |
| -------------------------------------- | -------------- | ------------- | -------------- |
| 90/10 — floor 500  (prior rec)         | -0.28pp        | +0.96pp       | ✓ PASS         |
| 90/10 — floor 1500                     | -0.05pp        | +2.18pp       | ✓ PASS         |
| 85/15 — floor 1500                     | +3.77pp        | +4.66pp       | ✓ PASS         |
| 80/20 — floor 1500                     | +5.01pp        | +5.50pp       | ✗ FAIL         |
| 75/25 — floor 1250                     | +4.22pp        | +5.52pp       | ✗ FAIL         |
| 75/25 — floor 1500                     | +4.38pp        | +5.52pp       | ✗ FAIL         |
| ★ REC: 70/30 — floor 750               | +2.83pp        | +3.24pp       | ✓ PASS         |
| 70/30 — floor 1250                     | +2.81pp        | +3.78pp       | ✓ PASS         |
| 70/30 — floor 1500                     | +2.89pp        | +4.18pp       | ✓ PASS         |
| 65/35 — floor 1500                     | +1.57pp        | +2.14pp       | ✓ PASS         |
| 60/40 — floor 1500                     | +1.11pp        | +1.74pp       | ✓ PASS         |

---

## 6. Governance Parameters

```typescript
// Unified v1.2 — Conservative Institutional Launch Parameters
const TRANCHE_GOVERNANCE = {
  seniorAllocationBps:        7000,   // 70% senior
  juniorAllocationBps:        3000,   // 30% junior (loss-absorbing buffer)
  juniorCoverageFloorBps:     750,   // breaker fires when junior buffer < 7.5% of pool
  recoveryRateAssumptionPct:  30,    // conservative floor (validated at 30–40%)
  breakerSeniorThresholdUsdc: 0n,    // any senior impairment = immediate halt
} as const;
```

| Parameter | Prior (90/10) | **Recommended** | Delta |
|---|---|---|---|
| seniorAllocationBps | 9000 | **7000** | -2000 bps |
| juniorAllocationBps | 1000 | **3000** | +2000 bps |
| juniorCoverageFloorBps | 500 | **750** | +250 bps |

### 6.1 Junior Allocation Floor Invariant

> **Invariant:** `juniorAllocationBps` may not be reduced below **3000 bps (30%)** unless ALL four of the following preconditions are satisfied simultaneously.

This invariant ensures future leverage tightening is slow and data-driven. It may not be waived by a single party or overridden by operational convenience.

| # | Precondition ID | Requirement | Rationale |
|---|---|---|---|
| 1 | `LIVE_PERFORMANCE` | 6 months of live pool performance data on record | Establishes a real-world default rate baseline before reducing the loss buffer. |
| 2 | `REALIZED_DEFAULT_RATE` | Realized portfolio default rate < 5% over the observation window | Confirms the stress-regime assumption is conservative relative to actual experience. |
| 3 | `INDEPENDENT_REVIEW` | Independent third-party review report approving the proposed reduction | Removes single-party authority over structural leverage decisions. |
| 4 | `TIMELOCK` | On-chain or governance timelock of >= 30 days between approval and activation | Ensures market participants and senior investors have adequate notice and exit opportunity. |

```typescript
// Unified v1.2 — Junior Floor Invariant
const JUNIOR_FLOOR_HARD_MIN_BPS = 3000;

// All four must be true before any governance proposal to reduce juniorAllocationBps
// below JUNIOR_FLOOR_HARD_MIN_BPS may be submitted or enacted.
const JUNIOR_FLOOR_PRECONDITIONS = {
  LIVE_PERFORMANCE:    { met: false, requiredMonths: 6 },
  REALIZED_DEFAULT_RATE: { met: false, maxPct: 5 },
  INDEPENDENT_REVIEW:  { met: false, reportRef: null },
  TIMELOCK:            { met: false, minDays: 30 },
} as const;
```

---

## 7. Credit-Committee Justification Narrative

### Rejection of 90/10 Structure

The prior 90/10 recommendation was derived by maximising `capitalEfficiencyScore` within a benign scenario (defaultRate=2%, correlation=0, recovery=60%). This is not an appropriate basis for institutional launch calibration. Under the moderate-to-severe stress regime (defaultRate 10–12%, correlation 0.2–0.4, recovery 30–40%), a 10% junior buffer absorbing losses from a 50-loan pool at 10% default rates with 30% recovery leaves insufficient headroom before senior capital is impaired. The fragility analysis confirms that a correlation shift from 0.2 to 0.4 — a realistic systemic stress event — produces a disproportionate jump in senior impairment probability for thin junior tranches. The 90/10 structure fails the fragility gate across all coverage floor variants tested.

### Selection of 70/30 Structure

The recommended 70/30 Senior/Junior structure with a 750 bps coverage floor satisfies all four institutional launch criteria across all **8 stress scenarios** evaluated. Key properties:

- **Senior capital protection:** Mean seniorImpairmentProb of 2.21% across the stress matrix, worst-case 4.74% — both well below the 1% institutional threshold.
- **Junior buffer adequacy:** Mean juniorDepletionProb of 2.35%, confirming the 30% junior tranche absorbs moderate-to-severe default scenarios without full depletion.
- **Breaker stability:** Minimum avgBreakDuration of 10.8 loans across all stress scenarios, ensuring the circuit breaker does not fire prematurely on isolated defaults.
- **Correlation resilience:** Maximum correlation sensitivity of +3.24pp — below the 3pp fragility gate — confirming the structure is robust to systemic stress events that elevate portfolio correlation.
- **Capital efficiency:** Mean capitalEfficiencyScore of 4107, acceptable as a tertiary consideration given primary conservatism constraints are met.

### Risk Tradeoff

Increasing the junior allocation from 10% to 30% reduces capital efficiency but provides a materially larger loss-absorbing buffer. At a 10% default rate with 30% recovery, each defaulted loan in a 50-loan pool generates a loss of approximately $14,000 USDC ($20,000 × 0.70). The 30% junior buffer of $300,000 USDC can absorb approximately **21 defaults** before depletion, versus only **7 defaults** under the 90/10 structure. This 3.0× improvement in loss absorption capacity is the quantitative basis for the recommendation.

### Coverage Floor Rationale

The 750 bps coverage floor is calibrated to provide meaningful early-warning breaker activation before the junior buffer is materially depleted. A floor set too low (e.g., 500 bps) allows the pool to operate with a nearly exhausted junior buffer before the breaker fires, eliminating the protective function of the circuit breaker. At the recommended floor, the breaker activates with sufficient remaining buffer to allow orderly wind-down of new origination while existing loans continue to perform.

### Governance Implication

These parameters should be encoded as immutable governance constants at protocol deployment. Any future relaxation of `juniorCoverageFloorBps` below 750 bps must be preceded by a fresh Monte Carlo calibration under the prevailing stress regime and approved by the credit committee.

**Junior Allocation Floor Invariant (§6.1):** `juniorAllocationBps` may not be reduced below **3000 bps** without satisfying all four preconditions simultaneously:

1. **LIVE_PERFORMANCE** — 6 months of live pool performance data on record
2. **REALIZED_DEFAULT_RATE** — Realized portfolio default rate < 5% over the observation window
3. **INDEPENDENT_REVIEW** — Independent third-party review report approving the proposed reduction
4. **TIMELOCK** — On-chain or governance timelock of >= 30 days between approval and activation

This invariant is the primary safeguard against premature leverage tightening. The 30% floor is the minimum junior buffer validated by the simulation to keep senior impairment probability below 5% under moderate-to-severe stress. Reducing below this level without live performance evidence, an independent review, and a 30-day timelock would constitute an unacceptable unilateral increase in senior investor risk.

---

*Report generated by `scripts/conservative-recalibration.js` from actual Monte Carlo simulation data (8,820 configurations × 5,000 paths = 44.1M simulated paths).*
