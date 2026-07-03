/**
 * Tests for the commandcode-key-rotation server plugin.
 *
 * Covers:
 * - L3-T1: config hook (reads keys.json → injects apiKeys[], malformed → fallback)
 * - L3-T3: atomic state write + event monitoring
 *
 * Strict TDD: tests written BEFORE implementation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { Config } from "@opencode-ai/plugin"
import type { KeyEntry } from "./server.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-key-rotation-test-"))
}

function makeConfig(overrides?: { apiKey?: string }): Config {
  return {
    provider: {
      commandcode: {
        options: {
          ...(overrides?.apiKey ? { apiKey: overrides.apiKey } : {}),
        },
      },
    },
  } as Config
}

function writeKeysJson(dir: string, data: unknown): string {
  const filePath = path.join(dir, "keys.json")
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8")
  return filePath
}

function writeRawFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, "utf-8")
  return filePath
}

// ─── Import the module under test ─────────────────────────────────────────────
// We need dynamic import so we can set env vars before module load.
// But for TDD we'll import the functions directly once they exist.

// For now, test against the expected API shape.
// The server.ts should export: readKeysJson, writeKeyState, readKeyState
// And the plugin factory: createServerPlugin

// ─── L3-T1: Config hook tests ────────────────────────────────────────────────

describe("config hook — reads keys.json and injects apiKeys[]", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("reads valid keys.json and injects apiKeys[] into provider config", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222", account: "acc2" },
      ],
      rotation: { strategy: "weighted" },
      notifications: { enabled: true },
    }
    const keysPath = writeKeysJson(tmpDir, keysData)

    // Import the module under test
    const { readKeysJson } = await import("./server.js")
    const result = readKeysJson(keysPath)

    expect(result).not.toBeNull()
    expect(result!.keys).toHaveLength(2)
    expect(result!.keys[0]).toEqual({
      name: "personal",
      key: "user_test_aaaa1111",
      account: "acc1",
    })
    expect(result!.keys[1]).toEqual({
      name: "work",
      key: "user_test_bbbb2222",
      account: "acc2",
    })
  })

  test("malformed JSON → returns null + logs warning (no crash)", async () => {
    const keysPath = writeRawFile(tmpDir, "keys.json", "{invalid json!!!")

    const { readKeysJson } = await import("./server.js")
    const result = readKeysJson(keysPath)

    expect(result).toBeNull()
  })

  test("missing keys.json → returns null (no crash)", async () => {
    const missingPath = path.join(tmpDir, "nonexistent-keys.json")

    const { readKeysJson } = await import("./server.js")
    const result = readKeysJson(missingPath)

    expect(result).toBeNull()
  })

  test("missing keys array in JSON → returns null", async () => {
    const keysPath = writeKeysJson(tmpDir, { rotation: { strategy: "weighted" } })

    const { readKeysJson } = await import("./server.js")
    const result = readKeysJson(keysPath)

    expect(result).toBeNull()
  })

  test("empty keys array → returns null", async () => {
    const keysPath = writeKeysJson(tmpDir, { keys: [] })

    const { readKeysJson } = await import("./server.js")
    const result = readKeysJson(keysPath)

    expect(result).toBeNull()
  })

  test("injects apiKeys[] into config, overriding single apiKey", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222", account: "acc2" },
      ],
    }
    const keysPath = writeKeysJson(tmpDir, keysData)

    const { applyKeysToConfig } = await import("./server.js")
    const config = makeConfig({ apiKey: "user_legacy_single_key" })
    applyKeysToConfig(config, keysData)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    // apiKeys[] must be set
    expect(ccOptions.apiKeys).toBeDefined()
    expect(Array.isArray(ccOptions.apiKeys)).toBe(true)
    expect(ccOptions.apiKeys).toHaveLength(2)
    // apiKeys must be the actual keys, not the legacy single key
    expect(ccOptions.apiKeys[0].key).toBe("user_test_aaaa1111")
  })

  test("redacts keys in any logged output (last 4 chars only)", async () => {
    const { redactKey } = await import("./server.js")

    expect(redactKey("user_test_aaaa1111")).toBe("user_…1111")
    expect(redactKey("sk-abcdefghijklmnop")).toBe("sk-ab…mnop")
    expect(redactKey("short")).toBe("short") // too short to redact
    expect(redactKey("")).toBe("")
  })
})

// ─── L3-T3: Atomic state write + event monitoring tests ──────────────────────

describe("atomic key-state.json write", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("writeKeyState writes atomic JSON (temp + rename)", async () => {
    const statePath = path.join(tmpDir, "key-state.json")

    const { writeKeyState } = await import("./server.js")
    const state = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "cooldown", score: 80 },
      ],
      lastRotation: Date.now(),
    }

    writeKeyState(statePath, state, {})

    // File must exist and be valid JSON
    const content = fs.readFileSync(statePath, "utf-8")
    const parsed = JSON.parse(content)
    expect(parsed.activeKey).toBe("personal")
    expect(parsed.keys).toHaveLength(2)

    // Temp file must NOT exist after successful write
    const tmpPath = statePath + ".tmp"
    expect(fs.existsSync(tmpPath)).toBe(false)
  })

  test("writeKeyState crash mid-write (rename fails) → original file intact", async () => {
    const statePath = path.join(tmpDir, "key-state.json")

    // Write initial valid state
    const initialState = {
      activeKey: "old-personal",
      keys: [{ name: "personal", health: "healthy", score: 100 }],
      lastRotation: 1000,
    }
    fs.writeFileSync(statePath, JSON.stringify(initialState), "utf-8")

    // Inject a failing rename function via deps
    let renameCalled = false
    const failingRename = (_oldPath: string, _newPath: string) => {
      renameCalled = true
      // Clean up the temp file to simulate a real crash
      try { fs.unlinkSync(_oldPath) } catch {}
      throw new Error("ENOSPC: simulated crash during rename")
    }

    const { writeKeyState } = await import("./server.js")
    const newState = {
      activeKey: "new-work",
      keys: [{ name: "work", health: "healthy", score: 90 }],
      lastRotation: 2000,
    }

    expect(() => writeKeyState(statePath, newState, { renameFn: failingRename })).toThrow()
    expect(renameCalled).toBe(true)

    // Original file must still be intact (old state)
    const content = fs.readFileSync(statePath, "utf-8")
    const parsed = JSON.parse(content)
    expect(parsed.activeKey).toBe("old-personal")
  })

  test("readKeyState tolerates malformed JSON → returns empty state", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    fs.writeFileSync(statePath, "{corrupt!!!", "utf-8")

    const { readKeyState } = await import("./server.js")
    const result = readKeyState(statePath)

    expect(result.activeKey).toBeNull()
    expect(result.keys).toEqual([])
  })

  test("readKeyState missing file → returns empty state", async () => {
    const missingPath = path.join(tmpDir, "nonexistent.json")

    const { readKeyState } = await import("./server.js")
    const result = readKeyState(missingPath)

    expect(result.activeKey).toBeNull()
    expect(result.keys).toEqual([])
  })

  test("readKeyState reads valid state correctly", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    const state = {
      activeKey: "work",
      keys: [{ name: "work", health: "healthy", score: 120 }],
      lastRotation: 5000,
    }
    fs.writeFileSync(statePath, JSON.stringify(state), "utf-8")

    const { readKeyState } = await import("./server.js")
    const result = readKeyState(statePath)

    expect(result.activeKey).toBe("work")
    expect(result.keys).toHaveLength(1)
    expect(result.keys[0].name).toBe("work")
  })
})

describe("event hook — session.error monitoring", () => {
  test("isRetryableError identifies 429/401/403 as retryable key-swap triggers", async () => {
    const { isRetryableError } = await import("./server.js")

    // ApiError with statusCode 429
    expect(
      isRetryableError({
        name: "APIError",
        data: { message: "rate limited", statusCode: 429, isRetryable: false },
      }),
    ).toBe(true)

    // ApiError with statusCode 401
    expect(
      isRetryableError({
        name: "APIError",
        data: { message: "unauthorized", statusCode: 401, isRetryable: false },
      }),
    ).toBe(true)

    // ApiError with statusCode 403
    expect(
      isRetryableError({
        name: "APIError",
        data: { message: "forbidden", statusCode: 403, isRetryable: false },
      }),
    ).toBe(true)

    // ApiError with statusCode 500 — NOT a key-swap trigger
    expect(
      isRetryableError({
        name: "APIError",
        data: { message: "server error", statusCode: 500, isRetryable: true },
      }),
    ).toBe(false)

    // ProviderAuthError — not an ApiError
    expect(
      isRetryableError({
        name: "ProviderAuthError",
        data: { providerID: "commandcode", message: "auth failed" },
      }),
    ).toBe(false)

    // null/undefined
    expect(isRetryableError(null)).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })
})

describe("plugin factory — createServerPlugin", () => {
  test("returns an object with config and event hooks", async () => {
    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: "/tmp/test-keys" })

    expect(plugin).toBeDefined()
    expect(typeof plugin.config).toBe("function")
    expect(typeof plugin.event).toBe("function")
  })
})

// ─── L3-T2/T4 corrective: actual hook-path integration tests ─────────────────

describe("config hook — actual plugin hook path", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("config hook reads keys.json and injects apiKeys[] into config", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222" },
      ],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.apiKeys).toBeDefined()
    expect(ccOptions.apiKeys).toHaveLength(2)
    expect(ccOptions.apiKeys[0].key).toBe("user_test_aaaa1111")
    expect(ccOptions.apiKeys[0].name).toBe("personal")
    expect(ccOptions.apiKeys[1].key).toBe("user_test_bbbb2222")
    // account is omitted when not provided
    expect(ccOptions.apiKeys[1].account).toBeUndefined()
  })

  test("config hook with malformed keys.json → does NOT set apiKeys, does not throw", async () => {
    writeRawFile(tmpDir, "keys.json", "{invalid!!!")

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.apiKeys).toBeUndefined()
  })

  test("config hook with malformed keys.json → writes configWarning to key-state.json", async () => {
    writeRawFile(tmpDir, "keys.json", "{invalid!!!")

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    // C10: configWarning must be set when keys.json is malformed
    expect(state.configWarning).toBeDefined()
    expect(state.configWarning).toContain("malformed")
    expect(state.configWarning).toContain("keys.json")
  })

  test("config hook initializes options when missing", async () => {
    const keysData = {
      keys: [{ name: "only", key: "user_test_only1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    // Config with commandcode provider but NO options object
    const config = {
      provider: {
        commandcode: {},
      },
    } as Config

    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.apiKeys).toBeDefined()
    expect(ccOptions.apiKeys).toHaveLength(1)
    expect(ccOptions.apiKeys[0].key).toBe("user_test_only1111")
  })

  test("config hook with entry missing name → falls back to legacy mode", async () => {
    writeKeysJson(tmpDir, { keys: [{ key: "user_test_only_key" }] })

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.apiKeys).toBeUndefined()
  })
})

describe("event hook — actual plugin hook path", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("session.error with 429 → writes key-state.json with rate-limited health", async () => {
    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    // Pre-populate key-state.json so the hook has an active key
    const statePath = path.join(tmpDir, "key-state.json")
    const initialState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "healthy", score: 90 },
      ],
    }
    fs.writeFileSync(statePath, JSON.stringify(initialState), "utf-8")

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_abc123",
          error: {
            name: "APIError",
            data: { statusCode: 429, message: "rate limited", isRetryable: false },
          },
        },
      },
    })

    const updated = readKeyState(statePath)
    expect(updated.keys.find((k) => k.name === "personal")?.health).toBe("rate-limited")
    // Non-active key untouched
    expect(updated.keys.find((k) => k.name === "work")?.health).toBe("healthy")
    expect(updated.lastRotation).toBeDefined()
  })

  test("session.error with 401 → writes key-state.json with auth-error health", async () => {
    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    const statePath = path.join(tmpDir, "key-state.json")
    const initialState = {
      activeKey: "work",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "healthy", score: 90 },
      ],
    }
    fs.writeFileSync(statePath, JSON.stringify(initialState), "utf-8")

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          error: {
            name: "APIError",
            data: { statusCode: 401, message: "unauthorized" },
          },
        },
      },
    })

    const updated = readKeyState(statePath)
    expect(updated.keys.find((k) => k.name === "work")?.health).toBe("auth-error")
    expect(updated.keys.find((k) => k.name === "personal")?.health).toBe("healthy")
  })

  test("non-error event (session.start) → no write to key-state.json", async () => {
    const statePath = path.join(tmpDir, "key-state.json")

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    await plugin.event({
      event: {
        type: "session.start",
        properties: { sessionID: "ses_xyz" },
      },
    })

    // File should NOT have been created
    expect(fs.existsSync(statePath)).toBe(false)
  })

  test("session.error with non-APIError (500) → no write", async () => {
    const statePath = path.join(tmpDir, "key-state.json")

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          error: {
            name: "APIError",
            data: { statusCode: 500, message: "internal server error", isRetryable: true },
          },
        },
      },
    })

    expect(fs.existsSync(statePath)).toBe(false)
  })

  test("session.error with missing error property → no write", async () => {
    const statePath = path.join(tmpDir, "key-state.json")

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })

    await plugin.event({
      event: {
        type: "session.error",
        properties: { sessionID: "ses_no_err" },
      },
    })

    expect(fs.existsSync(statePath)).toBe(false)
  })
})

// ─── PR3 corrective: account + notifications in key-state.json ─────────────

describe("config hook — writes initial key-state.json with account + notifications", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("config hook writes initial key-state.json with account per key", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "danielxxomg" },
        { name: "work", key: "user_test_bbbb2222", account: "work-corp" },
        { name: "backup", key: "user_test_cccc3333" },
      ],
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true },
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    // Must have written key-state.json with accounts
    expect(state.keys).toHaveLength(3)
    expect(state.keys.find((k) => k.name === "personal")?.account).toBe("danielxxomg")
    expect(state.keys.find((k) => k.name === "work")?.account).toBe("work-corp")
    // backup has no account → should be undefined or missing
    expect(state.keys.find((k) => k.name === "backup")?.account).toBeUndefined()
  })

  test("config hook writes notifications config into key-state.json", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111" },
      ],
      notifications: { onRotate: false, onCooldown: true, onRecovery: false, onPermanentDeath: true },
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    // Must include notifications config from keys.json
    expect(state.notifications).toBeDefined()
    expect(state.notifications!.onRotate).toBe(false)
    expect(state.notifications!.onCooldown).toBe(true)
    expect(state.notifications!.onRecovery).toBe(false)
    expect(state.notifications!.onPermanentDeath).toBe(true)
  })

  test("config hook uses DEFAULT_NOTIFICATIONS when keys.json has no notifications", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111" },
      ],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    await plugin.config(config)

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    // Must include default notifications (all true)
    expect(state.notifications).toBeDefined()
    expect(state.notifications!.onRotate).toBe(true)
    expect(state.notifications!.onCooldown).toBe(true)
    expect(state.notifications!.onRecovery).toBe(true)
    expect(state.notifications!.onPermanentDeath).toBe(true)
  })

  test("event hook preserves account and notifications when updating health", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "danielxxomg" },
        { name: "work", key: "user_test_bbbb2222", account: "work-corp" },
      ],
      notifications: { onRotate: false, onCooldown: true, onRecovery: true, onPermanentDeath: false },
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({ keysDir: tmpDir })
    const config = makeConfig()

    // Config hook writes initial state with accounts + notifications
    await plugin.config(config)

    // Now trigger a 429 error on the active key
    await plugin.event({
      event: {
        type: "session.error",
        properties: {
          error: {
            name: "APIError",
            data: { statusCode: 429, message: "rate limited" },
          },
        },
      },
    })

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    // Account must be preserved after event hook writes
    expect(state.keys.find((k) => k.name === "personal")?.account).toBe("danielxxomg")
    expect(state.keys.find((k) => k.name === "work")?.account).toBe("work-corp")

    // Notifications must be preserved
    expect(state.notifications).toBeDefined()
    expect(state.notifications!.onRotate).toBe(false)
    expect(state.notifications!.onPermanentDeath).toBe(false)
  })
})

// ─── L3-T1/T2: models.json cost map loading + LockManager creation ──────────

/** Fake lock coordinator for deterministic config-hook tests (no real file I/O). */
function makeFakeLockManager(
  locked: string[] = [],
  owners: Record<string, string> = {},
): {
  acquireLock: (name: string) => boolean
  releaseLock: (name: string) => void
  refreshLock: (name: string) => boolean
  isLocked: (name: string) => boolean
  getLockOwner: (name: string) => string | null
  getActiveLocks: () => Array<{ keyName: string; instanceId: string; acquiredAt: number; expiresAt: number }>
} {
  return {
    acquireLock: () => true,
    releaseLock: () => {},
    refreshLock: () => true,
    isLocked: (name) => locked.includes(name),
    getLockOwner: (name) => owners[name] ?? null,
    getActiveLocks: () =>
      locked.map((name) => ({
        keyName: name,
        instanceId: owners[name] ?? "inst-x",
        acquiredAt: 1000,
        expiresAt: 9999,
      })),
  }
}

