# Proposal: Command Code API Key Rotation

## Intent

Command Code's 5-hour session limit kills the active key mid-conversation. Today, that error is classified NON_RETRYABLE → the provider throws immediately. Main sessions stall; sub-agents (which share the provider instance via `getLanguage()` cache at `provider.ts:1809`) die silently. The user must manually swap keys in `auth.json` and restart. With 2-3 accounts available, automatic rotation eliminates this friction entirely.

## Scope

### In Scope
- `KeyManager` module: holds key pool with health metadata (score, cooldown, permanent-death), weighted random selection, per-key cooldown tracking
- Modified `fetchWithRetry()`: swap key on 429/quota-exhaustion (don't consume retry attempts); defensive pattern matching (`QUOTA_PATTERNS` array)
- Modified `streamWithReconnect()`: swap key on mid-stream 429/quota; `emittedContent` guard unchanged (partialOutputError if content already emitted)
- Factory accepts `apiKeys[]` option; falls back to single `apiKey` (legacy mode, zero behavior change)
- Server plugin: reads `~/.commandcode/keys.json` (format: `{ name, key, account }[]` + rotation/notifications config), monitors `session.error` events, writes state to `~/.commandcode/key-state.json`
- TUI plugin: `sidebar_footer` slot (active key name + health), `/key-status` command, toast notifications (onRotate, onCooldown, onRecovery, onPermanentDeath)
- `api.kv` persistence for key state across sessions
- Dev-mode error body logging (status + redacted body) to capture real Command Code error formats at runtime

### Out of Scope
- Multi-instance lock-file coordination (phase 3)
- Intelligent health scoring beyond basic cooldown + permanent death (phase 3)
- Pre-emptive rotation based on usage/credits API tracking (phase 3)
- Usage/credits API integration (phase 3)

## Capabilities

### New Capabilities
- `key-rotation`: Core key rotation logic — KeyManager module, key swap in fetchWithRetry/streamWithReconnect, factory apiKeys[] option, backward-compatible single-key fallback
- `key-rotation-plugin`: Server + TUI plugin — config reading from keys.json, event monitoring, toast notifications, sidebar display, /key-status command, kv persistence

### Modified Capabilities
None — no existing specs in `openspec/specs/`.

## Approach

**Hybrid architecture** — two layers, verified by exploration:

1. **Provider modification** (critical path): Inject `KeyManager` into `CommandCodeLanguageModel`. `fetchWithRetry()` calls `keyManager.selectKey()` before each attempt; on quota/429 response, calls `keyManager.reportFailure(key)` + `keyManager.selectKey()` for next attempt (retry budget untouched). `streamWithReconnect()` does the same for mid-stream failures. Sub-agents automatically benefit — they share the cached provider instance.

2. **Plugin** (config + TUI): Server plugin reads `keys.json`, passes `apiKeys[]` to provider config. TUI plugin registers `sidebar_footer` (active key), toast events, `/key-status` command. Server↔TUI state via file-based `key-state.json` (proven pattern from `opencode-go-multi-auth`).

**Error handling** — defensive: extend with `QUOTA_PATTERNS` = `["usage limit", "usage_limit", "exceeded your", "quota exceeded", "insufficient credit", "insufficient_credit"]`. Respect `Retry-After` header if present (use as cooldown ms). Dev-mode logs full error body (key redacted) so real patterns can be refined at runtime.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `~/.config/opencode/providers/commandcode-retry/index.ts` | Modified | Factory accepts `apiKeys[]`, passes to model |
| `~/.config/opencode/providers/commandcode-retry/src/model.ts` | Modified | fetchWithRetry + streamWithReconnect key swap integration |
| `~/.config/opencode/providers/commandcode-retry/src/auth.ts` | Modified | Multi-key resolution (don't break single-key) |
| `~/.config/opencode/providers/commandcode-retry/src/key-manager.ts` | Created | KeyManager module + tests |
| `~/.config/opencode/providers/commandcode-key-rotation/` | Created | New plugin package (server.ts, ui.tsx, index.ts) |
| `~/.commandcode/keys.json` | Created | Key config file (example with fake keys) |
| `~/.config/opencode/opencode.json` | Modified | Add plugin to list |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Mid-stream exhaustion after content emitted | Medium | `partialOutputError` — unavoidable; proactive health tracking reduces frequency |
| Multi-instance selects same key (no coordination) | Medium | Weighted random partially mitigates thundering herd; lock-file coordination deferred to phase 3 |
| Error pattern mismatch (Command Code formats unknown) | Medium | Defensive multi-pattern matching + dev-mode body logging to capture real formats |
| All keys simultaneously exhausted (5h limit) | Low | Use least-recently-blocked key with warning toast; user must wait or add keys |

## Rollback Plan

Backward compatibility IS the rollback. When no `apiKeys[]` is provided, the factory falls back to legacy single-key mode — identical behavior to today's `commandcode-retry`. To fully revert: (1) remove `commandcode-key-rotation/server` from `opencode.json` plugins, (2) restore original `commandcode-retry` from the upstream fork (`danielxxomg/opencode-commandcode-provider`). The modified provider is tracked in the project repo with a copy/install script.

## Dependencies

- `commandcode-retry` provider (existing, at `~/.config/opencode/providers/commandcode-retry/`)
- `ai` SDK >=6.0.0 (peer dep, already present)
- Bun >=1.0.0 (test runner + runtime)

## Success Criteria

- [ ] Single `apiKey` config works identically to today (backward compat)
- [ ] `apiKeys[]` with 2+ keys: 429/quota error triggers key swap, not throw
- [ ] Sub-agents inherit rotated keys automatically (shared provider instance)
- [ ] TUI sidebar shows active key name; toast fires on rotation/cooldown/death
- [ ] `bun test` passes with 80%+ coverage on new/modified code
- [ ] Dev-mode error logging captures real Command Code error response bodies
