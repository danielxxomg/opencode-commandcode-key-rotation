# Command Code Key Rotation Plugin — MVP Brief

> OpenCode plugin for automatic API key rotation with session continuity, TUI integration, and multi-instance coordination.

## Session Context (for new AI sessions)

If you're reading this in a new session, here's what you need to know:

### What exists today
- **This document** — the complete brief (you're reading it)
- **Provider patch**: `~/.config/opencode/providers/commandcode-retry/` — local fork of `commandcode-go-opencode-provider` with retry/backoff improvements. THIS is the code you'll modify.
- **Upstream fork**: [danielxxomg/opencode-commandcode-provider](https://github.com/danielxxomg/opencode-commandcode-provider) — has PR #10 (retry/backoff) and PR #11 (SSE handling) pending upstream at [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider)
- **Engram artifacts**: `sdd/commandcode-key-rotation-plugin/explore` and `explore-v2` — deep research on plugin API, TUI slots, provider architecture
- **SDD artifacts**: `sdd/commandcode-upstream-retry-pr/*` — full SDD cycle for the upstream contribution (explore, proposal, design, tasks, apply, verify, archive)

### Key files to read before implementing
1. `~/.config/opencode/providers/commandcode-retry/src/model.ts` — the retry engine (THIS gets modified)
2. `~/.config/opencode/providers/commandcode-retry/src/stream.ts` — SSE error handling (THIS gets modified)
3. `~/.config/opencode/providers/commandcode-retry/index.ts` — provider factory (THIS gets modified)
4. `~/.config/opencode/providers/commandcode-retry/src/auth.ts` — auth resolution (reference, don't modify)
5. `~/.config/opencode/node_modules/@opencode-ai/plugin/` — plugin API (read for TUI slots, toast, kv)
6. `~/.config/opencode/opencode.json` — current config (provider + plugin registration)
7. `~/.commandcode/auth.json` — existing single-key auth file

### Critical architectural decision
Key rotation MUST happen **inside the provider** (`fetchWithRetry()`), NOT in a plugin hook. The `chat.headers` plugin hook cannot see responses and cannot help sub-agents. Only provider-level interception solves both the main-session and sub-agent problems transparently.

### Engram search shortcuts
```
mem_search("commandcode-key-rotation-plugin") — all plugin research
mem_search("commandcode-upstream-retry-pr") — upstream contribution SDD cycle
mem_search("sdd-init/token-ahorrator") — project context and testing capabilities
```

---

## Problem

Command Code offers small Go plans with **5-hour session limits**. Users managing multiple API keys (across accounts or orgs) face two critical failure modes:

### 1. Main Session Stall
When the active key hits its limit, OpenCode freezes with an error. The user must manually run `/connect` to switch keys, which **cancels the current session** and loses context.

### 2. Sub-Agent Death (Critical)
When a sub-agent's key expires mid-task, the entire agent session terminates. The **thought chain, context, and progress are permanently lost**. Recovery requires launching a new session from scratch with no memory of what was being done.

Both problems require **transparent key swapping at the provider level** — before errors propagate to the AI SDK.

## Solution

A **hybrid architecture**: modified provider handles key rotation internally, while a plugin provides TUI notifications and configuration.

```
Key exhausted → fetchWithRetry() detects 429/quota
  → Suppress error (don't propagate to AI SDK)
  → KeyManager.pickBest() selects next healthy key
  → Re-fetch with new key (retry attempt preserved)
  → Toast notifies user
  → Sub-agent NEVER knows a switch happened → continues normally
```

## Architecture

### Layer 1: Provider (`commandcode-retry` — modified)

The rotation engine lives **inside the provider**, in `fetchWithRetry()`. This is the only interception point that works for both main sessions and sub-agents.

```
┌─────────────────────────────────────────────┐
│  KeyManager                                 │
│  ├── apiKeys: KeyHealth[]                   │
│  ├── pickBest() → weighted random           │
│  ├── markSuccess(key)                       │
│  ├── markRateLimited(key, retryAfter?)      │
│  ├── markAuthError(key)                     │
│  └── getState() → for TUI display           │
├─────────────────────────────────────────────┤
│  fetchWithRetry()                           │
│  ├── On 429/quota error:                    │
│  │   ├── Don't consume retry attempt        │
│  │   ├── KeyManager.markFailed(currentKey)  │
│  │   ├── newKey = KeyManager.pickBest()     │
│  │   ├── buildHeaders() with newKey         │
│  │   └── Re-fetch                           │
│  └── On success:                            │
│      └── KeyManager.markSuccess(currentKey) │
├─────────────────────────────────────────────┤
│  streamWithReconnect()                      │
│  └── Same key-swap logic on mid-stream      │
│      disconnects                            │
└─────────────────────────────────────────────┘
```

### Layer 2: Server Plugin

- Reads key config from `~/.commandcode/keys.json`
- Injects `apiKeys[]` into provider options
- Listens for rotation events
- Fires `api.ui.toast()` on every key switch

### Layer 3: TUI Plugin

- Registers `sidebar_footer` slot with Solid.js component
- Shows: current key name, associated account, keys status
- `/key-status` command for detailed view
- `api.kv` for health state persistence across sessions

## Configuration

### Keys File (`~/.commandcode/keys.json`)

```json
{
  "keys": [
    {
      "name": "personal",
      "key": "user_5CEqzW3Ev...",
      "account": "danielxxomg"
    },
    {
      "name": "work",
      "key": "user_abc123...",
      "account": "work-org"
    },
    {
      "name": "backup",
      "key": "user_def456...",
      "account": "danielxxomg"
    }
  ],
  "rotation": {
    "strategy": "weighted-random",
    "cooldownMs": 60000,
    "cooldownFromRetryAfter": true,
    "serverErrorCooldownMs": 10000,
    "scoreDecayPerHour": 1,
    "maxSuccessBonus": 50
  },
  "notifications": {
    "onRotate": true,
    "onCooldown": true,
    "onRecovery": true,
    "onPermanentDeath": true
  }
}
```

### OpenCode Config (`~/.config/opencode/opencode.json`)

```json
{
  "plugin": [
    "commandcode-key-rotation/server"
  ],
  "provider": {
    "commandcode": {
      "npm": "file:./providers/commandcode-retry",
      "env": ["COMMANDCODE_API_KEY"]
    }
  }
}
```

## Rotation Strategy

### Health Scoring

Each key maintains a persistent health score:

```
score = 100
      + (successes * 0.1)         // bonus for successful use (capped at +50)
      - (rateLimitHits * 10)      // penalty per 429
      - (authErrors * 1000)       // nuclear penalty for auth failures
      - (agePenalty)              // mild penalty for inactivity (1 point/hour)
```

### Selection Algorithm

**Weighted random** (not always-best): prevents single-key thundering herd. Higher-scored keys get proportionally more traffic, but all healthy keys get some.

```
pickBest():
  1. Filter: not permanently dead, not in cooldown
  2. If none eligible → use least-recently-cooldowned (emergency)
  3. Weighted random: probability ∝ score
```

### Cooldown Behavior

| Event | Cooldown | Notification |
|-------|----------|-------------|
| HTTP 429 | 60s (configurable) | `⚠️ Key 'personal' rate limited — cooling down 60s` |
| 429 + `Retry-After` header | Respects header | `⚠️ Key 'personal' rate limited — retry after {X}s` |
| 401/403 (auth) | ∞ (permanent) | `🔴 Key 'personal' auth failed — permanently disabled` |
| 5xx (server) | 10s | `⚠️ Key 'personal' server error — retrying in 10s` |
| Success after cooldown | Reset | `✅ Key 'personal' back online` |

### Edge Cases

| Case | Behavior |
|------|----------|
| All keys in cooldown | Use least-recently-blocked, warn user |
| Single key available | Use it always (no random), warn if score low |
| Permanently dead key | Exclude from pool, notify once |
| All permanently dead | Fatal error, show all keys and their status |
| New key (no history) | Score 100, immediately eligible |
| Config changed (key added/removed) | Hot-reload without restart |

## Multi-Instance Coordination

When multiple OpenCode instances run simultaneously, they share the same key pool. A **lock file** prevents conflicts:

```
~/.commandcode/.key-lock
{
  "lockedBy": "instance-uuid-abc",
  "lockedKey": "personal",
  "expiresAt": "2026-07-02T16:30:00Z"
}
```

- Before picking a key, check if it's locked by another instance
- Lock timeout: 5 minutes (auto-release on crash)
- Prefer unlocked keys over locked ones
- If all keys locked, use the one with earliest expiry

## TUI Display

### Sidebar Footer

```
┌─ MCP Servers ─────────────┐
│ context7 ✅                │
│ engram ✅                  │
├─ Key Rotation ────────────┤
│ 🔑 personal (danielxxomg) │
│ 📊 4 keys | 3 healthy     │
│ work: cooldown 45s        │
├─ LSP ─────────────────────┤
│ typescript ✅              │
└───────────────────────────┘
```

### Toast Notifications

```
⚠️ Key Rotated: 'personal' → 'work' (rate limited)
✅ Key Restored: 'personal' back online
🔴 Key Disabled: 'backup' auth failed — permanently removed
```

### `/key-status` Command

```
Active Keys:
  ✅ personal (danielxxomg)  — score: 87, used: 145 reqs
  ⏳ work (work-org)         — cooldown: 23s, score: 42
  🔴 backup (danielxxomg)    — permanently disabled (auth error)

Current: personal
Strategy: weighted-random
Cooldown: 60s
```

## Dependencies

| Dependency | Purpose |
|------------|---------|
| `commandcode-go-opencode-provider` (fork) | Base provider — we modify this |
| `@opencode-ai/plugin` | Plugin API (toast, slots, kv, keymap) |
| `@opentui/solid` | Solid.js for TUI sidebar component |

## File Structure

```
~/.config/opencode/
├── providers/
│   ├── commandcode-retry/          ← MODIFIED (provider with rotation)
│   │   ├── index.ts                ← Accept apiKeys[]
│   │   ├── src/
│   │   │   ├── model.ts            ← fetchWithRetry with key swap
│   │   │   ├── stream.ts           ← reconnect with new key
│   │   │   ├── key-manager.ts      ← NEW: health tracking + pick
│   │   │   ├── auth.ts             ← Unchanged
│   │   │   └── convert.ts          ← Unchanged
│   │   └── package.json
│   └── commandcode-key-rotation/   ← NEW (TUI plugin)
│       ├── server.ts               ← Server plugin (config + events)
│       ├── ui.tsx                  ← TUI sidebar component (Solid.js)
│       ├── index.ts                ← Plugin entry
│       └── package.json
├── opencode.json                   ← Plugin registration
└── package.json                    ← Dependencies

~/.commandcode/
├── auth.json                       ← Existing single key (legacy)
├── keys.json                       ← NEW: multi-key config
└── .key-lock                       ← NEW: multi-instance lock
```

## Roadmap

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1 (MVP)** | KeyManager + fetchWithRetry rotation + toast notifications | Medium |
| **Phase 2** | TUI sidebar + `/key-status` command | Low |
| **Phase 3** | Lock file coordination + intelligent scoring | Low |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Mid-stream key swap after content emitted | Medium | Can't reconnect (duplicate risk) — surface clear error |
| Error message patterns don't match real errors | Medium | Test with real quota exhaustion; add fallback patterns |
| Provider fork diverges from upstream | High | Keep local patch as fallback; contribute upstream |
| Multi-instance lock contention | Low | Timeout-based locks with auto-release |
| No usage/credits API | Known | Track usage locally; can't do pre-emptive rotation |

## Related

- **Fork**: [danielxxomg/opencode-commandcode-provider](https://github.com/danielxxomg/opencode-commandcode-provider) — base provider with retry/backoff improvements
- **Upstream**: [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) — original provider
- **PR #10**: Retry/backoff core with error classification
- **PR #11**: SSE error handling improvements

## License

MIT
