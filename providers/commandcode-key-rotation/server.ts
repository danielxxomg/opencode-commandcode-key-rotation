/**
 * Server plugin for commandcode-key-rotation.
 *
 * Responsibilities:
 * - config hook: reads ~/.commandcode/keys.json, injects apiKeys[] into provider config
 * - event hook: monitors session.error events, writes key health to key-state.json
 * - atomic state writes: temp file + rename for crash safety
 *
 * Design decision — Hook ordering:
 *   The config hook ALWAYS sets apiKeys[] when keys.json is valid, regardless of
 *   whether another plugin already set a single apiKey. The provider factory
 *   (commandcode-retry/index.ts) checks apiKeys[] FIRST and ignores apiKey when
 *   apiKeys[] is present. This means our hook runs after commandcode-go-opencode-provider
 *   and overrides its single apiKey injection. If opencode doesn't guarantee hook
 *   order, the provider factory itself handles precedence (apiKeys[] wins over apiKey).
 *
 * Design decision — Server vs Provider split:
 *   The server plugin's event hook is POST-HOC — it detects failures AFTER they happen
 *   and writes to key-state.json for the TUI to read. The provider's KeyManager does
 *   the actual key rotation in fetchWithRetry(). The server plugin cannot directly
 *   access the provider's KeyManager (it's internal to the provider instance).
 */

import type { Config, Plugin, PluginModule } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"
import { LockManager } from "../commandcode-retry/src/lock-manager.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeyEntry {
  name: string
  key: string
  account?: string
}

/**
 * Per-model pricing in USD per 1M tokens. `cache_write` is optional (some
 * models do not charge separately for cache writes → treated as 0). Mirrors the
 * provider's `ModelCost` shape; redefined here so the plugin does not depend on
 * the provider's internal types for its own cost-map builder.
 */
export interface ModelCostEntry {
  input: number
  output: number
  cache_read: number
  cache_write?: number
}

export interface KeysJsonData {
  keys: KeyEntry[]
  rotation?: {
    strategy?: string
    /** Phase 3: lock TTL in ms (default 300000 = 5min). */
    lockTimeoutMs?: number
    /** Phase 3: scoring weight for the cost penalty (default 2.0). */
    costPerDollar?: number
    /** Phase 3: structured scoring weights (overrides costPerDollar). */
    scoringWeights?: { costPerDollar?: number }
  }
  notifications?: {
    enabled?: boolean
    onRotate?: boolean
    onCooldown?: boolean
    onRecovery?: boolean
    onPermanentDeath?: boolean
    /** Phase 3: toast when a key's lock is released. */
    onLockRelease?: boolean
  }
}

export interface NotificationsConfig {
  onRotate: boolean
  onCooldown: boolean
  onRecovery: boolean
  onPermanentDeath: boolean
  /** Phase 3: lock-release toast toggle. */
  onLockRelease: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  onRotate: true,
  onCooldown: true,
  onRecovery: true,
  onPermanentDeath: true,
  onLockRelease: true,
}

/**
 * A single key's persisted state entry. Phase 3 cost + lock fields are all
 * optional so old key-state.json files (phase 1+2) parse without migration.
 */
export interface KeyStateEntry {
  name: string
  health: string
  score: number
  cooldownExpiry?: number
  account?: string
  // Phase 3: per-key cost tracking (populated when a cost map is configured)
  totalInputTokens?: number
  totalOutputTokens?: number
  totalCacheReadTokens?: number
  totalCacheWriteTokens?: number
  totalCostUSD?: number
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
  // Phase 3: lock status (populated by the server from its LockManager)
  locked?: boolean
  lockOwner?: string | null
}

/** Active lock summary entry (top-level on KeyState). */
export interface ActiveLockInfo {
  keyName: string
  instanceId: string
  acquiredAt: number
  expiresAt: number
}

export interface KeyState {
  activeKey: string | null
  keys: KeyStateEntry[]
  notifications?: NotificationsConfig
  lastRotation?: number
  /** C10: written by server when keys.json is malformed; read by TUI for warning toast. */
  configWarning?: string
  /** Phase 3: active cross-instance locks (for TUI lock display). */
  activeLocks?: ActiveLockInfo[]
}

