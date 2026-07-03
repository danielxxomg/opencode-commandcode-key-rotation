# Design: Command Code Key Rotation — Phase 3

## Technical Approach

Provider-level extensions: (1) new `LockManager` module using per-key files with `O_EXCL` atomic creation, (2) `KeyManager` gains cost tracking, lock-aware selection, and incremental cost-aware scoring, (3) stream wrapper in `doStream()` holds lock until stream ends, intercepts `finish` for usage capture, (4) server plugin loads `models.json` cost map and passes lock/cost config to provider.

## Architecture Decisions

### Decision: Lock file strategy — single JSON array vs per-key files with O_EXCL

**Choice**: Per-key files at `~/.commandcode/.key-locks/{sanitized-key-name}` using `O_EXCL` (atomic create-if-not-exists). No JSON array.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| JSON array + temp+rename | Read-modify-write race: two instances read same state, both write → lost update | Rejected |
| JSON array + retry-on-conflict | Adds complexity; still has small window between read and write | Rejected |
| Per-key files + O_EXCL | Atomic create-if-not-exists; simplest; no shared state to corrupt | **Selected** |
| Accept race (5min timeout) | Simplest but silent double-use possible during window | Rejected |

**Rationale**: `O_EXCL` is a kernel-level atomic operation — two concurrent `open(O_CREAT|O_EXCL)` on the same path: one succeeds, one gets `EEXIST`. No read-modify-write needed. Directory `~/.commandcode/.key-locks/` auto-created. Each file contains `{ instanceId, acquiredAt, expiresAt }`. Release = `unlink()`. Expired locks detected by `expiresAt` in file content (read on `isLocked()` check). Flock not needed — O_EXCL + unlink is sufficient for this use case.

### Decision: Single key selection point (fetchWithRetry authority)

**Choice**: `fetchWithRetry()` is the SOLE key selection authority. `fetchOpts()` no longer calls `selectKey()`.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| fetchOpts() selects + acquires lock, fetchWithRetry() uses that key | fetchOpts() called once but fetchWithRetry() retries with same key (no swap on 429) | Rejected |
| fetchWithRetry() sole authority — fetchOpts() accepts key param | Clean: selection + lock + retry all in one place. fetchOpts() becomes a pure builder | **Selected** |

**Rationale**: Current code has a bug — `fetchOpts()` (line 579) calls `km.selectKey()`, then `fetchWithRetry()` (line 315) calls `km.selectKey()` again on each attempt. This double-selects. Fix: `fetchOpts()` becomes a factory that accepts an optional `key` parameter. `fetchWithRetry()` selects the key, acquires the lock, builds headers, and passes the key reference out so the stream wrapper can attribute usage.

**Refactoring**:
```typescript
// BEFORE (model.ts line 577-582):
const fetchOpts = (): RequestInit => ({
  method: "POST",
  headers: this.buildHeaders(km ? km.selectKey().key : undefined),
  body: requestBody,
  signal: controller.signal,
})

// AFTER:
const fetchOpts = (key?: string): RequestInit => ({
  method: "POST",
  headers: this.buildHeaders(key),
  body: requestBody,
  signal: controller.signal,
})
```

`fetchWithRetry()` signature changes to return `{ response: Response; keyUsed: string | null }` so the caller knows which key was used.

### Decision: Lock lifecycle — release after HTTP response vs after stream completes

**Choice**: Lock held until stream COMPLETES, ERRORS, or is CANCELLED. Not after `fetchWithRetry()` returns.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Release after fetchWithRetry() success | Simple but WRONG for streaming — HTTP 200 arrives before stream ends | Rejected |
| Release in stream completion/error/cancel handlers | Correct lifecycle; lock held for entire stream duration | **Selected** |

**Rationale**: For `doStream()`, `fetchWithRetry()` returns at HTTP 200 — the stream body is still being consumed. Releasing the lock at that point allows another instance to grab the same key while content is still streaming. The lock MUST be released in the stream wrapper's terminal handlers.

**Implementation**: `fetchWithRetry()` acquires the lock and returns a `releaseLock` callback alongside the response. The stream wrapper (or `doStream()`) calls `releaseLock()` in three places:
1. `streamWithReconnect`'s `controller.close()` (line 507) — normal completion
2. `controller.error()` calls (lines 474, 476, 498, 500, 541) — error path
3. `cancel()` handler (line 550-552) — consumer cancels

For `doGenerate()` (non-streaming): lock released after `reader.read()` loop exits (line 653) or in the `finally` block (line 654).

### Decision: Lock renewal for long-running streams

**Choice**: Periodic timer refreshes lock expiry every `lockTimeoutMs / 3` (~100s with 5min default). Cleared on stream completion/error/cancel.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Periodic refresh (lockTimeoutMs / 3) | Adds timer management but prevents expiry during long streams | **Selected** |
| Longer timeout (30min) | Simple but holds locks too long if instance crashes | Rejected |
| Accept risk (5min generous) | Simplest but silent double-use on slow streams | Rejected |

