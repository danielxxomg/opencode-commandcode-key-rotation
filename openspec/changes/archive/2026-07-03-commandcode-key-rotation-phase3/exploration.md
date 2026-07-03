# Exploration: Command Code Key Rotation — Phase 3

## Current State

The Phase 1+2 MVP is delivered and archived (3 PRs open). The system has:
- **Provider** (`commandcode-retry`): `KeyManager` with weighted random selection, health scoring (`100 + success*0.1 - rateLimit*10 - auth*1000`), cooldowns (60s/300s/10s), permanent death, file-backed hot-reload.
- **Plugin** (`commandcode-key-rotation`): Server reads `keys.json`, injects `apiKeys[]`, writes `key-state.json` atomically. TUI renders sidebar footer (`🔑 name (account) ✅ | 📊 N keys | M healthy`), toast notifications, `/key-status` table, `/key-dismiss`.
- **Tests**: 115 passing (35 provider, 80 plugin). Coverage ≥80% on all changed files.

### Verified Architecture Facts
- Sub-agents SHARE the provider instance via `getLanguage()` cache (`provider.ts:1809`) — rotation is automatic.
- `doGenerate()` delegates to `doStream()` — it reads the full stream and extracts `usage` from the `finish` event.
- `doStream()` returns a `ReadableStream<LanguageModelV3StreamPart>` — the CALLER reads it.
- `fetchWithRetry()` handles HTTP-level errors but does NOT see parsed stream events (usage, finish, etc.).
- `models.json` is NOT loaded at runtime by the provider code — it's a static package file. Opencode's provider loader reads it to discover available models.

## Deep Analysis Results

### 1. Cost Data Access

#### models.json Cost Structure ✅ VERIFIED

```json
{
  "id": "claude-sonnet-4-6",
  "cost": {
    "input": 3,        // dollars per million tokens
    "output": 15,      // dollars per million tokens
    "cache_read": 0.3, // dollars per million tokens
    "cache_write": 3.75 // dollars per million tokens (optional — 11/33 models lack it)
  }
}
```

**Units**: Dollars per million tokens. Verified against known Claude pricing (Haiku $1/M input, $5/M output matches real pricing).

**All 33 models have `input`, `output`, `cache_read`. Only 7 models have `cache_write`** (Claude, some Qwen). Cost fields are `{ input, output, cache_read, cache_write? }`.

#### Usage Shape ✅ VERIFIED

From `LanguageModelV3Usage` (AI SDK v3):
```typescript
{
  inputTokens: {
    total: number | undefined,
    noCache: number | undefined,
    cacheRead: number | undefined,
    cacheWrite: number | undefined,
  },
  outputTokens: {
    total: number | undefined,
    text: number | undefined,
    reasoning: number | undefined,
  }
}
```

`mapUsage()` in `stream.ts:63-79` maps raw SSE fields: `inputTokens`/`prompt_tokens` → `total`, `inputTokenDetails.cacheReadTokens` → `cacheRead`, `inputTokenDetails.cacheWriteTokens` → `cacheWrite`, `outputTokens`/`completion_tokens` → `total`.

#### Capture Points

| Path | Where usage arrives | Key known? | Model known? |
|------|-------------------|-----------|-------------|
| `doGenerate()` line 650 | `value.usage` from `finish` stream event | ✅ via `fetchOpts.headers.Authorization` | ✅ `this.modelId` |
| `doStream()` | Stream returned to caller — provider doesn't read it | ✅ via fetchOpts | ✅ `this.modelId` |

**Critical finding**: `doGenerate()` delegates to `doStream()` and reads the stream itself. So both paths flow through the same stream. The `finish` event with usage data passes through `parseStreamEvents()` → `toStreamPart()` → stream part.

#### Model Cost Lookup Strategy

`models.json` is NOT loaded at runtime. Options:

| Option | Pros | Cons |
|--------|------|------|
| **A: Load models.json in provider** | Single source of truth, matches model IDs exactly | File I/O on startup, path resolution |
| **B: Pass cost map via options** | DI-friendly, testable | Server plugin must load + pass it |
| **C: Load in server plugin, pass via config** | Plugin already reads keys.json | Adds coupling |

**Recommendation: Option B** — inject a `modelCosts` map into `CommandCodeModelOptions`. The server plugin loads `models.json` once at startup and passes the cost map. This is DI-friendly (tests inject deterministic costs) and keeps the provider clean.

### 2. Token Capture Point

#### Where to intercept usage

