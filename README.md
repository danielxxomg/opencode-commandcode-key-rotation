# Command Code Key Rotation Plugin

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.0.0-fbf0d9.svg)
![Tests](https://img.shields.io/badge/tests-246%20pass-brightgreen.svg)
![Coverage](https://img.shields.io/badge/coverage-%3E80%25-brightgreen.svg)
![Strict TDD](https://img.shields.io/badge/TDD-strict-orange.svg)

> OpenCode plugin for automatic API key rotation across multiple Command Code accounts — with session continuity, sub-agent transparency, and TUI integration.

> [!WARNING]
> This plugin **modifies the `commandcode-retry` provider** (a local fork of `commandcode-go-opencode-provider`). If the upstream provider releases changes, you'll need to re-apply the key-rotation patch. The modified provider is fully backward-compatible: when no `apiKeys[]` are configured, it behaves identically to the original single-key provider.

## Problem

Command Code plans have **5-hour session limits**. When the active key hits its limit, OpenCode freezes with an error. Two critical failure modes:

1. **Main session stall** — you must manually run `/connect` to switch keys, which cancels the current session and loses context.
2. **Sub-agent death** — when a sub-agent's key expires mid-task, the entire agent session terminates. The thought chain, context, and progress are permanently lost.

Both problems require **transparent key swapping at the provider level** — before errors propagate to the AI SDK.

## Solution

Provider-level key rotation that's transparent to both main sessions and sub-agents. Sub-agents share the parent's provider instance (verified at [opencode `provider.ts:1809`](https://github.com/anomalyco/opencode) — `getLanguage()` caches `LanguageModelV3` instances), so provider-level rotation benefits them automatically.

## How It Works

```
1. Request sent with key A
2. Command Code responds 429 / quota-exceeded
3. fetchWithRetry() detects quota error (does NOT consume retry attempt)
4. KeyManager.markRateLimited(key A) → key A enters cooldown
5. KeyManager.selectKey() → weighted-random picks key B
6. buildHeaders(key B) → re-fetch with new key (retry budget untouched)
7. Toast: "Key Rotated: A → B (rate limited)"
8. Sub-agent continues normally — never knows a switch happened
```

**Why not a plugin hook?** The `chat.headers` plugin hook can't see responses and can't detect failures. The `auth.loader` custom-fetch only works for bundled SDK providers — `commandcode-retry` calls `globalThis.fetch` directly, bypassing it. Only provider-level interception in `fetchWithRetry()` solves both the main-session and sub-agent problems.

## Prerequisites

- [OpenCode](https://opencode.ai) installed and working
- [Bun](https://bun.sh) >= 1.0.0 (runtime + test runner)
- A [Command Code](https://commandcode.ai) account with at least one API key
- 2+ API keys across accounts (for rotation to be useful)

## Quick Start

```bash
# 1. Clone
git clone https://github.com/danielxxomg/opencode-commandcode-key-rotation.git
cd opencode-commandcode-key-rotation

# 2. Install — copies providers into ~/.config/opencode/providers/
./install.sh

# 3. Set up keys
cp providers/commandcode-key-rotation/keys.json.example ~/.commandcode/keys.json
# Edit with your real keys (see Configuration below)

# 4. Register in ~/.config/opencode/opencode.json
#    Add "commandcode-key-rotation/server" and "commandcode-key-rotation/tui" to the plugin array
#    Ensure provider.commandcode.npm points to the modified provider

# 5. Restart OpenCode
```

## Configuration

### `~/.commandcode/keys.json`

Multi-key config with rotation and notification settings:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "keys": [
    { "name": "personal", "key": "user_YOUR_KEY_1", "account": "myaccount" },
    { "name": "work",     "key": "user_YOUR_KEY_2", "account": "work-org" },
    { "name": "backup",   "key": "user_YOUR_KEY_3", "account": "myaccount" }
  ],
  "rotation": {
    "strategy": "weighted-random",
    "cooldownMs": 60000,
    "cooldownFromRetryAfter": true,
    "serverErrorCooldownMs": 10000,
    "scoreDecayPerHour": 1,
    "maxSuccessBonus": 50,
    "lockTimeoutMs": 300000,
    "costPerDollar": 2.0
  },
  "notifications": {
    "onRotate": true,
    "onCooldown": true,
    "onRecovery": true,
    "onPermanentDeath": true,
    "onLockRelease": true
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `keys[].name` | — | Human-readable identifier (shown in TUI/toasts) |
| `keys[].key` | — | Command Code API key (`user_…`) |
| `keys[].account` | — | Associated account name (shown in TUI) |
| `rotation.strategy` | `weighted-random` | Selection algorithm (only `weighted-random` supported) |
| `rotation.cooldownMs` | `60000` | Cooldown duration after 429 (ms) |
| `rotation.cooldownFromRetryAfter` | `true` | Respect `Retry-After` header if present (capped at 300s) |
| `rotation.serverErrorCooldownMs` | `10000` | Cooldown after 5xx server errors (ms) |
| `rotation.scoreDecayPerHour` | `1` | Health score decay for inactivity |
| `rotation.maxSuccessBonus` | `50` | Max bonus from successful requests |
| `rotation.lockTimeoutMs` | `300000` | Phase 3: cross-instance lock TTL (ms). Prevents two instances using the same key simultaneously |
| `rotation.costPerDollar` | `2.0` | Phase 3: cost-aware scoring weight (each $1 est. spent → score penalty) |
| `rotation.scoringWeights` | — | Phase 3: optional `{ "costPerDollar": N }` overriding `costPerDollar` |
| `notifications.*` | `true` | Toggle toast notifications per event type (`onLockRelease` = Phase 3 lock-release toast) |

### `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "commandcode-go-opencode-provider/server",
    "commandcode-key-rotation/server",
    "commandcode-key-rotation/tui"
  ],
  "provider": {
    "commandcode": {
      "npm": "file:./providers/commandcode-retry",
      "env": ["COMMANDCODE_API_KEY"]
    }
  }
}
```

> [!NOTE]
> If `keys.json` is missing or malformed, the plugin falls back to legacy single-key mode (uses `COMMANDCODE_API_KEY` env var or `~/.commandcode/auth.json`). No crash — just a warning toast.

## Architecture

| Layer | Location | Role |
|-------|----------|------|
| **Provider** | `providers/commandcode-retry/src/lock-manager.ts` | Phase 3: per-key `O_EXCL` file locks at `~/.commandcode/.key-locks/` — acquire/release/refresh + 5min auto-release |
| **Provider** | `providers/commandcode-retry/src/key-manager.ts` | KeyManager: health scoring, weighted random selection, cooldown, permanent death, hot-reload, cost tracking, lock-aware selection, cost-aware scoring |
| **Provider** | `providers/commandcode-retry/src/model.ts` | `fetchWithRetry()` (sole key-selection authority) + `streamWithReconnect()` key swap on 429/quota/auth; lock lifecycle (acquire/refresh/release) + transparent usage/cost capture |
| **Provider** | `providers/commandcode-retry/index.ts` | Factory: accepts `apiKeys[]` + Phase 3 options (`modelCosts`, `lockManager`, `costPerDollar`, `instanceId`, `lockTimeoutMs`); backward-compat single `apiKey` |
| **Server Plugin** | `providers/commandcode-key-rotation/server.ts` | Config hook reads `keys.json` + `models.json` (cost map), creates the shared `LockManager` + instance UUID, injects provider options, atomic `key-state.json` with cost + lock data |
| **TUI Plugin** | `providers/commandcode-key-rotation/ui.tsx` | `sidebar_footer` slot (💰 est. cost + 🔒 locks), toast notifications (incl. lock-release), `/key-status`, `/key-dismiss` |
| **TUI Logic** | `providers/commandcode-key-rotation/ui-logic.ts` | Pure functions: formatting (cost/tokens/model breakdown/lock owner), redaction, toast decisions, notification gating |

Key rotation happens **inside the provider** (`fetchWithRetry()`), not in a plugin hook — the only interception point that works transparently for sub-agents.

## Rotation Strategy

**Weighted random** selection prevents thundering herd when multiple instances share keys. Each key maintains a persistent health score:

```
score = 100
      + (successes × 0.1)         // bonus for successful use (capped at +50)
      − (rateLimitHits × 10)      // penalty per 429
      − (authErrors × 1000)       // nuclear penalty for auth failures
      − (agePenalty)              // mild penalty for inactivity (1 point/hour)
      − (estCostUSD × costPerDollar)  // Phase 3: cost-aware penalty (default 2.0 per $1 est. spent)
```

> [!NOTE]
> The cost penalty uses **estimated** cost (tokens × model pricing). It only applies when a `models.json` cost map is configured. With no cost map, scoring is identical to phase 1+2.

| Event | Effect | Cooldown | Notification |
|-------|--------|----------|-------------|
| Successful request | +0.1 bonus (capped at +50) | — | — |
| HTTP 429 (rate limit) | -10 penalty | 60s (configurable) | `Key 'name' rate limited — cooling down 60s` |
| 429 + `Retry-After` header | -10 penalty | Header value (capped 300s) | `Key 'name' rate limited — retry after Xs` |
| 401/403 (auth failure) | -1000 penalty | Permanent (∞) | `Key 'name' auth failed — permanently disabled` |
| 5xx (server error) | -5 penalty | 10s (configurable) | `Key 'name' server error — retrying in 10s` |
| Success after cooldown | Reset | — | `Key 'name' back online` |
| Inactivity | -1 per hour | — | — |

**Selection algorithm (`selectKey()`):**

1. Filter out permanently-dead keys and keys in cooldown
2. Phase 3: prefer keys NOT locked by another instance (lock-aware selection)
3. If none eligible → use least-recently-cooldowned non-dead key (emergency fallback + warning)
4. If all eligible keys are locked by other instances → use the one whose lock expires soonest + warning
5. If single key eligible → return it directly (no random)
6. If all eligible keys have score 0 → uniform random (avoid divide-by-zero)
7. Weighted random: `P(key_i) = score_i / Σscores`
8. If all keys permanently dead → fatal error listing all keys + status

## Edge Cases

| Case | Behavior |
|------|----------|
| All keys in cooldown | Use least-recently-blocked non-dead key, warn user |
| Single key available | Use it always (no random), warn if score low |
| Permanently dead key | Exclude from pool, notify once |
| All permanently dead | Fatal error, show all keys and their status |
| New key (no history) | Score 100, immediately eligible |
| Config hot-reload | `keys.json` changes → next `selectKey()` reads updated config (file mtime check) |
| Mid-stream exhaustion (before content) | Swap key + reconnect |
| Mid-stream exhaustion (after content) | `partialOutputError()` — cannot reconnect (duplicate-content risk) |
| Malformed `keys.json` | Fall back to single-key legacy mode + warning toast |
| `Retry-After` header present | Use header value as cooldown (capped at 300s) |
| Two instances pick the same key (Phase 3) | Per-key `O_EXCL` lock prevents double-use; the second instance selects another unlocked key |
| All keys locked by other instances (Phase 3) | Use the key whose lock expires soonest + warning (no deadlock) |
| Instance crashes mid-stream (Phase 3) | Its lock auto-releases after `lockTimeoutMs` (default 5min); key becomes available again |

## TUI

### Sidebar Footer

Shows the active key with health indicator, key counts, total estimated cost, and active locks:

```
┌─ Key Rotation ─────────────────────────────────┐
│ personal (myaccount) ✅                         │
│ 📊 3 keys | 2 healthy | 💰 $0.42 | 🔒 1 locked  │
└─────────────────────────────────────────────────┘
```

> The `💰` (total est. cost) and `🔒` (lock count) indicators only appear when a `models.json` cost map is configured and locks are active — otherwise the sidebar renders identically to phase 1+2.

### Toast Notifications

```
⚠️ Key Rotated: 'personal' → 'work' (rate limited)
✅ Key Restored: 'personal' back online
🔴 Key Disabled: 'backup' auth failed — permanently removed
⚠️ Configuration Warning: keys.json is malformed — using single-key mode
🔓 Key 'work' lock released
```

### Commands

- **`/key-status`** — detailed table of all keys: name, account, health, score, cooldown, status, **tokens (in/out)**, **est. cost**, **lock owner**. Below the table: a **Summary** (total est. cost, total tokens, top model) and a per-**model breakdown**.
- **`/key-dismiss`** — dismiss a notification type, incl. `lock-release` (persists across sessions via `api.kv`)

## Debugging

To capture real Command Code error response bodies (for refining error patterns):

```bash
# Enable dev-mode error logging
COMMANDCODE_DEV_LOG=1 opencode
```

This logs the full HTTP status + response body (with API keys redacted to last 4 chars: `user_…xxxx`) whenever an error response is received. Use this to:

- Verify whether Command Code sends `Retry-After` headers on 429
- Capture the exact error message for the 5-hour session limit
- Refine `QUOTA_PATTERNS` in `src/model.ts` based on real responses

> [!IMPORTANT]
> Dev-mode logs redact API keys in the **current key** and in the **response body** (via `redactBody()` which replaces `user_XXXX...` patterns). Never share raw dev logs without reviewing them first.

## Troubleshooting

### Keys don't rotate — still using single key

- Verify `~/.commandcode/keys.json` exists and is valid JSON (`python -m json.tool ~/.commandcode/keys.json`)
- Verify `apiKeys[]` is being injected: check the provider config hook ran (look for the sidebar footer showing key count > 1)
- If `keys.json` is malformed, the plugin falls back to single-key mode with a warning toast

### 429 errors still reach OpenCode (rotation not happening)

- The error might not match `QUOTA_PATTERNS`. Enable dev-mode logging (`COMMANDCODE_DEV_LOG=1`) to capture the actual response body and add the pattern to `src/model.ts`
- All keys might be in cooldown simultaneously (all hit the 5-hour limit). The emergency fallback uses the least-recently-cooldowned key, but if all are exhausted, errors will propagate
- `MAX_KEY_SWAPS` (`keys.length + 1`) may have been exceeded — if all keys returned 429 in one request cycle, the fatal error is intentional

### Sub-agent dies on key exhaustion

- This should NOT happen — sub-agents share the provider instance. If it does, verify no separate provider instance is being created. Check that the provider `npm` path resolves to `commandcode-retry` (the modified one), not the upstream `commandcode-go-opencode-provider`
- If the key exhaustion happens mid-stream AFTER content was emitted, `partialOutputError()` is unavoidable — the sub-agent will receive a partial output error. This is a known limitation (see Edge Cases)

### TUI sidebar not showing

- Verify `commandcode-key-rotation/tui` is in the plugin array (not just `/server`)
- Verify `@opentui/solid` is available in the opencode runtime (it's provided by opencode, not installed locally)
- Check that `key-state.json` is being written: `cat ~/.commandcode/key-state.json`

### Toast notifications not appearing

- Check `notifications` config in `keys.json` — all 5 types default to `true` (incl. `onLockRelease`)
- If you dismissed a notification type via `/key-dismiss`, it's persisted in `api.kv`. Run `/key-dismiss` again to toggle it back on

### Lock file errors (Phase 3)

- Lock files live at `~/.commandcode/.key-locks/{sanitized-key-name}/` and auto-release after `rotation.lockTimeoutMs` (default 5min)
- If an instance crashed and left a stale lock, it clears automatically on timeout. To force-clear: `rm -rf ~/.commandcode/.key-locks/`
- "All keys locked by other instances" warnings are expected when running several instances — the fallback picks the lock that expires soonest; it is not a deadlock
- Permissions errors creating `.key-locks/`: ensure `~/.commandcode/` is writable. The directory is auto-created on first lock acquire

### Cost estimation disclaimer (Phase 3)

- The `💰` totals and `/key-status` cost columns are **estimates** computed locally as `tokens × model pricing` from `models.json`. They are **not** billing data and will not match your Command Code invoice exactly
- If `models.json` is missing or a model has no `cost` entry, that model's usage accumulates tokens but contributes $0 to the estimate
- Cost figures persist cumulatively in `~/.commandcode/key-state.json` (never auto-reset). To reset: delete the `totalCostUSD` / `modelUsage` fields from that file

## FAQ

<details>
<summary><b>Do I need to remove my existing single-key setup?</b></summary>

No. The plugin is backward-compatible. If `keys.json` is absent or `apiKeys[]` is not provided, the provider falls back to legacy single-key mode using `COMMANDCODE_API_KEY` or `~/.commandcode/auth.json`. You can keep your existing setup as a fallback.
</details>

<details>
<summary><b>How does this work with sub-agents?</b></summary>

Sub-agents share the parent's `LanguageModelV3` instance (cached by opencode's `getLanguage()` at `provider.ts:1809`). Since key rotation happens inside the provider's `fetchWithRetry()`, sub-agents automatically use the rotated key — they never know a switch happened. No separate mechanism is needed.
</details>

<details>
<summary><b>Can I run multiple OpenCode instances simultaneously?</b></summary>

Yes. Phase 3 adds cross-instance coordination via per-key file locks (`O_EXCL` at `~/.commandcode/.key-locks/`). When an instance selects a key, it acquires that key's lock; a second instance selecting the same key sees the lock and picks another unlocked key instead. If every key is locked, the instance waits on the lock that expires soonest (no deadlock). Locks auto-release after `rotation.lockTimeoutMs` (default 5min) and are refreshed every ~100s while a stream is active, so a long stream won't lose its lock. If an instance crashes, its lock clears on timeout.
</details>

<details>
<summary><b>What happens when two instances pick the same key?</b></summary>

They can't — the `O_EXCL` lock prevents it. The first instance to call `open(O_CREAT|O_EXCL)` on a key's lock file wins; the second gets `EEXIST` and `selectKey()` re-selects an unlocked key. If all keys are locked by other instances, the fallback picks the key whose lock expires soonest and logs a warning. There is no busy-wait: selection is immediate, and a held lock is released when the stream completes, errors, is cancelled, or times out.
</details>

<details>
<summary><b>How accurate is the cost estimation?</b></summary>

It's a **local estimate**, not billing data. The provider captures token usage from each response's `finish` event and multiplies by the per-model pricing in `models.json` (`input × cost.input/1M + output × cost.output/1M + cache_read + cache_write`). It will NOT exactly match your Command Code invoice — pricing changes, rounding, cache-write handling, and any models missing a `cost` entry all introduce drift (missing `cache_write` is treated as $0). Use it to compare keys relatively, not as a billing record. Totals persist cumulatively in `~/.commandcode/key-state.json`.
</details>

<details>
<summary><b>What happens if all my keys hit the 5-hour limit at once?</b></summary>

All keys enter cooldown. The emergency fallback uses the least-recently-cooldowned key (the one closest to recovery). You'll see a warning toast. If all keys are permanently dead (auth errors), a fatal error is thrown listing all keys and their status — you must refresh your keys manually.
</details>

<details>
<summary><b>Does this break the upstream provider?</b></summary>

No. The modified `commandcode-retry` is a local fork. When no `apiKeys[]` are configured, it behaves identically to the original. The upstream `commandcode-go-opencode-provider` is untouched. To fully revert: remove the plugin from `opencode.json` and point the provider `npm` back to the upstream package.
</details>

<details>
<summary><b>How do I add or remove keys without restarting?</b></summary>

Edit `~/.commandcode/keys.json` and save. The KeyManager checks the file's modification time on each `selectKey()` call and hot-reloads if the file changed. No restart needed.
</details>

## Development

```bash
# Clone
git clone https://github.com/danielxxomg/opencode-commandcode-key-rotation.git
cd opencode-commandcode-key-rotation

# Run tests (provider)
cd providers/commandcode-retry
bun test
bun test --coverage

# Run tests (plugin)
cd ../commandcode-key-rotation
bun test
bun test --coverage

# Typecheck both
bunx tsc --noEmit

# Link locally for development
# Point opencode.json provider npm to your local path:
#   "npm": "file:///absolute/path/to/opencode-commandcode-key-rotation/providers/commandcode-retry"
```

### Test Architecture

- **246 tests** (117 provider + 129 plugin), all passing
- **Coverage ≥80%** on all modified files (key-manager 100%, lock-manager 100%, model 95%, server ≥80%, ui-logic ≥80%)
- **Strict TDD** — tests written first (Red-Green-Refactor)
- **Dependency injection** for determinism: `fetchFn`, `sleep`, `now`, `random` injected (Bun has no fake timers)
- **Pure functions** extracted from TUI components for unit testing (Solid.js render is not unit-tested)

## Updating

```bash
# Pull latest
git pull origin main

# Re-run install to copy updated providers
./install.sh

# Restart OpenCode
```

If you installed via `npm` cache and need a fresh install:

```bash
rm -rf ~/.cache/opencode/node_modules/commandcode-key-rotation
opencode  # triggers fresh install
```

## Security

- **API keys are secrets** — stored in `~/.commandcode/keys.json` (outside any git repo). Never commit keys.
- **Test fixtures use fake keys** (`user_test_…`) — no real keys in the repository.
- **Redaction in logs**: API keys are redacted to last 4 chars (`user_…xxxx`) in all logs and TUI display.
- **Dev-mode body redaction**: `redactBody()` replaces `user_XXXX…` patterns in error response bodies before logging (defense in depth — catches keys not in the pool).
- **Authorization header** is built per-request from the currently selected key — never cached globally beyond a single request.
- **`keys.json.example`** uses placeholder keys only (`user_YOUR_KEY`).

## Dependencies

| Package | Purpose |
|---------|---------|
| `commandcode-go-opencode-provider` (fork) | Base provider — modified with KeyManager + key swap |
| `@opencode-ai/plugin` | Plugin API (toast, slots, kv, keymap) — provided by opencode runtime |
| `@opentui/solid` | Solid.js for TUI sidebar component — provided by opencode runtime |
| `ai` SDK >=6.0.0 | `LanguageModelV3` interface (peer dependency) |

## Related

- **Upstream provider**: [brent-weatherall/opencode-commandcode-provider](https://github.com/brent-weatherall/opencode-commandcode-provider) — original
- **Fork**: [danielxxomg/opencode-commandcode-provider](https://github.com/danielxxomg/opencode-commandcode-provider) — retry/backoff patches (PR #10, PR #11)
- **Reference pattern**: [masrurimz/opencode-go-multi-auth](https://github.com/masrurimz/opencode-go-multi-auth) — multi-account rotation for OpenCode Go (different architecture: auth.loader + custom fetch, doesn't work for custom providers)

## License

MIT
