# Proposal: Command Code Key Rotation — Phase 3

## Intent

Phase 1+2 delivered provider-level rotation + TUI visibility. Phase 3 adds three capabilities that make multi-instance usage safe, cost-aware, and smarter: multi-instance coordination via lock files, per-key cost estimation, and cost-aware health scoring.

## Scope

### In Scope
- **Multi-instance lock file** — `~/.commandcode/.key-lock` (JSON array), 5min timeout, prefer unlocked keys, lock count in sidebar + `/key-status` lock owner column
- **Cost tracking (local estimation)** — capture tokens per response via stream wrapper, calculate cost via `models.json` prices, accumulate per-key totals + per-model breakdown, persist in `key-state.json`, label as "est. cost"
- **Intelligent scoring** — cost-spent penalty in health score (`costPerDollar` weight, default 2.0), configurable in `keys.json`

### Out of Scope
- Real Command Code billing API integration (doesn't exist)
- Pre-emptive rotation based on actual remaining quota (no usage API)
- Per-session cost tracking (opencode already does this natively)

## Capabilities

### New Capabilities
- `key-rotation-lock`: Multi-instance coordination via lock file — acquire/release/timeout, prefer unlocked keys, display in TUI
- `key-rotation-cost`: Per-key cost estimation from token usage × models.json pricing, model breakdown, TUI display
- `key-rotation-scoring`: Cost-aware health scoring with configurable weights

### Modified Capabilities
- `key-rotation`: selectKey() must respect lock state; reportUsage() added; scoring formula extended
- `key-rotation-plugin`: server.ts loads models.json cost map, reads lock file for state, extends key-state.json with cost + lock data; TUI shows new columns

## Approach

1. **Cost tracking first** — `calculateCost()` utility + `KeyManager.reportUsage()` + stream wrapper in `doStream()` to intercept `finish` events. `models.json` cost map injected via options (DI-friendly).
2. **Scoring second** — extend existing formula with `costPenalty = totalCostUSD * costPerDollar`. Configurable via `keys.json` `rotation.scoringWeights`.
3. **Lock file last** — `LockManager` class (NEW file) handles read/write/acquire/release with atomic writes. `KeyManager.selectKey()` filters locked keys. Plugin reads lock file for display.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `commandcode-retry/src/key-manager.ts` | Modified | `reportUsage()`, lock-aware `selectKey()`, enhanced scoring |
| `commandcode-retry/src/model.ts` | Modified | Stream wrapper intercepts `finish` for usage capture |
| `commandcode-retry/index.ts` | Modified | Load models.json, pass cost map to options |
| `commandcode-key-rotation/server.ts` | Modified | Lock file reading, cost data in state, scoring config |
| `commandcode-key-rotation/ui-logic.ts` | Modified | New formatters: cost, lock count, model breakdown |
| `commandcode-key-rotation/ui.tsx` | Modified | Enhanced sidebar + `/key-status` table |
| `commandcode-retry/src/lock-manager.ts` | **Created** | Lock file read/write/acquire/release |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cost estimation misleads users | Medium | Label "est. cost" everywhere; document it's tokens × models.json |
| Lock file race condition | Low | Atomic writes + 5min timeout auto-releases |
| Stream wrapper breaks existing behavior | Medium | TDD: test wrapper preserves all stream parts |

## Rollback Plan

All features gated by config — without lock config, no lock file; without `modelCosts`, no cost display; scoring weights default to phase 1+2 values. Revert by removing new `keys.json` fields.

## Dependencies

- `models.json` cost data verified (input/output/cache_read/cache_write in $/M tokens)
- `crypto.randomUUID()` available in Bun

## Success Criteria

- [ ] Lock file prevents two instances from using the same key simultaneously (90%+ of the time)
- [ ] `/key-status` shows tokens, est. cost, lock owner per key
- [ ] Sidebar shows `💰 $X.XX` and `🔒 N locked`
- [ ] Cost penalty shifts selection toward lower-spend keys
- [ ] All phase 1+2 tests still pass; new code ≥80% coverage