/**
 * Full per-key health (mirrors the provider's `KeyHealth` shape). Redefined
 * locally so the plugin does not depend on the provider's internal
 * `key-manager.ts` (which imports `@ai-sdk/provider`, not a plugin dependency).
 * TypeScript structural typing makes this compatible with the provider's
 * `KeyHealthSnapshot` at the callback boundary.
 */
export interface KeyHealthFields {
  score: number
  cooldownExpiry: number
  successCount: number
  failureCount: number
  rateLimitHits: number
  authErrors: number
  permanentlyDead: boolean
  lastUsedAt: number
  lastCooldownAt: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUSD: number
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
}

/**
 * A complete health snapshot for one key — the unit the provider exports via
 * `onStateChange` and the server re-imports via `initialKeyState`. Carries the
 * full health plus live lock status. The `key` field is the secret key string:
 * it is safe IN-MEMORY (the callback receives it) but the server NEVER persists
 * `key` to key-state.json — only `name` + cost/lock fields are written.
 */
export interface KeyHealthSnapshot {
  name: string
  key: string
  health: KeyHealthFields
  locked: boolean
  lockOwner: string | null
}

export interface WriteDeps {
  renameFn?: (oldPath: string, newPath: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_KEYS_DIR = path.join(os.homedir(), ".commandcode")
const KEYS_FILE = "keys.json"
const STATE_FILE = "key-state.json"
const MODELS_FILE = "models.json"
const LOCK_DIR = ".key-locks"
/** Phase 3: default lock TTL (5min). Matches the provider's DEFAULT_LOCK_TIMEOUT_MS. */
const DEFAULT_LOCK_TIMEOUT_MS = 300_000

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * Redact an API key to show only the last 4 characters.
 * Keys shorter than 8 chars are returned as-is (too short to redact safely).
 */
export function redactKey(key: string): string {
  if (!key || key.length < 8) return key
  return key.slice(0, 5) + "…" + key.slice(-4)
}

// ─── Keys.json reading ───────────────────────────────────────────────────────

/**
 * Read and parse keys.json from the given path.
 * Returns the parsed data if valid, null if missing/malformed/empty.
 * Does NOT throw — always returns null on error.
 */
export function readKeysJson(filePath: string): KeysJsonData | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content)

    // Validate: must have a non-empty keys array
    if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
      console.warn(
        `[commandcode-key-rotation] keys.json at ${filePath} has no valid keys array — falling back to legacy mode`,
      )
      return null
    }

    // Validate each key entry has at least name and key
    for (const entry of parsed.keys) {
      if (!entry.name || !entry.key) {
        console.warn(
          `[commandcode-key-rotation] keys.json entry missing name or key — falling back to legacy mode`,
        )
        return null
      }
    }

    return parsed as KeysJsonData
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn(
        `[commandcode-key-rotation] keys.json at ${filePath} contains invalid JSON — falling back to legacy mode`,
      )
    } else {
      console.warn(
        `[commandcode-key-rotation] Could not read keys.json at ${filePath} — falling back to legacy mode`,
      )
    }
    return null
  }
}

// ─── models.json cost map ────────────────────────────────────────────────────

/**
 * Build a `Record<modelId, ModelCostEntry>` from a parsed models.json array.
 *
 * models.json is an array of `{ id, name, cost: { input, output, cache_read, cache_write? } }`.
 * Pure function — no file I/O — so it is trivially unit-testable. Tolerant:
 * entries missing `id`/`cost` or with incomplete cost are skipped (never throws).
 * Non-array input → empty map.
 */
export function buildCostMap(models: unknown): Record<string, ModelCostEntry> {
  if (!Array.isArray(models)) return {}
  const map: Record<string, ModelCostEntry> = {}
  for (const m of models) {
    if (!m || typeof m !== "object") continue
    const entry = m as {
      id?: string
      cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
    }
    if (typeof entry.id !== "string" || !entry.id) continue
    const cost = entry.cost
    if (!cost) continue
    if (
      typeof cost.input !== "number" ||
      typeof cost.output !== "number" ||
      typeof cost.cache_read !== "number"
    ) {
      continue
    }
    map[entry.id] = {
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read,
      ...(typeof cost.cache_write === "number" ? { cache_write: cost.cache_write } : {}),
    }
  }
  return map
}

