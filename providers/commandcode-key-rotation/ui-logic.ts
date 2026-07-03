/**
 * Pure logic functions for the TUI plugin.
 *
 * These are extracted from the Solid.js component so they can be unit-tested
 * independently. The Solid.js render (ui.tsx) uses these functions but is
 * NOT itself unit-tested (pragmatic for TUI).
 *
 * All functions are pure — same input → same output, no side effects.
 */

import type { KeyState } from "./server.js"
import { DEFAULT_NOTIFICATIONS } from "./server.js"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NotificationsConfig {
  onRotate: boolean
  onCooldown: boolean
  onRecovery: boolean
  onPermanentDeath: boolean
}

// ─── getHealthEmoji ───────────────────────────────────────────────────────────

/**
 * Map a key health string to a user-visible emoji.
 * Used in sidebar footer and /key-status table.
 */
export function getHealthEmoji(health: string): string {
  switch (health) {
    case "healthy":
      return "✅"
    case "rate-limited":
    case "cooldown":
      return "⏳"
    case "auth-error":
    case "dead":
      return "🔴"
    default:
      return "❓"
  }
}

// ─── redactForDisplay ────────────────────────────────────────────────────────

/**
 * Redact an API key for TUI display.
 * Shows first 5 chars + "…" + last 4 chars.
 * Keys shorter than 8 chars are returned as-is (too short to redact safely).
 *
 * IMPORTANT: This is the TUI display redaction. server.ts has its own
 * redactKey() for logging — they share the same algorithm.
 */
export function redactForDisplay(key: string): string {
  if (!key || key.length < 8) return key
  return key.slice(0, 5) + "…" + key.slice(-4)
}

// ─── formatKeyStatus ─────────────────────────────────────────────────────────

/**
 * Format a compact one-line status string for the sidebar footer.
 *
 * Format: "🔑 {activeName} ({account}) {healthEmoji} | 📊 {n} keys | {m} healthy"
 * When no active key: "🔑 none | 📊 {n} keys | {m} healthy"
 */
export function formatKeyStatus(state: KeyState): string {
  const activeName = state.activeKey ?? "none"
  const total = state.keys.length
  const healthy = state.keys.filter((k) => k.health === "healthy").length

  const keyWord = total === 1 ? "key" : "keys"

  // Find active key for health emoji + account
  const activeEntry = state.keys.find((k) => k.name === state.activeKey)
  const healthEmoji = activeEntry ? getHealthEmoji(activeEntry.health) : ""
  const account = activeEntry?.account

  // Build the active key display: name (account) emoji
  let activeDisplay = activeName
  if (account) {
    activeDisplay += ` (${account})`
  }
  if (healthEmoji) {
    activeDisplay += ` ${healthEmoji}`
  }

  return `🔑 ${activeDisplay} | 📊 ${total} ${keyWord} | ${healthy} healthy`
}

// ─── shouldShowToast ─────────────────────────────────────────────────────────

/**
 * Gate toast notifications based on the user's notifications config.
 *
 * Event types: "rotate", "cooldown", "recovery", "permanent-death"
 * Config flags: onRotate, onCooldown, onRecovery, onPermanentDeath
 */
export function shouldShowToast(
  eventType: string,
  config: NotificationsConfig,
): boolean {
  switch (eventType) {
    case "rotate":
      return config.onRotate
    case "cooldown":
      return config.onCooldown
    case "recovery":
      return config.onRecovery
    case "permanent-death":
      return config.onPermanentDeath
    default:
      return false
  }
}

// ─── decideToast ───────────────────────────────────────────────────────────

/** Possible event types the TUI monitors. */
export type ToastEventType = "rotate" | "cooldown" | "recovery" | "permanentDeath"

/** Context passed by the caller — what changed. */
export interface ToastEventContext {
  /** For rotate: the key we're rotating FROM. */
  fromKey?: string
  /** For cooldown / recovery / permanentDeath: the affected key's name. */
  keyName?: string
}

/** The decision returned by decideToast. */
export interface ToastDecision {
  show: boolean
  variant: "info" | "success" | "warning" | "error"
  title: string
  message: string
}

/**
 * Pure function: decide whether to show a toast and what payload to use.
 *
 * This is the SINGLE integration point that:
 *  1. Resolves the effective notifications config from KeyState (fallback: defaults).
 *  2. Gates on shouldShowToast(eventType, config).
 *  3. Checks dismissed notifications set (api.kv persistence).
 *  4. Builds the toast payload using key NAMES only (never raw key material).
 *
 * Extracted from ui.tsx so the toast-suppression path is unit-testable.
 */
