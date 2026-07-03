# Command Code Key Rotation Plugin

> OpenCode plugin for automatic API key rotation with session continuity, TUI integration, and multi-instance coordination.

## Problem

Command Code plans have session limits. When a key expires, OpenCode freezes — losing your session context. Sub-agents die mid-task, losing their entire thought chain.

## Solution

Provider-level key rotation that's transparent to both main sessions and sub-agents:

```
Key exhausted → fetchWithRetry() detects 429/quota
  → Suppress error (don't propagate to AI SDK)
  → KeyManager selects next healthy key
  → Re-fetch with new key
  → Toast notifies you
  → Sub-agent continues normally — never knows a switch happened
```

## Architecture

| Layer | Location | Role |
|-------|----------|------|
| **Provider** | `providers/commandcode-retry/` | KeyManager + fetchWithRetry key swap |
| **Server Plugin** | `providers/commandcode-key-rotation/server.ts` | Config hook, event monitoring, toast |
| **TUI Plugin** | `providers/commandcode-key-rotation/ui.tsx` | Sidebar footer, `/key-status`, kv persistence |

Key rotation happens **inside the provider** (`fetchWithRetry()`), not in a plugin hook — the only interception point that works transparently for sub-agents.

## Quick Start

```bash
# 1. Install
./install.sh

# 2. Set up keys
cp providers/commandcode-key-rotation/keys.json.example ~/.commandcode/keys.json
# Edit with your real keys

# 3. Register in ~/.config/opencode/opencode.json
#    plugin: ["commandcode-key-rotation/server"]
#    provider.commandcode.npm: "file:./providers/commandcode-retry"

# 4. Restart OpenCode
```

## Configuration

### `~/.commandcode/keys.json`

```json
{
  "keys": [
    { "name": "personal", "key": "user_****xxxx", "account": "myaccount" },
    { "name": "work",     "key": "user_****yyyy", "account": "work-org" }
  ],
  "rotation": {
    "strategy": "weighted-random",
    "cooldownMs": 60000,
    "cooldownFromRetryAfter": true,
    "serverErrorCooldownMs": 10000
  }
}
```

### `~/.config/opencode/opencode.json`

```json
{
  "plugin": ["commandcode-key-rotation/server"],
  "provider": {
    "commandcode": {
      "npm": "file:./providers/commandcode-retry",
      "env": ["COMMANDCODE_API_KEY"]
    }
  }
}
```

## Rotation Strategy

**Weighted random** selection prevents thundering herd. Each key has a health score:

| Event | Effect |
|-------|--------|
| Successful request | +0.1 bonus (capped at +50) |
| HTTP 429 (rate limit) | -10 penalty, cooldown applied |
| 429 + `Retry-After` | Respects header value |
| 401/403 (auth failure) | Permanent death |
| 5xx (server error) | -5 penalty, 10s cooldown |
| Inactivity | -1 per hour |

## Edge Cases

| Case | Behavior |
|------|----------|
| All keys in cooldown | Use least-recently-blocked, warn user |
| Single key available | Use it always, warn if score low |
| Permanently dead key | Exclude from pool, notify once |
| All permanently dead | Fatal error, show all key statuses |
| New key (no history) | Score 100, immediately eligible |
| Config hot-reload | Key added/removed without restart |

## TUI

- **Sidebar footer**: current key, account, health summary
- **Toast notifications**: key rotation, cooldown, recovery, permanent death
- **`/key-status` command**: detailed view of all keys

## Dependencies

| Package | Purpose |
|---------|---------|
| `commandcode-go-opencode-provider` (fork) | Base provider — modified with KeyManager |
| `@opencode-ai/plugin` | Plugin API (toast, slots, kv, keymap) |
| `@opentui/solid` | Solid.js for TUI sidebar component |

## License

MIT