/**
 * Read + parse models.json into a cost map. Returns null when the file is
 * missing or malformed (→ cost tracking disabled, no crash). Returns the
 * (possibly empty) cost map when the file is valid JSON.
 */
export function readModelsJson(filePath: string): Record<string, ModelCostEntry> | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content)
    return buildCostMap(parsed)
  } catch {
    return null
  }
}

// ─── Config injection ─────────────────────────────────────────────────────────

/**
 * Inject apiKeys[] into the commandcode provider config.
 * Overrides any existing single apiKey (provider factory handles precedence).
 * Also sets keysFile for file-backed hot-reload (REQ-11).
 */
export function applyKeysToConfig(
  config: Config,
  keysData: KeysJsonData,
  keysFilePath?: string,
): void {
  const provider = config.provider?.commandcode
  if (!provider) return

  if (!provider.options) {
    provider.options = {}
  }

  // Set apiKeys[] — the provider factory checks this FIRST
  ;(provider.options as Record<string, unknown>).apiKeys = keysData.keys.map(
    (k) => ({
      name: k.name,
      key: k.key,
      ...(k.account ? { account: k.account } : {}),
    }),
  )

  // Wire file-backed hot-reload (REQ-11): pass keysFile path so the
  // provider's KeyManager can detect file changes on each selectKey().
  // readKeysFile and getMtime use Node.js fs (available in Bun runtime).
  ;(provider.options as Record<string, unknown>).keysFile = keysFilePath
}

// ─── Atomic state write ──────────────────────────────────────────────────────

/**
 * Write key state to disk atomically (temp file + rename).
 * If rename fails, the original file is preserved.
 *
 * @param filePath - path to key-state.json
 * @param state - state to write
 * @param deps - optional deps for testing (renameFn)
 */
export function writeKeyState(
  filePath: string,
  state: KeyState,
  deps: WriteDeps = {},
): void {
  const tmpPath = filePath + ".tmp"
  const renameFn = deps.renameFn ?? fs.renameSync

  // Write to temp file first
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8")

  // Atomic rename — on the same filesystem this is guaranteed atomic
  renameFn(tmpPath, filePath)
}

// ─── State reading ────────────────────────────────────────────────────────────

/**
 * Read key state from disk. Tolerates missing/malformed files.
 * Returns empty state on any error.
 */
export function readKeyState(filePath: string): KeyState {
  const emptyState: KeyState = { activeKey: null, keys: [] }

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content)

    // Validate basic shape
    if (!parsed || typeof parsed !== "object") return emptyState

    return {
      activeKey: parsed.activeKey ?? null,
      // Phase 3: keys pass through with all optional cost/lock fields intact
      // (KeyStateEntry fields are optional, so old files parse without migration).
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      notifications: parsed.notifications,
      lastRotation: parsed.lastRotation,
      configWarning: parsed.configWarning,
      // Phase 3: active locks summary (tolerant — missing/malformed → undefined)
      activeLocks: Array.isArray(parsed.activeLocks) ? parsed.activeLocks : undefined,
    }
  } catch {
    return emptyState
  }
}

// ─── Runtime state bridge — pure helpers (Fix 1/2/3) ─────────────────────────

/**
 * Derive the coarse health string the TUI reads from a full `KeyHealthFields`
 * snapshot. Mirrors the strings `getHealthEmoji` handles: "dead" (permanently
 * dead), "cooldown" (currently in cooldown), else "healthy". Pure — takes `now`
 * so it is deterministic and unit-testable.
 */
export function deriveHealthString(h: KeyHealthFields, now: number): string {
  if (h.permanentlyDead) return "dead"
  if (h.cooldownExpiry > now) return "cooldown"
  return "healthy"
}

/**
 * Build a `KeyHealthSnapshot[]` (for the provider's `initialKeyState` →
 * `KeyManager.importState`) from keys.json key strings + the existing
 * key-state.json cost data. The `key` field comes from keys.json (the secret) so
 * `importState` can match by key string; cost totals + model usage come from the
 * existing persisted state so they survive server restarts. Keys with no prior
 * cost data get zero defaults. Pure — no file I/O.
 */