describe("buildCostMap — pure cost map builder from models array", () => {
  test("builds a cost map keyed by model id with input/output/cache_read/cache_write", async () => {
    const { buildCostMap } = await import("./server.js")
    const models = [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        cost: { input: 5, output: 20, cache_read: 0.5 },
      },
    ]
    const map = buildCostMap(models)
    expect(Object.keys(map).length).toBe(2)
    expect(map["claude-sonnet-4-6"]).toEqual({
      input: 3,
      output: 15,
      cache_read: 0.3,
      cache_write: 3.75,
    })
    // cache_write is optional — omitted when absent
    expect(map["gpt-5.4"]).toEqual({ input: 5, output: 20, cache_read: 0.5 })
    expect(map["gpt-5.4"].cache_write).toBeUndefined()
  })

  test("skips entries missing id or cost (tolerant)", async () => {
    const { buildCostMap } = await import("./server.js")
    const models = [
      { id: "good", cost: { input: 1, output: 2, cache_read: 0.1 } },
      { id: "no-cost" },
      { name: "no-id", cost: { input: 1, output: 2, cache_read: 0.1 } },
      { id: "bad-cost", cost: { input: 1 } }, // missing output + cache_read
    ]
    const map = buildCostMap(models)
    expect(Object.keys(map)).toEqual(["good"])
  })

  test("non-array input → empty map", async () => {
    const { buildCostMap } = await import("./server.js")
    expect(buildCostMap(null)).toEqual({})
    expect(buildCostMap({})).toEqual({})
    expect(buildCostMap("not-an-array")).toEqual({})
  })
})