**Rationale**: LLM streams can run 2-5 minutes for complex prompts. A 5min lock with no renewal is risky. Refreshing at 1/3 intervals ensures the lock stays alive with margin. The refresh timer is created when the lock is acquired in `fetchWithRetry()` and cleared when the lock is released.

### Decision: Scoring — incremental mutation with cost penalty vs recomputed formula

**Choice**: Keep existing incremental mutation pattern. ADD `reportUsage()` that subtracts `requestCost × costPerDollar` from score (floor at 0).

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Incremental + cost penalty | Matches existing pattern (success+0.1, rateLimit-10). Simple. Running penalty, not recompute | **Selected** |
| Recomputed formula | Requires storing all raw counters + computing on each selectKey. Overhaul of existing scoring | Rejected |

**Rationale**: Current scoring uses incremental mutations: `reportSuccess` adds `min(successCount*0.1, 50)`, `reportRateLimit` subtracts 10, `reportServerError` subtracts 5. There is NO formula-based scoring or `agePenalty` in the codebase. The design must match this pattern. Adding cost as another incremental penalty (`score -= requestCost × costPerDollar`) is consistent and backward-compatible (no costMap → no penalty).

### Decision: Stream wrapper key attribution

**Choice**: `fetchWithRetry()` returns `{ response, keyUsed, releaseLock }` tuple. The `keyUsed` string is passed to the stream wrapper so it can attribute usage to the correct key.

**Rationale**: Currently `fetchWithRetry()` returns just `Response`. The stream wrapper needs to know which key was used to call `reportUsage(key, modelId, usage)`. Returning the key alongside the response avoids global state or closures over mutable variables.

### Decision: reportUsage error isolation

**Choice**: Stream wrapper wraps `reportUsage()` in try/catch. Errors are logged but never propagate to the stream.

**Rationale**: A bad costMap entry or division-by-zero in cost calculation MUST NOT break the stream. The `finish` event must always be forwarded to the consumer. Errors in `reportUsage` are side-effects, not stream data.

## Data Flow

### Key Selection + Lock (doStream path)

    doStream()
      → fetchWithRetry(url, fetchOpts(key))
          → selectKey() picks key, acquires lock (O_EXCL)
          → fetchOpts(key) builds headers with selected key
          → HTTP request
          → success: return { response, keyUsed, releaseLock, refreshLock }
          → 429/auth: release lock, swap key, retry
      → stream wrapper wraps response.body
      → wrapper holds releaseLock callback
      → wrapper starts refresh timer (lockTimeoutMs / 3)
      → stream completes/errors/cancels → releaseLock() + clearInterval(refreshTimer)

### Cost Capture (stream wrapper)

    doStream() → fetchWithRetry() → { response, keyUsed }
         → streamWithReconnect(makeStream)
              → [new: usageStreamWrapper(stream, keyManager, keyUsed, modelId, releaseLock, refreshTimer)]
                   → intercepts "finish" event
                   → try { keyManager.reportUsage(keyUsed, modelId, usage) } catch { log.error }
                   → releaseLock(keyUsed)
                   → clearInterval(refreshTimer)
                   → enqueues unchanged "finish" event

### Lock Acquire (O_EXCL atomic)

    acquireLock(keyName):
      path = ~/.commandcode/.key-locks/{sanitize(keyName)}
      try { fs.open(path, O_CREAT|O_EXCL); write JSON → return true }
      catch EEXIST → read file → if expired → unlink + retry once → else return false

    releaseLock(keyName):
      path = ~/.commandcode/.key-locks/{sanitize(keyName)}
      try { fs.unlink(path) } catch { /* already gone */ }

    refreshLock(keyName):
      path = ~/.commandcode/.key-locks/{sanitize(keyName)}
      read file → update expiresAt → write (atomic temp+rename)

### All Keys Locked Fallback

    selectKey() → all eligible locked by other instances
              → sort by lock expiresAt ascending
              → select earliest-expiry key + log warning

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `commandcode-retry/src/lock-manager.ts` | Create | LockManager — per-key O_EXCL files, acquire/release/refresh/isLocked/timeout |
| `commandcode-retry/src/lock-manager.test.ts` | Create | TDD: atomic acquire, conflict detection, expiry, refresh, release |
| `commandcode-retry/src/key-manager.ts` | Modify | Add reportUsage() with incremental cost penalty, lock-aware selectKey() |
| `commandcode-retry/src/key-manager.test.ts` | Modify | TDD: cost penalty, lock filtering, scoring |
| `commandcode-retry/src/model.ts` | Modify | Refactor fetchOpts(key?) + fetchWithRetry returns {response, keyUsed, releaseLock}; add usageStreamWrapper with lock lifecycle + refresh timer |
| `commandcode-retry/src/model.test.ts` | Modify | TDD: stream wrapper usage capture, lock release on error/cancel, reportUsage isolation |
| `commandcode-retry/index.ts` | Modify | Accept modelCosts/lockManager/scoringWeights/costPerDollar in options |
| `commandcode-key-rotation/server.ts` | Modify | Load models.json → costMap, create LockManager, pass to provider |
| `commandcode-key-rotation/server.test.ts` | Modify | TDD: models.json loading |
| `commandcode-key-rotation/ui-logic.ts` | Modify | Add formatCost, formatTokens, formatModelBreakdown, formatLockOwner |
| `commandcode-key-rotation/ui-logic.test.ts` | Modify | TDD: new formatters |
| `commandcode-key-rotation/ui.tsx` | Modify | Sidebar shows cost + lock; /key-status shows new columns |