export function decideToast(
  eventType: ToastEventType,
  ctx: ToastEventContext,
  state: KeyState,
  dismissed?: Set<string>,
): ToastDecision {
  // Check dismissed notifications first (api.kv persistence — C11)
  if (dismissed && dismissed.has(eventType)) {
    return { show: false, variant: "info", title: "", message: "" }
  }

  const config = state.notifications ?? DEFAULT_NOTIFICATIONS
  const show = shouldShowToast(
    eventType === "permanentDeath" ? "permanent-death" : eventType,
    config,
  )

  if (!show) {
    return { show: false, variant: "info", title: "", message: "" }
  }

  switch (eventType) {
    case "rotate": {
      const toKey = state.activeKey ?? "unknown"
      const fromKey = ctx.fromKey ?? "none"
      return {
        show: true,
        variant: "warning",
        title: "Key Rotated",
        message: `${fromKey} → ${toKey}`,
      }
    }
    case "cooldown":
      return {
        show: true,
        variant: "warning",
        title: "Key Cooldown",
        message: `${ctx.keyName} entered cooldown`,
      }
    case "recovery":
      return {
        show: true,
        variant: "success",
        title: "Key Recovered",
        message: `${ctx.keyName} is back online`,
      }
    case "permanentDeath":
      return {
        show: true,
        variant: "error",
        title: "Key Dead",
        message: `${ctx.keyName} permanently failed (auth error)`,
      }
  }
}

// ─── formatKeyStatusTable ────────────────────────────────────────────────────

/**
 * Format a detailed multi-line table for the /key-status command.
 *
 * Columns: Marker, Name, Account, Health (emoji), Score, Cooldown, Status
 * Active key is marked with "◄".
 */
export function formatKeyStatusTable(state: KeyState): string {
  if (state.keys.length === 0) {
    return "No keys configured."
  }

  const now = Date.now()
  const header = "  Name           Account         Health  Score  Cooldown   Status"
  const separator = "  ─────────────  ───────────────  ──────  ─────  ─────────  ──────"

  const rows = state.keys.map((k) => {
    const marker = k.name === state.activeKey ? "◄" : " "
    const emoji = getHealthEmoji(k.health)
    const score = String(k.score).padStart(5)
    const account = (k.account ?? "—").padEnd(15)

    let cooldown = "none"
    if (k.cooldownExpiry && k.cooldownExpiry > now) {
      const remainingMs = k.cooldownExpiry - now
      const remainingSec = Math.ceil(remainingMs / 1000)
      if (remainingSec >= 60) {
        const mins = Math.floor(remainingSec / 60)
        const secs = remainingSec % 60
        cooldown = `${mins}m${secs.toString().padStart(2, "0")}s`
      } else {
        cooldown = `${remainingSec}s`
      }
    }

    const status = k.health === "healthy" ? "active" : k.health

    return `  ${marker} ${k.name.padEnd(13)}  ${account}  ${emoji}      ${score}  ${cooldown.padEnd(9)}  ${status}`
  })

  return [header, separator, ...rows].join("\n")
}

// ─── decideConfigWarning (C10) ───────────────────────────────────────────────

/** Extended KeyState with optional configWarning field. */
interface KeyStateWithWarning extends KeyState {
  configWarning?: string
}

/**
 * Pure function: decide whether to show a config warning toast.
 *
 * When the server plugin detects a malformed keys.json, it writes a
 * `config-warning` field into key-state.json. The TUI reads this and
 * shows a warning toast to the user.
 *
 * Returns null when no warning is present (no toast needed).
 */
export function decideConfigWarning(
  state: KeyStateWithWarning,
): ToastDecision | null {
  const warning = state.configWarning
  if (!warning) return null

  return {
    show: true,
    variant: "warning",
    title: "Config Warning",
    message: warning,
  }
}

// ─── Dismissed notifications (C11 — api.kv persistence) ──────────────────────

/**
 * Check if a notification event type has been dismissed by the user.
 * Dismissed state is persisted via api.kv ("dismissed-notifications").
 *
 * @param eventType - the event type to check (e.g., "cooldown", "rotate")
 * @param dismissed - set of dismissed event types (from api.kv)
 */
export function isNotificationDismissed(
  eventType: string,
  dismissed: Set<string>,
): boolean {
  return dismissed.has(eventType)
}

/**
 * Add an event type to the dismissed notifications set.
 * Returns a NEW set (does not mutate the original).
 *
 * @param dismissed - current dismissed set
 * @param eventType - event type to dismiss
 */
export function dismissNotification(
  dismissed: Set<string>,
  eventType: string,
): Set<string> {
  const next = new Set(dismissed)
  next.add(eventType)
  return next
}