describe("readModelsJson — file reader for cost map", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("reads a valid models.json → returns cost map", async () => {
    const modelsPath = writeRawFile(
      tmpDir,
      "models.json",
      JSON.stringify([
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
      ]),
    )
    const { readModelsJson } = await import("./server.js")
    const map = readModelsJson(modelsPath)
    expect(map).not.toBeNull()
    expect(map!["claude-sonnet-4-6"].input).toBe(3)
  })

  test("missing models.json → returns null (no cost tracking)", async () => {
    const { readModelsJson } = await import("./server.js")
    const map = readModelsJson(path.join(tmpDir, "no-such-models.json"))
    expect(map).toBeNull()
  })

  test("malformed models.json → returns null (graceful, no crash)", async () => {
    const modelsPath = writeRawFile(tmpDir, "models.json", "{not valid json!!!")
    const { readModelsJson } = await import("./server.js")
    const map = readModelsJson(modelsPath)
    expect(map).toBeNull()
  })
})

describe("config hook — models.json cost map + LockManager injection (L3-T2)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("models.json present → modelCosts injected into provider options", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111", account: "acc1" }],
    }
    writeKeysJson(tmpDir, keysData)
    writeRawFile(
      tmpDir,
      "models.json",
      JSON.stringify([
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
      ]),
    )

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.modelCosts).toBeDefined()
    const costMap = ccOptions.modelCosts as Record<string, { input: number; output: number }>
    expect(costMap["claude-sonnet-4-6"].input).toBe(3)
    expect(costMap["claude-sonnet-4-6"].output).toBe(15)
  })

  test("models.json missing → modelCosts NOT set (cost tracking disabled, no crash)", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-such-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.modelCosts).toBeUndefined()
    // apiKeys still injected — only cost tracking disabled
    expect(ccOptions.apiKeys).toBeDefined()
  })

  test("lockManager + instanceId + lockTimeoutMs passed to provider options", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
      rotation: { lockTimeoutMs: 120_000 },
    }
    writeKeysJson(tmpDir, keysData)

    const fakeLock = makeFakeLockManager()
    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: fakeLock,
      instanceId: "inst-abc",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    // The SAME lockManager instance is forwarded (server + provider share it)
    expect(ccOptions.lockManager).toBe(fakeLock)
    expect(ccOptions.instanceId).toBe("inst-abc")
    // lockTimeoutMs from keys.json rotation → forwarded
    expect(ccOptions.lockTimeoutMs).toBe(120_000)
  })

  test("rotation.costPerDollar → forwarded as scoringWeights", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
      rotation: { costPerDollar: 3.5 },
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.scoringWeights).toEqual({ costPerDollar: 3.5 })
  })

  test("no rotation.costPerDollar → scoringWeights NOT set (KeyManager uses default 2.0)", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.scoringWeights).toBeUndefined()
  })

  test("instanceId auto-generated when not provided", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(typeof ccOptions.instanceId).toBe("string")
    expect((ccOptions.instanceId as string).length).toBeGreaterThan(0)
  })

  test("lock status per key written into key-state.json (locked + lockOwner + activeLocks)", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111" },
        { name: "work", key: "user_test_bbbb2222" },
      ],
    }
    writeKeysJson(tmpDir, keysData)

    // "personal" is locked by another instance
    const fakeLock = makeFakeLockManager(["personal"], { personal: "inst-other" })
    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: fakeLock,
      instanceId: "inst-me",
    })
    const config = makeConfig()
    await plugin.config(config)

    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)

    const personal = state.keys.find((k) => k.name === "personal")
    const work = state.keys.find((k) => k.name === "work")
    expect(personal?.locked).toBe(true)
    expect(personal?.lockOwner).toBe("inst-other")
    expect(work?.locked).toBe(false)
    // Top-level active locks summary present
    expect(Array.isArray(state.activeLocks)).toBe(true)
    expect(state.activeLocks!.length).toBe(1)
    expect(state.activeLocks![0]!.keyName).toBe("personal")
  })

  test("default lockTimeoutMs (300000) when keys.json has no rotation.lockTimeoutMs", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.lockTimeoutMs).toBe(300_000)
  })
})

