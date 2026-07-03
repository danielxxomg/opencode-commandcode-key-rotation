# Tasks: Command Code API Key Rotation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~605 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1: KeyManager + Provider mod (L0-L2, ~355 lines) → PR2: Server plugin (L3, ~120 lines) → PR3: TUI plugin + Config (L4-L5, ~130 lines) |
| Delivery strategy | ask-always |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | KeyManager module + Provider integration (critical path) | PR 1 | Tests + impl. Sub-agent transparency depends on this. |
| 2 | Server plugin: config + event hooks + state file | PR 2 | Depends on PR 1 (uses KeyManager types). |
| 3 | TUI plugin + config files + registration | PR 3 | Depends on PR 2 (reads key-state.json). |

---

## Layer 0: Test Setup

- [x] L0-T1 [config] Add `"scripts": {"test": "bun test"}` to `~/.config/opencode/providers/commandcode-retry/package.json`. Verify `bun test` runs (no tests yet = 0 pass). Files: `package.json`. Acceptance: `bun test` exits 0.

## Layer 1: KeyManager (NEW, TDD-first)

- [x] L1-T1 [test] Write failing tests in `src/key-manager.test.ts` for `KeyManager` construction + `selectKey()` weighted random (REQ-2: scenarios multi-key init, 429→swap). Covers: REQ-1, REQ-2, S2, S3, S4, S11. Depends: L0-T1.
- [x] L1-T2 [impl] Implement `src/key-manager.ts`: `KeyEntry`, `KeyHealth`, `KeyManager` class with `selectKey()` (weighted random), `reportSuccess()`, `reportRateLimit()`, `reportAuthError()`. Inject `now`, `random`. Covers: REQ-1, REQ-2, REQ-3, REQ-5. Depends: L1-T1. Acceptance: `bun test key-manager.test.ts` green.
- [x] L1-T3 [test] Write failing tests for zero-score uniform random (REQ-3 S5), all-dead fatal (REQ-2 S4), MAX_KEY_SWAPS exceeded (REQ-5 S7). Covers: REQ-3, REQ-5, S4, S5, S7. Depends: L1-T2.
- [x] L1-T4 [impl] Implement zero-score fallback, all-dead detection, MAX_KEY_SWAPS guard. Covers: REQ-3, REQ-5. Depends: L1-T3. Acceptance: all KeyManager tests green.
- [x] L1-T5 [test] Write failing tests for Retry-After cooldown (REQ-5 S8), auth permanent death (REQ-6 S9), quota-vs-auth precedence (REQ-7 S10), config hot-reload (REQ-11 S17). Covers: REQ-5-8, REQ-11, S7-S10, S17. Depends: L1-T4.
- [x] L1-T6 [impl] Implement cooldown with Retry-After (capped 300s), permanent death, quota-vs-auth precedence (401/403 → auth wins), hot-reload `keys.json` re-read. Covers: REQ-5-8, REQ-11. Depends: L1-T5. Acceptance: `bun test key-manager.test.ts` all green, 100% coverage.

## Layer 2: Provider Modification (CRITICAL PATH, TDD-first)

