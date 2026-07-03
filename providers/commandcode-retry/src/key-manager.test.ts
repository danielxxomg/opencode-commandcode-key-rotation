import { describe, test, expect } from "bun:test"
import { KeyManager, type KeyLockCoordinator } from "./key-manager.js"
import type { LanguageModelV3Usage } from "@ai-sdk/provider"

// Phase 3 test helpers — fake keys only (never real secrets).
function makeUsage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): LanguageModelV3Usage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead, cacheWrite },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  }
}

function makeLockMock(opts: {
  locked: string[]
  expiry?: Record<string, number>
  owners?: Record<string, string>
}): KeyLockCoordinator {
  const lockedSet = new Set(opts.locked)
  return {
    isLocked: (name: string) => lockedSet.has(name),
    getLockOwner: (name: string) => opts.owners?.[name] ?? null,
    getActiveLocks: () =>
      Object.entries(opts.expiry ?? {}).map(([keyName, expiresAt]) => ({
        keyName,
        expiresAt,
      })),
  }
}

describe("KeyManager", () => {
  describe("construction", () => {
    test("initializes with multiple keys all at score 100", () => {
      const km = new KeyManager({
        keys: [
          { name: "personal", key: "user_aaaa1111", account: "acc1" },
          { name: "work", key: "user_bbbb2222", account: "acc2" },
        ],
      })
      const health = km.getHealthSnapshot()
      expect(health).toHaveLength(2)
      expect(health[0]!.health.score).toBe(100)
      expect(health[1]!.health.score).toBe(100)
    })

    test("stores key entries with name, key, and account", () => {
      const km = new KeyManager({
        keys: [
          { name: "personal", key: "user_aaaa1111", account: "acc1" },
        ],
      })
      const entries = km.getKeyEntries()
      expect(entries).toHaveLength(1)
      expect(entries[0]!.name).toBe("personal")
      expect(entries[0]!.key).toBe("user_aaaa1111")
      expect(entries[0]!.account).toBe("acc1")
    })
  })

  describe("selectKey()", () => {
    test("selects a key from the pool", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.5,
        now: () => 1000,
      })
      const selected = km.selectKey()
      expect(["user_aaaa1111", "user_bbbb2222"]).toContain(selected.key)
    })

    test("weighted random favors higher-scored keys", () => {
      // A has score 100, B has score 100 initially.
      // With random=0.25, should select A (first half of 0..1 range)
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.25,
        now: () => 1000,
      })
      const selected = km.selectKey()
      expect(selected.key).toBe("user_aaaa1111")
    })

    test("after 429 on A, selects B (A enters cooldown)", () => {
      let callCount = 0
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => {
          callCount++
          // First call: selects A (random=0.25)
          // After cooldown: A is filtered out, B is only option
          return callCount <= 1 ? 0.25 : 0.5
        },
        now: () => 1000,
      })

      // First select gets A
      const first = km.selectKey()
      expect(first.key).toBe("user_aaaa1111")

      // Report 429 on A — enters 60s cooldown
      km.reportRateLimit(first.key)

      // Next select should skip A (in cooldown) and get B
      const second = km.selectKey()
      expect(second.key).toBe("user_bbbb2222")
    })
  })

  describe("zero-score edge case (REQ-3)", () => {
    test("zero-score keys selected via uniform random without crash", () => {
      let currentTime = 1000
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.5,
        now: () => currentTime,
      })

      // Drive scores to 0 via rate limits (each -10, from 100 → 0 after 10 hits)
      for (let i = 0; i < 10; i++) {
        km.reportRateLimit("user_aaaa1111")
        km.reportRateLimit("user_bbbb2222")
      }

      // Advance past all cooldowns
      currentTime = 999_999_999

      const snapshot = km.getHealthSnapshot()
      expect(snapshot[0]!.health.score).toBe(0)
      expect(snapshot[1]!.health.score).toBe(0)

      // selectKey should NOT crash (uniform random fallback)
      const selected = km.selectKey()
      expect(["user_aaaa1111", "user_bbbb2222"]).toContain(selected.key)
    })
  })

  describe("Retry-After cooldown (REQ-5)", () => {
    test("respects Retry-After header value as cooldown", () => {
      let currentTime = 1000
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.25, // selects A first
        now: () => currentTime,
      })

      const selected = km.selectKey()
      expect(selected.key).toBe("user_aaaa1111")

      // 429 with Retry-After: 120s → cooldown = 120000ms
      km.reportRateLimit(selected.key, 120_000)

      const health = km.getHealthSnapshot()
      const aHealth = health.find((h) => h.key === "user_aaaa1111")!
      expect(aHealth.health.cooldownExpiry).toBe(1000 + 120_000)

      // At 60s — still in cooldown
      currentTime = 1000 + 60_000
      const second = km.selectKey()
      expect(second.key).toBe("user_bbbb2222") // B selected, A in cooldown

      // At 121s — A is out of cooldown
      currentTime = 1000 + 121_000
      const third = km.selectKey()
      // Both eligible now — with random=0.25, A gets selected
      expect(third.key).toBe("user_aaaa1111")
    })

    test("Retry-After capped at 300 seconds", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
      })

      km.reportRateLimit("user_aaaa1111", 600_000) // 10 min → should cap to 300s

      const health = km.getHealthSnapshot()
      expect(health[0]!.health.cooldownExpiry).toBe(1000 + 300_000)
    })
  })

  describe("auth permanent death (REQ-6)", () => {
    test("401 marks key permanently dead", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.25,
        now: () => 1000,
      })

      km.reportAuthError("user_aaaa1111")

      const health = km.getHealthSnapshot()
      const aHealth = health.find((h) => h.key === "user_aaaa1111")!
      expect(aHealth.health.permanentlyDead).toBe(true)
      expect(aHealth.health.score).toBe(0)

      // selectKey should skip dead A and return B
      const selected = km.selectKey()
      expect(selected.key).toBe("user_bbbb2222")
    })
  })

  describe("quota-vs-auth precedence (REQ-7)", () => {
    test("401 with quota wording → auth wins (permanent death, not cooldown)", () => {
      // When status is 401/403, auth takes precedence even if body contains
      // quota patterns. This is enforced at the provider level, but KeyManager
      // reportAuthError is the correct call path.
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
      })

      // Auth error should permanently kill, not just cooldown
      km.reportAuthError("user_aaaa1111")

      const health = km.getHealthSnapshot()
      const aHealth = health.find((h) => h.key === "user_aaaa1111")!
      expect(aHealth.health.permanentlyDead).toBe(true)
      // NOT just a cooldown — permanently dead
      expect(aHealth.health.authErrors).toBe(1)
    })
  })

  describe("config hot-reload (REQ-11)", () => {
    test("reloadKeys adds new keys with fresh health", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
      })

      // Degrade A
      for (let i = 0; i < 5; i++) km.reportRateLimit("user_aaaa1111")
      const before = km.getHealthSnapshot()
      expect(before.find((h) => h.key === "user_aaaa1111")!.health.score).toBe(50)

      // Hot-reload: add C, keep A and B
      km.reloadKeys([
        { name: "a", key: "user_aaaa1111" },
        { name: "b", key: "user_bbbb2222" },
        { name: "c", key: "user_cccc3333" },
      ])

      const after = km.getHealthSnapshot()
      expect(after).toHaveLength(3)
      // A's health is preserved (degraded)
      expect(after.find((h) => h.key === "user_aaaa1111")!.health.score).toBe(50)
      // C is new with fresh health
      expect(after.find((h) => h.key === "user_cccc3333")!.health.score).toBe(100)
    })

    test("reloadKeys removes keys no longer in list", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
      })

      km.reloadKeys([{ name: "a", key: "user_aaaa1111" }])

      const after = km.getHealthSnapshot()
      expect(after).toHaveLength(1)
      expect(after[0]!.key).toBe("user_aaaa1111")
    })
  })

  describe("emergency fallback (REQ-2)", () => {
    test("all non-dead keys in cooldown → returns least-recently-cooldowned non-dead key", () => {
      let currentTime = 1000
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
          { name: "c", key: "user_cccc3333" },
        ],
        now: () => currentTime,
      })

      // Put A in cooldown at t=1000
      km.reportRateLimit("user_aaaa1111")
      // Put B in cooldown at t=2000
      currentTime = 2000
      km.reportRateLimit("user_bbbb2222")
      // C is dead
      km.reportAuthError("user_cccc3333")

      // All non-dead keys (A, B) are in cooldown. C is dead.
      // Emergency: pick least-recently-cooldowned non-dead → A (cooldownAt=1000)
      const selected = km.selectKey()
      expect(selected.key).toBe("user_aaaa1111")
      // Must NOT pick the dead key
      expect(selected.key).not.toBe("user_cccc3333")
    })

    test("emergency fallback picks the key with oldest lastCooldownAt", () => {
      let currentTime = 1000
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => currentTime,
      })

      // B enters cooldown first at t=500
      currentTime = 500
      km.reportRateLimit("user_bbbb2222")
      // A enters cooldown later at t=1500
      currentTime = 1500
      km.reportRateLimit("user_aaaa1111")

      // Both in cooldown. Emergency should pick B (oldest cooldownAt=500)
      currentTime = 1600
      const selected = km.selectKey()
      expect(selected.key).toBe("user_bbbb2222")
    })
  })

  describe("file-backed hot-reload (REQ-11)", () => {
    test("reloads keys when file mtime changes between selectKey() calls", () => {
      let currentMtime = 1000
      const fileKeys = [
        { name: "a", key: "user_aaaa1111" },
        { name: "b", key: "user_bbbb2222" },
      ]

      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
        keysFile: "/fake/keys.json",
        readKeysFile: () => fileKeys,
        getMtime: () => currentMtime,
      })

      // Initially only 1 key (from constructor)
      expect(km.getKeyEntries()).toHaveLength(1)

      // File changes — mtime advances
      currentMtime = 2000
      fileKeys.push({ name: "c", key: "user_cccc3333" })

      // Next selectKey should detect mtime change and reload
      const selected = km.selectKey()
      expect(km.getKeyEntries()).toHaveLength(3)
      expect(["user_aaaa1111", "user_bbbb2222", "user_cccc3333"]).toContain(selected.key)
    })

    test("does NOT reload when file mtime is unchanged", () => {
      let readCount = 0
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
        keysFile: "/fake/keys.json",
        readKeysFile: () => {
          readCount++
          return [
            { name: "a", key: "user_aaaa1111" },
            { name: "b", key: "user_bbbb2222" },
          ]
        },
        getMtime: () => 1000, // always same mtime
      })

      // First call triggers initial load (lastMtime was 0, now 1000)
      km.selectKey()
      expect(readCount).toBe(1)

      // Subsequent calls: mtime unchanged → no reload
      km.selectKey()
      km.selectKey()
      expect(readCount).toBe(1)
    })

    test("hot-reload preserves health for existing keys", () => {
      let currentMtime = 1000
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
        keysFile: "/fake/keys.json",
        readKeysFile: () => [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
          { name: "c", key: "user_cccc3333" },
        ],
        getMtime: () => currentMtime,
      })

      // Degrade A's health
      for (let i = 0; i < 5; i++) km.reportRateLimit("user_aaaa1111")
      const beforeHealth = km.getHealthSnapshot()
      expect(beforeHealth.find((h) => h.key === "user_aaaa1111")!.health.score).toBe(50)

      // File changes → reload
      currentMtime = 2000
      km.selectKey()

      const afterHealth = km.getHealthSnapshot()
      // A's degraded health preserved
      expect(afterHealth.find((h) => h.key === "user_aaaa1111")!.health.score).toBe(50)
      // C is new with fresh health
      expect(afterHealth.find((h) => h.key === "user_cccc3333")!.health.score).toBe(100)
    })

    test("no hot-reload when keysFile is not provided (manual reloadKeys only)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
        // No keysFile, readKeysFile, or getMtime
      })

      // Should work fine — just no auto-reload
      const selected = km.selectKey()
      expect(selected.key).toBe("user_aaaa1111")
      expect(km.getKeyEntries()).toHaveLength(1)
    })
  })

  describe("all-dead fatal (REQ-2)", () => {
    test("throws fatal error when all keys permanently dead", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
      })
      km.reportAuthError("user_aaaa1111")
      km.reportAuthError("user_bbbb2222")

      expect(() => km.selectKey()).toThrow(/All keys permanently dead/)
    })
  })

  // ============================================================
  // Phase 3 — KeyManager extensions (L1-T1..L1-T9 / tasks 2.1-2.9)
  // ============================================================

  describe("reportUsage — cost tracking (L1-T1, L1-T2)", () => {
    const costMap = {
      "test-model": { input: 1000, output: 0, cache_read: 0, cache_write: 0 },
    }

    test("accumulates input/output tokens on KeyHealth", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 500))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalInputTokens).toBe(1000)
      expect(h.totalOutputTokens).toBe(500)
    })

    test("accumulates cache read/write tokens", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 500, 800, 200))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalCacheReadTokens).toBe(800)
      expect(h.totalCacheWriteTokens).toBe(200)
    })

    test("standard cost calculation matches spec (claude-sonnet-4-6)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: {
          "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "claude-sonnet-4-6", makeUsage(1000, 500))
      const h = km.getHealthSnapshot()[0]!.health
      // 1000×3/1M + 500×15/1M = 0.003 + 0.0075 = 0.0105
      expect(h.totalCostUSD).toBeCloseTo(0.0105, 10)
    })

    test("missing cache_write cost treated as 0", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: {
          "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3 },
        },
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "claude-sonnet-4-6", makeUsage(1000, 500, 800, 500))
      const h = km.getHealthSnapshot()[0]!.health
      // cacheWrite contributes 0; 1000×3/1M + 500×15/1M + 800×0.3/1M + 0 = 0.01074
      expect(h.totalCostUSD).toBeCloseTo(0.01074, 10)
      expect(h.totalCacheWriteTokens).toBe(500)
    })

    test("tracks per-model usage breakdown", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: {
          m1: { input: 1000, output: 0, cache_read: 0, cache_write: 0 },
          m2: { input: 2000, output: 0, cache_read: 0, cache_write: 0 },
        },
        now: () => 1000,
      })
      // m1: 1000 input × 1000/1M = 1.0 USD
      km.reportUsage("user_aaaa1111", "m1", makeUsage(1000, 0))
      // m2: 1000 input × 2000/1M = 2.0 USD
      km.reportUsage("user_aaaa1111", "m2", makeUsage(1000, 0))
      const h = km.getHealthSnapshot()[0]!.health
      expect(Object.keys(h.modelUsage).sort()).toEqual(["m1", "m2"])
      expect(h.modelUsage["m1"]!.inputTokens).toBe(1000)
      expect(h.modelUsage["m1"]!.costUSD).toBeCloseTo(1.0, 10)
      expect(h.modelUsage["m2"]!.inputTokens).toBe(1000)
      expect(h.modelUsage["m2"]!.costUSD).toBeCloseTo(2.0, 10)
      expect(h.totalCostUSD).toBeCloseTo(3.0, 10)
    })

    test("no costMap → tokens tracked, cost stays 0", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 500, 300, 200))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalInputTokens).toBe(1000)
      expect(h.totalOutputTokens).toBe(500)
      expect(h.totalCacheReadTokens).toBe(300)
      expect(h.totalCacheWriteTokens).toBe(200)
      expect(h.totalCostUSD).toBe(0)
    })

    test("unknown model in costMap → cost 0, tokens still tracked", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { known: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "unknown-model", makeUsage(1000, 0))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalInputTokens).toBe(1000)
      expect(h.totalCostUSD).toBe(0)
    })

    test("unknown key → no-op", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportUsage("user_doesnotexist", "test-model", makeUsage(1000, 0))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalInputTokens).toBe(0)
      expect(h.totalCostUSD).toBe(0)
    })
  })

  describe("reportUsage — cost penalty scoring (L1-T3, L1-T4)", () => {
    const costMap = {
      "test-model": { input: 1000, output: 0, cache_read: 0, cache_write: 0 },
    }

    test("default costPerDollar 2.0 reduces score by cost×2", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      // cost = 1000 × 1000/1M = 1.0 USD → penalty 1.0 × 2.0 = 2.0 → score 98
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(98)
    })

    test("configurable costPerDollar via scoringWeights", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        scoringWeights: { costPerDollar: 5.0 },
        now: () => 1000,
      })
      // cost 1.0 × 5.0 = 5.0 → score 95
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(95)
    })

    test("configurable costPerDollar top-level option", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        costPerDollar: 5.0,
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(95)
    })

    test("score floored at 0 (cannot go negative)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      // 2,000,000 input × 1000/1M = 2000 USD → penalty 4000 → score max(0, 100-4000) = 0
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(2_000_000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(0)
    })

    test("zero cost (no costMap) → score unchanged", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(100)
    })

    test("cost penalty accumulates across multiple reportUsage calls", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      // two calls: cost 1.0 each → penalty 2 + 2 = 4 → score 96
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      km.reportUsage("user_aaaa1111", "test-model", makeUsage(1000, 0))
      expect(km.getHealthSnapshot()[0]!.health.score).toBe(96)
      expect(km.getHealthSnapshot()[0]!.health.totalCostUSD).toBeCloseTo(2.0, 10)
    })
  })

  describe("lock-aware selectKey (L1-T5, L1-T6)", () => {
    test("prefers unlocked keys over locked ones", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
          { name: "c", key: "user_cccc3333" },
        ],
        random: () => 0,
        now: () => 1000,
        lockManager: makeLockMock({ locked: ["a"] }),
      })
      const selected = km.selectKey()
      // "a" is locked → must not be selected; with random=0 picks first unlocked (b)
      expect(selected.key).not.toBe("user_aaaa1111")
      expect(selected.key).toBe("user_bbbb2222")
    })

    test("all eligible keys locked → falls back to earliest-expiry", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0,
        now: () => 1000,
        lockManager: makeLockMock({
          locked: ["a", "b"],
          expiry: { a: 5000, b: 3000 },
        }),
      })
      const selected = km.selectKey()
      // both locked → earliest expiry is "b" (3000)
      expect(selected.key).toBe("user_bbbb2222")
    })

    test("no lockManager → no lock checks (backward compat)", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0,
        now: () => 1000,
        // no lockManager — "a" would be locked but is NOT checked
      })
      const selected = km.selectKey()
      // no lock filtering → random=0 picks first (a)
      expect(selected.key).toBe("user_aaaa1111")
    })

    test("only one unlocked key → returns it regardless of random", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0,
        now: () => 1000,
        lockManager: makeLockMock({ locked: ["a"] }),
      })
      // "a" locked → only b is eligible+unlocked → must return b.
      // (Without lock filtering, random=0 would pick "a" — so this proves filtering.)
      const selected = km.selectKey()
      expect(selected.key).toBe("user_bbbb2222")
    })
  })

  describe("reportSuccess extended with usage (L1-T7, L1-T8)", () => {
    const costMap = {
      "test-model": { input: 1000, output: 0, cache_read: 0, cache_write: 0 },
    }

    test("with usage → success tracking AND cost tracking happen", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportSuccess("user_aaaa1111", "test-model", makeUsage(1000, 0))
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.successCount).toBe(1)
      // success bonus: min(1×0.1, 50) = 0.1 → score 100.1; cost penalty: 1.0×2=2 → 98.1
      expect(h.score).toBeCloseTo(98.1, 5)
      expect(h.totalCostUSD).toBeCloseTo(1.0, 10)
      expect(h.totalInputTokens).toBe(1000)
    })

    test("without usage → identical to phase 1+2 (backward compat)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportSuccess("user_aaaa1111")
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.successCount).toBe(1)
      // success bonus only: 100 + 0.1 = 100.1
      expect(h.score).toBeCloseTo(100.1, 5)
      expect(h.totalCostUSD).toBe(0)
      expect(h.totalInputTokens).toBe(0)
    })

    test("with modelId but no usage → success only (no cost tracking)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap,
        now: () => 1000,
      })
      km.reportSuccess("user_aaaa1111", "test-model")
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.successCount).toBe(1)
      expect(h.totalCostUSD).toBe(0)
    })
  })

  describe("getHealthSnapshot — cost + lock status (L1-T8)", () => {
    test("includes cost totals and model usage after reportUsage", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
      })
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      const snap = km.getHealthSnapshot()[0]!
      expect(snap.health.totalCostUSD).toBeCloseTo(1.0, 10)
      expect(snap.health.modelUsage["m"]).toBeDefined()
      expect(snap.health.modelUsage["m"]!.costUSD).toBeCloseTo(1.0, 10)
    })

    test("includes lock status when lockManager present", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
        lockManager: makeLockMock({
          locked: ["a"],
          owners: { a: "inst-abc" },
        }),
      })
      const snap = km.getHealthSnapshot()
      const a = snap.find((s) => s.name === "a")!
      const b = snap.find((s) => s.name === "b")!
      expect(a.locked).toBe(true)
      expect(a.lockOwner).toBe("inst-abc")
      expect(b.locked).toBe(false)
      expect(b.lockOwner).toBe(null)
    })

    test("lock status defaults to unlocked when no lockManager", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
      })
      const snap = km.getHealthSnapshot()[0]!
      expect(snap.locked).toBe(false)
      expect(snap.lockOwner).toBe(null)
    })
  })

  describe("backward compatibility — no new deps (L1-T9 / 2.9)", () => {
    test("constructed without costMap/lockManager/scoringWeights behaves as phase 1+2", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        random: () => 0.25,
        now: () => 1000,
      })
      const selected = km.selectKey()
      expect(selected.key).toBe("user_aaaa1111")
      km.reportRateLimit(selected.key)
      const h = km.getHealthSnapshot()
      expect(h.find((s) => s.key === "user_aaaa1111")!.health.score).toBe(90)
      // new fields exist with safe defaults; no lock/cost behavior active
      expect(h[0]!.health.totalCostUSD).toBe(0)
      expect(h[0]!.locked).toBe(false)
    })
  })

  // ─── Fix 1/2/3: runtime state bridge (export/import + onStateChange) ────────
  describe("importState — restore cost totals + model usage from a snapshot (Fix 2)", () => {
    test("restores cost totals + model usage for matching keys", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
      })
      // Fresh KeyManager has zero cost.
      expect(km.getHealthSnapshot()[0]!.health.totalCostUSD).toBe(0)

      km.importState([
        {
          name: "a",
          key: "user_aaaa1111",
          locked: false,
          lockOwner: null,
          health: {
            score: 80,
            cooldownExpiry: 0,
            successCount: 5,
            failureCount: 1,
            rateLimitHits: 2,
            authErrors: 0,
            permanentlyDead: false,
            lastUsedAt: 900,
            lastCooldownAt: 500,
            totalInputTokens: 1200,
            totalOutputTokens: 800,
            totalCacheReadTokens: 400,
            totalCacheWriteTokens: 100,
            totalCostUSD: 0.3,
            modelUsage: {
              m: { inputTokens: 1000, outputTokens: 600, costUSD: 0.25 },
            },
          },
        },
      ])

      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalInputTokens).toBe(1200)
      expect(h.totalOutputTokens).toBe(800)
      expect(h.totalCostUSD).toBeCloseTo(0.3, 10)
      expect(h.modelUsage["m"]).toBeDefined()
      expect(h.modelUsage["m"]!.costUSD).toBeCloseTo(0.25, 10)
      // Non-cost fields restored too (full health snapshot).
      expect(h.successCount).toBe(5)
      expect(h.score).toBe(80)
    })

    test("ignores snapshot keys not in the pool; leaves unmatched pool keys fresh", () => {
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
      })
      km.importState([
        {
          name: "a",
          key: "user_aaaa1111",
          locked: false,
          lockOwner: null,
          health: {
            score: 50, cooldownExpiry: 0, successCount: 0, failureCount: 0,
            rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
            lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 500,
            totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
            totalCostUSD: 0.1, modelUsage: {},
          },
        },
        {
          name: "ghost",
          key: "user_ghost0000",
          locked: false,
          lockOwner: null,
          health: {
            score: 10, cooldownExpiry: 0, successCount: 0, failureCount: 0,
            rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
            lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 999,
            totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
            totalCostUSD: 9.9, modelUsage: {},
          },
        },
      ])

      const a = km.getHealthSnapshot().find((s) => s.name === "a")!
      const b = km.getHealthSnapshot().find((s) => s.name === "b")!
      expect(a.health.totalInputTokens).toBe(500)
      expect(a.health.score).toBe(50)
      // "ghost" not in pool → ignored. "b" not in snapshot → fresh health.
      expect(b.health.totalInputTokens).toBe(0)
      expect(b.health.score).toBe(100)
    })

    test("constructor with initialState restores cost on construction", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
        initialState: [
          {
            name: "a",
            key: "user_aaaa1111",
            locked: false,
            lockOwner: null,
            health: {
              score: 90, cooldownExpiry: 0, successCount: 3, failureCount: 0,
              rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
              lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 2000,
              totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
              totalCostUSD: 2.0, modelUsage: { m: { inputTokens: 2000, outputTokens: 0, costUSD: 2.0 } },
            },
          },
        ],
      })
      const h = km.getHealthSnapshot()[0]!.health
      expect(h.totalCostUSD).toBeCloseTo(2.0, 10)
      expect(h.totalInputTokens).toBe(2000)
      expect(h.score).toBe(90)
      // Imported cost is cumulative: a subsequent reportUsage ADDS to it.
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      // Re-read the snapshot — getHealthSnapshot() returns copies.
      const after = km.getHealthSnapshot()[0]!.health
      expect(after.totalInputTokens).toBe(3000)
      expect(after.totalCostUSD).toBeCloseTo(3.0, 10)
    })
  })

  describe("onStateChange — emitted after state-mutating reports (Fix 1)", () => {
    test("reportUsage → onStateChange called with snapshot containing cost totals", () => {
      const calls: Array<{ totalCostUSD: number; totalInputTokens: number }> = []
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
        onStateChange: (snapshot) => {
          const h = snapshot[0]!.health
          calls.push({ totalCostUSD: h.totalCostUSD, totalInputTokens: h.totalInputTokens })
        },
      })
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      expect(calls).toHaveLength(1)
      expect(calls[0]!.totalInputTokens).toBe(1000)
      expect(calls[0]!.totalCostUSD).toBeCloseTo(1.0, 10)
    })

    test("reportSuccess (no usage) → onStateChange called once", () => {
      let calls = 0
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
        onStateChange: () => { calls++ },
      })
      km.reportSuccess("user_aaaa1111")
      expect(calls).toBe(1)
    })

    test("reportRateLimit / reportServerError / reportQuotaError / reportAuthError → each emits", () => {
      const calls: number[] = []
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 5000,
        onStateChange: () => { calls.push(1) },
      })
      km.reportRateLimit("user_aaaa1111")
      km.reportServerError("user_aaaa1111")
      km.reportQuotaError("user_aaaa1111")
      km.reportAuthError("user_aaaa1111")
      expect(calls).toHaveLength(4)
    })

    test("no onStateChange callback → no crash (backward compat with phase 1+2)", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
      })
      // No callback set — these must NOT throw.
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      km.reportRateLimit("user_aaaa1111")
      km.reportSuccess("user_aaaa1111")
      expect(km.getHealthSnapshot()[0]!.health.totalInputTokens).toBe(1000)
    })

    test("onStateChange throwing is isolated — does not break reportUsage", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        costMap: { m: { input: 1000, output: 0, cache_read: 0, cache_write: 0 } },
        now: () => 1000,
        onStateChange: () => { throw new Error("callback boom") },
      })
      // Must NOT throw — the callback failure is isolated.
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      // State still updated despite the throwing callback.
      expect(km.getHealthSnapshot()[0]!.health.totalInputTokens).toBe(1000)
    })

    test("snapshot includes live lock status from lockManager (Fix 3 data)", () => {
      const lockMock = makeLockMock({ locked: ["a"], owners: { a: "inst-x" } })
      const calls: Array<{ locked: boolean; lockOwner: string | null }> = []
      const km = new KeyManager({
        keys: [
          { name: "a", key: "user_aaaa1111" },
          { name: "b", key: "user_bbbb2222" },
        ],
        now: () => 1000,
        lockManager: lockMock,
        onStateChange: (snapshot) => {
          const a = snapshot.find((s) => s.name === "a")!
          calls.push({ locked: a.locked, lockOwner: a.lockOwner })
        },
      })
      km.reportUsage("user_aaaa1111", "m", makeUsage(1000, 0))
      expect(calls[0]!.locked).toBe(true)
      expect(calls[0]!.lockOwner).toBe("inst-x")
    })

    test("notifyStateChange() triggers onStateChange without mutating state (lock bridge)", () => {
      let calls = 0
      let lastSnapshotLen = 0
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
        onStateChange: (snapshot) => { calls++; lastSnapshotLen = snapshot.length },
      })
      km.notifyStateChange()
      expect(calls).toBe(1)
      expect(lastSnapshotLen).toBe(1)
    })

    test("notifyStateChange() is a no-op when no onStateChange callback", () => {
      const km = new KeyManager({
        keys: [{ name: "a", key: "user_aaaa1111" }],
        now: () => 1000,
      })
      // Must not throw.
      km.notifyStateChange()
      expect(km.getHealthSnapshot()).toHaveLength(1)
    })
  })
})
