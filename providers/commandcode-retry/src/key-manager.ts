import type { LanguageModelV3Usage } from "@ai-sdk/provider"

/**
 * KeyManager — manages a pool of API keys with health tracking,
 * weighted random selection, cooldowns, and permanent death.
 */

export interface KeyEntry {
  name: string
  key: string
  account?: string
}

/**
 * Per-model pricing in USD per 1M tokens. `cache_write` is optional
 * (some models do not charge separately for cache writes → treated as 0).
 */
export interface ModelCost {
  input: number
  output: number
  cache_read: number
  cache_write?: number
}

/**
 * Minimal lock-coordination surface that KeyManager depends on.
 * The real `LockManager` (lock-manager.ts) satisfies this structurally,
 * so it can be passed in directly; tests inject a small mock. depending
 * on a narrow interface (instead of the whole LockManager class) keeps
 * KeyManager decoupled and easy to test in isolation (Interface Segregation).
 */
export interface KeyLockCoordinator {
  isLocked(keyName: string): boolean
  getLockOwner(keyName: string): string | null
  getActiveLocks(): Array<{ keyName: string; expiresAt: number }>
}

export interface KeyHealth {
  score: number
  cooldownExpiry: number
  successCount: number
  failureCount: number
  rateLimitHits: number
  authErrors: number
  permanentlyDead: boolean
  lastUsedAt: number
  lastCooldownAt: number
  // Phase 3: cost / usage tracking (all default to 0 / empty)
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUSD: number
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
}

/**
 * A complete health snapshot for one key — the unit the provider exports to the
 * server plugin (via `onStateChange`) and re-imports on restart (via
 * `importState`). Carries the full `KeyHealth` plus live lock status read from
 * the `KeyLockCoordinator`. The `key` field is the secret key string: it is
 * safe IN-MEMORY (the callback passes it to the server, which never persists
 * `key` to key-state.json — only `name` + cost/lock fields are written).
 */
export interface KeyHealthSnapshot {
  name: string
  key: string
  health: KeyHealth
  locked: boolean
  lockOwner: string | null
}

export interface KeyManagerDeps {
  now?: () => number
  random?: () => number
  keysFile?: string
  readKeysFile?: (filePath: string) => KeyEntry[]
  getMtime?: (filePath: string) => number
  // Phase 3 extensions — all optional so phase 1+2 behavior is unchanged
  // when none are provided (no costMap → no cost tracking, no lockManager →
  // no lock filtering, no scoringWeights → default costPerDollar).
  costMap?: Record<string, ModelCost>
  lockManager?: KeyLockCoordinator
  costPerDollar?: number
  scoringWeights?: { costPerDollar?: number }
  /**
   * Phase 3 Fix 1/3: runtime state bridge. When set, the KeyManager invokes it
   * with `getHealthSnapshot()` after every state-mutating report and on
   * `notifyStateChange()`. The server plugin supplies this callback to persist
   * cost + lock status to key-state.json so the TUI sees live data. Absent →
   * no emission (in-memory only, phase 1+2 behavior).
   */
  onStateChange?: (snapshot: KeyHealthSnapshot[]) => void
  /**
   * Phase 3 Fix 2: restart preservation. A snapshot restored on construction so
   * cost totals + model usage survive server restarts. Absent → fresh health.
   */
  initialState?: KeyHealthSnapshot[]
}

interface InternalKeyState {
  entry: KeyEntry
  health: KeyHealth
}

const DEFAULT_COOLDOWN_MS = 60_000
const QUOTA_COOLDOWN_MS = 300_000
const SERVER_ERROR_COOLDOWN_MS = 10_000
const MAX_RETRY_AFTER_MS = 300_000
const INITIAL_SCORE = 100
const MAX_SCORE = 150
const MIN_SCORE = 0
const DEFAULT_COST_PER_DOLLAR = 2.0

export class KeyManager {
  private keys: InternalKeyState[]
  private now: () => number
  private random: () => number
  private keysFile?: string
  private readKeysFile?: (filePath: string) => KeyEntry[]
  private getMtime?: (filePath: string) => number
  private lastMtime: number = 0
  private costMap?: Record<string, ModelCost>
  private lockManager?: KeyLockCoordinator
  private costPerDollar: number
  private onStateChange?: (snapshot: KeyHealthSnapshot[]) => void

