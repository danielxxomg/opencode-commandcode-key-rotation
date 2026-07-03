# Exploration: Command Code API Key Rotation

## Current State

### Provider Architecture
The `commandcode-retry` provider at `~/.config/opencode/providers/commandcode-retry/` implements a custom AI SDK `LanguageModelV3` with retry/backoff logic. Key files:

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | 33 | Factory: `createCommandCode(options)` → `{ languageModel(modelId) }` |
| `src/model.ts` | 532 | `CommandCodeLanguageModel` — `fetchWithRetry()`, `streamWithReconnect()`, `doStream()`, `doGenerate()` |
| `src/stream.ts` | 243 | SSE parsing — line-delimited JSON, error detection via `controller.error()` |
| `src/auth.ts` | 42 | `resolveApiKey()` — options → env → `~/.commandcode/auth.json` → `~/.pi/agent/auth.json` |
| `src/convert.ts` | 223 | AI SDK → Command Code request conversion |
| `models.json` | 537 | 33 models (Claude, GPT, DeepSeek, Gemini, GLM, Kimi, etc.) |

### Key Resolution Chain (auth.ts lines 5-42)
1. `options.apiKey` (passed by auth plugin)
2. `COMMANDCODE_API_KEY` env var
3. `~/.commandcode/auth.json` — `{ apiKey, userId, userName, keyName, authenticatedAt }`
4. `~/.pi/agent/auth.json` (legacy fallback)

### Error Classification (model.ts lines 55-121)

**NON_RETRYABLE_PATTERNS** (line 55-76):
```
"insufficient credit", "insufficient_credit", "model_not_in_plan", "model not in plan",
"not_in_plan", "not in plan", "usage limit", "usage_limit", "exceeded your",
"quota exceeded", "unauthorized", "forbidden", "invalid api key", "invalid_api_key",
"authentication", "auth_error", "permission_denied", "validation_error", "bad request", "not found"
```

**RETRYABLE_PATTERNS** (line 79-104):
```
"network connection lost", "connection lost", "connection reset", "connection refused",
"connection timeout", "server_error", "server error", "internal server error", "internal error",
"aborted", "aborterror", "abort_error", "fetch failed", "fetchfailed", "econnreset",
"econnrefused", "etimedout", "socket hang up", "terminated", "bad gateway",
"service unavailable", "gateway timeout", "downstream", "temporarily unavailable"
```

**Status-based retry** (line 119-121): `isRetryableStatus(status) = status === 429 || status >= 500`

**The 5-hour session limit** matches `"usage limit"` or `"usage_limit"` → **NON_RETRYABLE** → throws immediately, no retry, no key swap.

### Retry Logic (model.ts lines 251-278)
- Max 3 retries (4 total attempts)
- Backoff: `[1000, 2500, 5000]ms ±25% jitter`
- 429 IS retryable (line 119) but retries with the SAME key (pointless if key exhausted)
- Non-retryable errors throw immediately

### Stream Reconnect (model.ts lines 303-415)
- `emittedContent` guard: if content was emitted (`text-delta`, `reasoning-delta`, `tool-call`, `tool-input-start/delta`), reconnect is BLOCKED to prevent duplicate content
- `partialOutputError()` is thrown when mid-stream disconnect happens after content emission
- Reconnect calls `fetchOnce()` which does a single fetch (no retry budget)

## Critical Finding: Sub-Agent Provider Sharing

### VERIFIED: Sub-agents SHARE the parent's provider instance

**Evidence**: `provider.ts` line 1805-1834 (`getLanguage` function):
```typescript
const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
  const s = yield* InstanceState.get(state)
  const key = `${model.providerID}/${model.id}`
  if (s.models.has(key)) return s.models.get(key)!  // CACHE HIT — same instance
  // ... create and cache
  s.models.set(key, language)
  return language
})
```

The `State.models` is a `Map<string, LanguageModelV3>` (line 1147). Once a `CommandCodeLanguageModel` is created for `commandcode/claude-sonnet-4-6`, it's cached and reused for ALL sessions — main and sub-agent.

**Sub-agent spawning** (`task.ts` line 142-158): Creates a new session with `parentID`, but uses the same model resolution path → same cached `LanguageModelV3` instance.

**Conclusion**: Provider-level key rotation AUTOMATICALLY benefits sub-agents. No separate mechanism needed.

