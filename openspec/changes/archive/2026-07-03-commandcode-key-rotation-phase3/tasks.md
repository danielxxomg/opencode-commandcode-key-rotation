# Tasks: Command Code Key Rotation — Phase 3

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~950–1100 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (LockManager) → PR 2 (KeyManager+scoring) → PR 3 (Provider) → PR 4 (Server+TUI) → PR 5 (Config+docs) |
| Delivery strategy | ask-always |
| Chain strategy | stacked-to-main |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | LockManager module + tests | PR 1 | New file, no existing deps. ~180 lines |
| 2 | KeyManager cost/lock/scoring extensions | PR 2 | Depends on PR 1 types. ~200 lines |
| 3 | Provider fetchWithRetry refactor + stream wrapper | PR 3 | Critical path. Depends on PR 1+2. ~250 lines |
| 4 | Server plugin + TUI extensions | PR 4 | Depends on PR 2+3. ~200 lines |
| 5 | Config examples + README updates | PR 5 | Independent. ~40 lines |

---

## Phase 1: LockManager (New Module — TDD)

- [x] 1.1 [RED] Create `commandcode-retry/src/lock-manager.test.ts` — tests: acquire success (O_EXCL), acquire EEXIST fail, release (unlink), expired lock auto-cleanup, tolerant read (missing/malformed file), getLockOwner, getActiveLocks
- [x] 1.2 [GREEN] Create `commandcode-retry/src/lock-manager.ts` — `LockManager` class with `acquireLock`, `releaseLock`, `refreshLock`, `isLocked`, `getLockOwner`, `getActiveLocks`. Per-key files at `~/.commandcode/.key-locks/{sanitized-name}`. O_EXCL atomic create. DI: now, mkdir, open(O_EXCL), unlink, readFile
- [x] 1.3 [RED] Add tests: refresh extends expiry, expired locks auto-removed on read, concurrent acquire race (O_EXCL prevents double-acquire), lock timeout configurable (default 5min)
- [x] 1.4 [GREEN] Implement `refreshLock` (read → update expiresAt → temp+rename) and expired-lock reclaim in `acquireLock`
- [x] 1.5 [REFACTOR] Extract sanitize function, ensure `lockDir` auto-created on first acquire, clean up test helpers

## Phase 2: KeyManager Extensions (TDD)

- [x] 2.1 [RED] Add tests to `commandcode-retry/src/key-manager.test.ts` — `reportUsage(key, modelId, usage)` updates totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, totalCostUSD, modelUsage. Inject fake costMap
- [x] 2.2 [GREEN] Extend `KeyHealth` with cost fields. Implement `reportUsage()` — cost calc: `input×cost.input/1M + output×cost.output/1M + cacheRead×cost.cache_read/1M + cacheWrite×cost.cache_write/1M`
- [x] 2.3 [RED] Add scoring tests — `reportUsage` subtracts `requestCost × costPerDollar` from score, floor at 0. Default costPerDollar 2.0
- [x] 2.4 [GREEN] Add `score -= requestCost × costPerDollar` in `reportUsage`. Accept `scoringWeights` in constructor
- [x] 2.5 [RED] Add lock-aware selectKey tests — prefer unlocked, fallback to earliest-expiry, all-locked behavior. Inject lockManager mock
- [x] 2.6 [GREEN] Extend `selectKey` to check `lockManager.isLocked()` before weighted random. Prefer unlocked. All locked → earliest expiry + warning
- [x] 2.7 [RED] Add `reportSuccess` extended tests — `reportSuccess(key, modelId, usage)` calls reportUsage when usage provided. Backward compat: no usage → no cost tracking
- [x] 2.8 [GREEN] Extend `reportSuccess` signature. When usage provided, delegate to `reportUsage`
- [x] 2.9 [REFACTOR] Ensure backward compat: no costMap → no cost tracking, no lockManager → no lock filtering, no scoringWeights → defaults

## Phase 3: Provider Modification (TDD — Critical Path)

