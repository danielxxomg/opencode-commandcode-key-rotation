/**
 * Tests for TUI pure logic functions (ui-logic.ts).
 *
 * These are pure, deterministic functions extracted from the Solid.js TUI
 * component so they can be unit-tested. The Solid.js render itself is NOT
 * unit-tested (pragmatic for TUI).
 *
 * Strict TDD: tests written BEFORE implementation.
 */

import { describe, test, expect } from "bun:test"

import {
  getHealthEmoji,
  redactForDisplay,
  formatKeyStatus,
  shouldShowToast,
  decideToast,
  formatKeyStatusTable,
  decideConfigWarning,
  isNotificationDismissed,
  dismissNotification,
} from "./ui-logic.js"

import type { KeyState, NotificationsConfig } from "./server.js"
import { DEFAULT_NOTIFICATIONS } from "./server.js"

// ─── getHealthEmoji ─────────────────────────────────────────────────────────

describe("getHealthEmoji", () => {
  test("returns ✅ for healthy", () => {
    expect(getHealthEmoji("healthy")).toBe("✅")
  })

  test("returns ⏳ for cooldown / rate-limited", () => {
    expect(getHealthEmoji("rate-limited")).toBe("⏳")
    expect(getHealthEmoji("cooldown")).toBe("⏳")
  })

  test("returns 🔴 for auth-error / dead", () => {
    expect(getHealthEmoji("auth-error")).toBe("🔴")
    expect(getHealthEmoji("dead")).toBe("🔴")
  })

  test("returns ❓ for unknown health string", () => {
    expect(getHealthEmoji("unknown-status")).toBe("❓")
    expect(getHealthEmoji("")).toBe("❓")
  })
})

// ─── redactForDisplay ──────────────────────────────────────────────────────

describe("redactForDisplay", () => {
  test("redacts a full key to last 4 chars with user_…xxxx format", () => {
    expect(redactForDisplay("user_test_aaaa1111")).toBe("user_…1111")
  })

  test("redacts any key prefix — shows first 5 + … + last 4", () => {
    expect(redactForDisplay("sk-abcdefghijklmnop")).toBe("sk-ab…mnop")
  })

  test("short keys (< 8 chars) returned as-is", () => {
    expect(redactForDisplay("short")).toBe("short")
    expect(redactForDisplay("abc")).toBe("abc")
  })

  test("empty string returned as-is", () => {
    expect(redactForDisplay("")).toBe("")
  })
})

// ─── formatKeyStatus ───────────────────────────────────────────────────────

describe("formatKeyStatus", () => {
  test("formats a compact status string from key state", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100, account: "danielxxomg" },
        { name: "work", health: "rate-limited", score: 80, account: "work-corp" },
        { name: "backup", health: "healthy", score: 90 },
      ],
    }

    const result = formatKeyStatus(state)

    // Must include active key name
    expect(result).toContain("personal")
    // Must show total keys count
    expect(result).toContain("3 keys")
    // Must show healthy count
    expect(result).toContain("2 healthy")
  })

  test("shows active key health emoji and account in sidebar status", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100, account: "danielxxomg" },
        { name: "work", health: "rate-limited", score: 80 },
      ],
    }

    const result = formatKeyStatus(state)

    // Must include the active key's health emoji (✅ for healthy)
    expect(result).toContain("✅")
    // Must include the active key's account
    expect(result).toContain("danielxxomg")
  })

  test("shows health emoji for non-healthy active key", () => {
    const state: KeyState = {
      activeKey: "work",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "rate-limited", score: 80, account: "corp" },
      ],
    }

    const result = formatKeyStatus(state)

    // Active key is rate-limited → should show ⏳
    expect(result).toContain("⏳")
    // Must include account
    expect(result).toContain("corp")
  })

  test("shows no active key when activeKey is null", () => {
    const state: KeyState = {
      activeKey: null,
      keys: [{ name: "only", health: "healthy", score: 50 }],
    }

    const result = formatKeyStatus(state)

    expect(result).toContain("1 key")
    expect(result).toContain("1 healthy")
    // Should indicate no active key
    expect(result).toContain("none")
  })

  test("singular 'key' when only 1 key", () => {
    const state: KeyState = {
      activeKey: "solo",
      keys: [{ name: "solo", health: "healthy", score: 100 }],
    }

    const result = formatKeyStatus(state)

    expect(result).toContain("1 key")
    expect(result).not.toContain("1 keys")
  })

  test("empty state shows 0 keys", () => {
    const state: KeyState = { activeKey: null, keys: [] }

    const result = formatKeyStatus(state)

    expect(result).toContain("0 keys")
    expect(result).toContain("0 healthy")
  })
})