## Prior Exploration Verification

### Verified Claims (from observations #451 and #453)

| Claim | Status | Evidence |
|-------|--------|----------|
| Auth resolution chain (options → env → auth.json → pi/agent) | ✅ VERIFIED | auth.ts lines 5-42 |
| `buildHeaders()` sets `Authorization: Bearer <key>` | ✅ VERIFIED | model.ts lines 236-245 |
| `fetchWithRetry()` at lines 251-278 | ✅ VERIFIED | Exact match |
| `streamWithReconnect()` at lines 303-415 | ✅ VERIFIED | Exact match |
| 429 is retryable status | ✅ VERIFIED | model.ts line 119 |
| "usage limit"/"usage_limit" is NON_RETRYABLE | ✅ VERIFIED | model.ts lines 62-63 |
| `emittedContent` guard prevents reconnect after content | ✅ VERIFIED | model.ts lines 374-382 |
| `chat.headers` cannot see responses | ✅ VERIFIED | plugin index.d.ts lines 216-224 (only outputs headers) |
| Provider-level rotation is MANDATORY for sub-agent transparency | ✅ VERIFIED | getLanguage() caching at provider.ts line 1809 |
| TUI slots: sidebar_footer, sidebar_content, session_prompt_right, home_prompt_right | ✅ VERIFIED | tui.d.ts lines 355-386 |
| `api.ui.toast()` with variants info/success/warning/error | ✅ VERIFIED | tui.d.ts lines 164-169 |
| `api.kv.get/set` for persistent storage | ✅ VERIFIED | tui.d.ts lines 282-286 |
| `api.event.on()` for event listening | ✅ VERIFIED | tui.d.ts lines 407-411 |

### Refuted/Corrected Claims

| Claim | Status | Evidence |
|-------|--------|----------|
| v1: "chat.headers plugin is sufficient" | ❌ REFUTED | chat.headers can't help sub-agents; they share the provider instance, so provider-level rotation is needed |
| v2: "chat.headers runs per HTTP request" | ⚠️ IMPRECISE | chat.headers runs per chat MESSAGE (request.ts line 134-146), not per HTTP request. The provider's fetchWithRetry may make multiple HTTP requests per message. |
| v2: "auth.loader can inject custom fetch" | ⚠️ PARTIALLY TRUE | Works for bundled SDK providers (provider.ts line 1707-1714), but `commandcode-retry` calls global `fetch` directly in model.ts line 255, bypassing the SDK's injected fetch |

## Plugin API Analysis

### Server Plugin Hooks (index.d.ts)

| Hook | Signature | Can Rotate Keys? | Notes |
|------|-----------|-------------------|-------|
| `chat.headers` | `(input: {sessionID, agent, model, provider, message}, output: {headers}) → Promise<void>` | ❌ NO | Sets headers per-message, can't see responses, can't help sub-agents |
| `chat.params` | `(input: {sessionID, agent, model, provider, message}, output: {temperature, topP, topK, maxOutputTokens, options}) → Promise<void>` | ❌ NO | Modifies LLM params, not auth |
| `event` | `(input: {event}) → Promise<void>` | Observer only | Can detect `session.error` for post-hoc key failure detection |
| `auth` | `{provider, loader?, methods[]}` | ⚠️ INDIRECT | loader can return custom options/fetch, but commandcode-retry uses global fetch |
| `provider` | `{id, models?}` | ⚠️ INDIRECT | Can wrap models, but complex |
| `config` | `(input: Config) → Promise<void>` | ⚠️ INDIRECT | Can modify provider config before load |

### TUI Plugin API (tui.d.ts)

| API | Purpose | Use Case |
|-----|---------|----------|
| `api.ui.toast({variant, title, message})` | Toast notifications | Key rotation alerts |
| `api.slots.register({render})` | Register UI slots | sidebar_footer for key status |
| `api.kv.get/set` | Persistent KV storage | Key health state across sessions |
| `api.event.on(type, handler)` | Event bus | Detect key failures |
| `api.keymap.registerLayer({commands, bindings})` | Register commands | `/key-status`, `/key-rotate` |
| `api.state.session` | Session state | Monitor active sessions |

### Available Slots (TuiHostSlotMap)
`app`, `app_bottom`, `home_logo`, `home_prompt`, `home_prompt_right`, `session_prompt`, `session_prompt_right`, `home_bottom`, `home_footer`, `sidebar_title`, `sidebar_content`, `sidebar_footer`

