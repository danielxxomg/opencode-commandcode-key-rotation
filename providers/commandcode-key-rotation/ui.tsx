/**
 * TUI plugin for commandcode-key-rotation.
 *
 * Responsibilities:
 * - sidebar_footer slot: shows active key name + health emoji + "N keys | M healthy"
 * - toast notifications: onRotate, onCooldown, onRecovery, onPermanentDeath
 * - /key-status command: detailed table of all keys
 *
 * Uses pure logic functions from ui-logic.ts (TDD-tested).
 * Reads key-state.json via fs (server writes, TUI reads).
 *
 * Design decision — TUI render is NOT unit-tested (pragmatic for TUI).
 * All pure logic is extracted to ui-logic.ts and tested there.
 */

/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiDialogStack } from "@opencode-ai/plugin/tui"
import type { Renderable, KeyEvent } from "@opentui/core"
import type { CommandContext, CommandResult } from "@opentui/keymap"
import { TextAttributes } from "@opentui/core"
import { createSignal, createEffect, onCleanup } from "solid-js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import type { KeyState } from "./server.js"
import {
  formatKeyStatus,
  formatKeyStatusTable,
  decideToast,
  decideConfigWarning,
  isNotificationDismissed,
  dismissNotification,
} from "./ui-logic.js"

// ─── Constants ────────────────────────────────────────────────────────────────

const KEYS_DIR = path.join(os.homedir(), ".commandcode")
const STATE_FILE = path.join(KEYS_DIR, "key-state.json")
const POLL_INTERVAL_MS = 3000

// ─── State reading ────────────────────────────────────────────────────────────

function readKeyStateSafe(): KeyState {
  try {
    const content = fs.readFileSync(STATE_FILE, "utf-8")
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object") {
      return { activeKey: null, keys: [] }
    }
    return {
      activeKey: parsed.activeKey ?? null,
      // Keys pass through with all optional Phase 3 cost/lock fields intact
      // (KeyStateEntry fields are optional, so old files parse without migration).
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      notifications: parsed.notifications,
      lastRotation: parsed.lastRotation,
      configWarning: parsed.configWarning,
      // Phase 3: active locks summary
      activeLocks: Array.isArray(parsed.activeLocks) ? parsed.activeLocks : undefined,
    }
  } catch {
    return { activeKey: null, keys: [] }
  }
}

// ─── TUI Plugin ──────────────────────────────────────────────────────────────

const id = "commandcode-key-rotation"