  constructor(deps: KeyManagerDeps & { keys: KeyEntry[] }) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? Math.random
    this.keysFile = deps.keysFile
    this.readKeysFile = deps.readKeysFile
    this.getMtime = deps.getMtime
    this.costMap = deps.costMap
    this.lockManager = deps.lockManager
    // scoringWeights.costPerDollar wins over the top-level costPerDollar option;
    // both fall back to the 2.0 default (each $1 spent → 2 score points).
    this.costPerDollar =
      deps.scoringWeights?.costPerDollar ?? deps.costPerDollar ?? DEFAULT_COST_PER_DOLLAR
    this.onStateChange = deps.onStateChange
    this.keys = deps.keys.map((entry) => ({
      entry,
      health: this.freshHealth(),
    }))
    // Fix 2: restore cost totals + model usage (full health) from a persisted
    // snapshot so they survive server restarts. No-op when absent.
    if (deps.initialState) {
      this.importState(deps.initialState)
    }
  }

  private freshHealth(): KeyHealth {
    return {
      score: INITIAL_SCORE,
      cooldownExpiry: 0,
      successCount: 0,
      failureCount: 0,
      rateLimitHits: 0,
      authErrors: 0,
      permanentlyDead: false,
      lastUsedAt: 0,
      lastCooldownAt: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUSD: 0,
      modelUsage: {},
    }
  }

  getKeyEntries(): KeyEntry[] {
    return this.keys.map((k) => k.entry)
  }

  getHealthSnapshot(): KeyHealthSnapshot[] {
    return this.keys.map((k) => ({
      name: k.entry.name,
      key: k.entry.key,
      health: { ...k.health },
      locked: this.lockManager ? this.lockManager.isLocked(k.entry.name) : false,
      lockOwner: this.lockManager ? this.lockManager.getLockOwner(k.entry.name) : null,
    }))
  }

  /**
   * Fix 2: Restore health (cost totals + model usage + counts + score + death
   * state) for keys whose `key` string matches a snapshot entry. Keys not in
   * the snapshot keep their current (fresh) health; snapshot keys not in the
   * pool are ignored. Used at construction to survive server restarts.
   *
   * Does NOT emit `onStateChange` — this is a one-time restoration, not a
   * runtime state change (the first runtime report/lock op will emit).
   */
  importState(snapshot: KeyHealthSnapshot[]): void {
    const healthByKey = new Map<string, KeyHealth>()
    for (const s of snapshot) {
      // Copy modelUsage entries to avoid shared references with the snapshot.
      healthByKey.set(s.key, {
        ...s.health,
        modelUsage: { ...s.health.modelUsage },
      })
    }
    for (const k of this.keys) {
      const restored = healthByKey.get(k.entry.key)
      if (restored) {
        k.health = restored
      }
    }
  }

  /**
   * Fix 3: Emit the current snapshot to the `onStateChange` callback WITHOUT
   * mutating state. The provider's `fetchWithRetry` calls this after lock
   * acquire/release so the server persists live lock status to key-state.json
   * (the snapshot reads lock status fresh from the `KeyLockCoordinator`).
   * No-op when no callback is configured (backward compatible).
   */
  notifyStateChange(): void {
    this.emitStateChange()
  }

  /**
   * Internal: invoke `onStateChange` with the current snapshot. Error-isolated
   * so a throwing callback (e.g. a failed file write) can NEVER break key
   * rotation — the state mutation already succeeded.
   */
  private emitStateChange(): void {
    if (!this.onStateChange) return
    try {
      this.onStateChange(this.getHealthSnapshot())
    } catch (e) {
      console.error(
        `[KeyManager] onStateChange callback failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  /**
   * Select a key using weighted random selection.
   * Filters out dead and cooldown keys. Falls back to emergency selection
   * when no eligible keys remain.
   *
   * If keysFile + readKeysFile + getMtime are provided, checks file mtime
   * on each call and hot-reloads keys when the file changes (REQ-11).
   */
  selectKey(): KeyEntry {
    // File-backed hot-reload: check if keys.json changed
    if (this.keysFile && this.readKeysFile && this.getMtime) {
      const currentMtime = this.getMtime(this.keysFile)
      if (currentMtime !== this.lastMtime) {
        this.lastMtime = currentMtime
        const newKeys = this.readKeysFile(this.keysFile)
        this.reloadKeys(newKeys)
      }
    }

    const now = this.now()

    // Filter: alive and not in cooldown
    const eligible = this.keys.filter(
      (k) => !k.health.permanentlyDead && k.health.cooldownExpiry <= now,
    )

    if (eligible.length === 0) {
      // All dead or all in cooldown — emergency: pick least-recently-cooldowned non-dead
      const nonDead = this.keys.filter((k) => !k.health.permanentlyDead)
      if (nonDead.length === 0) {
        const deadList = this.keys
          .map((k) => `${k.entry.name} (dead)`)
          .join(", ")
        throw new Error(`All keys permanently dead: ${deadList}`)
      }
      // Least-recently-cooldowned
      nonDead.sort((a, b) => a.health.lastCooldownAt - b.health.lastCooldownAt)
      const emergency = nonDead[0]!
      emergency.health.lastUsedAt = now
      return emergency.entry
    }

    // Phase 3: lock-aware selection — prefer keys not locked by another
    // instance. No lockManager → skip entirely (backward compatible with
    // phase 1+2: candidates === eligible, identical weighted random).
    let candidates = eligible
    if (this.lockManager) {
      const unlocked = eligible.filter((k) => !this.lockManager!.isLocked(k.entry.name))
      if (unlocked.length > 0) {
        candidates = unlocked
      } else {
        // Every eligible key is locked by another instance — emergency:
        // pick the one whose lock expires soonest (it comes back first).
        // Lock file names are sanitized key names; for names without
        // filesystem-unsafe chars they equal the key name (the common case),
        // so we look up expiry by entry.name.
        const activeLocks = this.lockManager.getActiveLocks()
        const expiryByName = new Map(activeLocks.map((l) => [l.keyName, l.expiresAt]))
        const earliest = [...eligible].sort((a, b) => {
          const ea = expiryByName.get(a.entry.name) ?? Number.POSITIVE_INFINITY
          const eb = expiryByName.get(b.entry.name) ?? Number.POSITIVE_INFINITY
          return ea - eb
        })[0]!
        earliest.health.lastUsedAt = now
        // Surface degraded mode without leaking key material (names only are
        // not secrets, but we keep the warning generic to stay quiet).
        console.warn(
          "[KeyManager] all eligible keys locked by other instances; falling back to earliest-expiry",
        )
        return earliest.entry
      }
    }

    if (candidates.length === 1) {
      const single = candidates[0]!
      single.health.lastUsedAt = now
      return single.entry
    }

    // Weighted random: P(key_i) = score_i / Σscores
    const totalScore = candidates.reduce((sum, k) => sum + k.health.score, 0)

    if (totalScore === 0) {
      // Zero-score edge case: uniform random
      const idx = Math.floor(this.random() * candidates.length)
      const selected = candidates[Math.min(idx, candidates.length - 1)]!
      selected.health.lastUsedAt = now
      return selected.entry
    }

    const roll = this.random() * totalScore
    let cumulative = 0
    for (const k of candidates) {
      cumulative += k.health.score
      if (roll < cumulative) {
        k.health.lastUsedAt = now
        return k.entry
      }
    }

    // Fallback (floating point edge case)
    const last = candidates[candidates.length - 1]!
    last.health.lastUsedAt = now
    return last.entry
  }

  reportSuccess(key: string, modelId?: string, usage?: LanguageModelV3Usage): void {
    const state = this.findKey(key)
    if (!state) return
    state.health.successCount++
    state.health.score = this.clampScore(
      state.health.score + Math.min(state.health.successCount * 0.1, 50),
    )
    // Phase 3: attribute token usage + estimated cost when the caller provides
    // a modelId and usage. Backward compatible: omit both → identical to phase
    // 1+2 (no cost tracking, no score penalty).
    if (modelId !== undefined && usage !== undefined) {
      this.reportUsage(key, modelId, usage) // emits inside reportUsage
    } else {
      this.emitStateChange()
    }
  }

  /**
   * Phase 3: Attribute token usage and estimated USD cost to the key that
   * served the request. Updates per-key token totals, a per-model breakdown,
   * and totalCostUSD. Applies an incremental cost penalty to the score
   * (requestCost × costPerDollar, floored at 0) so keys that have spent more
   * are selected less often — consistent with the existing incremental
   * scoring pattern (success +0.1×n, rateLimit −10, serverError −5).
   *
   * Cost is a LOCAL estimate (per spec, displays are labeled "est. cost").
   * Backward compatible: no costMap → tokens are still tracked but cost stays
   * 0 and no score penalty is applied.
   */
  reportUsage(key: string, modelId: string, usage: LanguageModelV3Usage): void {
    const state = this.findKey(key)
    if (!state) return
    const health = state.health

    const inputTokens = usage.inputTokens.total ?? 0
    const outputTokens = usage.outputTokens.total ?? 0
    const cacheRead = usage.inputTokens.cacheRead ?? 0
    const cacheWrite = usage.inputTokens.cacheWrite ?? 0

    health.totalInputTokens += inputTokens
    health.totalOutputTokens += outputTokens
    health.totalCacheReadTokens += cacheRead
    health.totalCacheWriteTokens += cacheWrite

    const model = health.modelUsage[modelId] ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 }
    model.inputTokens += inputTokens
    model.outputTokens += outputTokens
    health.modelUsage[modelId] = model

    // Only priced when a costMap entry exists for the model. Missing
    // cache_write is treated as 0 (some models don't charge for it).
    const cost = this.costMap?.[modelId]
    if (cost) {
      const requestCost =
        (inputTokens * cost.input) / 1_000_000 +
        (outputTokens * cost.output) / 1_000_000 +
        (cacheRead * cost.cache_read) / 1_000_000 +
        (cacheWrite * (cost.cache_write ?? 0)) / 1_000_000

      health.totalCostUSD += requestCost
      model.costUSD += requestCost

      const penalty = requestCost * this.costPerDollar
      if (penalty > 0) {
        health.score = this.clampScore(health.score - penalty)
      }
    }
    this.emitStateChange()
  }

  reportRateLimit(key: string, retryAfterMs?: number): void {
    const state = this.findKey(key)
    if (!state) return
    const now = this.now()
    const cooldown =
      retryAfterMs !== undefined
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
        : DEFAULT_COOLDOWN_MS
    state.health.cooldownExpiry = now + cooldown
    state.health.lastCooldownAt = now
    state.health.rateLimitHits++
    state.health.score = this.clampScore(state.health.score - 10)
    this.emitStateChange()
  }

  reportAuthError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    state.health.permanentlyDead = true
    state.health.authErrors++
    state.health.score = 0
    this.emitStateChange()
  }

  reportServerError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    const now = this.now()
    state.health.cooldownExpiry = now + SERVER_ERROR_COOLDOWN_MS
    state.health.lastCooldownAt = now
    state.health.failureCount++
    state.health.score = this.clampScore(state.health.score - 5)
    this.emitStateChange()
  }

  reportQuotaError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    const now = this.now()
    state.health.cooldownExpiry = now + QUOTA_COOLDOWN_MS
    state.health.lastCooldownAt = now
    state.health.rateLimitHits++
    state.health.score = this.clampScore(state.health.score - 10)
    this.emitStateChange()
  }

  /**
   * Reload keys from a new list. Preserves health for existing keys,
   * adds new keys with fresh health, removes keys no longer in the list.
   */
  reloadKeys(newKeys: KeyEntry[]): void {
    const existingByKey = new Map<string, InternalKeyState>()
    for (const k of this.keys) {
      existingByKey.set(k.entry.key, k)
    }

    this.keys = newKeys.map((entry) => {
      const existing = existingByKey.get(entry.key)
      if (existing) {
        // Preserve health, update entry metadata
        existing.entry = entry
        return existing
      }
      // New key — fresh health
      return { entry, health: this.freshHealth() }
    })
  }

  private findKey(key: string): InternalKeyState | undefined {
    return this.keys.find((k) => k.entry.key === key)
  }

  private clampScore(score: number): number {
    return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score))
  }
}
