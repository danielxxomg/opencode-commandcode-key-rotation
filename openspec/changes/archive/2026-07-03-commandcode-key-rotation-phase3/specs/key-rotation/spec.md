# Delta for Key Rotation

## MODIFIED Requirements

### Requirement: Key Selection (Weighted Random)

`selectKey()` MUST filter dead/cooldown keys. It MUST then prefer unlocked keys over locked ones (see `key-rotation-lock`). Multiple eligible unlocked → weighted random `P(key_i) = score_i / Σscores`. All locked → use earliest-expiry key + warning. One → direct return. None → least-recently-cooldowned non-dead + warning. ALL dead → fatal error.

(Previously: No lock awareness — all eligible keys treated equally)

#### Scenario: 429 on A → swap to B (retry untouched)

- GIVEN keys A, B (score 100)
- WHEN A gets 429
- THEN A enters cooldown, B selected, retry budget NOT consumed

#### Scenario: All keys permanently dead

- GIVEN A, B both `permanentlyDead: true`
- WHEN `selectKey()` called
- THEN fatal error listing both keys and status

#### Scenario: Unlocked preferred over locked

- GIVEN key A unlocked, key B locked by other instance
- WHEN `selectKey()` called
- THEN key A is selected

#### Scenario: All locked → earliest expiry

- GIVEN keys A, B both locked by other instances
- WHEN `selectKey()` called
- THEN key with earliest expiry selected, warning logged

### Requirement: Key Swap on Quota/429

On `QUOTA_PATTERNS` or HTTP 429, mark key rate-limited, select different. Swap MUST NOT consume retry. `MAX_KEY_SWAPS = keys.length + 1`. `Retry-After` (capped 300s) used as cooldown. Lock for the swapped key MUST be released before selecting a new key.

(Previously: No lock release on swap)

#### Scenario: MAX_KEY_SWAPS exceeded → fatal

- GIVEN 2 keys, `MAX_KEY_SWAPS = 3`
- WHEN A→429, B→429, A→429
- THEN fatal error "all keys exhausted"

#### Scenario: Retry-After respected

- GIVEN A gets 429 with `Retry-After: 120`
- WHEN cooldown set
- THEN `cooldownExpiry = now + 120000`

#### Scenario: Lock released on swap

- GIVEN key A is locked by this instance
- WHEN A gets 429 and is swapped
- THEN lock for A is released before selecting new key

### Requirement: Mid-Stream Guard

Reconnect calls `selectKey()`. `emittedContent=false` → swap + reconnect. `emittedContent=true` → `partialOutputError()`, no reconnect. Lock for the failed key MUST be released on mid-stream failure.

(Previously: No lock release on mid-stream failure)

#### Scenario: Mid-stream before content → swap

- GIVEN no content emitted
- WHEN mid-stream 429
- THEN key swapped, lock released, stream reconnects

#### Scenario: Mid-stream after content → error

- GIVEN `emittedContent = true`
- WHEN mid-stream 429
- THEN `partialOutputError()`, lock released, no reconnect

## ADDED Requirements

### Requirement: Usage Reporting

`reportSuccess(key, modelId?, usage?)` MUST, when `usage` is provided, call `reportUsage(key, modelId, usage)` to accumulate token counts and cost. When `usage` is absent, only the existing success-reporting behavior applies.

#### Scenario: reportSuccess with usage → cost tracked

- GIVEN key "personal" completes a request with usage data
- WHEN `reportSuccess("personal", "claude-sonnet-4-6", usage)` is called
- THEN success count increments AND `reportUsage` is called

#### Scenario: reportSuccess without usage → existing behavior

- GIVEN key "personal" completes a request
- WHEN `reportSuccess("personal")` is called (no usage)
- THEN only success count increments, no cost tracking