const tui: TuiPlugin = async (api) => {
  const [state, setState] = createSignal<KeyState>(readKeyStateSafe())

  // C11: Load dismissed notifications from api.kv for persistence across sessions
  const dismissedKey = "dismissed-notifications"
  let dismissedNotifications = new Set<string>(
    ((await api.kv.get(dismissedKey)) as string[] | undefined) ?? [],
  )

  // Track previous state for toast notifications
  let prevState: KeyState = readKeyStateSafe()

  // Helper: save dismissed state to api.kv
  function persistDismissed() {
    api.kv.set(dismissedKey, Array.from(dismissedNotifications))
  }

  // C10: Check for config warning on init
  const initialState = state()
  if (initialState.configWarning) {
    const warning = decideConfigWarning(initialState)
    if (warning?.show) {
      api.ui.toast({ variant: warning.variant, title: warning.title, message: warning.message })
    }
  }

  // Poll key-state.json and fire toasts on state changes
  const interval = setInterval(() => {
    const newState = readKeyStateSafe()
    setState(newState)

    // C10: Check for config warning
    if (newState.configWarning && newState.configWarning !== prevState.configWarning) {
      const warning = decideConfigWarning(newState)
      if (warning?.show) {
        api.ui.toast({ variant: warning.variant, title: warning.title, message: warning.message })
      }
    }

    // Detect changes and fire toasts via decideToast (single integration point)
    // C11: pass dismissed set to gate dismissed notifications
    if (newState.activeKey !== prevState.activeKey && newState.activeKey) {
      const toast = decideToast("rotate", { fromKey: prevState.activeKey ?? "none" }, newState, dismissedNotifications)
      if (toast.show) {
        api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
      }
    }

    // Check each key for health changes
    for (const newKey of newState.keys) {
      const oldKey = prevState.keys.find((k) => k.name === newKey.name)
      if (!oldKey) continue

      if (newKey.health !== oldKey.health) {
        if (newKey.health === "rate-limited" || newKey.health === "cooldown") {
          const toast = decideToast("cooldown", { keyName: newKey.name }, newState, dismissedNotifications)
          if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
        } else if (newKey.health === "healthy" && oldKey.health !== "healthy") {
          const toast = decideToast("recovery", { keyName: newKey.name }, newState, dismissedNotifications)
          if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
        } else if (newKey.health === "auth-error" || newKey.health === "dead") {
          const toast = decideToast("permanentDeath", { keyName: newKey.name }, newState, dismissedNotifications)
          if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
        }
      }

      // Phase 3: lock-release toast — a key that was locked is now unlocked.
      if (newKey.locked !== true && oldKey.locked === true) {
        const toast = decideToast("lockRelease", { keyName: newKey.name }, newState, dismissedNotifications)
        if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
      }
    }

    prevState = newState
  }, POLL_INTERVAL_MS)

  // Listen for server events that might change key state
  const offEvent = api.event.on("session.error", () => {
    // Re-read state after a short delay (server writes async)
    setTimeout(() => {
      const newState = readKeyStateSafe()
      setState(newState)

      // Same toast logic as polling — via decideToast with dismissed set
      if (newState.activeKey !== prevState.activeKey && newState.activeKey) {
        const toast = decideToast("rotate", { fromKey: prevState.activeKey ?? "none" }, newState, dismissedNotifications)
        if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
      }

      // Phase 3: lock-release toast on lock→unlock transition
      for (const newKey of newState.keys) {
        const oldKey = prevState.keys.find((k) => k.name === newKey.name)
        if (oldKey && oldKey.locked === true && newKey.locked !== true) {
          const toast = decideToast("lockRelease", { keyName: newKey.name }, newState, dismissedNotifications)
          if (toast.show) api.ui.toast({ variant: toast.variant, title: toast.title, message: toast.message })
        }
      }

      prevState = newState
    }, 500)
  })

  // Cleanup
  api.lifecycle.onDispose(() => {
    clearInterval(interval)
    offEvent()
  })

  // ─── sidebar_footer slot ────────────────────────────────────────────────────

  api.slots.register({
    order: 10,
    slots: {
      sidebar_footer() {
        return <text>{formatKeyStatus(state())}</text>
      },
    },
  })

  // ─── /key-status command ────────────────────────────────────────────────────

  api.keymap.registerLayer({
    commands: [
      {
        name: "key-status",
        title: "Key Status",
        description: "Show detailed key rotation status",
        slash: { name: "key-status" },
        run() {
          const table = formatKeyStatusTable(state())
          api.ui.dialog.replace(
            () => (
              <box flexDirection="column" padding={1}>
                <text attributes={TextAttributes.BOLD}>Key Rotation Status</text>
                <text />
                <text>{table}</text>
              </box>
            ),
            () => api.ui.dialog.clear(),
          )
        },
      },
      {
        name: "key-dismiss",
        title: "Dismiss Notification",
        description: "Dismiss a key rotation notification type (persists across sessions). Usage: /key-dismiss <type>",
        slash: { name: "key-dismiss" },
        run(ctx: CommandContext<Renderable, KeyEvent>) {
          const type = ctx.input?.trim()
          if (!type) {
            // No arg: show the dismiss menu
            const types = ["rotate", "cooldown", "recovery", "permanent-death", "lock-release"]
            api.ui.dialog.replace(
              () => (
                <box flexDirection="column" padding={1}>
                  <text attributes={TextAttributes.BOLD}>Dismiss Notifications</text>
                  <text />
                  {types.map((t: string) => {
                    const dismissed = isNotificationDismissed(t, dismissedNotifications)
                    return (
                      <text>
                        {dismissed ? "  [X]" : "  [ ]"} {t}
                      </text>
                    )
                  })}
                  <text />
                  <text>Usage: /key-dismiss cooldown  (toggle)</text>
                </box>
              ),
              () => api.ui.dialog.clear(),
            )
            return
          }
          // Normalize: "permanent-death" ↔ "permanentDeath"
          const normalized = type === "permanentDeath" ? "permanent-death" : type
          if (isNotificationDismissed(normalized, dismissedNotifications)) {
            // Un-dismiss: remove from set
            dismissedNotifications = new Set(
              Array.from(dismissedNotifications).filter((t) => t !== normalized),
            )
          } else {
            // Dismiss
            dismissedNotifications = dismissNotification(dismissedNotifications, normalized)
          }
          persistDismissed()
        },
      },
    ],
    bindings: [],
  })
}

export default { id, tui }
