import { randomUUID } from "node:crypto"
import { resolveApiKey } from "./src/auth.js"
import { CommandCodeLanguageModel } from "./src/model.js"
import { KeyManager } from "./src/key-manager.js"
import type { KeyEntry, KeyManagerDeps, ModelCost, KeyLockCoordinator, KeyHealthSnapshot } from "./src/key-manager.js"
import type { LockLifecycleCoordinator } from "./src/model.js"

/**
 * A lock coordinator that can be shared between the KeyManager (which needs
 * `isLocked`/`getLockOwner`/`getActiveLocks` for lock-aware selection) and the
 * model (which needs `acquireLock`/`releaseLock`/`refreshLock` for the lock
 * lifecycle). The real `LockManager` satisfies both structural interfaces, so a
 * single instance can be passed in and forwarded to both. Tests inject a small
 * mock satisfying the intersection.
 */
export type SharedLockManager = KeyLockCoordinator & LockLifecycleCoordinator

export interface CommandCodeProviderOptions {
  name?: string
  apiKey?: string
  apiKeys?: KeyEntry[]
  baseURL?: string
  headers?: Record<string, string>
  /** Path to keys.json for file-backed hot-reload (REQ-11). */
  keysFile?: string
  /** Read keys from file (DI for testability). */
  readKeysFile?: (filePath: string) => KeyEntry[]
  /** Get file mtime in ms (DI for testability). */
  getMtime?: (filePath: string) => number
  /** Phase 3: per-model pricing ($/1M tokens) for cost estimation + cost-aware scoring. */
  modelCosts?: Record<string, ModelCost>
  /** Phase 3: cross-instance key lock coordinator. Absent → no lock logic (phase 1+2). */
  lockManager?: SharedLockManager
  /** Phase 3: scoring weight for the cost penalty (default 2.0 — each $1 → 2 score points). */
  costPerDollar?: number
  /** Phase 3: alternative to costPerDollar — structured scoring weights. */
  scoringWeights?: { costPerDollar?: number }
  /** Phase 3: unique instance identity for lock ownership. Generated via crypto.randomUUID() if absent. */
  instanceId?: string
  /** Phase 3: lock TTL in ms (default 5min). Refresh interval = TTL/3. */
  lockTimeoutMs?: number
  /**
   * Phase 3 Fix 1/3: runtime state bridge. When set, the KeyManager invokes it
   * with a health snapshot (cost + lock status) after each state change and lock
   * acquire/release. The server plugin supplies this to persist live data to
   * key-state.json for the TUI. Absent → in-memory only (phase 1+2 behavior).
   */
  onStateChange?: (snapshot: KeyHealthSnapshot[]) => void
  /**
   * Phase 3 Fix 2: restart preservation. A health snapshot restored on KeyManager
   * construction so cost totals + model usage survive server restarts. Absent →
   * fresh health.
   */
  initialKeyState?: KeyHealthSnapshot[]
}

/**
 * Factory consumed by opencode's provider loader. Mirrors the original
 * commandcode-go-opencode-provider surface so the existing auth loader
 * (which injects { apiKey }) keeps working unchanged.
 *
 * When apiKeys[] is provided and non-empty, constructs a KeyManager for
 * automatic key rotation. Absent → legacy single-key mode.
 *
 * Phase 3 options (modelCosts, lockManager, costPerDollar, scoringWeights,
 * instanceId, lockTimeoutMs) are all optional. When absent, behavior is
 * identical to phase 1+2 (no cost tracking, no lock coordination, default
 * scoring). The server plugin constructs the LockManager + instanceId and
 * passes them here so the server and provider share one lock instance.
 */
export function createCommandCode(options: CommandCodeProviderOptions = {}) {
  // Multi-key mode: apiKeys[] provided and non-empty
  const hasMultipleKeys = Array.isArray(options.apiKeys) && options.apiKeys.length > 0

  // Legacy single-key mode: resolve apiKey as before
  const apiKey = resolveApiKey({ apiKey: options.apiKey })
  if (!hasMultipleKeys && !apiKey) {
    throw new Error(
      "Command Code API key not found. Set COMMANDCODE_API_KEY env var, create ~/.commandcode/auth.json, or pass apiKey option.",
    )
  }

  // Phase 3: every provider instance has a unique identity. Used for lock
  // ownership when a lockManager is provided. Generated if not supplied so the
  // server plugin (which constructs the real LockManager) can pass its own.
  const instanceId = options.instanceId ?? randomUUID()

  // Construct KeyManager for multi-key rotation. Phase 3 deps are only spread
  // when present so phase 1+2 behavior is unchanged when none are provided.
  const keyManagerDeps: KeyManagerDeps = {}
  if (options.keysFile) keyManagerDeps.keysFile = options.keysFile
  if (options.readKeysFile) keyManagerDeps.readKeysFile = options.readKeysFile
  if (options.getMtime) keyManagerDeps.getMtime = options.getMtime
  if (options.modelCosts) keyManagerDeps.costMap = options.modelCosts
  if (options.lockManager) keyManagerDeps.lockManager = options.lockManager
  if (options.costPerDollar !== undefined) keyManagerDeps.costPerDollar = options.costPerDollar
  if (options.scoringWeights) keyManagerDeps.scoringWeights = options.scoringWeights
  // Fix 1/3: runtime state bridge — forward the onStateChange callback so the
  // KeyManager emits snapshots (cost + lock) the server can persist.
  if (options.onStateChange) keyManagerDeps.onStateChange = options.onStateChange
  // Fix 2: restart preservation — forward the initial snapshot so the KeyManager
  // imports cost totals + model usage on construction.
  if (options.initialKeyState) keyManagerDeps.initialState = options.initialKeyState

  const keyManager = hasMultipleKeys
    ? new KeyManager({ keys: options.apiKeys!, ...keyManagerDeps })
    : undefined

  return {
    /** Phase 3: unique instance identity (for lock ownership + observability). */
    instanceId,
    languageModel(modelId: string): CommandCodeLanguageModel {
      return new CommandCodeLanguageModel(modelId, {
        apiKey: apiKey ?? options.apiKeys![0]!.key, // fallback to first key for legacy compat
        baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
        headers:
          typeof options.headers === "object" && options.headers !== null
            ? (options.headers as Record<string, string>)
            : undefined,
        ...(keyManager ? { keyManager } : {}),
        // Phase 3: forward the shared lock coordinator + TTL to the model so it
        // can acquire/refresh/release the lock across the stream lifecycle.
        ...(options.lockManager ? { lockManager: options.lockManager } : {}),
        ...(options.lockTimeoutMs !== undefined ? { lockTimeoutMs: options.lockTimeoutMs } : {}),
      })
    },
  }
}
