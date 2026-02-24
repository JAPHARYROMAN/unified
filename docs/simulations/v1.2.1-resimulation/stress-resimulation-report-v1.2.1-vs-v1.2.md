# Stress Re-Simulation Report (v1.2.1 vs v1.2)

Run ID: `v121-resim-120260223`
Generated At: 2026-02-24T04:00:26.701Z

## Scope
- UnifiedPoolTranched v1.2.1 semantics
- 5,000 paths per configuration
- Configuration count: 9450
- Response profiles: FAST, BASE, SLOW

## Baseline vs v1.2.1
- Baseline senior impairment probability: 0.0000%
- v1.2.1 senior impairment probability: 0.0000%
- Drift (pp): 0.0000 pp
- Drift acceptance (<= +0.75 pp): **true**

- Baseline junior depletion probability: 0.0000%
- v1.2.1 junior depletion probability: 0.0000%

- Baseline liquidity spiral severity avg: 0.196074
- v1.2.1 liquidity spiral severity avg: 0.176761

## Governance Response Sensitivity
| Profile | Max Senior Impairment % | Junior Depletion Prob % | Liquidity Spiral Severity Avg | Redemption Backlog Avg | Idle Capital Ratio Avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| FAST | 0.0000 | 0.0000 | 0.112504 | 0.051737 | 0.281761 |
| BASE | 0.0000 | 0.0000 | 0.147709 | 0.080509 | 0.281761 |
| SLOW | 0.0000 | 0.0000 | 0.270071 | 0.182176 | 0.281761 |

### Slow vs Fast Delta
- Max Senior Impairment (pp): 0.0000
- Junior Depletion Probability (pp): 0.0000
- Liquidity Spiral Severity: 0.157568
- Redemption Backlog: 0.130438
- Idle Capital Ratio: 0.000000

## Acceptance Status
- Senior impairment drift <= +0.75pp: **true**
- No invariant violations: **true**
- Coverage floor undercollateralization prevention: **true**