- [x] L2-T1 [test] Write failing tests in `src/model.test.ts` for factory backward compat: single `apiKey` → no KeyManager, identical behavior (REQ-1 S1). Covers: REQ-1, S1, S11. Depends: L1-T6.
- [x] L2-T2 [impl] Modify `index.ts` factory (lines 4-33): accept `apiKeys?: KeyEntry[]`, construct `KeyManager` when present, pass to model. Backward compat: absent `apiKeys[]` → legacy mode. Covers: REQ-1, S1, S11. Depends: L2-T1. Acceptance: `bun test` green, single apiKey unchanged.
- [x] L2-T3 [test] Write failing tests for `fetchWithRetry` key swap: 429→swap (not retry), quota→swap, auth→death+swap, 5xx→retry (REQ-4-6). Inject `fetchFn` (sequenced responses), `sleep: noop`. Covers: REQ-4, REQ-5, REQ-6, S3, S7-S9. Depends: L2-T2.
- [x] L2-T4 [impl] Modify `src/model.ts`: extend `CommandCodeModelOptions` with `keyManager?`, DI fns; extract `QUOTA_PATTERNS`; add `isQuotaError()`; modify `fetchWithRetry()` key swap loop; `buildHeaders(key)` accepts key param. Covers: REQ-4, REQ-5, REQ-6, REQ-7. Depends: L2-T3. Acceptance: `bun test model.test.ts` green.
- [x] L2-T5 [test] Write failing tests for `streamWithReconnect` mid-stream swap: before-content→swap (REQ-8 S13), after-content→partialOutputError (REQ-8 S14). Inject `fetchFn`, mock ReadableStream. Covers: REQ-8, S13, S14. Depends: L2-T4.
- [x] L2-T6 [impl] Modify `streamWithReconnect` (lines 303-415): call `selectKey()` on reconnect, guard with `emittedContent`. Covers: REQ-8. Depends: L2-T5. Acceptance: `bun test` all green.
- [x] L2-T7 [test] Write failing test for dev-mode error body logging (REQ-9 S15): status+body logged, key redacted to last 4. Covers: REQ-9, S15. Depends: L2-T6.
- [x] L2-T8 [impl] Add dev-mode logging gated by flag in `fetchWithRetry`/`streamWithReconnect`. Keys redacted (`user_…xxxx`). Covers: REQ-9. Depends: L2-T7. Acceptance: `bun test` all green, coverage ≥80%.

## Layer 3: Server Plugin (TDD-first where testable)

- [x] L3-T1 [test] Write failing tests for server `config` hook: reads `keys.json` → injects `apiKeys[]`; malformed → fallback + warning (plugin-REQ-1 S1-S2). Covers: plugin-REQ-1, S1, S2. Depends: L2-T8.
- [x] L3-T2 [impl] Create `~/.config/opencode/providers/commandcode-key-rotation/server.ts`: config hook reads `~/.commandcode/keys.json`, injects `apiKeys[]` into provider config. Error handling: malformed → fallback + warning toast. Covers: plugin-REQ-1, plugin-REQ-2. Depends: L3-T1.
- [x] L3-T3 [test] Write failing tests for atomic `key-state.json` write (plugin-REQ-2 S3) and event monitoring. Covers: plugin-REQ-2, S3. Depends: L3-T2.
- [x] L3-T4 [impl] Implement atomic state write (temp+rename), event hook monitors `session.error`, writes key health to `key-state.json`. Covers: plugin-REQ-2, plugin-REQ-3. Depends: L3-T3. Acceptance: `bun test` for server module green.
- [x] L3-T5 [impl] Create `~/.config/opencode/providers/commandcode-key-rotation/index.ts` plugin entry + `package.json`. Depends: L3-T4.

## Layer 4: TUI Plugin

- [x] L4-T1 [impl] Create `~/.config/opencode/providers/commandcode-key-rotation/ui.tsx`: `sidebar_footer` slot (active key name+account+health, "N keys|M healthy"). Keys redacted — name+last4 only. Covers: plugin-REQ-4, S5. Depends: L3-T5.
- [x] L4-T2 [impl] Add toast notifications: onRotate, onCooldown, onRecovery, onPermanentDeath. Names only, no keys. Covers: plugin-REQ-5, S6. Depends: L4-T1.
- [x] L4-T3 [impl] Register `/key-status` command via `api.keymap.registerLayer`: table with name, account, health emoji, score, cooldown, status. Covers: plugin-REQ-6, S7. Depends: L4-T2.

## Layer 5: Config + Integration

- [x] L5-T1 [config] Create `~/.commandcode/keys.json` example with FAKE keys (`user_test_aaaa`, `user_test_bbbb`). Files: `~/.commandcode/keys.json.example`. Depends: L4-T3.
- [x] L5-T2 [config] Modify `~/.config/opencode/opencode.json`: add `commandcode-key-rotation` plugin after `commandcode-go-opencode-provider`. Depends: L5-T1.
- [x] L5-T3 [docs] Verify end-to-end: single `apiKey` backward compat identical to today. Run full `bun test`. Covers: REQ-1, S1, S11, all success criteria. Depends: L5-T2.
