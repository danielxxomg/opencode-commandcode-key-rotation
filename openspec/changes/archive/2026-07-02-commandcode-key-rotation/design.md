# Design: Command Code API Key Rotation

## Technical Approach

Two-layer hybrid. **Provider**: `KeyManager` injected into `CommandCodeLanguageModel`; `fetchWithRetry()` calls `selectKey()` before each attempt, swaps on 429/quota without consuming retry budget. Sub-agents benefit automatically via shared instance cache (`provider.ts:1809`). **Plugin**: server reads `keys.json`, passes `apiKeys[]` to provider config; TUI renders sidebar + toasts via file-based state (`key-state.json`), proven by `opencode-go-multi-auth`.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|-------------|-----------|
| Rotation location | Provider `fetchWithRetry` | Plugin `chat.headers` | Headers can't see responses; can't help sub-agents |
| Selection | Weighted random (∝ score) | Always-best | Prevents thundering herd on shared keys |
| Server↔TUI state | File-based `key-state.json` | Events, shared KV | Proven pattern; events are fire-and-forget |
| Error classification | `QUOTA_PATTERNS` before `NON_RETRYABLE` | Remove quota patterns | Safer precedence check |
| Test determinism | Inject `now`, `random`, `sleep`, `fetchFn` | Fake timers | Bun lacks `jest.useFakeTimers()` |

## Data Flow

```
fetchWithRetry() → selectKey() → buildHeaders(key) → fetch()
  ├─ 200 OK → reportSuccess → return
  ├─ 429/quota → reportRateLimit → selectKey() [no retry consumed, MAX_SWAPS=5]
  ├─ 401/403 → reportAuthError → permanentlyDead → swap [no retry consumed]
  └─ 5xx → reportServerError → consume retry → backoff 1s/2.5s/5s ±25%
```

Sub-agents share same `CommandCodeLanguageModel` instance → automatic rotation.

## Interception Points

| File | Lines | Change |
|------|-------|--------|
| `src/key-manager.ts` | **NEW** | `KeyManager`, `KeyEntry`, `KeyHealth` |
| `index.ts` | 4-9, 16-32 | Factory: accept `apiKeys[]`, construct KeyManager |
| `src/model.ts` | 213-217 | Options: add `keyManager?`, `fetchFn?`, `sleep?`, `now?`, `random?` |
| `src/model.ts` | 236-245 | `buildHeaders(key)` — accept key param |
| `src/model.ts` | 55-76 | Extract `QUOTA_PATTERNS` from `NON_RETRYABLE_PATTERNS` |
| `src/model.ts` | 251-278 | `fetchWithRetry`: key swap loop, `MAX_KEY_SWAPS=5` |
| `src/model.ts` | 303-415 | `streamWithReconnect`: reconnect calls `selectKey()` |
| `src/model.ts` | 123-131 | `backoffDelay`/`sleep` use injected fns |
| `commandcode-key-rotation/server.ts` | **NEW** | Config hook reads `keys.json`; event hook monitors errors |
| `commandcode-key-rotation/ui.tsx` | **NEW** | `sidebar_footer` slot, `/key-status`, toasts |
| `commandcode-key-rotation/index.ts` | **NEW** | Plugin entry |

## KeyManager Algorithm

```typescript
interface KeyEntry { name: string; key: string; account?: string }
interface KeyHealth {
  score: number; cooldownExpiry: number; successCount: number;
  rateLimitHits: number; authErrors: number; permanentlyDead: boolean;
  lastUsedAt: number; lastCooldownAt: number;
}
```

**Health**: `score = clamp(100 + min(successes*0.1, 50) - rateLimitHits*10 - authErrors*1000 - hoursSinceLastSuccess, 0, 150)`

**Selection**: (1) filter alive + not in cooldown. (2) none eligible → emergency: least-recently-cooldowned. (3) one → direct return. (4) weighted random: `P(key_i) = score_i / Σ scores`.

**Cooldowns**: 429 → 60s (or `Retry-After`, max 300s). 5xx → 10s. Auth → permanent. Quota → 300s.

## Interfaces / Contracts

```typescript
interface KeyManagerDeps { now?: () => number; random?: () => number }
interface CommandCodeModelOptions {
  apiKey: string; baseURL?: string; headers?: Record<string, string>;
  keyManager?: KeyManager; fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number;
}
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/key-manager.ts` + `.test.ts` | Create | KeyManager + TDD tests |
| `src/model.ts` | Modify | Key swap in fetchWithRetry/streamWithReconnect, error classification, DI |
| `src/model.test.ts` | Create | Key swap path tests |
| `index.ts` | Modify | Factory accepts `apiKeys[]` |
| `commandcode-key-rotation/server.ts` | Create | Config + event hooks |
| `commandcode-key-rotation/ui.tsx` | Create | Sidebar + toasts + /key-status |
| `commandcode-key-rotation/index.ts` | Create | Plugin entry |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | KeyManager selection, scoring, cooldown, emergency | Inject `now`, `random` |
| Unit | fetchWithRetry swap (429→swap, quota→swap, auth→death, 5xx→retry) | Inject `fetchFn` (sequenced responses), `sleep: () => Promise.resolve()` |
| Unit | streamWithReconnect mid-stream swap, emittedContent guard | Inject `fetchFn`, mock ReadableStream |
| Unit | Factory backward compat (single apiKey → no KeyManager) | Direct call |

**Coverage**: KeyManager 100%, fetchWithRetry swap paths 100%, streamWithReconnect swap paths 100%.

## Sequence Diagrams

**Diagram 1 — Main 429→Swap→Success**: `fetchWithRetry → selectKey(A) → 429 → reportRateLimit → selectKey(B) → 200 → reportSuccess`

**Diagram 2 — Sub-Agent Transparent**: `SubAgent → getLanguage() → cache HIT → same instance → fetchWithRetry → selectKey → (same rotation)`

**Diagram 3 — Mid-Stream Guard**: `doStream → 200 OK → text-delta (emittedContent=true) → mid-stream 429 → partialOutputError (CANNOT reconnect)`

**Diagram 4 — All Exhausted**: `selectKey(A) → 429 → selectKey(B) → 429 → ... → MAX_SWAPS=5 → Error: all keys exhausted`

## Migration / Rollout

No migration. Backward compat IS rollback: single `apiKey` → zero KeyManager, identical behavior. Activate: add plugin to `opencode.json`, create `~/.commandcode/keys.json`.

## Open Questions

- [ ] Does Command Code send `Retry-After` on 429?
- [ ] Exact 5-hour limit error message? (dev-mode logging captures it)
- [ ] Auth plugin `config` hook ordering: must our plugin override existing single-key injection?