// ─── L3-T3/T4: key-state.json cost + lock data persistence ──────────────────

describe("key-state.json — cost + lock data round-trip", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("writeKeyState persists per-key cost totals + model usage", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    const { writeKeyState, readKeyState } = await import("./server.js")
    const state = {
      activeKey: "personal",
      keys: [
        {
          name: "personal",
          health: "healthy",
          score: 100,
          totalInputTokens: 1200,
          totalOutputTokens: 800,
          totalCacheReadTokens: 400,
          totalCacheWriteTokens: 100,
          totalCostUSD: 0.3,
          modelUsage: {
            "claude-sonnet-4-6": { inputTokens: 1000, outputTokens: 600, costUSD: 0.25 },
            "gpt-5.4": { inputTokens: 200, outputTokens: 200, costUSD: 0.05 },
          },
        },
      ],
    }

    writeKeyState(statePath, state, {})
    const readBack = readKeyState(statePath)

    const personal = readBack.keys.find((k) => k.name === "personal")!
    expect(personal.totalInputTokens).toBe(1200)
    expect(personal.totalOutputTokens).toBe(800)
    expect(personal.totalCacheReadTokens).toBe(400)
    expect(personal.totalCacheWriteTokens).toBe(100)
    expect(personal.totalCostUSD).toBe(0.3)
    expect(personal.modelUsage).toBeDefined()
    expect(personal.modelUsage!["claude-sonnet-4-6"].costUSD).toBe(0.25)
    expect(personal.modelUsage!["gpt-5.4"].inputTokens).toBe(200)
  })

  test("writeKeyState persists per-key lock status (locked + lockOwner)", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    const { writeKeyState, readKeyState } = await import("./server.js")
    const state = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100, locked: true, lockOwner: "inst-abc" },
        { name: "work", health: "healthy", score: 90, locked: false, lockOwner: null },
      ],
      activeLocks: [
        { keyName: "personal", instanceId: "inst-abc", acquiredAt: 1000, expiresAt: 9999 },
      ],
    }

    writeKeyState(statePath, state, {})
    const readBack = readKeyState(statePath)

    expect(readBack.keys.find((k) => k.name === "personal")?.locked).toBe(true)
    expect(readBack.keys.find((k) => k.name === "personal")?.lockOwner).toBe("inst-abc")
    expect(readBack.keys.find((k) => k.name === "work")?.locked).toBe(false)
    expect(readBack.activeLocks).toBeDefined()
    expect(readBack.activeLocks!.length).toBe(1)
    expect(readBack.activeLocks![0]!.instanceId).toBe("inst-abc")
  })

  test("readKeyState tolerates keys missing cost + lock fields (phase 1+2 files)", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    // An old phase 1+2 key-state.json — no cost/lock fields at all
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        activeKey: "personal",
        keys: [{ name: "personal", health: "healthy", score: 100, account: "acc1" }],
        lastRotation: 5000,
      }),
      "utf-8",
    )

    const { readKeyState } = await import("./server.js")
    const result = readKeyState(statePath)

    expect(result.keys).toHaveLength(1)
    expect(result.keys[0]!.name).toBe("personal")
    // Cost/lock fields default to undefined (no crash, no NaN)
    expect(result.keys[0]!.totalCostUSD).toBeUndefined()
    expect(result.keys[0]!.locked).toBeUndefined()
    expect(result.keys[0]!.lockOwner).toBeUndefined()
    expect(result.activeLocks).toBeUndefined()
  })

  test("atomic write preserved with cost + lock fields (temp + rename, no regression)", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    const { writeKeyState } = await import("./server.js")
    const state = {
      activeKey: "personal",
      keys: [
        {
          name: "personal",
          health: "healthy",
          score: 100,
          totalCostUSD: 0.42,
          locked: true,
          lockOwner: "inst-x",
        },
      ],
      activeLocks: [{ keyName: "personal", instanceId: "inst-x", acquiredAt: 1, expiresAt: 2 }],
    }

    writeKeyState(statePath, state, {})

    // Temp file must NOT remain after a successful atomic write
    expect(fs.existsSync(statePath + ".tmp")).toBe(false)
    // Final file is valid JSON with the cost + lock data intact
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"))
    expect(parsed.keys[0].totalCostUSD).toBe(0.42)
    expect(parsed.keys[0].locked).toBe(true)
    expect(parsed.activeLocks[0].keyName).toBe("personal")
  })
})

