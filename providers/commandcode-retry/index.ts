import { resolveApiKey } from "./src/auth.js"
import { CommandCodeLanguageModel } from "./src/model.js"
import { KeyManager } from "./src/key-manager.js"
import type { KeyEntry, KeyManagerDeps } from "./src/key-manager.js"

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
}

/**
 * Factory consumed by opencode's provider loader. Mirrors the original
 * commandcode-go-opencode-provider surface so the existing auth loader
 * (which injects { apiKey }) keeps working unchanged.
 *
 * When apiKeys[] is provided and non-empty, constructs a KeyManager for
 * automatic key rotation. Absent → legacy single-key mode.
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

  // Construct KeyManager for multi-key rotation
  const keyManagerDeps: KeyManagerDeps = {}
  if (options.keysFile) keyManagerDeps.keysFile = options.keysFile
  if (options.readKeysFile) keyManagerDeps.readKeysFile = options.readKeysFile
  if (options.getMtime) keyManagerDeps.getMtime = options.getMtime

  const keyManager = hasMultipleKeys
    ? new KeyManager({ keys: options.apiKeys!, ...keyManagerDeps })
    : undefined

  return {
    languageModel(modelId: string): CommandCodeLanguageModel {
      return new CommandCodeLanguageModel(modelId, {
        apiKey: apiKey ?? options.apiKeys![0]!.key, // fallback to first key for legacy compat
        baseURL: typeof options.baseURL === "string" ? options.baseURL : undefined,
        headers: typeof options.headers === "object" && options.headers !== null ? (options.headers as Record<string, string>) : undefined,
        ...(keyManager ? { keyManager } : {}),
      })
    },
  }
}