The `finish` stream part flows through `parseStreamEvents()` → `toStreamPart()` → the ReadableStream. We need to intercept it BEFORE it reaches the caller.

**Approach: Stream wrapper in `doStream()`**

```typescript
// In doStream(), after fetchWithRetry returns the response:
const rawStream = parseStreamEvents(response.body)
const km = this.opts.keyManager
const modelId = this.modelId

// Wrap stream to intercept finish events for usage tracking
const trackedStream = new ReadableStream({
  pull(controller) {
    const { done, value } = await reader.read()
    if (done) { controller.close(); return }
    if (value.type === "finish" && km) {
      // Extract current key from the fetchOpts used for this request
      km.reportUsage(currentKey, modelId, value.usage)
    }
    controller.enqueue(value)
  }
})
```

**Problem**: `doStream()` creates `fetchOpts()` as a function and calls it multiple times (for initial fetch + reconnects). The key used for the SUCCESSFUL fetch is the one we need. We can capture it from the response path.

**Better approach**: Add an `onUsage` callback to the model options:

```typescript
interface CommandCodeModelOptions {
  // ... existing ...
  onUsage?: (key: string, modelId: string, usage: LanguageModelV3Usage) => void
}
```

In `fetchWithRetry()`, after a successful response, the key is known. We pass it to `doStream()` which wraps the stream. When `finish` fires, the callback is invoked.

**Simplest approach** (least invasive): In `doGenerate()`, after reading the stream and getting `usage`, call `keyManager.reportUsage()` directly. For `doStream()`, wrap the returned stream to intercept `finish`. Both paths know the key from the last `fetchOpts` call.

#### KeyManager.reportUsage() — new method needed

```typescript
reportUsage(key: string, modelId: string, usage: LanguageModelV3Usage): void {
  const state = this.findKey(key)
  if (!state) return
  state.health.totalInputTokens += usage.inputTokens.total ?? 0
  state.health.totalOutputTokens += usage.outputTokens.total ?? 0
  state.health.totalCacheReadTokens += usage.inputTokens.cacheRead ?? 0
  state.health.totalCacheWriteTokens += usage.inputTokens.cacheWrite ?? 0
  // Cost calculation uses injected modelCosts map
  const cost = calculateCost(modelId, usage, this.modelCosts)
  state.health.totalCostUSD += cost
}
```

### 3. Lock File Design

#### Pattern

**File**: `~/.commandcode/.key-lock`
**Structure**: Array of locks (one per locked key) — NOT single lock.

```json
{
  "locks": [
    {
      "keyName": "personal",
      "lockedBy": "a8525e60-c6f1-48c5-bd4c-1660bd288d38",
      "expiresAt": 1751234567890
    }
  ]
}
```

**Why array**: Multiple keys can be locked simultaneously by different instances. Single lock would serialize ALL key usage across instances.

#### UUID Availability ✅ VERIFIED

`crypto.randomUUID()` works in Bun (tested: `a8525e60-c6f1-48c5-bd4c-1660bd288d38`).

#### Atomic Write

Reuse the same temp+rename pattern from `server.ts:writeKeyState()`. The lock file is small JSON — atomic write is cheap.

#### Lock Lifecycle

1. **Acquire**: Before `selectKey()`, check if candidate keys are locked by another instance. Prefer unlocked keys. If all locked, use earliest-expiry.
2. **Release**: After request completes (success or failure), release the lock.
3. **Timeout**: 5 minutes auto-release (crash recovery).
4. **Refresh**: Not needed for MVP — 5min timeout is generous for most requests.

#### Integration Point

Lock logic lives in `KeyManager` (provider level), NOT the plugin. The plugin only needs to read the lock file for display purposes.

```typescript
// In KeyManager.selectKey(), after filtering eligible keys:
const lockedKeys = this.readLockFile()
const unlocked = eligible.filter(k => !isLockedByOther(k.entry.name, lockedKeys))
if (unlocked.length > 0) {
  // Use unlocked keys (normal weighted random)
} else {
  // All locked — use the one with earliest expiry
}
```

#### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Crash mid-request | Lock expires after 5min, auto-released |
| Two instances select same key | Possible if lock read is stale — acceptable for 2-3 instances |
| Lock file missing | Treat as no locks (first-run friendly) |
| Lock file malformed | Treat as no locks, log warning |

### 4. Intelligent Health Scoring

#### Current Formula

```
score = clamp(100 + min(successes * 0.1, 50) - rateLimitHits * 10 - authErrors * 1000 - agePenalty, 0, 150)
```

