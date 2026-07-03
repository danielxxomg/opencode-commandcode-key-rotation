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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KeyEntry {
  name: string
  key: string
  account?: string
}

export interface KeysJsonData {
  keys: KeyEntry[]
  rotation?: { strategy?: string }
  notifications?: {
    enabled?: boolean
    onRotate?: boolean
    onCooldown?: boolean
    onRecovery?: boolean
    onPermanentDeath?: boolean
  }
}

export interface NotificationsConfig {
  onRotate: boolean
  onCooldown: boolean
  onRecovery: boolean
  onPermanentDeath: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  onRotate: true,
  onCooldown: true,
  onRecovery: true,
  onPermanentDeath: true,
}

export interface KeyState {
  activeKey: string | null
  keys: Array<{
    name: string
    health: string
    score: number
    cooldownExpiry?: number
    account?: string
  }>
  notifications?: NotificationsConfig
  lastRotation?: number
  /** C10: written by server when keys.json is malformed; read by TUI for warning toast. */
  configWarning?: string
}

export interface WriteDeps {
  renameFn?: (oldPath: string, newPath: string) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_KEYS_DIR = path.join(os.homedir(), ".commandcode")
const KEYS_FILE = "keys.json"
const STATE_FILE = "key-state.json"

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
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      notifications: parsed.notifications,
      lastRotation: parsed.lastRotation,
      configWarning: parsed.configWarning,
    }
  } catch {
    return emptyState
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
}

/**
 * Create the server plugin hooks for commandcode-key-rotation.
 *
 * @param options - optional overrides (keysDir for testing)
 * @returns Hooks object with config and event hooks
 */
export function createServerPlugin(
  options: ServerPluginOptions = {},
): { config: (input: Config) => Promise<void>; event: (input: { event: { type: string; properties?: unknown } }) => Promise<void> } {
  const keysDir = options.keysDir ?? DEFAULT_KEYS_DIR
  const keysPath = path.join(keysDir, KEYS_FILE)
  const statePath = path.join(keysDir, STATE_FILE)

  return {
    config: async (input: Config) => {
      const keysData = readKeysJson(keysPath)
      if (keysData) {
        applyKeysToConfig(input, keysData, keysPath)

        // Write initial key-state.json with account info + notifications config
        // so the TUI can read it without needing keys.json directly
        const existingState = readKeyState(statePath)
        const resolvedNotifications: NotificationsConfig = keysData.notifications
          ? {
              onRotate: keysData.notifications.onRotate ?? true,
              onCooldown: keysData.notifications.onCooldown ?? true,
              onRecovery: keysData.notifications.onRecovery ?? true,
              onPermanentDeath: keysData.notifications.onPermanentDeath ?? true,
            }
          : { ...DEFAULT_NOTIFICATIONS }

        const initialState: KeyState = {
          activeKey: existingState.activeKey ?? keysData.keys[0]?.name ?? null,
          keys: keysData.keys.map((k) => ({
            name: k.name,
            health: "healthy",
            score: 100,
            ...(k.account ? { account: k.account } : {}),
          })),
          notifications: resolvedNotifications,
          lastRotation: existingState.lastRotation,
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