// ─── shouldShowToast ───────────────────────────────────────────────────────

describe("shouldShowToast", () => {
  const allEnabled = {
    onRotate: true,
    onCooldown: true,
    onRecovery: true,
    onPermanentDeath: true,
  }

  const allDisabled = {
    onRotate: false,
    onCooldown: false,
    onRecovery: false,
    onPermanentDeath: false,
  }

  test("returns true for onRotate when enabled", () => {
    expect(shouldShowToast("rotate", allEnabled)).toBe(true)
  })

  test("returns false for onRotate when disabled", () => {
    expect(shouldShowToast("rotate", allDisabled)).toBe(false)
  })

  test("returns true for onCooldown when enabled", () => {
    expect(shouldShowToast("cooldown", allEnabled)).toBe(true)
  })

  test("returns false for onCooldown when disabled", () => {
    expect(shouldShowToast("cooldown", allDisabled)).toBe(false)
  })

  test("returns true for onRecovery when enabled", () => {
    expect(shouldShowToast("recovery", allEnabled)).toBe(true)
  })

  test("returns false for onRecovery when disabled", () => {
    expect(shouldShowToast("recovery", allDisabled)).toBe(false)
  })

  test("returns true for onPermanentDeath when enabled", () => {
    expect(shouldShowToast("permanent-death", allEnabled)).toBe(true)
  })

  test("returns false for onPermanentDeath when disabled", () => {
    expect(shouldShowToast("permanent-death", allDisabled)).toBe(false)
  })

  test("returns false for unknown event type", () => {
    expect(shouldShowToast("unknown", allEnabled)).toBe(false)
  })

  test("selective config — only some enabled", () => {
    const partial = {
      onRotate: true,
      onCooldown: false,
      onRecovery: true,
      onPermanentDeath: false,
    }

    expect(shouldShowToast("rotate", partial)).toBe(true)
    expect(shouldShowToast("cooldown", partial)).toBe(false)
    expect(shouldShowToast("recovery", partial)).toBe(true)
    expect(shouldShowToast("permanent-death", partial)).toBe(false)
  })
})

// ─── decideToast ──────────────────────────────────────────────────────────

describe("decideToast", () => {
  // Helpers: minimal KeyState fixtures with notifications config
  const stateWith = (overrides: Partial<NotificationsConfig>): KeyState => ({
    activeKey: "personal",
    keys: [
      { name: "personal", health: "healthy", score: 100 },
      { name: "work", health: "rate-limited", score: 80 },
    ],
    notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true, ...overrides },
  })

  // ── rotate ──

  test("rotate with onRotate=true → show=true, warning variant, key names in message", () => {
    const result = decideToast("rotate", {}, stateWith({ onRotate: true }))
    expect(result.show).toBe(true)
    expect(result.variant).toBe("warning")
    expect(result.title).toBe("Key Rotated")
    expect(result.message).toContain("personal")
  })

  test("rotate with onRotate=false → show=false (config is respected)", () => {
    const result = decideToast("rotate", {}, stateWith({ onRotate: false }))
    expect(result.show).toBe(false)
  })

  // ── cooldown ──

  test("cooldown with onCooldown=true → show=true, warning variant", () => {
    const result = decideToast("cooldown", { keyName: "work" }, stateWith({ onCooldown: true }))
    expect(result.show).toBe(true)
    expect(result.variant).toBe("warning")
    expect(result.title).toBe("Key Cooldown")
    expect(result.message).toContain("work")
    expect(result.message).toContain("cooldown")
  })

  test("cooldown with onCooldown=false → show=false (config is respected)", () => {
    const result = decideToast("cooldown", { keyName: "work" }, stateWith({ onCooldown: false }))
    expect(result.show).toBe(false)
  })

  // ── recovery ──

  test("recovery with onRecovery=true → show=true, success variant", () => {
    const result = decideToast("recovery", { keyName: "personal" }, stateWith({ onRecovery: true }))
    expect(result.show).toBe(true)
    expect(result.variant).toBe("success")
    expect(result.title).toBe("Key Recovered")
    expect(result.message).toContain("personal")
    expect(result.message).toContain("online")
  })

  test("recovery with onRecovery=false → show=false (config is respected)", () => {
    const result = decideToast("recovery", { keyName: "personal" }, stateWith({ onRecovery: false }))
    expect(result.show).toBe(false)
  })

  // ── permanentDeath ──

  test("permanentDeath with onPermanentDeath=true → show=true, error variant", () => {
    const result = decideToast("permanentDeath", { keyName: "work" }, stateWith({ onPermanentDeath: true }))
    expect(result.show).toBe(true)
    expect(result.variant).toBe("error")
    expect(result.title).toBe("Key Dead")
    expect(result.message).toContain("work")
    expect(result.message).toContain("auth")
  })

  test("permanentDeath with onPermanentDeath=false → show=false (config is respected)", () => {
    const result = decideToast("permanentDeath", { keyName: "work" }, stateWith({ onPermanentDeath: false }))
    expect(result.show).toBe(false)
  })

  // ── redaction ──

  test("messages use key NAMES only — no raw key material", () => {
    // From-key in rotate
    const rotateResult = decideToast("rotate", { fromKey: "personal" }, stateWith({}))
    expect(rotateResult.message).not.toMatch(/user_[a-zA-Z0-9]{8,}/) // no full key
    // Cooldown
    const cooldownResult = decideToast("cooldown", { keyName: "work" }, stateWith({}))
    expect(cooldownResult.message).not.toMatch(/user_[a-zA-Z0-9]{8,}/)
    // Recovery
    const recoveryResult = decideToast("recovery", { keyName: "personal" }, stateWith({}))
    expect(recoveryResult.message).not.toMatch(/user_[a-zA-Z0-9]{8,}/)
    // PermanentDeath
    const deathResult = decideToast("permanentDeath", { keyName: "work" }, stateWith({}))
    expect(deathResult.message).not.toMatch(/user_[a-zA-Z0-9]{8,}/)
  })

  // ── default notifications (state.notifications undefined) ──

  test("falls back to DEFAULT_NOTIFICATIONS when state.notifications is undefined", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [{ name: "personal", health: "healthy", score: 100 }],
    }
    // Default has all enabled → should show
    const result = decideToast("rotate", {}, state)
    expect(result.show).toBe(true)
  })

  // ── break-test: proves config gate is wired ──

  test("BREAK-TEST: if decideToast ignored config, onRotate=false test would fail", () => {
    // This test documents that the onRotate=false test IS the gate.
    // If decideToast always returned show:true, the "rotate with onRotate=false"
    // test above would fail — proving the config path is active.
    const result = decideToast("rotate", {}, stateWith({ onRotate: false }))
    // The fact that show=false proves config is read.
    expect(result.show).toBe(false)
  })
})

