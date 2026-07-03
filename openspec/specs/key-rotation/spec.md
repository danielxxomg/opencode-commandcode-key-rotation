# Key Rotation Specification

## Purpose

Provider-level key rotation. `KeyManager` manages key pool with health tracking; `fetchWithRetry`/`streamWithReconnect` swap keys on quota/429/auth errors. Sub-agents inherit rotation via shared provider instance.

## ADDED Requirements

### Requirement: Multi-Key Acceptance

Factory MUST accept `apiKeys?: KeyEntry[]` (`{name, key, account}`) alongside legacy `apiKey?: string`. Non-empty `apiKeys[]` → construct `KeyManager`. Absent → legacy mode (identical behavior). `auth.ts` UNCHANGED.

#### Scenario: Backward compat — single apiKey

- GIVEN `options = { apiKey: "user_abc123" }`
- WHEN factory called
- THEN legacy mode, no KeyManager

#### Scenario: Multi-key init

- GIVEN `options = { apiKeys: [{name:"personal", key:"user_aaaa"}, {name:"work", key:"user_bbbb"}] }`
- WHEN factory called
- THEN KeyManager constructed, both score 100

### Requirement: Key Selection (Weighted Random)

`selectKey()` MUST filter dead/cooldown keys. Multiple eligible → weighted random `P(key_i) = score_i / Σscores`. One → direct return. None → least-recently-cooldowned non-dead + warning. ALL dead → fatal error.

#### Scenario: 429 on A → swap to B (retry untouched)

- GIVEN keys A, B (score 100)
- WHEN A gets 429
- THEN A enters cooldown, B selected, retry budget NOT consumed

#### Scenario: All keys permanently dead

- GIVEN A, B both `permanentlyDead: true`
- WHEN `selectKey()` called
- THEN fatal error listing both keys and status

### Requirement: Zero-Score Edge Case

When all eligible keys have score 0, `selectKey()` MUST use uniform random (not divide-by-zero).

#### Scenario: Zero-score uniform random

- GIVEN eligible keys A (0), B (0)
- WHEN `selectKey()` called with `random: () => 0.5`
- THEN one key selected, no crash

### Requirement: Key Swap on Quota/429

On `QUOTA_PATTERNS` or HTTP 429, mark key rate-limited, select different. Swap MUST NOT consume retry. `MAX_KEY_SWAPS = keys.length + 1`. `Retry-After` (capped 300s) used as cooldown.

#### Scenario: MAX_KEY_SWAPS exceeded → fatal

- GIVEN 2 keys, `MAX_KEY_SWAPS = 3`
- WHEN A→429, B→429, A→429
- THEN fatal error "all keys exhausted"

#### Scenario: Retry-After respected

- GIVEN A gets 429 with `Retry-After: 120`
- WHEN cooldown set
- THEN `cooldownExpiry = now + 120000`

### Requirement: Retry on Transient Errors

5xx/network (`RETRYABLE_PATTERNS`) → consume retry, backoff 1s/2.5s/5s ±25% jitter.

#### Scenario: 5xx consumes retries

- GIVEN max 3 retries
- WHEN 500, 500, 500
- THEN 3 retries consumed, error thrown

### Requirement: Auth Errors (Permanent Death)

401/403 or auth patterns → mark permanently dead, swap if keys remain. All dead → fatal.

#### Scenario: 401 → dead, swap

- GIVEN keys A, B
- WHEN A gets 401 "unauthorized"
- THEN A permanently dead, B selected

### Requirement: Quota-vs-Auth Precedence

`QUOTA_PATTERNS` before `NON_RETRYABLE_PATTERNS`. BUT 401/403 → auth wins over quota wording.

#### Scenario: 401 with quota wording → auth wins

- GIVEN status 401, body "exceeded your usage limit"
- WHEN classified
- THEN permanent death (not cooldown)

### Requirement: Mid-Stream Guard

Reconnect calls `selectKey()`. `emittedContent=false` → swap + reconnect. `emittedContent=true` → `partialOutputError()`, no reconnect.

#### Scenario: Mid-stream before content → swap

- GIVEN no content emitted
- WHEN mid-stream 429
- THEN key swapped, stream reconnects

#### Scenario: Mid-stream after content → error

- GIVEN `emittedContent = true`
- WHEN mid-stream 429
- THEN `partialOutputError()`, no reconnect

### Requirement: Sub-Agent Transparency

Sub-agents share provider via `getLanguage()` cache. Rotation automatic.

#### Scenario: Sub-agent uses rotated key

- GIVEN main rotated A→B
- WHEN sub-agent calls `fetchWithRetry()`
- THEN uses same KeyManager, key B active

### Requirement: Dev-Mode Error Logging

MAY log status + body (key redacted last 4) when dev flag enabled. Keys MUST NOT be unredacted.

#### Scenario: Dev logs redacted key

- GIVEN dev-mode, key `user_ijklmnop`, 429
- WHEN error logged
- THEN body logged, key as `user_ijkl` only

### Requirement: Config Hot-Reload

`keys.json` changes → next `selectKey()` reads updated config. No restart needed.

#### Scenario: New key added → next selection includes it

- GIVEN initial keys A, B; `keys.json` adds C
- WHEN next `selectKey()` called
- THEN C in eligible pool