export function buildInitialSnapshot(
  keysFromJson: KeyEntry[],
  existing: KeyState,
): KeyHealthSnapshot[] {
  const byName = new Map(existing.keys.map((k) => [k.name, k]))
  return keysFromJson.map((k) => {
    const ex = byName.get(k.name)
    const dead = ex?.health === "dead" || ex?.health === "auth-error"
    return {
      name: k.name,
      key: k.key,
      locked: false, // not used by importState (only key + health matter)
      lockOwner: null,
      health: {
        score: ex?.score ?? 100,
        cooldownExpiry: ex?.cooldownExpiry ?? 0,
        successCount: 0,
        failureCount: 0,
        rateLimitHits: 0,
        authErrors: dead ? 1 : 0,
        permanentlyDead: dead,
        lastUsedAt: 0,
        lastCooldownAt: 0,
        totalInputTokens: ex?.totalInputTokens ?? 0,
        totalOutputTokens: ex?.totalOutputTokens ?? 0,
        totalCacheReadTokens: ex?.totalCacheReadTokens ?? 0,
        totalCacheWriteTokens: ex?.totalCacheWriteTokens ?? 0,
        totalCostUSD: ex?.totalCostUSD ?? 0,
        modelUsage: ex?.modelUsage ? { ...ex.modelUsage } : {},
      },
    }
  })
}

/**
 * Build the `keys` array for the initial key-state.json write, merging keys.json
 * with existing persisted state. Existing keys KEEP their cost totals + score +
 * health string (config rewrite does NOT zero them out); new keys get fresh
 * defaults. Lock status is read live from the shared lockManager. Pure — no file
 * I/O (the lockManager is injected).
 */
export function buildInitialStateKeys(
  keysFromJson: KeyEntry[],
  existing: KeyState,
  lockManager: { isLocked(name: string): boolean; getLockOwner(name: string): string | null },
): KeyStateEntry[] {
  const byName = new Map(existing.keys.map((k) => [k.name, k]))
  return keysFromJson.map((k) => {
    const ex = byName.get(k.name)
    return {
      name: k.name,
      health: ex?.health ?? "healthy",
      score: ex?.score ?? 100,
      ...(k.account ? { account: k.account } : {}),
      // Preserve existing cost fields (do NOT overwrite with zeros on rewrite).
      ...(ex?.cooldownExpiry !== undefined ? { cooldownExpiry: ex.cooldownExpiry } : {}),
      ...(ex?.totalInputTokens !== undefined ? { totalInputTokens: ex.totalInputTokens } : {}),
      ...(ex?.totalOutputTokens !== undefined ? { totalOutputTokens: ex.totalOutputTokens } : {}),
      ...(ex?.totalCacheReadTokens !== undefined ? { totalCacheReadTokens: ex.totalCacheReadTokens } : {}),
      ...(ex?.totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens: ex.totalCacheWriteTokens } : {}),
      ...(ex?.totalCostUSD !== undefined ? { totalCostUSD: ex.totalCostUSD } : {}),
      ...(ex?.modelUsage !== undefined ? { modelUsage: ex.modelUsage } : {}),
      // Live lock status from the shared lockManager.
      locked: lockManager.isLocked(k.name),
      lockOwner: lockManager.getLockOwner(k.name),
    }
  })
}

/**
 * Merge a runtime `KeyHealthSnapshot[]` (emitted by the provider via
 * `onStateChange`) into the existing key-state.json state. Each snapshot entry
 * becomes a `KeyStateEntry` with derived health string, score, cost totals, and
 * live lock status; `account` is preserved from the existing entry by name.
 * Top-level fields (activeKey, notifications, lastRotation, configWarning) are
 * preserved. The secret `key` is NEVER copied to `KeyStateEntry`. Pure — takes
 * `now` for deterministic health derivation. `activeLocks` is left untouched
 * (the caller updates it from the live lockManager).
 */
