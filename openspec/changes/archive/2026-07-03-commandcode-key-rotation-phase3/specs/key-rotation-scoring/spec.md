# Key Rotation Scoring Specification

## Purpose

Cost-aware health scoring for key selection. Extends the existing scoring formula with a cost penalty so keys that have spent more are selected less frequently, distributing load across keys with remaining headroom.

## Requirements

### Requirement: Revised Scoring Formula

The key health score MUST be calculated as: `100 + min(successes × 0.1, 50) - rateLimitHits × 10 - authErrors × 1000 - agePenalty - totalCostUSD × costPerDollar`. Score MUST be clamped to minimum 0.

#### Scenario: Cost penalty reduces score

- GIVEN key A has `totalCostUSD: 5.0`, key B has `totalCostUSD: 0.50`, `costPerDollar: 2.0`
- WHEN scores are calculated
- THEN key A score is reduced by 10 points, key B by 1 point

#### Scenario: Score clamped to minimum 0

- GIVEN a key with `totalCostUSD: 100` and `costPerDollar: 2.0` (cost penalty = 200)
- WHEN score is calculated
- THEN score is 0 (not negative)

### Requirement: Default costPerDollar Weight

`costPerDollar` MUST default to 2.0 (each $1 spent reduces score by 2 points). It MUST be configurable via `rotation.costPerDollar` in `keys.json`.

#### Scenario: Default weight applied

- GIVEN no `costPerDollar` configured
- WHEN score is calculated for a key with `totalCostUSD: 3.0`
- THEN cost penalty is 6.0 points

#### Scenario: Custom weight applied

- GIVEN `rotation.costPerDollar: 5.0`
- WHEN score is calculated for a key with `totalCostUSD: 3.0`
- THEN cost penalty is 15.0 points

### Requirement: Zero-Cost Backward Compatibility

When `totalCostUSD` is 0 for all keys (no usage tracked yet), the scoring formula MUST produce identical results to phase 1+2 (`100 + min(successes × 0.1, 50) - rateLimitHits × 10 - authErrors × 1000 - agePenalty`).

#### Scenario: No cost data → phase 1+2 formula

- GIVEN all keys have `totalCostUSD: 0`
- WHEN scores are calculated
- THEN results match the phase 1+2 formula exactly

### Requirement: Configurable Scoring Weights

All scoring weights MUST be overridable via `rotation.scoringWeights` in `keys.json`. Supported weights: `successBonus` (default 0.1), `rateLimitPenalty` (default 10), `authPenalty` (default 1000), `costPerDollar` (default 2.0), `agePenaltyPerHour` (default 1.0).

#### Scenario: Weights override applied

- GIVEN `rotation.scoringWeights = { costPerDollar: 5.0, rateLimitPenalty: 20 }`
- WHEN scores are calculated
- THEN these weights are used instead of defaults

#### Scenario: Partial override → defaults for rest

- GIVEN `rotation.scoringWeights = { costPerDollar: 3.0 }`
- WHEN scores are calculated
- THEN `costPerDollar: 3.0` is used, all other weights use defaults

### Requirement: Cost-Aware Selection Distribution

Keys with higher `totalCostUSD` MUST have lower selection probability (all else being equal). This distributes API spend across keys with remaining headroom.

#### Scenario: Higher spend → lower probability

- GIVEN key A (score 100, cost $10) and key B (score 100, cost $1), `costPerDollar: 2.0`
- WHEN `selectKey()` is called with `random: () => 0.3`
- THEN key B has higher effective score (98 vs 80), more likely selected
