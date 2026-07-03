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