export function applySnapshotToState(
  existing: KeyState,
  snapshot: KeyHealthSnapshot[],
  now: number,
): KeyState {
  const accountByName = new Map(
    existing.keys.map((k) => [k.name, k.account]),
  )
  return {
    activeKey: existing.activeKey,
    notifications: existing.notifications,
    lastRotation: existing.lastRotation,
    configWarning: existing.configWarning,
    activeLocks: existing.activeLocks,
    keys: snapshot.map((s) => ({
      name: s.name,
      health: deriveHealthString(s.health, now),
      score: s.health.score,
      ...(accountByName.get(s.name) ? { account: accountByName.get(s.name) } : {}),
      ...(s.health.cooldownExpiry ? { cooldownExpiry: s.health.cooldownExpiry } : {}),
      totalInputTokens: s.health.totalInputTokens,
      totalOutputTokens: s.health.totalOutputTokens,
      totalCacheReadTokens: s.health.totalCacheReadTokens,
      totalCacheWriteTokens: s.health.totalCacheWriteTokens,
      totalCostUSD: s.health.totalCostUSD,
      modelUsage: s.health.modelUsage,
      locked: s.locked,
      lockOwner: s.lockOwner,
    })),
  }
}

// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Check if an error from a session.error event is an ApiError with
 * statusCode 429, 401, or 403 — these trigger key swaps in the provider.
 *
 * The server plugin uses this to write failure info to key-state.json.
 * The actual key rotation happens in the provider's fetchWithRetry().
 */
export function isRetryableError(
  error: unknown,
): boolean {
  if (!error || typeof error !== "object") return false

  const e = error as { name?: string; data?: { statusCode?: number } }
  if (e.name !== "APIError") return false

  const code = e.data?.statusCode
  return code === 429 || code === 401 || code === 403
}

// ─── Plugin factory ───────────────────────────────────────────────────────────

export interface ServerPluginOptions {
  keysDir?: string
  /** Phase 3: path to models.json (DI for testing). Defaults to {keysDir}/models.json. */
  modelsFile?: string
  /** Phase 3: inject a LockManager (DI for testing). If absent, a real one is constructed. */
  lockManager?: InstanceType<typeof LockManager>
  /** Phase 3: inject an instanceId (DI for testing). If absent, crypto.randomUUID() is used. */
  instanceId?: string
}

/**
 * Create the server plugin hooks for commandcode-key-rotation.
 *
 * @param options - optional overrides (keysDir, modelsFile, lockManager, instanceId for testing)
 * @returns Hooks object with config and event hooks
 */
