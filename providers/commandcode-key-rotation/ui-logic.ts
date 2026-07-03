/**
 * Pure logic functions for the TUI plugin.
 *
 * These are extracted from the Solid.js component so they can be unit-tested
 * independently. The Solid.js render (ui.tsx) uses these functions but is
 * NOT itself unit-tested (pragmatic for TUI).
 *
 * All functions are pure — same input → same output, no side effects.
 */

import type { KeyState, NotificationsConfig } from "./server.js"
import { DEFAULT_NOTIFICATIONS } from "./server.js"

// Re-export so existing import sites (`from "./ui-logic.js"`) keep working.
export type { NotificationsConfig }

// ─── Types ────────────────────────────────────────────────────────────────────

// (NotificationsConfig now comes from server.ts — single source of truth.)

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

// ─── Phase 3 formatters (pure) ────────────────────────────────────────────────

/**
 * Compact a token count: values >= 100 are shown in thousands with a `k` suffix
 * (one decimal, trailing `.0` stripped); smaller values are shown verbatim.
 * e.g. 1200 → "1.2k", 800 → "0.8k", 1000 → "1k", 50 → "50", 0 → "0".
 */
function compactTokens(n: number): string {
  if (n >= 100) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  }
  return String(n)
}

/**
 * Format an estimated USD cost as "$X.XX" (2 decimals). `undefined` → "$0.00".
 * Always labeled "est. cost" in surrounding UI — this is local estimation, not billing.
 */
export function formatCost(usd: number | undefined): string {
  return `$${(usd ?? 0).toFixed(2)}`
}

/**
 * Format input/output token counts as a compact "in/out" pair.
 * e.g. (1200, 800) → "1.2k/0.8k", (0, 0) → "0/0".
 */
export function formatTokens(
  input: number | undefined,
  output: number | undefined,
): string {
  return `${compactTokens(input ?? 0)}/${compactTokens(output ?? 0)}`
}

/**
 * Format per-model usage as a multi-line breakdown.
 * Each line: "{modelId}: ${cost} ({totalTokens} tok)".
 * Empty input → "" (caller conditionally renders the section).
 */
export function formatModelBreakdown(
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>,
): string {
  const entries = Object.entries(modelUsage)
  if (entries.length === 0) return ""
  return entries
    .map(([id, mu]) => {
      const total = (mu.inputTokens ?? 0) + (mu.outputTokens ?? 0)
      return `${id}: ${formatCost(mu.costUSD)} (${compactTokens(total)} tok)`
    })
    .join("\n")
}

/**
 * Format a lock owner (instance UUID) for display. Truncated to the first 8
 * chars; null/undefined/empty → "—" (em dash) for unlocked keys.
 */
export function formatLockOwner(owner: string | null | undefined): string {
  if (!owner) return "—"
  return owner.length <= 8 ? owner : owner.slice(0, 8)
}

/**
 * Format the locked-key count for the sidebar. Returns "🔒 N locked" when one
 * or more keys are locked, "" (empty) when zero — so a clean state stays clean.
 */
export function formatLockCount(lockedCount: number): string {
  return lockedCount > 0 ? `🔒 ${lockedCount} locked` : ""
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

  const base = `🔑 ${activeDisplay} | 📊 ${total} ${keyWord} | ${healthy} healthy`

  // Phase 3: cost + lock indicators. Only appended when the state carries
  // phase-3 data (a cost/lock field on any key) so old key-state.json files
  // render identically to phase 1+2 (backward compatible).
  const hasPhase3Data = state.keys.some(
    (k) => k.totalCostUSD !== undefined || k.locked !== undefined,
  )
  if (!hasPhase3Data) return base

  const totalCost = state.keys.reduce((sum, k) => sum + (k.totalCostUSD ?? 0), 0)
  const lockedCount = state.keys.filter((k) => k.locked === true).length
  const lockSuffix = formatLockCount(lockedCount)
  return `${base} | 💰 ${formatCost(totalCost)}${lockSuffix ? ` | ${lockSuffix}` : ""}`
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
    case "lock-release":
      return config.onLockRelease
    default:
      return false
  }
}

// ─── decideToast ───────────────────────────────────────────────────────────