## Interfaces / Contracts

```typescript
// lock-manager.ts — per-key O_EXCL files
interface LockEntry {
  instanceId: string
  acquiredAt: number
  expiresAt: number
}

interface LockManagerDeps {
  now?: () => number
  mkdirSync?: (path: string) => void
  openSync?: (path: string, flags: number) => number
  closeSync?: (fd: number) => void
  writeFileSync?: (path: string, content: string) => void
  readFileSync?: (path: string) => string | null
  unlinkSync?: (path: string) => void
  renameSync?: (old: string, newPath: string) => void
}

class LockManager {
  constructor(lockDir: string, lockTimeoutMs: number, instanceId: string, deps?: LockManagerDeps)
  acquireLock(keyName: string): boolean       // O_EXCL atomic create
  releaseLock(keyName: string): void          // unlink
  refreshLock(keyName: string): boolean       // read → update expiresAt → temp+rename
  isLocked(keyName: string): boolean          // read file → check expiresAt
  getLockOwner(keyName: string): string | null
  getActiveLocks(): LockEntry[]
}

// fetchWithRetry return type
interface FetchResult {
  response: Response
  keyUsed: string | null       // null when no KeyManager
  releaseLock: () => void      // no-op when no KeyManager
}

// key-manager.ts extensions
interface KeyHealth {
  // existing fields unchanged...
  totalCostUSD: number                                                    // NEW
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> // NEW
}

// New method — incremental cost penalty
reportUsage(key: string, modelId: string, usage: LanguageModelV3Usage): void
// Calculates: requestCost from costMap + usage tokens
// Applies: health.score -= requestCost * costPerDollar (floor 0)
// Updates: health.totalCostUSD, health.totalInputTokens, health.modelUsage[modelId]

// index.ts extensions
interface CommandCodeProviderOptions {
  // existing...
  modelCosts?: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }>
  lockManager?: LockManager
  costPerDollar?: number   // default 2.0 — scoring weight for cost penalty
  instanceId?: string
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | LockManager O_EXCL acquire (success + EEXIST) | Inject openSync mock that throws EEXIST. Assert returns false. |
| Unit | LockManager release (unlink) + expired lock reclaim | Inject readFileSync returning expired entry. Assert acquire succeeds after unlink. |
| Unit | LockManager refresh updates expiresAt | Inject readFileSync + renameSync. Assert new expiresAt written. |
| Unit | reportUsage incremental cost penalty | Inject costMap. Call reportUsage. Assert `health.score` decreased by `cost * costPerDollar`. |
| Unit | reportUsage floor at 0 | Call reportUsage with huge cost. Assert score clamps to 0. |
| Unit | Stream wrapper releases lock on controller.close | Inject fetchFn. Assert releaseLock called when stream ends. |
| Unit | Stream wrapper releases lock on controller.error | Inject fetchFn that errors. Assert releaseLock called. |
| Unit | Stream wrapper releases lock on cancel | Cancel the stream. Assert releaseLock called. |
| Unit | Stream wrapper refreshes lock periodically | Use fake timers. Advance by lockTimeoutMs/3. Assert refreshLock called. |
| Unit | reportUsage error does NOT break stream | Inject costMap that throws. Assert finish event still forwarded. |
| Unit | fetchWithRetry returns keyUsed | Inject KeyManager. Assert keyUsed matches the key that succeeded. |
| Unit | fetchOpts() no longer selects key | Assert fetchOpts(key) uses the passed key, does not call selectKey. |
| Integration | Lock-aware selectKey prefers unlocked | Inject LockManager with one key locked. Assert other key selected. |
| Integration | All locked → earliest expiry fallback | Inject LockManager with all locked. Assert earliest selected. |
| E2E | Backward compat: no lockManager/costMap → phase 1+2 behavior | Construct without new deps. Assert identical behavior. |

## Migration / Rollout

No migration required. All features gated by optional config:
- No `lockManager` → no lock checks (backward compat)
- No `modelCosts` → no cost tracking (backward compat)
- No `costPerDollar` → defaults to 2.0
- Old `keys.json` configs work unchanged
- `~/.commandcode/.key-locks/` directory auto-created on first lock acquire

## Open Questions

- [ ] Lock timeout configurable in keys.json? (Default 5min — proposal says yes)
- [ ] Model breakdown in /key-status: per-key or total-only? (Proposal: total across all keys)