export function createServerPlugin(
  options: ServerPluginOptions = {},
): { config: (input: Config) => Promise<void>; event: (input: { event: { type: string; properties?: unknown } }) => Promise<void> } {
  const keysDir = options.keysDir ?? DEFAULT_KEYS_DIR
  const keysPath = path.join(keysDir, KEYS_FILE)
  const statePath = path.join(keysDir, STATE_FILE)
  const modelsPath = options.modelsFile ?? path.join(keysDir, MODELS_FILE)
  const lockDir = path.join(keysDir, LOCK_DIR)

  return {
    config: async (input: Config) => {
      const keysData = readKeysJson(keysPath)
      if (keysData) {
        applyKeysToConfig(input, keysData, keysPath)

        // ── Phase 3: load models.json cost map ──────────────────────────────
        const costMap = readModelsJson(modelsPath)
        const provider = input.provider?.commandcode
        const providerOptions = provider?.options as Record<string, unknown> | undefined
        if (providerOptions && costMap && Object.keys(costMap).length > 0) {
          providerOptions.modelCosts = costMap
        }

        // ── Phase 3: lock coordination + instance identity ──────────────────
        // The server constructs the LockManager so the server (for key-state.json
        // lock status) and the provider (for acquire/release) share ONE instance.
        const instanceId = options.instanceId ?? randomUUID()
        const lockTimeoutMs = keysData.rotation?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
        const lockManager =
          options.lockManager ?? new LockManager(lockDir, lockTimeoutMs, instanceId)

        if (providerOptions) {
          providerOptions.lockManager = lockManager
          providerOptions.instanceId = instanceId
          providerOptions.lockTimeoutMs = lockTimeoutMs
          // costPerDollar → scoringWeights (the KeyManager reads scoringWeights)
          if (keysData.rotation?.costPerDollar !== undefined) {
            providerOptions.scoringWeights = { costPerDollar: keysData.rotation.costPerDollar }
          }
        }

        // Write initial key-state.json with account info + notifications config
        // + Phase 3 lock status so the TUI can read it without needing keys.json directly
        const existingState = readKeyState(statePath)

        // Fix 1/3: runtime state bridge — provide an onStateChange callback the
        // provider invokes with a health snapshot (cost + lock) after each state
        // change / lock op. The server merges it into key-state.json (atomic) so
        // the TUI sees live cost + lock data. Error-isolated: a failed write must
        // never break the provider (the callback is best-effort).
        const onStateChange = (snapshot: KeyHealthSnapshot[]): void => {
          try {
            const current = readKeyState(statePath)
            const merged = applySnapshotToState(current, snapshot, Date.now())
            // Refresh the active-locks summary from the live lockManager.
            merged.activeLocks = lockManager.getActiveLocks() as ActiveLockInfo[]
            writeKeyState(statePath, merged)
          } catch (e) {
            console.error(
              `[commandcode-key-rotation] onStateChange write failed: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
        }

        // Fix 2: restart preservation — build a snapshot from keys.json key
        // strings + existing persisted cost so the provider's KeyManager imports
        // cost totals + model usage on construction (survives server restart).
        const initialKeyState = buildInitialSnapshot(keysData.keys, existingState)

        if (providerOptions) {
          providerOptions.onStateChange = onStateChange
          providerOptions.initialKeyState = initialKeyState
        }

        const resolvedNotifications: NotificationsConfig = keysData.notifications
          ? {
              onRotate: keysData.notifications.onRotate ?? true,
              onCooldown: keysData.notifications.onCooldown ?? true,
              onRecovery: keysData.notifications.onRecovery ?? true,
              onPermanentDeath: keysData.notifications.onPermanentDeath ?? true,
              onLockRelease: keysData.notifications.onLockRelease ?? true,
            }
          : { ...DEFAULT_NOTIFICATIONS }

        const initialState: KeyState = {
          activeKey: existingState.activeKey ?? keysData.keys[0]?.name ?? null,
          // Fix 2: preserve existing cost totals on config rewrite (merge, not
          // zero). New keys get fresh defaults; existing keys keep cost + score.
          keys: buildInitialStateKeys(keysData.keys, existingState, lockManager),
          notifications: resolvedNotifications,
          lastRotation: existingState.lastRotation,
          // Phase 3: active locks summary for the TUI
          activeLocks: lockManager.getActiveLocks() as ActiveLockInfo[],
        }

        writeKeyState(statePath, initialState)
      } else {
        // C10: keys.json malformed/missing — write configWarning so TUI can show toast
        try {
          const existingState = readKeyState(statePath)
          writeKeyState(statePath, {
            ...existingState,
            configWarning: "keys.json is malformed or missing — using legacy single-key mode",
          })
        } catch {
          // If state file doesn't exist yet, create it with just the warning
          writeKeyState(statePath, {
            activeKey: null,
            keys: [],
            configWarning: "keys.json is malformed or missing — using legacy single-key mode",
          })
        }
      }
    },

    event: async (input: { event: { type: string; properties?: unknown } }) => {
      if (input.event.type !== "session.error") return

      const props = input.event.properties as {
        sessionID?: string
        error?: unknown
      } | undefined

      if (!props?.error) return

      if (isRetryableError(props.error)) {
        const currentState = readKeyState(statePath)
        const errorData = (props.error as { data?: { statusCode?: number; message?: string } }).data

        // Update state with failure info
        currentState.lastRotation = Date.now()
        writeKeyState(statePath, {
          ...currentState,
          // Record that an error happened — the TUI will read this
          keys: currentState.keys.map((k) => ({
            ...k,
            health:
              k.name === currentState.activeKey
                ? errorData?.statusCode === 429
                  ? "rate-limited"
                  : "auth-error"
                : k.health,
          })),
        })
      }
    },
  }
}

// ─── Default export (PluginModule shape) ──────────────────────────────────────

/**
 * The server plugin module export.
 * opencode loads this as `commandcode-key-rotation/server`.
 */
const serverPlugin: Plugin = async (_input, _options) => {
  return createServerPlugin()
}

export default serverPlugin
