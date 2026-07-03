# Delta for Key Rotation Plugin

## MODIFIED Requirements

### Requirement: Config Reading

The server plugin `config` hook MUST read `~/.commandcode/keys.json` and inject `apiKeys[]` into the commandcode provider config. It MUST also load `models.json` to build a cost map and pass it as `modelCosts` to the provider options. If `keys.json` is missing or malformed, the system MUST fall back to legacy single-key mode and emit a warning (not crash). If `models.json` is missing or malformed, cost tracking MUST be disabled (no crash).

(Previously: No models.json loading or cost map injection)

#### Scenario: Malformed keys.json → fallback + warning

- GIVEN `keys.json` contains invalid JSON
- WHEN the config hook runs
- THEN legacy single-key mode activates, a warning toast fires, no crash occurs

#### Scenario: Plugin hook ordering — apiKeys overrides single apiKey

- GIVEN `commandcode-go-opencode-provider/server` sets `apiKey: "user_legacy"`
- AND our plugin reads `keys.json` with 2 entries
- WHEN config hooks complete
- THEN `apiKeys[]` with 2 entries is set on the provider config (not the single `apiKey`)

#### Scenario: models.json loaded for cost map

- GIVEN `models.json` contains cost data for 33 models
- WHEN the config hook runs
- THEN `modelCosts` map is injected into provider options

#### Scenario: models.json missing → cost tracking disabled

- GIVEN `models.json` is not found
- WHEN the config hook runs
- THEN `modelCosts` is not set, cost tracking disabled, no crash

### Requirement: Server-TUI State

The server plugin MUST write key state to `~/.commandcode/key-state.json` (active key name, health snapshot, last rotation timestamp). The state MUST include per-key cost data (`totalCostUSD`, `totalInputTokens`, `totalOutputTokens`, `modelUsage`) and lock state (active locks). Writes MUST be atomic (write to temp file + rename). Reads MUST tolerate partial/malformed JSON (fall back to last-known state, not crash).

(Previously: No cost data or lock state in key-state.json)

#### Scenario: Atomic key-state.json write

- GIVEN the server plugin is writing key state
- WHEN the process crashes mid-write
- THEN `key-state.json` contains either the old complete state or the new complete state (never partial)

#### Scenario: Cost data persisted in key-state.json

- GIVEN key "personal" has accumulated $0.30 in cost
- WHEN key state is written
- THEN `key-state.json` includes `totalCostUSD: 0.30` for "personal"

#### Scenario: Lock state readable from key-state.json

- GIVEN 2 keys are currently locked
- WHEN TUI reads `key-state.json`
- THEN lock information is available for display

### Requirement: TUI Display

The TUI plugin MUST register a `sidebar_footer` slot showing: active key name + account + health indicator + "N keys | M healthy" + total est. cost (`💰 $X.XX`) + lock count (`🔒 N locked`). Keys MUST NOT be displayed — only name + last 4 chars.

(Previously: Sidebar showed key name, account, health, key count, healthy count — no cost or lock info)

#### Scenario: Sidebar shows key summary with cost and locks

- GIVEN 3 keys: 2 healthy, 1 in cooldown, total cost $0.42, 1 locked
- WHEN sidebar renders
- THEN it shows "personal (acc1) ✅ | 3 keys | 2 healthy | 💰 $0.42 | 🔒 1 locked"

#### Scenario: Sidebar with no cost data

- GIVEN no `modelCosts` configured
- WHEN sidebar renders
- THEN cost and lock indicators are omitted (backward compat)

### Requirement: /key-status Command

The TUI MUST register a `/key-status` command via `api.keymap.registerLayer` showing all keys: name, account, health indicator, score, cooldown remaining, status, tokens (in/out), est. cost, lock owner. Below the table, a summary section MUST show total cost, total tokens, top model, and per-model cost breakdown.

(Previously: /key-status showed name, account, health, score, cooldown, status — no tokens, cost, lock, or model breakdown)

#### Scenario: /key-status displays enhanced columns

- GIVEN 3 keys with mixed health, cost, and lock states
- WHEN user types `/key-status`
- THEN table shows name, account, health, score, cooldown, status, tokens, est. cost, lock owner

#### Scenario: Model breakdown in summary

- GIVEN usage across claude-sonnet-4-6 ($0.30) and gpt-5.4 ($0.12)
- WHEN `/key-status` renders
- THEN summary shows model breakdown with per-model costs

#### Scenario: Lock owner column

- GIVEN key "personal" locked by instance "a852…"
- WHEN `/key-status` renders
- THEN lock owner column shows "a852…" for "personal", "—" for unlocked keys

### Requirement: Toast Notifications

The TUI MUST fire toasts for: `onRotate` (key switched), `onCooldown` (key entered cooldown), `onRecovery` (key back online), `onPermanentDeath` (key auth-failed), `onLockRelease` (lock released). Toasts MUST NOT include full keys (redacted).

(Previously: No `onLockRelease` toast)

#### Scenario: Rotation toast fires

- GIVEN key A rotates to key B
- WHEN the rotation event fires
- THEN a toast shows "personal → work" (names only, no keys)

#### Scenario: Lock release toast fires

- GIVEN key "personal" lock is released
- WHEN the lock release event fires
- THEN a toast shows "personal lock released"