Where `agePenalty = hoursSinceLastSuccess` (linear decay).

#### Proposed Enhanced Formula

```
score = baseScore + successBonus - rateLimitPenalty - authPenalty - agePenalty - costPenalty + headroomBonus

Where:
  baseScore = 100
  successBonus = min(successes * 0.1, 50)
  rateLimitPenalty = rateLimitHits * 10
  authPenalty = authErrors * 1000
  agePenalty = hoursSinceLastSuccess
  costPenalty = (totalCostUSD / maxCostAcrossKeys) * costWeight * 100
  headroomBonus = (1 - totalCostUSD / maxCostAcrossKeys) * headroomWeight * 50
```

**Simpler approach** (recommended — don't over-engineer for 2-3 keys):

```
costPenalty = totalCostUSD * costPerDollarWeight
```

Where `costPerDollarWeight` is configurable (default: 2.0 — each dollar spent reduces score by 2 points).

**Rationale**: Keys that have spent more $$ are likely closer to their quota limit (even though we can't know the exact limit). Distributing load across keys by penalizing high-spend keys is a reasonable heuristic.

#### Configurable Weights

```typescript
interface ScoringWeights {
  successBonus: number      // default: 0.1 (per success, capped at 50)
  rateLimitPenalty: number  // default: 10
  authPenalty: number       // default: 1000
  costPerDollar: number     // default: 2.0
  agePenaltyPerHour: number // default: 1.0
}
```

Expose via `keys.json`:
```json
{
  "keys": [...],
  "scoring": {
    "costPerDollar": 2.0,
    "agePenaltyPerHour": 1.0
  }
}
```

#### Should cost LOWER priority?

**Yes** — the user said "keys with more headroom → higher priority". So cost-spent should LOWER the score. Default `costPerDollar: 2.0` means a key that spent $10 gets -20 points vs a fresh key. This is meaningful but not overwhelming (base score is 100).

### 5. TUI Display

#### Current `formatKeyStatusTable` Structure ✅ VERIFIED

```
  Name           Account         Health  Score  Cooldown   Status
  ─────────────  ───────────────  ──────  ─────  ─────────  ──────
  ◄ personal     acc1             ✅        100  none       active
    work         acc2             ⏳         90  2m30s      rate-limited
```

The function builds fixed-width columns with `padEnd`. Adding columns requires widening the header/separator and adding data columns.

#### New Columns Needed

| Column | Data source | Format |
|--------|-----------|--------|
| Tokens (in/out) | `KeyHealth.totalInputTokens / totalOutputTokens` | `1.2k/0.8k` |
| Est. Cost | `KeyHealth.totalCostUSD` | `$0.30` |
| Lock Owner | Lock file `lockedBy` (instance UUID, truncated) | `a852…` or `—` |

#### Sidebar Enhancement

Current: `🔑 personal (acc1) ✅ | 📊 3 keys | 2 healthy`
New: `🔑 personal (acc1) ✅ | 📊 3 keys | 2 healthy | 💰 $0.30 | 🔒 1 locked`

#### Model Breakdown (in /key-status summary)

Add below the table:
```
Total: $0.42 | 2.0k tokens | Top: claude-sonnet-4-6

Model Breakdown:
  claude-sonnet-4-6: $0.30 (1.2k tok)
  gpt-5.4: $0.12 (0.8k tok)
```

This requires per-model usage tracking in `KeyHealth`:
```typescript
modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
```

**Is this too complex for 2-3 keys?** No — it's a simple map. Each key tracks which models it served. The total across all keys gives the breakdown.

## Affected Areas

| File | Why affected |
|------|-------------|
| `commandcode-retry/src/key-manager.ts` | Add `reportUsage()`, lock file methods, enhanced scoring with configurable weights, `modelUsage` tracking |
| `commandcode-retry/src/key-manager.test.ts` | TDD tests for all new KeyManager methods |
| `commandcode-retry/src/model.ts` | Intercept `finish` stream event for usage tracking; pass `onUsage` callback or wrap stream |
| `commandcode-retry/src/model.test.ts` | TDD tests for usage interception |
| `commandcode-retry/index.ts` | Load models.json cost map, pass to KeyManager/model options |
| `commandcode-key-rotation/server.ts` | Read lock file for display, pass scoring config, load models.json |
| `commandcode-key-rotation/ui-logic.ts` | New formatters: cost display, lock count, model breakdown |
| `commandcode-key-rotation/ui-logic.test.ts` | TDD tests for new formatters |
| `commandcode-key-rotation/ui.tsx` | Enhanced sidebar, /key-status table with new columns |
| `~/.commandcode/keys.json` | Add `scoring` config section |
| `~/.commandcode/.key-lock` | NEW — lock file |

## Approaches

### Feature 1: Lock File

1. **Provider-level lock in KeyManager** — lock acquisition in `selectKey()`, release in `fetchWithRetry()`/`streamWithReconnect()` completion
   - Pros: Clean integration, all rotation logic in one place
   - Cons: KeyManager grows in complexity
   - Effort: Medium

2. **Plugin-level lock** — server plugin manages locks, passes lock state to provider
   - Pros: Separation of concerns
   - Cons: Plugin can't see real-time key selection; would need IPC
   - Effort: High

**Recommendation: Option 1** — provider-level lock in KeyManager. The lock is part of key selection logic.

### Feature 2: Cost Tracking

1. **Stream wrapper in doStream()** — intercept `finish` events, call `reportUsage()`
   - Pros: Covers both doGenerate and doStream paths
   - Cons: Stream wrapper adds complexity
   - Effort: Medium

2. **Callback-based** — `onUsage` callback in model options, invoked on finish
   - Pros: Clean DI, testable
   - Cons: Callback threading
   - Effort: Medium

3. **doGenerate-only** — track usage only in doGenerate(), ignore doStream()
   - Pros: Simplest
   - Cons: Misses direct doStream() callers (though doGenerate delegates to doStream)
   - Effort: Low

**Recommendation: Option 1** — stream wrapper. Since `doGenerate()` delegates to `doStream()`, wrapping the stream in `doStream()` covers ALL paths. The key is known from `fetchOpts` at the time of the successful fetch.

### Feature 3: Intelligent Scoring

1. **Extend existing formula** — add `costPenalty` to the existing score calculation
   - Pros: Minimal change, backward compatible
   - Cons: Formula gets complex
   - Effort: Low

2. **Modular scoring** — separate scoring strategies (pluggable)
   - Pros: Extensible
   - Cons: Over-engineering for 2-3 keys
   - Effort: High

**Recommendation: Option 1** — extend existing formula with configurable weights. Keep it simple.

## Recommendation

**Proceed with all three features in a single change, ordered by dependency:**

1. **Cost tracking first** — it's the foundation for intelligent scoring
2. **Intelligent scoring second** — depends on cost data
3. **Lock file last** — independent, but benefits from the enhanced KeyManager

### Implementation Order (TDD)

| Layer | Task | Depends on |
|-------|------|-----------|
| L0 | Cost types + `calculateCost()` utility | — |
| L1 | `KeyManager.reportUsage()` + `modelUsage` tracking | L0 |
| L2 | Stream wrapper in `doStream()` for usage capture | L1 |
| L3 | `models.json` loading + DI in factory | — |
| L4 | Enhanced scoring with configurable weights | L1 |
| L5 | Lock file: acquire/release/timeout in KeyManager | — |
| L6 | TUI: cost display, lock count, model breakdown | L1, L5 |
| L7 | Server plugin: lock file reading, scoring config | L4, L5 |

## Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| models.json cost values may not match Command Code's actual billing | Medium | Document as "est. cost" everywhere; never claim billing accuracy |
| Lock file race condition (two instances read stale lock) | Low | 5min timeout auto-releases; weighted random already distributes load |
| Stream wrapper breaks existing stream behavior | Medium | TDD: test wrapper preserves all stream parts, only adds usage hook |
| Per-model tracking adds memory per key | Low | 2-3 keys × ~10 models = trivial memory |
| Cost penalty makes expensive models less likely to be selected | Medium | Make weight configurable; default is conservative (2.0) |

## Ready for Proposal

**Yes.** All critical questions are answered:
- ✅ Cost data: `models.json` has `input/output/cache_read/cache_write` in $/M tokens; usage shape verified
- ✅ Capture point: stream wrapper in `doStream()` intercepts `finish` events
- ✅ Lock file: array pattern, `crypto.randomUUID()` available, atomic write reusable
- ✅ Scoring: extend existing formula with `costPerDollar` weight (default 2.0)
- ✅ TUI: `formatKeyStatusTable` has clear column structure, adding columns is straightforward

**Open questions for user:**
1. Should the lock timeout be configurable in `keys.json`? (Default 5min)
2. Should `costPerDollar` weight be in `keys.json` or hardcoded?
3. Should the model breakdown in `/key-status` show per-key or total-only?
4. Do you want the lock file visible in `/key-status` (lock owner column)?