// ─── Fix 1/2/3: runtime state bridge — pure helpers ──────────────────────────

describe("runtime state bridge — pure helpers (Fix 1/2/3)", () => {
  test("deriveHealthString: dead → 'dead', in-cooldown → 'cooldown', else 'healthy'", async () => {
    const { deriveHealthString } = await import("./server.js")
    const now = 5000
    expect(deriveHealthString({ permanentlyDead: true, cooldownExpiry: 0 } as any, now)).toBe("dead")
    expect(deriveHealthString({ permanentlyDead: false, cooldownExpiry: 9000 } as any, now)).toBe("cooldown")
    expect(deriveHealthString({ permanentlyDead: false, cooldownExpiry: 1000 } as any, now)).toBe("healthy")
  })

  test("buildInitialSnapshot: maps keys.json + existing state → snapshot with key strings + cost (Fix 2)", async () => {
    const { buildInitialSnapshot } = await import("./server.js")
    const keysFromJson: KeyEntry[] = [
      { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
      { name: "work", key: "user_test_bbbb2222" },
    ]
    const existing = {
      activeKey: "personal",
      keys: [
        {
          name: "personal", health: "healthy", score: 80, cooldownExpiry: 0,
          totalInputTokens: 1200, totalOutputTokens: 800, totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0, totalCostUSD: 0.3,
          modelUsage: { m: { inputTokens: 1200, outputTokens: 800, costUSD: 0.3 } },
        },
        { name: "work", health: "healthy", score: 100 },
      ],
    }
    const snap = buildInitialSnapshot(keysFromJson, existing)
    expect(snap).toHaveLength(2)
    const personal = snap.find((s) => s.name === "personal")!
    // key string comes from keys.json (secret) so importState can match by key.
    expect(personal.key).toBe("user_test_aaaa1111")
    expect(personal.health.totalInputTokens).toBe(1200)
    expect(personal.health.totalCostUSD).toBeCloseTo(0.3, 10)
    expect(personal.health.score).toBe(80)
    expect(personal.health.modelUsage["m"]!.costUSD).toBeCloseTo(0.3, 10)
    // work had no cost data → zero defaults, score 100.
    const work = snap.find((s) => s.name === "work")!
    expect(work.key).toBe("user_test_bbbb2222")
    expect(work.health.totalInputTokens).toBe(0)
    expect(work.health.totalCostUSD).toBe(0)
    expect(work.health.score).toBe(100)
  })

  test("buildInitialStateKeys: preserves existing cost on config rewrite; fresh for new keys (Fix 2)", async () => {
    const { buildInitialStateKeys } = await import("./server.js")
    const keysFromJson: KeyEntry[] = [
      { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
      { name: "newkey", key: "user_test_cccc3333" },
    ]
    const existing = {
      activeKey: "personal",
      keys: [
        {
          name: "personal", health: "healthy", score: 80,
          totalInputTokens: 1200, totalOutputTokens: 800, totalCostUSD: 0.3,
          modelUsage: { m: { inputTokens: 1200, outputTokens: 800, costUSD: 0.3 } },
        },
      ],
    }
    const lock = makeFakeLockManager(["personal"], { personal: "inst-x" })
    const keys = buildInitialStateKeys(keysFromJson, existing, lock)
    expect(keys).toHaveLength(2)
    const personal = keys.find((k) => k.name === "personal")!
    // Existing cost preserved (NOT overwritten with zeros).
    expect(personal.totalInputTokens).toBe(1200)
    expect(personal.totalCostUSD).toBeCloseTo(0.3, 10)
    expect(personal.score).toBe(80)
    expect(personal.modelUsage!["m"]!.costUSD).toBeCloseTo(0.3, 10)
    expect(personal.account).toBe("acc1")
    // Live lock status from the lockManager.
    expect(personal.locked).toBe(true)
    expect(personal.lockOwner).toBe("inst-x")
    // New key (not in existing state) → fresh defaults, no cost fields.
    const newkey = keys.find((k) => k.name === "newkey")!
    expect(newkey.score).toBe(100)
    expect(newkey.health).toBe("healthy")
    expect(newkey.totalCostUSD).toBeUndefined()
    expect(newkey.locked).toBe(false)
  })

  test("applySnapshotToState: maps snapshot → KeyStateEntry (cost + lock + derived health, account preserved)", async () => {
    const { applySnapshotToState } = await import("./server.js")
    const existing = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100, account: "acc1" },
        { name: "work", health: "healthy", score: 100, account: "acc2" },
      ],
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true, onLockRelease: true },
      lastRotation: 9000,
    }
    const snapshot = [
      {
        name: "personal", key: "user_test_aaaa1111", locked: true, lockOwner: "inst-x",
        health: {
          score: 75, cooldownExpiry: 0, successCount: 4, failureCount: 1,
          rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
          lastUsedAt: 8000, lastCooldownAt: 0, totalInputTokens: 5000,
          totalOutputTokens: 2000, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 0.42, modelUsage: { m: { inputTokens: 5000, outputTokens: 2000, costUSD: 0.42 } },
        },
      },
      {
        name: "work", key: "user_test_bbbb2222", locked: false, lockOwner: null,
        health: {
          score: 0, cooldownExpiry: 0, successCount: 0, failureCount: 0,
          rateLimitHits: 0, authErrors: 1, permanentlyDead: true,
          lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 0,
          totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 0, modelUsage: {},
        },
      },
    ]
    const merged = applySnapshotToState(existing, snapshot as any, 1000)
    // Top-level fields preserved from existing.
    expect(merged.activeKey).toBe("personal")
    expect(merged.lastRotation).toBe(9000)
    expect(merged.notifications).toEqual(existing.notifications)
    // Per-key: cost + score + derived health + lock, account preserved by name.
    const personal = merged.keys.find((k) => k.name === "personal")!
    expect(personal.score).toBe(75)
    expect(personal.totalInputTokens).toBe(5000)
    expect(personal.totalCostUSD).toBeCloseTo(0.42, 10)
    expect(personal.modelUsage!["m"]!.costUSD).toBeCloseTo(0.42, 10)
    expect(personal.locked).toBe(true)
    expect(personal.lockOwner).toBe("inst-x")
    expect(personal.account).toBe("acc1")
    expect(personal.health).toBe("healthy") // not dead, not in cooldown
    // Dead key → health "dead", score 0.
    const work = merged.keys.find((k) => k.name === "work")!
    expect(work.health).toBe("dead")
    expect(work.score).toBe(0)
    expect(work.account).toBe("acc2")
    // Secrets (key strings) are NEVER written to KeyStateEntry.
    expect((personal as any).key).toBeUndefined()
    expect((work as any).key).toBeUndefined()
  })
})