/** Possible event types the TUI monitors. */
export type ToastEventType =
  | "rotate"
  | "cooldown"
  | "recovery"
  | "permanentDeath"
  | "lockRelease"

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
  // Map camelCase event types to the kebab-case keys shouldShowToast expects.
  const gateKey =
    eventType === "permanentDeath"
      ? "permanent-death"
      : eventType === "lockRelease"
        ? "lock-release"
        : eventType
  const show = shouldShowToast(gateKey, config)

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
    case "lockRelease":
      return {
        show: true,
        variant: "info",
        title: "Lock Released",
        message: `🔓 Key '${ctx.keyName ?? "unknown"}' lock released`,
      }
  }
}

// ─── formatKeyStatusTable ────────────────────────────────────────────────────

/**
 * Format a detailed multi-line table for the /key-status command.
 *
 * Columns (phase 1+2): Marker, Name, Account, Health (emoji), Score, Cooldown, Status
 * Phase 3 (when any key carries cost/lock data): adds Tokens(in/out), Est. Cost,
 * Lock Owner columns + a Summary section (total est. cost, total tokens, top
 * model) + a per-model breakdown. Cost is labeled "est. cost" — local
 * estimation, not billing. Active key is marked with "◄".
 */
export function formatKeyStatusTable(state: KeyState): string {
  if (state.keys.length === 0) {
    return "No keys configured."
  }

  const now = Date.now()
  const hasPhase3Data = state.keys.some(
    (k) => k.totalCostUSD !== undefined || k.locked !== undefined,
  )

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
    const base = `  ${marker} ${k.name.padEnd(13)}  ${account}  ${emoji}      ${score}  ${cooldown.padEnd(9)}  ${(status as string).padEnd(12)}`

    if (!hasPhase3Data) return base

    const tokens = formatTokens(k.totalInputTokens, k.totalOutputTokens)
    const cost = formatCost(k.totalCostUSD)
    const owner = formatLockOwner(k.lockOwner ?? null)
    return `${base}  ${tokens.padEnd(13)}  ${cost.padEnd(9)}  ${owner}`
  })

  // Phase 1+2: legacy header, no summary/breakdown (backward compatible).
  if (!hasPhase3Data) {
    const header = "  Name           Account         Health  Score  Cooldown   Status"
    const separator = "  ─────────────  ───────────────  ──────  ─────  ─────────  ──────"
    return [header, separator, ...rows].join("\n")
  }

  const header =
    "  Name           Account         Health  Score  Cooldown   Status        Tokens(in/out)  Est. Cost  Lock Owner"
  const separator =
    "  ─────────────  ───────────────  ──────  ─────  ─────────  ──────        ──────────────  ─────────  ──────────"
  const lines = [header, separator, ...rows]

  // ── Summary section ──────────────────────────────────────────────────────
  const totalCost = state.keys.reduce((sum, k) => sum + (k.totalCostUSD ?? 0), 0)
  const totalIn = state.keys.reduce((sum, k) => sum + (k.totalInputTokens ?? 0), 0)
  const totalOut = state.keys.reduce((sum, k) => sum + (k.totalOutputTokens ?? 0), 0)

  // Aggregate per-model usage across all keys (for breakdown + top model).
  const aggUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {}
  for (const k of state.keys) {
    for (const [modelId, mu] of Object.entries(k.modelUsage ?? {})) {
      if (!aggUsage[modelId]) {
        aggUsage[modelId] = { inputTokens: 0, outputTokens: 0, costUSD: 0 }
      }
      aggUsage[modelId]!.inputTokens += mu.inputTokens
      aggUsage[modelId]!.outputTokens += mu.outputTokens
      aggUsage[modelId]!.costUSD += mu.costUSD
    }
  }
  const topModel = Object.entries(aggUsage).sort((a, b) => b[1].costUSD - a[1].costUSD)[0]
  const topModelStr = topModel ? `${topModel[0]} (${formatCost(topModel[1].costUSD)})` : "—"

  lines.push("")
  lines.push("  Summary")
  lines.push(
    `  Total est. cost: ${formatCost(totalCost)}  |  Total tokens: ${formatTokens(totalIn, totalOut)}  |  Top model: ${topModelStr}`,
  )

  // ── Model breakdown section ──────────────────────────────────────────────
  const breakdown = formatModelBreakdown(aggUsage)
  if (breakdown) {
    lines.push("")
    lines.push("  Model breakdown")
    for (const line of breakdown.split("\n")) lines.push(`  ${line}`)
  }

  return lines.join("\n")
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