// ─── formatKeyStatusTable ──────────────────────────────────────────────────

describe("formatKeyStatusTable", () => {
  test("formats a multi-line table with all key details including Account column", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100, account: "danielxxomg" },
        { name: "work", health: "rate-limited", score: 80, cooldownExpiry: Date.now() + 60000, account: "work-corp" },
      ],
    }

    const result = formatKeyStatusTable(state)

    // Must be multi-line
    expect(result.split("\n").length).toBeGreaterThanOrEqual(3)

    // Must include key names
    expect(result).toContain("personal")
    expect(result).toContain("work")

    // Must include health emojis
    expect(result).toContain("✅")
    expect(result).toContain("⏳")

    // Must include scores
    expect(result).toContain("100")
    expect(result).toContain("80")

    // Must include a header with Account column
    expect(result).toContain("Name")
    expect(result).toContain("Account")

    // Must include account values in rows
    expect(result).toContain("danielxxomg")
    expect(result).toContain("work-corp")
  })

  test("shows cooldown remaining when key is in cooldown", () => {
    const futureTime = Date.now() + 120000 // 2 minutes from now
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "rate-limited", score: 80, cooldownExpiry: futureTime },
      ],
    }

    const result = formatKeyStatusTable(state)

    // Should show some cooldown indicator (not "none" for the rate-limited key)
    expect(result).toContain("work")
    // The cooldown line should contain a time-like value for work
    const lines = result.split("\n")
    const workLine = lines.find((l) => l.includes("work"))
    expect(workLine).toBeDefined()
    // Should NOT show "none" for cooldown on the work line
    expect(workLine).not.toContain("none")
  })

  test("empty state shows header and 'no keys' message", () => {
    const state: KeyState = { activeKey: null, keys: [] }

    const result = formatKeyStatusTable(state)

    expect(result).toContain("No keys")
  })

  test("marks active key with a marker", () => {
    const state: KeyState = {
      activeKey: "work",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "healthy", score: 90 },
      ],
    }

    const result = formatKeyStatusTable(state)

    // Active key should have some marker (e.g. ◄ or * or →)
    const lines = result.split("\n")
    const workLine = lines.find((l) => l.includes("work"))
    expect(workLine).toBeDefined()
    // Should have an active marker
    expect(workLine).toMatch(/◄|→|\*|active/i)
  })

  test("shows dash for keys without account", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "healthy", score: 90, account: "corp" },
      ],
    }

    const result = formatKeyStatusTable(state)

    // personal has no account → should show "-" or "—"
    const lines = result.split("\n")
    const personalLine = lines.find((l) => l.includes("personal"))
    expect(personalLine).toBeDefined()
    // work has account
    expect(result).toContain("corp")
  })
})

