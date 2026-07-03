/**
 * Tests for the provider factory wiring (index.ts).
 *
 * Task 3.9: createCommandCode accepts Phase 3 options (modelCosts, lockManager,
 * costPerDollar, scoringWeights, instanceId, lockTimeoutMs) and forwards them to
 * the KeyManager + CommandCodeLanguageModel constructors. Backward compatible:
 * no new options → Phase 1+2 behavior.
 *
 * Strict TDD: tests written BEFORE implementation.
 */

import { describe, test, expect } from "bun:test"
import { createCommandCode } from "./index.js"
import type { KeyEntry, KeyHealthSnapshot } from "./src/key-manager.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

const KEYS: KeyEntry[] = [
  { name: "a", key: "user_test_aaaa1111" },
  { name: "b", key: "user_test_bbbb2222" },
]

/**
 * Minimal success SSE response (text-delta + finish-step with usage).
 * Mirrors the fixture in model.test.ts so doGenerate completes cleanly.
 */
function successSSE(text: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: {"type":"text-delta","id":"t1","text":"${text}"}\n\n`),
      )
      controller.enqueue(
        encoder.encode(
          'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":1}}\n\n',
        ),
      )
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const PROMPT = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any

// ─── instanceId ───────────────────────────────────────────────────────────────

describe("createCommandCode — instanceId", () => {
  test("generates an instanceId when not provided (non-empty UUID-like string)", () => {
    const provider = createCommandCode({ apiKeys: KEYS })
    expect(typeof provider.instanceId).toBe("string")
    expect(provider.instanceId.length).toBeGreaterThan(0)
    // UUID v4 shape: 8-4-4-4-12
    expect(provider.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  test("uses the provided instanceId verbatim", () => {
    const provider = createCommandCode({ apiKeys: KEYS, instanceId: "test-uuid-1234" })
    expect(provider.instanceId).toBe("test-uuid-1234")
  })

  test("each factory call generates a distinct instanceId", () => {
    const a = createCommandCode({ apiKeys: KEYS })
    const b = createCommandCode({ apiKeys: KEYS })
    expect(a.instanceId).not.toBe(b.instanceId)
  })
})

// ─── Backward compatibility ───────────────────────────────────────────────────

describe("createCommandCode — backward compatibility", () => {
  test("multi-key mode with NO phase 3 options → languageModel returns a working model", () => {
    const provider = createCommandCode({ apiKeys: KEYS })
    const model = provider.languageModel("claude-sonnet-4-6")
    expect(model.modelId).toBe("claude-sonnet-4-6")
    expect(model.provider).toBe("commandcode")
  })

  test("legacy single-key mode (apiKey, no apiKeys) → languageModel returns a working model", () => {
    const provider = createCommandCode({ apiKey: "user_test_legacy0000" })
    const model = provider.languageModel("claude-sonnet-4-6")
    expect(model.modelId).toBe("claude-sonnet-4-6")
  })

  test("multi-key mode with NO phase 3 options → request works without any lock ops (phase 1+2 behavior)", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return successSSE("hello")
    }) as typeof fetch
    try {
      const provider = createCommandCode({ apiKeys: KEYS })
      const model = provider.languageModel("test-model")
      const result = await model.doGenerate({ prompt: PROMPT })
      expect(fetchCalls).toBe(1)
      expect(result.content.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── Phase 3 options forwarded ────────────────────────────────────────────────

describe("createCommandCode — phase 3 options accepted + forwarded", () => {
  test("accepts modelCosts + lockManager + scoringWeights + lockTimeoutMs without crash", () => {
    const fakeLock = {
      acquireLock: () => true,
      releaseLock: () => {},
      refreshLock: () => true,
      isLocked: () => false,
      getLockOwner: () => null,
      getActiveLocks: () => [],
    }
    const provider = createCommandCode({
      apiKeys: KEYS,
      modelCosts: { "test-model": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      lockManager: fakeLock,
      scoringWeights: { costPerDollar: 2.0 },
      lockTimeoutMs: 120_000,
      instanceId: "inst-abc",
    })
    const model = provider.languageModel("test-model")
    expect(model.modelId).toBe("test-model")
    expect(provider.instanceId).toBe("inst-abc")
  })

  test("lockManager forwarded through factory → acquireLock called during doGenerate", async () => {
    const acquireCalls: string[] = []
    const releaseCalls: string[] = []
    const fakeLock = {
      acquireLock: (name: string) => {
        acquireCalls.push(name)
        return true
      },
      releaseLock: (name: string) => {
        releaseCalls.push(name)
      },
      refreshLock: () => true,
      isLocked: () => false,
      getLockOwner: () => null,
      getActiveLocks: () => [],
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => successSSE("hi")) as typeof fetch
    try {
      const provider = createCommandCode({ apiKeys: KEYS, lockManager: fakeLock })
      const model = provider.languageModel("test-model")
      await model.doGenerate({ prompt: PROMPT })
      // The lockManager reached the model: acquireLock was called for the selected key.
      expect(acquireCalls.length).toBeGreaterThan(0)
      // And released when the doGenerate response stream completed.
      expect(releaseCalls.length).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── Runtime state bridge (Fix 1/2 wiring) ────────────────────────────────────

describe("createCommandCode — runtime state bridge (onStateChange + initialKeyState)", () => {
  test("onStateChange forwarded → callback fires after doGenerate with cost totals (Fix 1)", async () => {
    const snapshots: KeyHealthSnapshot[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => successSSE("hi")) as typeof fetch
    try {
      const provider = createCommandCode({
        apiKeys: KEYS,
        modelCosts: { "test-model": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
        onStateChange: (snap) => { snapshots.push(...snap) },
      })
      const model = provider.languageModel("test-model")
      await model.doGenerate({ prompt: PROMPT })
    } finally {
      globalThis.fetch = originalFetch
    }

    // The selected key's snapshot was emitted with token + cost totals from the
    // finish event (successSSE usage: inputTokens 10, outputTokens 1).
    const used = snapshots.find((s) => s.health.totalInputTokens > 0)
    expect(used).toBeDefined()
    expect(used!.health.totalInputTokens).toBe(10)
    expect(used!.health.totalOutputTokens).toBe(1)
    expect(used!.health.totalCostUSD).toBeGreaterThan(0)
  })

  test("initialKeyState forwarded → KeyManager imports cost on construction (Fix 2)", async () => {
    // Seed a snapshot with prior cost for key A (the first key, selected by
    // random=0.0 → weighted-random picks A first).
    const seed: KeyHealthSnapshot[] = [
      {
        name: "a", key: "user_test_aaaa1111", locked: false, lockOwner: null,
        health: {
          score: 95, cooldownExpiry: 0, successCount: 2, failureCount: 0,
          rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
          lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 2000,
          totalOutputTokens: 500, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 1.5, modelUsage: {},
        },
      },
      {
        name: "b", key: "user_test_bbbb2222", locked: false, lockOwner: null,
        health: {
          score: 100, cooldownExpiry: 0, successCount: 0, failureCount: 0,
          rateLimitHits: 0, authErrors: 0, permanentlyDead: false,
          lastUsedAt: 0, lastCooldownAt: 0, totalInputTokens: 0,
          totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0,
          totalCostUSD: 0, modelUsage: {},
        },
      },
    ]
    const snapshots: KeyHealthSnapshot[] = []
    const originalFetch = globalThis.fetch
    const originalRandom = Math.random
    // Force the KeyManager to select key A (weighted-random with roll=0 picks
    // the first candidate) so the imported base + new usage both land on A.
    Math.random = () => 0
    globalThis.fetch = (async () => successSSE("hi")) as typeof fetch
    try {
      const provider = createCommandCode({
        apiKeys: KEYS,
        initialKeyState: seed,
        onStateChange: (snap) => { snapshots.push(...snap) },
      })
      const model = provider.languageModel("test-model")
      await model.doGenerate({ prompt: PROMPT })
    } finally {
      globalThis.fetch = originalFetch
      Math.random = originalRandom
    }

    // The imported base (2000 input tokens) survives AND the new request adds
    // 10 input tokens (successSSE usage) → cumulative 2010. Proves initialKeyState
    // was forwarded to the KeyManager and imported on construction. Use the LAST
    // emission for A (post-usage); earlier emissions (acquire notify) show the
    // pre-usage imported base.
    const aEntries = snapshots.filter((s) => s.name === "a")
    const a = aEntries[aEntries.length - 1]
    expect(a).toBeDefined()
    expect(a!.health.totalInputTokens).toBe(2010)
    // Imported cost preserved (no costMap this test → no new cost added).
    expect(a!.health.totalCostUSD).toBeCloseTo(1.5, 10)
  })
})