### Server ↔ TUI Communication
No direct IPC mechanism. Options:
1. **Shared KV** (`api.kv`) — both server and TUI can access, but server plugin uses different API
2. **File-based** — write state to `~/.commandcode/key-state.json`, TUI reads it
3. **Events** — server emits events, TUI listens via `api.event.on`

The `opencode-go-multi-auth` plugin uses file-based state (`~/.config/opencode/opencode-go-rotation.json`). This is the proven pattern.

## Existing Tools & Libraries

### Directly Relevant

| Project | URL | Approach | Reusable? |
|---------|-----|----------|-----------|
| `masrurimz/opencode-go-multi-auth` | github.com/masrurimz/opencode-go-multi-auth | Auth loader + custom fetch rotation on 429 | Pattern yes, code no (different provider architecture) |
| `lehuygiang28/gemini-proxy` | github.com/lehuygiang28/gemini-proxy | Proxy with key rotation, polling, load balancing | Architecture inspiration |
| `omarkamali/borgllm` | github.com/omarkamali/borgllm | Zero-config OpenAI client with 20+ providers, key rotation | Key pool pattern |
| `majus47/nos-token-proxy` | github.com/majus47/nos-token-proxy | LLM API proxy with key rotation, usage tracking | Usage tracking approach |

### Key Insight from opencode-go-multi-auth
This plugin confirms the pattern works in opencode:
- Per-process account stickiness (sub-agents share the same account)
- Automatic 429 failover to next account
- File-based rotation state persistence
- **BUT**: It uses `auth.loader` + custom `fetch`, which only works for bundled SDK providers. For `commandcode-retry` (custom provider with direct `fetch`), we must modify the provider itself.

### Upstream Repos
- `brent-weatherall/opencode-commandcode-provider` — 26 stars, active issues about model syncing and retry
- `danielxxomg/opencode-commandcode-provider` — fork with retry/backoff patches (2 merged PRs)

## Architecture Decision: Provider Modification Required

### Why NOT plugin-only?

The `commandcode-retry` provider calls `fetch()` directly (model.ts line 255):
```typescript
const response = await fetch(url, fetchOpts)
```

This is the GLOBAL `fetch`, not a custom fetch injected by opencode's SDK wrapper. The `auth.loader` hook's custom fetch only works for bundled providers that receive it through their factory function (provider.ts line 1707-1714). The `commandcode-retry` provider is a custom npm provider that bypasses this.

### Recommended Architecture: Hybrid

**Layer 1: Modified Provider** (critical path)
- `KeyManager` module: holds keys with health metadata, weighted random selection
- Modified `fetchWithRetry()`: swap keys on 429/quota, don't consume retry attempts
- Modified `streamWithReconnect()`: swap keys on mid-stream 429/quota
- Modified factory: accept `apiKeys[]` option (backward-compatible with single `apiKey`)

**Layer 2: Server Plugin** (config + monitoring)
- Read keys from `~/.commandcode/keys.json` or plugin options
- Pass keys to provider via config modification
- Monitor `session.error` events for post-hoc key failure detection
- Write key state to `~/.commandcode/key-state.json`

**Layer 3: TUI Plugin** (display + notifications)
- Toast on key rotation
- Sidebar footer showing active key name
- `/key-status` command

## Edge Cases & Risks

### Critical

| Edge Case | Behavior | Risk |
|-----------|----------|------|
| All keys in cooldown | Use least-recently-blocked key with warning toast | If all keys hit 5-hour limit simultaneously, all are in long cooldown |
| All keys permanently dead (auth errors) | Fatal error, display all keys + status | User must refresh keys manually |
| Mid-stream key exhaustion AFTER content emitted | `partialOutputError()` — CANNOT reconnect (duplicate-content risk) | Unavoidable; proactive health tracking mitigates |
| 5-hour session limit | Matches "usage limit" → NON_RETRYABLE in current code | Must change to trigger key swap instead of throw |

### Important

| Edge Case | Behavior | Risk |
|-----------|----------|------|
| Single key available | No random, always use it | No rotation benefit; behaves like today |
| New key with no history | Score 100, immediately eligible | None |
| Config hot-reload | Re-read `keys.json` on each key pick | Slight I/O overhead; file may be malformed |
| Multi-instance | Lock file with timeout (`~/.commandcode/.key-lock`) | MVP assumes single instance |
| `Retry-After` header | Respect if present, use as cooldown duration | Command Code may or may not send it |