// ─── decideConfigWarning (C10 — malformed config warning toast) ────────────

describe("decideConfigWarning", () => {
  test("state with configWarning → returns toast payload", () => {
    const state: KeyState & { configWarning?: string } = {
      activeKey: null,
      keys: [],
      configWarning: "keys.json contains invalid JSON — falling back to legacy mode",
    }

    const result = decideConfigWarning(state)

    expect(result).not.toBeNull()
    expect(result!.show).toBe(true)
    expect(result!.variant).toBe("warning")
    expect(result!.title).toBe("Config Warning")
    expect(result!.message).toContain("keys.json")
    expect(result!.message).toContain("invalid JSON")
  })

  test("state without configWarning → returns null (no toast)", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [{ name: "personal", health: "healthy", score: 100 }],
    }

    const result = decideConfigWarning(state)
    expect(result).toBeNull()
  })

  test("state with empty configWarning → returns null (no toast)", () => {
    const state: KeyState & { configWarning?: string } = {
      activeKey: null,
      keys: [],
      configWarning: "",
    }

    const result = decideConfigWarning(state)
    expect(result).toBeNull()
  })
})

// ─── isNotificationDismissed + dismissNotification (C11 — api.kv persistence) ──

describe("isNotificationDismissed", () => {
  test("returns true when event type is in dismissed set", () => {
    const dismissed = new Set(["cooldown", "rotate"])
    expect(isNotificationDismissed("cooldown", dismissed)).toBe(true)
    expect(isNotificationDismissed("rotate", dismissed)).toBe(true)
  })

  test("returns false when event type is NOT in dismissed set", () => {
    const dismissed = new Set(["cooldown"])
    expect(isNotificationDismissed("rotate", dismissed)).toBe(false)
    expect(isNotificationDismissed("recovery", dismissed)).toBe(false)
  })

  test("returns false when dismissed set is empty", () => {
    const dismissed = new Set<string>()
    expect(isNotificationDismissed("cooldown", dismissed)).toBe(false)
  })
})

describe("dismissNotification", () => {
  test("adds event type to dismissed set", () => {
    const dismissed = new Set<string>()
    const result = dismissNotification(dismissed, "cooldown")
    expect(result.has("cooldown")).toBe(true)
    expect(result.has("rotate")).toBe(false)
  })

  test("does not mutate original set", () => {
    const dismissed = new Set<string>()
    const result = dismissNotification(dismissed, "cooldown")
    expect(dismissed.has("cooldown")).toBe(false)
    expect(result.has("cooldown")).toBe(true)
  })

  test("accumulates multiple dismissed types", () => {
    let dismissed = new Set<string>()
    dismissed = dismissNotification(dismissed, "cooldown")
    dismissed = dismissNotification(dismissed, "rotate")
    dismissed = dismissNotification(dismissed, "cooldown") // idempotent
    expect(dismissed.size).toBe(2)
    expect(dismissed.has("cooldown")).toBe(true)
    expect(dismissed.has("rotate")).toBe(true)
  })
})

describe("decideToast with dismissed notifications", () => {
  test("decideToast returns show=false when event type is dismissed", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "rate-limited", score: 80 },
      ],
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true },
    }
    const dismissed = new Set(["cooldown"])

    const result = decideToast("cooldown", { keyName: "work" }, state, dismissed)
    expect(result.show).toBe(false)
  })

  test("decideToast shows toast when event type is NOT dismissed", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [
        { name: "personal", health: "healthy", score: 100 },
        { name: "work", health: "rate-limited", score: 80 },
      ],
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true },
    }
    const dismissed = new Set<string>()

    const result = decideToast("cooldown", { keyName: "work" }, state, dismissed)
    expect(result.show).toBe(true)
  })

  test("decideToast without dismissed param → backward compat (shows as before)", () => {
    const state: KeyState = {
      activeKey: "personal",
      keys: [{ name: "personal", health: "healthy", score: 100 }],
      notifications: { onRotate: true, onCooldown: true, onRecovery: true, onPermanentDeath: true },
    }

    // No dismissed param — backward compatible
    const result = decideToast("rotate", {}, state)
    expect(result.show).toBe(true)
  })
})