// ─── Fix 1/2/3: config hook wires the runtime state bridge ───────────────────

describe("config hook — runtime state bridge wiring (Fix 1/2/3)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("existing key-state.json with cost → initialKeyState passed to provider options (Fix 2)", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222" },
      ],
    }
    writeKeysJson(tmpDir, keysData)
    // Seed existing key-state.json with cost data for "personal".
    writeRawFile(
      tmpDir,
      "key-state.json",
      JSON.stringify({
        activeKey: "personal",
        keys: [
          {
            name: "personal", health: "healthy", score: 80,
            totalInputTokens: 1200, totalOutputTokens: 800, totalCostUSD: 0.3,
            modelUsage: { m: { inputTokens: 1200, outputTokens: 800, costUSD: 0.3 } },
          },
          { name: "work", health: "healthy", score: 100 },
        ],
      }),
    )

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.initialKeyState).toBeDefined()
    const snap = ccOptions.initialKeyState as Array<{ name: string; key: string; health: { totalInputTokens: number; totalCostUSD: number; score: number } }>
    const personal = snap.find((s) => s.name === "personal")!
    // key string from keys.json (so KeyManager.importState can match by key).
    expect(personal.key).toBe("user_test_aaaa1111")
    expect(personal.health.totalInputTokens).toBe(1200)
    expect(personal.health.totalCostUSD).toBeCloseTo(0.3, 10)
    expect(personal.health.score).toBe(80)
  })

  test("config hook rewrite preserves existing cost totals (merge, not zero) (Fix 2)", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222" },
      ],
    }
    writeKeysJson(tmpDir, keysData)
    writeRawFile(
      tmpDir,
      "key-state.json",
      JSON.stringify({
        activeKey: "personal",
        keys: [
          {
            name: "personal", health: "healthy", score: 80,
            totalInputTokens: 1200, totalOutputTokens: 800, totalCostUSD: 0.3,
            modelUsage: { m: { inputTokens: 1200, outputTokens: 800, costUSD: 0.3 } },
          },
        ],
      }),
    )

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const state = readKeyState(path.join(tmpDir, "key-state.json"))
    const personal = state.keys.find((k) => k.name === "personal")!
    // Cost preserved across the config rewrite (NOT overwritten with zeros).
    expect(personal.totalInputTokens).toBe(1200)
    expect(personal.totalOutputTokens).toBe(800)
    expect(personal.totalCostUSD).toBeCloseTo(0.3, 10)
    expect(personal.score).toBe(80)
    expect(personal.modelUsage!["m"]!.costUSD).toBeCloseTo(0.3, 10)
    // New key "work" (not in existing state) → fresh defaults.
    const work = state.keys.find((k) => k.name === "work")!
    expect(work.score).toBe(100)
    expect(work.totalCostUSD).toBeUndefined()
  })

  test("onStateChange callback writes snapshot to key-state.json (cost + lock, merged) (Fix 1/3)", async () => {
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222" },
      ],
    }
    writeKeysJson(tmpDir, keysData)

    const fakeLock = makeFakeLockManager(["personal"], { personal: "inst-x" })
    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: fakeLock,
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    expect(ccOptions.onStateChange).toBeDefined()
    const onStateChange = ccOptions.onStateChange as (snap: unknown[]) => void

    // Simulate the provider emitting a snapshot after reportUsage + lock acquire.
    onStateChange([
      {
        name: "personal", key: "user_test_aaaa1111", locked: true, lockOwner: "inst-x",
        health: {
          score: 75, cooldownExpiry: 0, successCount: 4, failureCount: 0,
          rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
          lastUsedAt: 8000, lastCooldownAt: 0, totalInputTokens: 5000,
          totalOutputTokens: 2000, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 0.42, modelUsage: { m: { inputTokens: 5000, outputTokens: 2000, costUSD: 0.42 } },
        },
      },
      {
        name: "work", key: "user_test_bbbb2222", locked: false, lockOwner: null,
        health: {
          score: 100, cooldownExpiry: 0, successCount: 0, failureCount: 0,
          rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
          lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 0,
          totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 0, modelUsage: {},
        },
      },
    ])

    const state = readKeyState(path.join(tmpDir, "key-state.json"))
    const personal = state.keys.find((k) => k.name === "personal")!
    // Cost flowed provider → onStateChange → key-state.json (Fix 1).
    expect(personal.totalInputTokens).toBe(5000)
    expect(personal.totalCostUSD).toBeCloseTo(0.42, 10)
    expect(personal.modelUsage!["m"]!.costUSD).toBeCloseTo(0.42, 10)
    // Lock status live in key-state.json (Fix 3).
    expect(personal.locked).toBe(true)
    expect(personal.lockOwner).toBe("inst-x")
    // account preserved across the merge.
    expect(personal.account).toBe("acc1")
    // activeLocks refreshed from the lockManager (Fix 3).
    expect(state.activeLocks).toBeDefined()
    expect(state.activeLocks!.length).toBe(1)
    expect(state.activeLocks![0]!.keyName).toBe("personal")
    // Secrets NEVER persisted.
    expect((personal as any).key).toBeUndefined()
  })

  test("no existing key-state.json → initialKeyState still provided (zero defaults), onStateChange set", async () => {
    const keysData = {
      keys: [{ name: "personal", key: "user_test_aaaa1111" }],
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    // Bridge always wired when keys.json is valid (cost/lock flow at runtime).
    expect(ccOptions.onStateChange).toBeDefined()
    expect(ccOptions.initialKeyState).toBeDefined()
    const snap = ccOptions.initialKeyState as Array<{ name: string; health: { totalCostUSD: number; score: number } }>
    // No prior cost → zero defaults, score 100.
    expect(snap[0]!.health.totalCostUSD).toBe(0)
    expect(snap[0]!.health.score).toBe(100)
  })
})

