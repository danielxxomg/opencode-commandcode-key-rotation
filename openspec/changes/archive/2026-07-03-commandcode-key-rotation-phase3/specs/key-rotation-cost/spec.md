# Key Rotation Cost Specification

## Purpose

Per-key cost estimation from token usage multiplied by model pricing. Tracks input/output/cache tokens per key, calculates estimated USD cost, and persists totals in `key-state.json`. All cost displays MUST be labeled "est. cost" — local estimation only, not billing.

## Requirements

### Requirement: Usage Reporting

`reportUsage(key, modelId, usage)` MUST capture `inputTokens` (total, cacheRead, cacheWrite) and `outputTokens` (total, reasoning) from each successful response. Usage MUST be attributed to the key that served the request.

#### Scenario: Successful response → tokens captured

- GIVEN key "personal" serves a request for model "claude-sonnet-4-6"
- WHEN response completes with `usage.inputTokens.total=1000, outputTokens.total=500`
- THEN `reportUsage("personal", "claude-sonnet-4-6", usage)` accumulates tokens

#### Scenario: Cache tokens captured

- GIVEN a response with `cacheRead=800, cacheWrite=200`
- WHEN `reportUsage` is called
- THEN `totalCacheReadTokens` increases by 800, `totalCacheWriteTokens` by 200

### Requirement: Cost Calculation

Cost MUST be calculated as: `(inputTokens.total × modelCost.input / 1M) + (outputTokens.total × modelCost.output / 1M) + (cacheRead × modelCost.cache_read / 1M) + (cacheWrite × modelCost.cache_write / 1M)`. Cost is in USD. If a model's `cache_write` cost is absent, it MUST be treated as 0.

#### Scenario: Standard cost calculation

- GIVEN model "claude-sonnet-4-6" costs `{input:3, output:15, cache_read:0.3, cache_write:3.75}` per 1M tokens
- WHEN usage is `{inputTokens:{total:1000, cacheRead:0, cacheWrite:0}, outputTokens:{total:500}}`
- THEN cost = `1000 × 3/1M + 500 × 15/1M = $0.003 + $0.0075 = $0.0105`

#### Scenario: Missing cache_write → treated as 0

- GIVEN model with no `cache_write` cost defined
- WHEN usage includes `cacheWrite=500`
- THEN cache write cost contribution is $0

### Requirement: Model Cost Map Injection

The model cost map MUST be injected via dependency injection (constructor options). It MUST NOT be loaded at runtime by the provider. The map structure is `Record<modelId, {input, output, cache_read, cache_write?}>` with costs in $/million tokens.

#### Scenario: Cost map passed via options

- GIVEN `modelCosts = {"claude-sonnet-4-6": {input:3, output:15, cache_read:0.3}}`
- WHEN KeyManager is constructed with this map
- THEN cost calculations use the injected prices

#### Scenario: No cost map → no cost tracking

- GIVEN no `modelCosts` provided
- WHEN `reportUsage` is called
- THEN tokens are accumulated but `totalCostUSD` remains 0

### Requirement: Per-Key Cost Accumulation

Each key's health state MUST track: `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCacheWriteTokens`, `totalCostUSD`, and `modelUsage: Record<modelId, {inputTokens, outputTokens, costUSD}>`.

#### Scenario: Per-model breakdown tracked

- GIVEN key "personal" served 2 requests: 1 for "claude-sonnet-4-6" (cost $0.01), 1 for "gpt-5.4" (cost $0.02)
- WHEN `/key-status` displays the key
- THEN `modelUsage` shows both models with their individual costs

### Requirement: Cost Persistence

Cost totals MUST persist in `key-state.json`. On restart, accumulated costs MUST be restored from the persisted file. Costs are cumulative (never reset automatically).

#### Scenario: Restart → costs preserved

- GIVEN key "personal" has `totalCostUSD: 0.50` in `key-state.json`
- WHEN the provider restarts
- THEN key "personal" starts with `totalCostUSD: 0.50`

### Requirement: Est. Cost Label

All cost displays in the TUI (sidebar, `/key-status`, toasts) MUST use the label "est. cost" or "est." prefix. The system MUST NOT display "billed", "charged", or imply billing accuracy.

#### Scenario: TUI shows "est. cost" label

- GIVEN key "personal" has `totalCostUSD: 0.30`
- WHEN `/key-status` renders
- THEN cost column shows "$0.30" with "est." context in column header

### Requirement: TUI Cost Display

The sidebar MUST show total estimated cost across all keys as `💰 $X.XX`. The `/key-status` table MUST include per-key tokens (in/out), estimated cost, and a model breakdown summary below the table.

#### Scenario: Sidebar shows total cost

- GIVEN 3 keys with total cost $0.42
- WHEN sidebar renders
- THEN it shows `💰 $0.42`

#### Scenario: Model breakdown in /key-status

- GIVEN total usage: claude-sonnet-4-6 ($0.30), gpt-5.4 ($0.12)
- WHEN `/key-status` renders
- THEN summary shows model breakdown with per-model costs and token counts
