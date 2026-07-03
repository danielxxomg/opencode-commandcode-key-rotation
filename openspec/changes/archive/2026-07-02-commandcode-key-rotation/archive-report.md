# Archive Report: commandcode-key-rotation

**Status**: ARCHIVED  
**Date**: 2026-07-02  
**Archived to**: `openspec/changes/archive/2026-07-02-commandcode-key-rotation/`

## Change Summary

Implemented hybrid API key rotation for OpenCode's Command Code provider. The system automatically rotates between multiple API keys when hitting rate limits (429), quota exhaustion, or auth errors — eliminating manual key swapping when the 5-hour session limit kills the active key.

**Architecture**: Two-layer hybrid:
1. **Provider-level** (critical path): `KeyManager` module injected into `CommandCodeLanguageModel` — `fetchWithRetry()` and `streamWithReconnect()` swap keys on 429/quota/auth errors. Sub-agents inherit rotation automatically via the shared provider instance cache (`provider.ts:1809`).
2. **Plugin** (config + TUI): Server plugin reads `~/.commandcode/keys.json`, injects `apiKeys[]` into provider config, monitors `session.error` events, writes state to `key-state.json`. TUI plugin renders sidebar footer (active key), toast notifications, and `/key-status` command.

## Final Test Results

| Area | Tests | Pass | Fail | Coverage |
|------|-------|------|------|----------|
| Provider (commandcode-retry) | 35 | 35 | 0 | key-manager.ts 100%, model.ts 94.36% |
| Plugin (commandcode-key-rotation) | 80 | 80 | 0 | server.ts 96.34%, ui-logic.ts 99.31% |
| **Total** | **115** | **115** | **0** | **≥80% all targets** |

Typecheck: `bunx tsc --noEmit` clean on both provider and plugin.

## Requirements & Scenarios

| Metric | Value |
|--------|-------|
| Requirements reviewed | 17 / 17 |
| Requirements verified | 17 / 17 |
| Scenarios reviewed | 22 / 22 |
| Scenarios verified | 22 / 22 |
| Critical issues | 0 |
| Warnings | 0 |

## Artifacts Produced

| Artifact | Path | Engram |
|----------|------|--------|
| Exploration | `openspec/changes/archive/2026-07-02-commandcode-key-rotation/exploration.md` | — |
| Proposal | `openspec/changes/archive/2026-07-02-commandcode-key-rotation/proposal.md` | #464 |
| Design | `openspec/changes/archive/2026-07-02-commandcode-key-rotation/design.md` | #465 |
| Spec: key-rotation | `openspec/specs/key-rotation/spec.md` | #468 |
| Spec: key-rotation-plugin | `openspec/specs/key-rotation-plugin/spec.md` | #468 |
| Tasks | `openspec/changes/archive/2026-07-02-commandcode-key-rotation/tasks.md` | #470 |
| Verify | `openspec/changes/archive/2026-07-02-commandcode-key-rotation/verify.md` | #490 |
| Apply-progress | — | #471 |
| Archive report | This file | `sdd/commandcode-key-rotation/archive-report` |

## Files Modified/Created

### Provider (commandcode-retry) — Modified
- `src/key-manager.ts` — NEW — KeyManager class with health tracking, weighted random selection, cooldown, permanent death
- `src/key-manager.test.ts` — NEW — 100% coverage TDD tests
- `src/model.ts` — Modified — fetchWithRetry key swap loop, streamWithReconnect mid-stream swap, QUOTA_PATTERNS extraction, DI for fetchFn/sleep/now/random
- `src/model.test.ts` — NEW — key swap path tests
- `index.ts` — Modified — factory accepts `apiKeys[]`, constructs KeyManager
- `package.json` — Modified — added test script
- `tsconfig.json` — Modified/created

### Plugin (commandcode-key-rotation) — Created
- `server.ts` — Config hook reads keys.json, event hook monitors errors, atomic key-state.json write
- `server.test.ts` — TDD tests for config/event hooks
- `ui-logic.ts` — Pure logic: formatKeyStatus, decideToast, decideConfigWarning, isNotificationDismissed, dismissNotification
- `ui-logic.test.ts` — TDD tests for all UI logic
- `ui.tsx` — TUI: sidebar_footer slot, toast notifications, /key-status command, /key-dismiss command
- `index.ts` — Plugin entry point
- `package.json` — Package metadata
- `tsconfig.json` — TypeScript config

### Config
- `~/.commandcode/keys.json.example` — Example key config with fake keys
- `~/.config/opencode/opencode.json` — Plugin registration

## Verified Outcomes

- [x] Single `apiKey` config works identically to today (backward compat — REQ-1, S1, S11)
- [x] `apiKeys[]` with 2+ keys: 429/quota triggers key swap, not throw (REQ-2, S3)
- [x] Sub-agents inherit rotated keys automatically (shared provider instance — REQ-10)
- [x] TUI sidebar shows active key name; toast fires on rotation/cooldown/death (Plugin-REQ-4, Plugin-REQ-5)
- [x] `bun test` passes with 80%+ coverage on all changed files
- [x] Dev-mode error logging captures real Command Code error response bodies (REQ-9)
- [x] Config hot-reload: keys.json changes take effect on next selectKey() (REQ-11)
- [x] Auth errors (401/403) mark key permanently dead, swap to next (REQ-6)
- [x] 401 with quota wording → auth wins over quota (REQ-7)
- [x] Mid-stream 429 before content → swap + reconnect; after content → partialOutputError (REQ-8)

## Backward Compatibility Confirmation

The provider still loads with single-key config (no keys.json, no apiKeys[]). The factory falls back to legacy single-key mode when `apiKeys[]` is absent — identical behavior to the original `commandcode-retry` provider. This was verified in:
- Provider test: `src/model.test.ts > createCommandCode factory > single apiKey → legacy mode, no key rotation, no KeyManager`
- Scenario S11: "Single key → no rotation benefit, identical to today"
- **Backward compat IS the rollback**: remove the plugin from opencode.json, restore original provider from upstream fork.

## Deferred to Phase 3

| Item | Reason |
|------|--------|
| Multi-instance lock-file coordination | MVP assumes single instance; weighted random partially mitigates thundering herd |
| Intelligent health scoring beyond basic cooldown + permanent death | Current scoring is sufficient for MVP |
| Pre-emptive rotation based on usage/credits API tracking | Requires Command Code usage API access |
| Usage/credits API integration | External dependency not available |

## Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Mid-stream post-content key exhaustion → `partialOutputError()` | Unavoidable; content already emitted cannot be re-sent safely | Proactive health tracking reduces frequency |
| Multi-instance no coordination | Two instances may select the same key simultaneously | Weighted random partially mitigates; phase 3 lock-file deferred |
| Bun `ReadableStream` limitation in tests | C7 — partialOutputError test uses documented workaround | Test verifies behavior through HTTP-level mock, not stream-level |
| `Retry-After` header from Command Code unverified | May or may not be sent on 429 | Code respects it if present, uses 60s default otherwise |

## SDD Cycle Complete

The change has been fully planned (proposal, design, specs, tasks), implemented (TDD across 6 layers, 115 tests), verified (0 critical, 17/17 requirements, 22/22 scenarios), and archived. All delta specs synced to canonical `openspec/specs/`. Ready for the next change.
