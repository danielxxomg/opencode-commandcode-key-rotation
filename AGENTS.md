# AGENTS.md — Rules for gga (Gentleman Guardian Angel) pre-commit reviewer

> Project: **opencode-commandcode-key-rotation** — Command Code API Key Rotation Plugin for OpenCode.
> This file is the rules source for the `gga` pre-commit AI reviewer (configured in `.gga`).

## Project Overview

A hybrid plugin/provider for OpenCode that rotates between multiple Command Code API keys
across different accounts. Key rotation happens **inside the provider's `fetchWithRetry()`**
for transparency across both main sessions AND sub-agents. A TUI plugin provides notifications
and sidebar display.

- **Stack**: TypeScript (ESM), Bun >=1.0.0, no build step (opencode loads `.ts` directly)
- **Runtime**: Bun 1.3.x
- **Peer dependency**: `ai` SDK >=6.0.0 (LanguageModelV3 interface)
- **Test runner**: `bun test` (built-in, zero-config). **Strict TDD active.** 80% coverage target.

## Code Locations

- **Provider (MODIFY)**: `~/.config/opencode/providers/commandcode-retry/`
  - `index.ts` — provider factory (accept `apiKeys[]`)
  - `src/model.ts` — `CommandCodeLanguageModel`, `fetchWithRetry`, `streamWithReconnect`
  - `src/stream.ts` — SSE handling
  - `src/auth.ts` — `resolveApiKey` (reference, do not break)
  - `src/convert.ts` — conversion (unchanged)
- **Plugin (CREATE)**: `~/.config/opencode/providers/commandcode-key-rotation/`
  - `server.ts` — server plugin (config + event monitoring + toast)
  - `ui.tsx` — TUI sidebar component (Solid.js via `@opentui/solid`)
  - `index.ts` — plugin entry
- **Config**: `~/.commandcode/keys.json` (multi-key), `~/.config/opencode/opencode.json` (registration)

## Coding Conventions (BLOCKER to violate)

1. **TypeScript strict mode** — no `any` without justification, no `// @ts-ignore` without an inline comment explaining why.
2. **ESM imports use `.js` extensions** in relative paths (e.g. `import { KeyManager } from "./key-manager.js"`).
3. **No build step** — opencode loads `.ts` directly via Bun. Do NOT add bundlers/compilers/tsc emit.
4. **Follow existing patterns** in `commandcode-retry`: error classification via pattern arrays (`NON_RETRYABLE_PATTERNS`, `RETRYABLE_PATTERNS`), retry schedule (1s/2.5s/5s ±25% jitter), SSE parsing.
5. **Backward compatibility** — single `apiKey` option MUST still work (fall back to legacy single-key mode when no `apiKeys[]` is provided).

## Testing Rules (CRITICAL — Strict TDD active)

1. **Behavior-first tests** — assert externally visible behavior (inputs → outputs), not implementation internals.
2. **No `test.only`** in committed code.
3. **Mock `fetch` and the `ai` SDK** — never hit the real Command Code API in tests.
4. **Cover edge cases**: all keys in cooldown, single key available, permanently dead key, all keys dead, new key with no history, config hot-reload, mid-stream key exhaustion, `Retry-After` header respect.
5. **Coverage target**: 80% for new/modified code (`bun test --coverage`).
6. **Determinism** — same input → same output; use fake timers for cooldown/backoff tests, never real `setTimeout` delays.
7. **Tests live next to code** — `*.test.ts` alongside the module, runnable via `bun test`.

## Security Rules (BLOCKER)

1. **API keys are secrets** — NEVER log full keys. Redact to last 4 chars: `user_…xxxx`.
2. **Never commit keys** — `keys.json` and `auth.json` live in `~/.commandcode/` (outside the repo). Any test fixtures MUST use fake keys like `user_test_…`.
3. **No hardcoded keys** in source or examples — use placeholders like `user_YOUR_KEY`.
4. **Authorization header** must be built per-request from the currently selected key, never cached globally beyond a single request.

## Architecture Rules (reviewer MUST verify)

1. **Key rotation MUST happen in `fetchWithRetry()`** (provider level), NOT in a plugin hook. The `chat.headers` hook cannot see responses and cannot help sub-agents. This is non-negotiable.
2. **429/quota errors must NOT consume retry attempts** — they trigger key swaps. Only transient errors (5xx, network) consume retry attempts.
3. **Sub-agent transparency** — sub-agents inherit the provider instance, so provider-level rotation automatically benefits them. Verify no separate provider instance is created per sub-agent.
4. **KeyManager** must track per-key health: score, cooldown expiry, success/failure counts, permanent death (auth errors).
5. **Weighted random selection** (not always-best) to prevent thundering herd when multiple instances share keys.
6. **Mid-stream swap guard** — if content was already emitted (`emittedContent = true`), a mid-stream key failure cannot silently reconnect (duplicate-content risk); surface a clear error instead.

## Review Checklist (gga must check before approving)

- [ ] No secrets/keys in code, logs, or committed files
- [ ] TypeScript strict, no `any`/`@ts-ignore` without justification
- [ ] ESM imports use `.js` extensions in relative paths
- [ ] Behavior-first tests cover new/changed logic
- [ ] Edge cases covered (cooldown, death, single-key, all-dead, Retry-After, mid-stream)
- [ ] Backward compat: single `apiKey` still works
- [ ] Key rotation is provider-level, not plugin-hook-level
- [ ] 429/quota triggers key swap, not retry consumption
- [ ] Keys redacted in logs/toasts (last 4 chars only)
- [ ] No `test.only` in committed tests
- [ ] No build step introduced (no bundler/compiler configs)
