import { describe, test, expect } from "bun:test"
import { KeyManager } from "./key-manager.js"

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
})