// ─── L5-T2: backward compat — old keys.json (no phase 3 fields) ─────────────

describe("backward compat — old keys.json without phase 3 fields → defaults applied", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("old-format keys.json → defaults (lockTimeoutMs 300000, costPerDollar 2.0 via no scoringWeights), no crash", async () => {
    // Phase 1+2 keys.json: NO rotation.lockTimeoutMs, NO costPerDollar, NO scoringWeights,
    // NO notifications.onLockRelease, NO models.json.
    const keysData = {
      keys: [
        { name: "personal", key: "user_test_aaaa1111", account: "acc1" },
        { name: "work", key: "user_test_bbbb2222", account: "acc2" },
      ],
      rotation: { strategy: "weighted-random" },
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true },
    }
    writeKeysJson(tmpDir, keysData)

    const { createServerPlugin, readKeyState } = await import("./server.js")
    const plugin = createServerPlugin({
      keysDir: tmpDir,
      modelsFile: path.join(tmpDir, "no-models.json"),
      lockManager: makeFakeLockManager(),
      instanceId: "inst-test",
    })
    const config = makeConfig()
    await plugin.config(config)

    const ccOptions = config.provider?.commandcode?.options as Record<string, unknown>
    // apiKeys still injected (rotation works)
    expect(ccOptions.apiKeys).toBeDefined()
    expect(ccOptions.apiKeys).toHaveLength(2)
    // lockManager created + forwarded (default timeout)
    expect(ccOptions.lockManager).toBeDefined()
    expect(ccOptions.lockTimeoutMs).toBe(300_000)
    // No cost config → no modelCosts, no scoringWeights (KeyManager defaults costPerDollar to 2.0)
    expect(ccOptions.modelCosts).toBeUndefined()
    expect(ccOptions.scoringWeights).toBeUndefined()
    expect(ccOptions.instanceId).toBe("inst-test")

    // key-state.json: onLockRelease defaults to true; lock status present (unlocked at init)
    const statePath = path.join(tmpDir, "key-state.json")
    const state = readKeyState(statePath)
    expect(state.notifications!.onLockRelease).toBe(true)
    expect(state.keys.every((k) => k.locked === false)).toBe(true)
  })

  test("old key-state.json (no cost/lock fields) → read tolerantly, no crash", async () => {
    const statePath = path.join(tmpDir, "key-state.json")
    // A phase 1+2 key-state.json — no cost/lock/activeLocks fields
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        activeKey: "personal",
        keys: [{ name: "personal", health: "healthy", score: 100, account: "acc1" }],
        lastRotation: 5000,
        notifications: {
          onRotate: true,
          onCooldown: true,
          onRecovery: true,
          onPermanentDeath: true,
        },
      }),
      "utf-8",
    )

    const { readKeyState } = await import("./server.js")
    const state = readKeyState(statePath)
    // Parses cleanly; phase 3 fields default to undefined (no crash, no NaN)
    expect(state.activeKey).toBe("personal")
    expect(state.keys).toHaveLength(1)
    expect(state.keys[0]!.totalCostUSD).toBeUndefined()
    expect(state.keys[0]!.locked).toBeUndefined()
    expect(state.activeLocks).toBeUndefined()
    // onLockRelease missing → undefined (TUI falls back to DEFAULT_NOTIFICATIONS)
    expect(state.notifications?.onLockRelease).toBeUndefined()
  })
})
