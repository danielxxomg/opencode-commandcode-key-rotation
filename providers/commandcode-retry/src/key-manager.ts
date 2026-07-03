/**
 * KeyManager — manages a pool of API keys with health tracking,
 * weighted random selection, cooldowns, and permanent death.
 */

export interface KeyEntry {
  name: string
  key: string
  account?: string
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
}

export interface KeyManagerDeps {
  now?: () => number
  random?: () => number
  keysFile?: string
  readKeysFile?: (filePath: string) => KeyEntry[]
  getMtime?: (filePath: string) => number
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

export class KeyManager {
  private keys: InternalKeyState[]
  private now: () => number
  private random: () => number
  private keysFile?: string
  private readKeysFile?: (filePath: string) => KeyEntry[]
  private getMtime?: (filePath: string) => number
  private lastMtime: number = 0

  constructor(deps: KeyManagerDeps & { keys: KeyEntry[] }) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? Math.random
    this.keysFile = deps.keysFile
    this.readKeysFile = deps.readKeysFile
    this.getMtime = deps.getMtime
    this.keys = deps.keys.map((entry) => ({
      entry,
      health: this.freshHealth(),
    }))
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
    }
  }

  getKeyEntries(): KeyEntry[] {
    return this.keys.map((k) => k.entry)
  }

  getHealthSnapshot(): Array<{ name: string; key: string; health: KeyHealth }> {
    return this.keys.map((k) => ({
      name: k.entry.name,
      key: k.entry.key,
      health: { ...k.health },
    }))
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

    if (eligible.length === 1) {
      const single = eligible[0]!
      single.health.lastUsedAt = now
      return single.entry
    }

    // Weighted random: P(key_i) = score_i / Σscores
    const totalScore = eligible.reduce((sum, k) => sum + k.health.score, 0)

    if (totalScore === 0) {
      // Zero-score edge case: uniform random
      const idx = Math.floor(this.random() * eligible.length)
      const selected = eligible[Math.min(idx, eligible.length - 1)]!
      selected.health.lastUsedAt = now
      return selected.entry
    }

    const roll = this.random() * totalScore
    let cumulative = 0
    for (const k of eligible) {
      cumulative += k.health.score
      if (roll < cumulative) {
        k.health.lastUsedAt = now
        return k.entry
      }
    }

    // Fallback (floating point edge case)
    const last = eligible[eligible.length - 1]!
    last.health.lastUsedAt = now
    return last.entry
  }

  reportSuccess(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    state.health.successCount++
    state.health.score = this.clampScore(
      state.health.score + Math.min(state.health.successCount * 0.1, 50),
    )
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
  }

  reportAuthError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    state.health.permanentlyDead = true
    state.health.authErrors++
    state.health.score = 0
  }

  reportServerError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    const now = this.now()
    state.health.cooldownExpiry = now + SERVER_ERROR_COOLDOWN_MS
    state.health.lastCooldownAt = now
    state.health.failureCount++
    state.health.score = this.clampScore(state.health.score - 5)
  }

  reportQuotaError(key: string): void {
    const state = this.findKey(key)
    if (!state) return
    const now = this.now()
    state.health.cooldownExpiry = now + QUOTA_COOLDOWN_MS
    state.health.lastCooldownAt = now
    state.health.rateLimitHits++
    state.health.score = this.clampScore(state.health.score - 10)
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