### Warning

| Edge Case | Behavior | Risk |
|-----------|----------|------|
| Key validation | No way to validate without making a request | Invalid keys fail on first use, then permanently disabled |
| Auth plugin conflict | Existing `commandcode-go-opencode-provider/server` sets single apiKey | Must ensure our plugin overrides it |

## Config & Git Topology

### Version Control Strategy

The provider code lives at `~/.config/opencode/providers/commandcode-retry/` (not in a git repo). Options:

| Approach | Pros | Cons |
|----------|------|------|
| **A: Track in project dir, copy to config** | Clean git history, proper versioning | Manual copy step |
| B: Init provider dir as git repo | Direct versioning | Mixes with other config files |
| C: Symlink from project to config | Single source of truth | Symlinks can break |

**Recommendation**: Option A. Track the modified provider in the project repo (`/home/danielxxomg/Projects/opencode-commandcode-key-rotation/`), provide a script to copy/install to `~/.config/opencode/providers/commandcode-retry/`. The upstream fork `danielxxomg/opencode-commandcode-provider` serves as the source of truth for the original provider.

### Config Changes Needed

`~/.config/opencode/opencode.json`:
```json
{
  "plugin": [
    "opencode-gemini-auth@latest",
    "commandcode-go-opencode-provider/server",
    "commandcode-key-rotation/server"  // NEW
  ]
}
```

Provider registration: The `commandcode` provider entry already exists. The modified provider at `~/.config/opencode/providers/commandcode-retry/` replaces the original — no config change needed for the provider itself.

## Testing Strategy (Strict TDD, `bun test`)

### Mock Strategy
- **fetch**: `mock.module("../../src/model.ts", ...)` or inject fetch as a constructor parameter
- **Recommended**: Dependency injection — pass `fetchFn` to `CommandCodeLanguageModel` constructor, default to `globalThis.fetch`
- **AI SDK**: Mock the `LanguageModelV3` interface if testing the plugin layer

### Timer Strategy
- Bun does NOT support `jest.useFakeTimers()` / `setSystemTime()`
- **Approach**: Inject a `sleep` function and a `now` function into the model/KeyManager
- Tests pass deterministic implementations: `sleep: () => Promise.resolve()`, `now: () => fixedTimestamp`
- This also makes backoff tests instant (no real delays)

### File Structure
```
src/
├── key-manager.ts
├── key-manager.test.ts      ← next to code
├── model.ts
├── model.test.ts
├── stream.ts
├── stream.test.ts
├── auth.ts
├── auth.test.ts
├── convert.ts
└── convert.test.ts
```

### Deterministic Weighted Random
- Inject `random: () => number` into KeyManager (default: `Math.random`)
- Tests pass `random: () => 0.5` for deterministic selection
- Or use a seeded PRNG for sequence testing

### Coverage
- `bun test --coverage` outputs text and/or lcov
- Target: 80% for new/modified code
- Focus on: KeyManager (100%), fetchWithRetry key swap paths (100%), streamWithReconnect key swap paths (100%)

## Recommendation

**Proceed with hybrid architecture (provider modification + plugin).**

The provider modification is the critical path — it's what makes sub-agent transparency possible. The plugin handles config, TUI, and monitoring.

### Implementation Order
1. `KeyManager` module (TDD: selection, health scoring, cooldown, weighted random)
2. Modified `fetchWithRetry()` (TDD: key swap on 429/quota, retry consumption)
3. Modified `streamWithReconnect()` (TDD: mid-stream key swap)
4. Modified factory (TDD: backward compatibility with single apiKey)
5. Server plugin (config reading, event monitoring)
6. TUI plugin (toast, sidebar, commands)

### Ready for Proposal
**Yes.** All architectural questions are resolved. The sub-agent instance-sharing question is CONFIRMED (they share). The plugin API is fully mapped. The existing tools are researched. The testing approach is defined.

## Open Questions for User
1. How many keys do you typically juggle? (Affects config design)
2. Does Command Code send `Retry-After` headers on 429? (Need to capture real responses)
3. What's the exact error message for the 5-hour session limit? (Need to verify against real API)
4. Do you want the keys file to include per-key metadata (name, account info)?