- [x] 3.1 [RED] Add tests to `commandcode-retry/src/model.test.ts` — fetchWithRetry returns `{response, keyUsed, releaseLock}`. fetchOpts accepts `key` param (no double selection)
- [x] 3.2 [GREEN] Refactor `fetchOpts` to accept optional `key` param. Refactor `fetchWithRetry` to return `FetchResult {response, keyUsed, releaseLock}`. Remove double-selection bug (line 579)
- [x] 3.3 [RED] Add lock lifecycle tests — lock acquired on selectKey, released on stream terminal (close/error/cancel), released after doGenerate response consumed. Lock refresh timer at lockTimeoutMs/3
- [x] 3.4 [GREEN] Wire `lockManager.acquireLock` on selectKey success. Wire `releaseLock` in streamWithReconnect close/error/cancel handlers and doGenerate finally block. Add refresh timer with clearInterval on release
- [x] 3.5 [RED] Add usage capture tests — stream finish event → reportSuccess(keyUsed, modelId, usage). Event order preserved. reportUsage error isolated (try/catch, never breaks stream)
- [x] 3.6 [GREEN] Wrap stream in doStream — intercept finish event, call `keyManager.reportUsage(keyUsed, modelId, usage)` in try/catch (per design data flow; reportSuccess 1-arg stays in fetchWithRetry to avoid double success-count), forward all events unchanged. doGenerate captures usage at finish for its return value (wrapper attributes cost)
- [x] 3.7 [RED] Add backward compat tests — no lockManager/costMap → identical to phase 1+2 behavior (no lock, no cost, no wrapper)
- [x] 3.8 [GREEN] Gate all new behavior behind optional deps. No lockManager → no lock. No costMap → no cost tracking. No scoringWeights → defaults
- [x] 3.9 [GREEN] Update `commandcode-retry/index.ts` — accept `modelCosts`, `lockManager`, `costPerDollar`, `instanceId` in options. Pass to KeyManager/Model constructors
- [ ] 3.10 [REFACTOR] Extract usageStreamWrapper as named function, clean up lock lifecycle code, ensure no regressions in existing retry/key-swap logic

## Phase 4: Server Plugin + TUI Extensions

- [x] 4.1 [RED] Add tests to `commandcode-key-rotation/server.test.ts` — server loads models.json cost map, passes to provider. Missing models.json → no cost tracking
- [x] 4.2 [GREEN] `server.ts` reads `models.json`, builds `costMap`, passes via provider options. Creates LockManager instance, generates instance UUID
- [x] 4.3 [RED] Add tests — key-state.json extended with cost + lock data. Atomic write preserved. Tolerant read of new fields
- [x] 4.4 [GREEN] Extend `writeKeyState` to include cost totals + model usage + lock status. Extend `readKeyState` to parse them (tolerant)
- [x] 4.5 [RED] Add tests to `commandcode-key-rotation/ui-logic.test.ts` — `formatCost`, `formatTokens`, `formatModelBreakdown`, `formatLockOwner` pure function tests
- [x] 4.6 [GREEN] Add pure functions to `ui-logic.ts`. formatCost → "$X.XX", formatTokens → "1.2k/0.8k", formatModelBreakdown → multi-line, formatLockOwner → "inst-abc" or "—"
- [x] 4.7 [RED] Add tests — `formatKeyStatus` extended with `💰 $X.XX | 🔒 N locked`
- [x] 4.8 [GREEN] Extend `formatKeyStatus`. Extend `formatKeyStatusTable` with new columns (Tokens, Est. Cost, Lock Owner) + summary section + model breakdown
- [x] 4.9 [GREEN] Wire `ui.tsx` — sidebar shows 💰 + 🔒. /key-status shows new columns. Lock release toast via `decideToast`

## Phase 5: Config + Documentation

- [x] 5.1 Update `keys.json.example` with new fields: `rotation.lockTimeoutMs`, `rotation.costPerDollar`, `rotation.scoringWeights`
- [x] 5.2 [RED] Add backward compat tests — old keys.json (no new fields) → defaults applied, behavior identical
- [x] 5.3 Update README with phase 3 features: lock coordination, cost tracking, cost-aware scoring, `/key-status` enhancements
