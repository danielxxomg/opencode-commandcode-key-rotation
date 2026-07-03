# Key Rotation Plugin Specification

## Purpose

Server + TUI plugin for key rotation. Server reads `keys.json`, injects `apiKeys[]` into provider config, monitors errors, writes state to `key-state.json`. TUI displays active key in sidebar footer, fires toast notifications, exposes `/key-status` command.

## ADDED Requirements

### Requirement: Config Reading

The server plugin `config` hook MUST read `~/.commandcode/keys.json` and inject `apiKeys[]` into the commandcode provider config. If `keys.json` is missing or malformed, the system MUST fall back to legacy single-key mode and emit a warning (not crash). The config hook MUST override any single `apiKey` injection from the existing `commandcode-go-opencode-provider/server` plugin.

#### Scenario: Malformed keys.json → fallback + warning

- GIVEN `keys.json` contains invalid JSON
- WHEN the config hook runs
- THEN legacy single-key mode activates, a warning toast fires, no crash occurs

#### Scenario: Plugin hook ordering — apiKeys overrides single apiKey

- GIVEN `commandcode-go-opencode-provider/server` sets `apiKey: "user_legacy"`
- AND our plugin reads `keys.json` with 2 entries
- WHEN config hooks complete
- THEN `apiKeys[]` with 2 entries is set on the provider config (not the single `apiKey`)

### Requirement: Server-TUI State

The server plugin MUST write key state to `~/.commandcode/key-state.json` (active key name, health snapshot, last rotation timestamp). Writes MUST be atomic (write to temp file + rename). Reads MUST tolerate partial/malformed JSON (fall back to last-known state, not crash).

#### Scenario: Atomic key-state.json write

- GIVEN the server plugin is writing key state
- WHEN the process crashes mid-write
- THEN `key-state.json` contains either the old complete state or the new complete state (never partial)

### Requirement: api.kv vs File State

`api.kv` (TUI) SHOULD be used for TUI-side persistence across sessions. `key-state.json` (file) MUST be used for server-TUI communication (server writes, TUI reads). Both coexist; they are NOT redundant.

#### Scenario: TUI persists dismissed notification via kv

- GIVEN user dismisses a "key rotated" toast
- WHEN the TUI session restarts
- THEN the dismissed state is restored from `api.kv`

### Requirement: TUI Display

The TUI plugin MUST register a `sidebar_footer` slot showing: active key name + account + health indicator + "N keys | M healthy". Keys MUST NOT be displayed — only name + last 4 chars.

#### Scenario: Sidebar shows key summary

- GIVEN 3 keys: 2 healthy, 1 in cooldown
- WHEN sidebar renders
- THEN it shows "personal (acc1) ✅ | 3 keys | 2 healthy"

### Requirement: Toast Notifications

The TUI MUST fire toasts for: `onRotate` (key switched), `onCooldown` (key entered cooldown), `onRecovery` (key back online), `onPermanentDeath` (key auth-failed). Toasts MUST NOT include full keys (redacted).

#### Scenario: Rotation toast fires

- GIVEN key A rotates to key B
- WHEN the rotation event fires
- THEN a toast shows "personal → work" (names only, no keys)

### Requirement: /key-status Command

The TUI MUST register a `/key-status` command via `api.keymap.registerLayer` showing all keys: name, account, health indicator, score, cooldown remaining, status.

#### Scenario: /key-status displays all key details

- GIVEN 3 keys with mixed health states
- WHEN user types `/key-status`
- THEN a table shows name, account, health emoji, score, cooldown remaining, and status for each key

### Requirement: Config Hot-Reload

When `keys.json` changes, the next `selectKey()` call MUST read the updated config. The system MUST NOT require a restart.

#### Scenario: keys.json updated → next selection uses new keys

- GIVEN initial config has keys A, B
- WHEN `keys.json` is updated to add key C
- THEN the next `selectKey()` call includes key C in the eligible pool
