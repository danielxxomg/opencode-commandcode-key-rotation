import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamResult,
  LanguageModelV3GenerateResult,
  LanguageModelV3Content,
  LanguageModelV3Usage,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { buildRequest } from "./convert.js"
import { parseStreamEvents } from "./stream.js"
import type { KeyManager } from "./key-manager.js"

const DEFAULT_BASE_URL = "https://api.commandcode.ai"
// x-command-code-version must match the Command Code CLI version for API compatibility
const CC_VERSION = "0.26.20"

// --- Retry config ---
// Max 3 retries after the initial attempt (4 total). Backoff schedule with
// jitter keeps reconnects short: ~1s, ~2.5s, ~5s (±25% jitter).
const MAX_RETRIES = 3
const BACKOFF_SCHEDULE_MS = [1000, 2500, 5000] as const
const REQUEST_TIMEOUT_MS = 300_000
// Phase 3: default lock TTL (5min). Refresh interval = TTL/3 (~100s).
const DEFAULT_LOCK_TIMEOUT_MS = 300_000
// Floor for the refresh interval so a tiny lockTimeoutMs can't produce a 0ms
// interval (which would spin aggressively).
const MIN_REFRESH_INTERVAL_MS = 1000

// --- error classification ---

/**
 * Extract a lowercased, searchable message from an error of any shape.
 * Handles Error instances, strings, and the plain SSE error objects Command
 * Code emits (e.g. { type: "server_error", message: "Network connection lost." }).
 */
function extractMessage(err: unknown): string {
  if (err === null || err === undefined) return ""
  if (err instanceof Error) return err.message.toLowerCase()
  if (typeof err === "string") return err.toLowerCase()
  if (typeof err === "object") {
    const e = err as Record<string, unknown>
    const nested = e.error as Record<string, unknown> | undefined
    const parts: string[] = []
    for (const v of [e.message, nested?.message, e.msg, nested?.type, e.type, e.code]) {
      if (typeof v === "string" && v) parts.push(v)
    }
    if (parts.length) return parts.join(" ").toLowerCase()
    try {
      return JSON.stringify(err).toLowerCase()
    } catch {
      return ""
    }
  }
  return String(err).toLowerCase()
}

// Non-transient failures: never retry these. Matched conservatively (specific
// phrases) so genuine transient errors are never misclassified as permanent.
// NOTE: quota patterns are checked FIRST (see QUOTA_PATTERNS) for key swap.
const NON_RETRYABLE_PATTERNS = [
  "model_not_in_plan",
  "model not in plan",
  "not_in_plan",
  "not in plan",
  "unauthorized",
  "forbidden",
  "invalid api key",
  "invalid_api_key",
  "authentication",
  "auth_error",
  "permission_denied",
  "validation_error",
  "bad request",
  "not found",
]

// Quota/rate-limit patterns: trigger key swap (NOT retry consumption).
// Checked before NON_RETRYABLE_PATTERNS for classification precedence.
const QUOTA_PATTERNS = [
  "usage limit",
  "usage_limit",
  "exceeded your",
  "quota exceeded",
  "insufficient credit",
  "insufficient_credit",
]

// Transient failures: safe to retry when no content has been emitted yet.
const RETRYABLE_PATTERNS = [
  "network connection lost",
  "connection lost",
  "connection reset",
  "connection refused",
  "connection timeout",
  "server_error",
  "server error",
  "internal server error",
  "internal error",
  "aborted",
  "aborterror",
  "abort_error",
  "fetch failed",
  "fetchfailed",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
  "terminated",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "downstream",
  "temporarily unavailable",
]

function isNonRetryableError(err: unknown): boolean {
  const msg = extractMessage(err)
  if (!msg) return false
  // Quota patterns are NOT non-retryable — they trigger key swap
  if (QUOTA_PATTERNS.some((p) => msg.includes(p))) return false
  return NON_RETRYABLE_PATTERNS.some((p) => msg.includes(p))
}

function isRetryableError(err: unknown): boolean {
  if (isNonRetryableError(err)) return false
  const msg = extractMessage(err)
  if (!msg) return false
  return RETRYABLE_PATTERNS.some((p) => msg.includes(p))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

function isQuotaError(body: string): boolean {
  const msg = body.toLowerCase()
  return QUOTA_PATTERNS.some((p) => msg.includes(p))
}

function redactKey(key: string): string {
  if (key.length <= 8) return "…xxxx"
  // Show first 5 chars + … + last 4 (e.g., user_…xxxx)
  return `${key.slice(0, 5)}…${key.slice(-4)}`
}

/**
 * Redact API key material from error bodies before logging.
 * Replaces known keys AND generic user_ patterns to prevent
 * accidental key exposure in logs.
 */
function redactBody(body: string, keys: string[]): string {
  let result = body
  // Redact known keys first
  for (const key of keys) {
    if (key.length > 8) {
      result = result.replaceAll(key, redactKey(key))
    }
  }
  // Defense-in-depth: redact any user_ key pattern not in pool
  result = result.replaceAll(/user_[A-Za-z0-9]{4,}/g, (match) => redactKey(match))
  return result
}

function backoffDelay(attempt: number): number {
  const base = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]
  // jitter ±25% to avoid synchronized retry storms
  return base * (0.75 + Math.random() * 0.5)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function wrapAsError(err: unknown): Error {
  if (err instanceof Error) return err
  if (typeof err === "string") return new Error(err)
  const e = err as Record<string, unknown>
  const nested = e.error as Record<string, unknown> | undefined
  const message =
    (typeof e.message === "string" && e.message) ||
    (typeof nested?.message === "string" && nested.message) ||
    (typeof e.msg === "string" && e.msg) ||
    (() => {
      try {
        return JSON.stringify(err)
      } catch {
        return "Unknown error"
      }
    })()
  const type =
    (typeof e.type === "string" && e.type) ||
    (typeof nested?.type === "string" && nested.type) ||
    undefined
  const error = new Error(type ? `${type}: ${message}` : String(message))
  Object.assign(error, { ccError: err, ...(type ? { code: type } : {}) })
  return error
}

export function partialOutputError(original: unknown): Error {
  const err = new Error(
    `Command Code stream failed after partial output was already emitted; reconnect aborted to avoid duplicate content. Original error: ${describeError(original)}`,
  )
  Object.assign(err, { partialOutput: true, ccError: original })
  return err
}

/**
 * Decide whether a failure should be retried.
 * Retry only when: the error is transient, NO substantive content has been
 * emitted yet (avoids dangerous duplicate regeneration), attempts remain, and
 * the request was not intentionally aborted (user cancel / hard timeout).
 */
export function shouldRetry(
  err: unknown,
  emittedContent: boolean,
  attempt: number,
  maxRetries: number,
  aborted: boolean,
): boolean {
  if (aborted) return false
  if (emittedContent) return false
  if (attempt >= maxRetries) return false
  return isRetryableError(err)
}

async function buildHttpError(response: Response, modelId: string): Promise<Error & { errorBody?: string }> {
  const errorBody = await response.text().catch(() => "")
  let message = `Command Code API error: ${response.status} ${response.statusText}`
  let type = ""
  try {
    const parsed = JSON.parse(errorBody)
    if (parsed?.error?.message) message = parsed.error.message
    else if (parsed?.message) message = parsed.message
    if (parsed?.error?.type) type = parsed.error.type
    else if (parsed?.type) type = parsed.type
  } catch {
    // intentionally silent: error body is not JSON
  }
  const err = new Error(`${message} [model=${modelId}]`) as Error & { errorBody?: string }
  if (type) Object.assign(err, { code: type })
  err.errorBody = errorBody
  return err
}

/**
 * Result of fetchWithRetry. `keyUsed` is the key string that actually served
 * the request (null when no KeyManager — legacy single-key mode). `releaseLock`
 * releases any coordination lock acquired for `keyUsed`; it is a no-op when no
 * LockManager is configured. The caller MUST invoke `releaseLock` when the
 * response stream terminates (close/error/cancel) so cross-instance key locks
 * are not held past the request lifetime.
 */
export interface FetchResult {
  response: Response
  keyUsed: string | null
  releaseLock: () => void
}

/**
 * Minimal lock-lifecycle surface the model depends on (Interface Segregation:
 * the model only acquires/releases/refreshes, never inspects). The real
 * `LockManager` (lock-manager.ts) satisfies this structurally, so it can be
 * passed in directly; tests inject a small recording fake.
 */
export interface LockLifecycleCoordinator {
  acquireLock(keyName: string): boolean
  releaseLock(keyName: string): void
  refreshLock(keyName: string): boolean
}

export interface CommandCodeModelOptions {
  apiKey: string
  baseURL?: string
  headers?: Record<string, string>
  keyManager?: KeyManager
  fetchFn?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  dev?: boolean
  /** Phase 3: cross-instance key lock coordinator. Absent → no lock logic. */
  lockManager?: LockLifecycleCoordinator
  /** Phase 3: lock TTL in ms (default 5min). Refresh interval = TTL/3. */
  lockTimeoutMs?: number
  /** Phase 3: injectable timer (determinism). Defaults to global. */
  setInterval?: (handler: () => void, timeout?: number) => unknown
  /** Phase 3: injectable timer clear (determinism). Defaults to global. */
  clearInterval?: (handle: unknown) => void
}

export class CommandCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider = "commandcode"
  readonly modelId: string
  supportedUrls: Record<string, RegExp[]> = {}

  private opts: CommandCodeModelOptions
  // Phase 3: lock coordination (all no-op when lockManager is absent).
  private lockManager?: LockLifecycleCoordinator
  private lockTimeoutMs: number
  private setIntervalFn: (handler: () => void, timeout?: number) => unknown
  private clearIntervalFn: (handle: unknown) => void

  constructor(modelId: string, opts: CommandCodeModelOptions) {
    this.modelId = modelId
    this.opts = opts
    this.lockManager = opts.lockManager
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
    this.setIntervalFn = opts.setInterval ?? setInterval
    // Adapter so the field accepts an `unknown` handle (test fakes return
    // arbitrary tokens like "h1") while the real global clearInterval still
    // receives the NodeJS.Timeout that setInterval produced. The cast is safe:
    // in production the handle is always a real timer handle.
    this.clearIntervalFn =
      opts.clearInterval ??
      ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  }

  private get baseURL(): string {
    return this.opts.baseURL ?? DEFAULT_BASE_URL
  }

  private buildHeaders(key?: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key ?? this.opts.apiKey}`,
      "x-command-code-version": CC_VERSION,
      "x-cli-environment": "production",
      "x-project-slug": "opencode",
      ...this.opts.headers,
    }
  }

  /**
   * Initial connection with retry/backoff for transient network and 5xx
   * failures. When a KeyManager is present, 429/quota errors trigger key
   * swap (NOT retry consumption). Auth errors (401/403) permanently kill
   * the key and swap. Only 5xx/network errors consume the retry budget.
   *
   * fetchWithRetry is the SOLE key selection authority: it calls selectKey()
   * and builds the request via the `fetchOpts` builder, passing the selected
   * key. `fetchOpts` is a pure builder (no selection) — this removes the
   * previous double-selection bug where fetchOpts() and fetchWithRetry both
   * called selectKey(). Returns { response, keyUsed, releaseLock } so the
   * caller can attribute usage and release any coordination lock.
   *
   * Lock lifecycle (L2-T4): when a LockManager is configured, the selected
   * key's lock is acquired here and held until the caller invokes the
   * returned `releaseLock` (on stream terminal). A refresh timer renews the
   * lock every lockTimeoutMs/3 while held. On key swap the old lock is
   * released before re-selecting; on any fatal throw the held lock is
   * released (no caller to release it). No LockManager → all lock logic is
   * skipped and `releaseLock` is a no-op (backward compatible).
   */
  private async fetchWithRetry(
    url: string,
    fetchOpts: (key?: string) => RequestInit,
    maxRetries: number = MAX_RETRIES,
  ): Promise<FetchResult> {
    const doFetch = this.opts.fetchFn ?? fetch
    const doSleep = this.opts.sleep ?? sleep
    const km = this.opts.keyManager
    const lockMgr = this.lockManager
    const dev = this.opts.dev ?? false
    const maxKeySwaps = km ? km.getKeyEntries().length + 1 : 0
    let keySwaps = 0
    let lastError: unknown

    // Currently-held lock state (null/undefined when no lock held).
    let heldName: string | null = null
    let refreshHandle: unknown = undefined
    const clearRefresh = () => {
      if (refreshHandle !== undefined) {
        try { this.clearIntervalFn(refreshHandle) } catch { /* best-effort */ }
        refreshHandle = undefined
      }
    }
    const releaseHeld = () => {
      clearRefresh()
      if (heldName !== null && lockMgr) {
        try { lockMgr.releaseLock(heldName) } catch { /* best-effort */ }
      }
      heldName = null
      // Fix 3: emit live lock status after a release so the server can persist
      // it to key-state.json (TUI lock count is never stale). No-op without a
      // KeyManager or onStateChange callback.
      km?.notifyStateChange()
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // SOLE selection authority: select the key here, then build opts with it.
      let currentKey: string | undefined
      if (km) {
        let selected: { name: string; key: string }
        try {
          selected = km.selectKey()
          currentKey = selected.key
        } catch (selErr) {
          // All keys dead — release any held lock, then fatal.
          releaseHeld()
          throw selErr
        }
        // Lock coordination: acquire on the selected key's NAME. Keep holding
        // across same-key retries; release+reacquire only when the key changes.
        if (lockMgr) {
          if (selected.name !== heldName) {
            if (heldName !== null) {
              clearRefresh()
              try { lockMgr.releaseLock(heldName) } catch { /* best-effort */ }
              heldName = null
            }
            if (!lockMgr.acquireLock(selected.name)) {
              // Race: another instance locked it between selectKey and acquire.
              // selectKey already filters locked keys, so this is rare —
              // re-select a different key, bounded by keySwaps.
              lastError = new Error(`Could not acquire lock for key ${redactKey(selected.key)}`)
              if (keySwaps < maxKeySwaps) {
                keySwaps++
                attempt-- // do NOT burn a retry on a lock race
                continue
              }
              releaseHeld()
              throw lastError
            }
            heldName = selected.name
            const intervalMs = Math.max(
              MIN_REFRESH_INTERVAL_MS,
              Math.floor(this.lockTimeoutMs / 3),
            )
            refreshHandle = this.setIntervalFn(() => {
              try { lockMgr.refreshLock(selected.name) } catch { /* best-effort */ }
            }, intervalMs)
            // Fix 3: emit live lock status right after acquire so the server
            // persists it (TUI shows the key locked during the in-flight
            // request, not just after the response). No-op without callback.
            km?.notifyStateChange()
          }
        }
      }
      const opts = fetchOpts(currentKey)

      try {
        const response = await doFetch(url, opts)
        if (response.ok) {
          if (km && currentKey) {
            // Report success on the key that served the request (success-count
            // + score bonus). Cost attribution happens in the usage stream
            // wrapper via reportUsage when the finish event arrives.
            km.reportSuccess(currentKey)
          }
          // Hand the lock + refresh timer off to the caller's releaseLock.
          const successName = heldName
          const successHandle = refreshHandle
          heldName = null
          refreshHandle = undefined
          const releaseLock = () => {
            if (successHandle !== undefined) {
              try { this.clearIntervalFn(successHandle) } catch { /* best-effort */ }
            }
            if (successName !== null && lockMgr) {
              try { lockMgr.releaseLock(successName) } catch { /* best-effort */ }
            }
            // Fix 3: emit live lock status when the caller releases the
            // coordination lock on stream terminal (close/error/cancel) so the
            // TUI stops showing the key as locked. No-op without callback.
            km?.notifyStateChange()
          }
          return {
            response,
            keyUsed: currentKey ?? null,
            releaseLock,
          }
        }

        const err = await buildHttpError(response, this.modelId)
        const errorBody = (err as { errorBody?: string }).errorBody ?? ""
        const currentKeyForReport = currentKey ?? this.opts.apiKey

        // Auth status (401/403) → permanent death + swap
        if (isAuthStatus(response.status)) {
          if (dev) console.error(`[CC-Dev] Auth error ${response.status}: ${redactKey(currentKeyForReport)} body=${redactBody(errorBody.slice(0, 200), km ? km.getKeyEntries().map(e => e.key) : [currentKeyForReport])}`)
          if (km) {
            km.reportAuthError(currentKeyForReport)
            if (keySwaps < maxKeySwaps) {
              keySwaps++
              // Release the swapped key's lock BEFORE re-selecting a new key.
              releaseHeld()
              attempt-- // do NOT consume retry
              continue
            }
          }
          releaseHeld()
          throw err
        }

        // 429 or quota error → key swap (NOT retry consumption)
        if (response.status === 429 || isQuotaError(errorBody)) {
          if (dev) console.error(`[CC-Dev] Rate/quota ${response.status}: ${redactKey(currentKeyForReport)} body=${redactBody(errorBody.slice(0, 200), km ? km.getKeyEntries().map(e => e.key) : [currentKeyForReport])}`)
          if (km) {
            const retryAfter = response.headers.get("retry-after")
            const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined
            if (response.status === 429) {
              km.reportRateLimit(currentKeyForReport, retryAfterMs)
            } else {
              km.reportQuotaError(currentKeyForReport)
            }
            if (keySwaps < maxKeySwaps) {
              keySwaps++
              // Release the swapped key's lock BEFORE re-selecting a new key.
              releaseHeld()
              attempt-- // do NOT consume retry
              continue
            }
          }
          // No KeyManager or swaps exhausted — fall through to legacy retry
          if (!km && isRetryableStatus(response.status) && attempt < maxRetries) {
            const delay = backoffDelay(attempt)
            console.error(
              `[CC-Retry] HTTP ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${err.message}`,
            )
            await doSleep(delay)
            continue
          }
          releaseHeld()
          throw err
        }

        // 5xx → consume retry + backoff (same as before). Keep holding the
        // lock across the retry; if selectKey picks a different key next
        // attempt (the 5xx key enters a short cooldown), the acquire branch
        // releases the old lock and acquires the new one.
        if (response.status >= 500) {
          if (dev) console.error(`[CC-Dev] Server error ${response.status}: ${redactKey(currentKeyForReport)} body=${redactBody(errorBody.slice(0, 200), km ? km.getKeyEntries().map(e => e.key) : [currentKeyForReport])}`)
          if (km) km.reportServerError(currentKeyForReport)
          if (attempt < maxRetries) {
            const delay = backoffDelay(attempt)
            console.error(
              `[CC-Retry] HTTP ${response.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${err.message}`,
            )
            await doSleep(delay)
            continue
          }
        }

        releaseHeld()
        throw err
      } catch (err) {
        lastError = err
        // Network errors → consume retry + backoff (keep holding the lock).
        if (isRetryableError(err) && attempt < maxRetries) {
          const delay = backoffDelay(attempt)
          console.error(
            `[CC-Retry] network error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${describeError(err)}`,
          )
          await doSleep(delay)
          continue
        }
        releaseHeld()
        throw err
      }
    }
    releaseHeld()
    throw lastError
  }

  /**
   * Single fetch used for mid-stream reconnects. The retry budget for
   * reconnects is owned by streamWithReconnect (no double counting).
   * 5xx/429 are tagged with a `server_error` token so the wrapper classifies
   * them as retryable; 4xx throw the parsed (non-retryable) error.
   */
  private async fetchOnce(url: string, fetchOpts: RequestInit): Promise<Response> {
    const doFetch = this.opts.fetchFn ?? fetch
    const response = await doFetch(url, fetchOpts)
    if (response.ok) return response
    const err = await buildHttpError(response, this.modelId)
    if (isRetryableStatus(response.status)) {
      throw new Error(`server_error: reconnect HTTP ${response.status} (${err.message})`)
    }
    throw err
  }

  /**
   * Wraps a parsed stream to detect mid-stream disconnects and transparently
   * reconnect — BUT only when no substantive content (text, reasoning,
   * tool-call, tool-input) has been emitted yet. If partial output already
   * went downstream, reconnecting would regenerate from scratch and produce
   * DUPLICATE content, so we instead surface a clear error.
   */
  private streamWithReconnect(
    makeStream: () => ReadableStream<LanguageModelV3StreamPart>,
    reconnect: () => Promise<ReadableStream<LanguageModelV3StreamPart>>,
    isAborted: () => boolean,
    lockCoord: { releaseLock: () => void },
    maxRetries: number = MAX_RETRIES,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const doSleep = this.opts.sleep ?? sleep
    let attempt = 0
    let currentStream = makeStream()
    let reader = currentStream.getReader()
    let emittedContent = false
    let pendingReconnect = false
    // Release the coordination lock exactly once when the stream terminates
    // (close/error/cancel). Idempotent so multiple terminal paths are safe.
    // Reads lockCoord.releaseLock() at call time so a mid-stream reconnect
    // that swapped the release closure (new key) releases the CURRENT key,
    // not the original failed one.
    let lockReleased = false
    const releaseOnce = () => {
      if (lockReleased) return
      lockReleased = true
      try { lockCoord.releaseLock() } catch { /* best-effort: never break the stream */ }
    }

    return new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        while (true) {
          if (pendingReconnect) {
            pendingReconnect = false
            try {
              currentStream = await reconnect()
              reader = currentStream.getReader()
              continue
            } catch (reconnectErr) {
              if (shouldRetry(reconnectErr, emittedContent, attempt, maxRetries, isAborted())) {
                attempt++
                const delay = backoffDelay(attempt - 1)
                console.error(
                  `[CC-Retry-Stream] reconnect failed (attempt ${attempt}/${maxRetries}), retrying in ${Math.round(delay)}ms: ${describeError(reconnectErr)}`,
                )
                await doSleep(delay)
                pendingReconnect = true
                continue
              }
              releaseOnce()
              if (emittedContent) {
                controller.error(partialOutputError(reconnectErr))
              } else {
                controller.error(wrapAsError(reconnectErr))
              }
              return
            }
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bun type incompatibility with ReadableStreamReadResult
          let readResult: any
          try {
            readResult = await reader.read()
          } catch (err) {
            if (shouldRetry(err, emittedContent, attempt, maxRetries, isAborted())) {
              attempt++
              const delay = backoffDelay(attempt - 1)
              console.error(
                `[CC-Retry-Stream] mid-stream disconnect (attempt ${attempt}/${maxRetries}), reconnecting in ${Math.round(delay)}ms: ${describeError(err)}`,
              )
              await doSleep(delay)
              pendingReconnect = true
              continue
            }
            releaseOnce()
            if (emittedContent) {
              controller.error(partialOutputError(err))
            } else {
              controller.error(wrapAsError(err))
            }
            return
          }

          const { done, value } = readResult
          if (done) {
            releaseOnce()
            controller.close()
            return
          }
          if (!value) continue

          // Track substantive content emission — gates safe reconnect.
          if (
            value.type === "text-delta" ||
            value.type === "reasoning-delta" ||
            value.type === "tool-call" ||
            value.type === "tool-input-start" ||
            value.type === "tool-input-delta"
          ) {
            emittedContent = true
          }

          // Defensive: stream.ts converts SSE errors into controller.error(),
          // so an {type:"error"} part should never arrive here. If it does,
          // treat it as a terminal failure with retry gating.
          if (value.type === "error") {
            const inner = (value as { error?: unknown }).error
            if (shouldRetry(inner, emittedContent, attempt, maxRetries, isAborted())) {
              attempt++
              const delay = backoffDelay(attempt - 1)
              console.error(
                `[CC-Retry-Stream] error part (attempt ${attempt}/${maxRetries}), reconnecting in ${Math.round(delay)}ms: ${describeError(inner)}`,
              )
              await doSleep(delay)
              pendingReconnect = true
              continue
            }
            releaseOnce()
            if (emittedContent) {
              controller.error(partialOutputError(inner))
            } else {
              controller.error(wrapAsError(inner))
            }
            return
          }

          controller.enqueue(value)
          return
        }
      },
      cancel() {
        releaseOnce()
        reader.cancel()
      },
    })
  }

  /**
   * Wrap a stream so the `finish` event's usage is attributed to the key that
   * actually served the request via `keyManager.reportUsage(keyUsed, modelId,
   * usage)`. ALL events are forwarded unchanged and in order — the wrapper is
   * transparent to the consumer. reportUsage is wrapped in try/catch (error
   * isolation): a bad costMap entry or division-by-zero MUST NEVER break the
   * response stream; the finish event is always forwarded. Applied only when a
   * KeyManager is present (legacy single-key mode skips the wrapper entirely).
   *
   * `keyUsed` is read from the shared `lockCoord` holder at finish time (not
   * captured by value) so a pre-content mid-stream reconnect that swapped keys
   * attributes usage to the NEW reconnect key, not the original failed one.
   *
   * Lock release is NOT handled here — streamWithReconnect (the inner stream)
   * already calls releaseLock on close/error/cancel, and cancel propagates
   * from this wrapper down to it.
   */
  private wrapStreamForUsage(
    inner: ReadableStream<LanguageModelV3StreamPart>,
    keyManager: KeyManager,
    lockCoord: { keyUsed: string | null },
    modelId: string,
  ): ReadableStream<LanguageModelV3StreamPart> {
    const reader = inner.getReader()
    return new ReadableStream<LanguageModelV3StreamPart>({
      async pull(controller) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bun type incompatibility with ReadableStreamReadResult
        let readResult: any
        try {
          readResult = await reader.read()
        } catch (err) {
          controller.error(err instanceof Error ? err : wrapAsError(err))
          return
        }
        const { done, value } = readResult as { done: boolean; value?: LanguageModelV3StreamPart }
        if (done) {
          controller.close()
          return
        }
        if (!value) return
        // Intercept finish for usage attribution. Error-isolated so a throwing
        // reportUsage can never break the stream — the event is always forwarded.
        if (value.type === "finish") {
          const usage = (value as { usage?: LanguageModelV3Usage }).usage
          if (usage && lockCoord.keyUsed) {
            try {
              keyManager.reportUsage(lockCoord.keyUsed, modelId, usage)
            } catch (e) {
              console.error(`[CC-Usage] reportUsage failed: ${describeError(e)}`)
            }
          }
        }
        controller.enqueue(value)
      },
      cancel() {
        try { reader.cancel() } catch { /* best-effort */ }
      },
    })
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const body = buildRequest(this.modelId, options)
    const requestBody = JSON.stringify(body)

    const controller = new AbortController()
    let userAborted = false
    const timeout = setTimeout(
      () => controller.abort(new Error("Request timed out after 5 minutes")),
      REQUEST_TIMEOUT_MS,
    )
    const userSignal = options.abortSignal
    if (userSignal) {
      const onAbort = () => {
        userAborted = true
        controller.abort(userSignal.reason)
      }
      userSignal.addEventListener("abort", onAbort, { once: true })
    }

    const url = `${this.baseURL}/alpha/generate`
    const km = this.opts.keyManager
    // Local const so closures inside the reconnect path keep TypeScript's
    // non-undefined narrowing (this.lockManager is set once in the ctor).
    const lockMgr = this.lockManager
    // Pure builder: takes the selected key and builds the RequestInit. Does NOT
    // select a key — fetchWithRetry is the sole selection authority (L2-T2).
    const fetchOpts = (key?: string): RequestInit => ({
      method: "POST",
      headers: this.buildHeaders(key),
      body: requestBody,
      signal: controller.signal,
    })

    const isAborted = () => userAborted || controller.signal.aborted

    try {
      const { response, keyUsed, releaseLock } = await this.fetchWithRetry(url, fetchOpts)

      if (!response.body) {
        // No stream to hold the lock for — release any coordination lock now.
        releaseLock()
        throw new Error(`Command Code API returned no body [model=${this.modelId}]`)
      }

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v
      })

      const makeStream = () => parseStreamEvents(response.body as ReadableStream<Uint8Array>)

      // Mutable lock-coordination state shared by the reconnect closure
      // (writer) and both stream wrappers (readers). On a pre-content
      // mid-stream reconnect, the failed key's lock is released and a lock
      // for the new reconnect key is acquired; this holder keeps the release
      // closure + keyUsed in sync so streamWithReconnect's terminal release
      // targets the CURRENT key and the usage wrapper attributes finish to
      // the CURRENT key. No lockManager → releaseLock is a no-op and the
      // holder is never swapped with lock state (backward compatible).
      const lockCoord: { keyUsed: string | null; releaseLock: () => void } = {
        keyUsed,
        releaseLock,
      }

      const reconnect = async (): Promise<ReadableStream<LanguageModelV3StreamPart>> => {
        // Release the FAILED key's lock before reconnecting (spec: mid-stream
        // failure MUST release the failed key lock). Safe in legacy mode —
        // the initial releaseLock is a no-op when no lockManager is set.
        try { lockCoord.releaseLock() } catch { /* best-effort */ }
        // Clear the release closure so a failure before re-acquire cannot
        // double-release the old key on the terminal path.
        lockCoord.releaseLock = () => {}

        // Reconnect logic unchanged: selectKey + pure builder + fetchOnce.
        let newKey: string | undefined
        if (km) {
          const selected = km.selectKey()
          newKey = selected.key
          // Update keyUsed so the usage wrapper attributes finish to the new
          // key (km present → wrapper is applied).
          lockCoord.keyUsed = newKey
          // Acquire a lock for the new reconnect key (spec). Skipped entirely
          // when no lockManager is configured (backward compat).
          if (lockMgr) {
            lockMgr.acquireLock(selected.name)
            // Fix 3: emit live lock status after the reconnect acquire so the
            // TUI reflects the new key as locked. No-op without callback.
            km?.notifyStateChange()
            // Mirror fetchWithRetry's lock lifecycle (refresh timer + release
            // closure) so the reconnect lock does not expire mid-stream.
            const newName = selected.name
            const intervalMs = Math.max(
              MIN_REFRESH_INTERVAL_MS,
              Math.floor(this.lockTimeoutMs / 3),
            )
            const newHandle = this.setIntervalFn(() => {
              try { lockMgr.refreshLock(newName) } catch { /* best-effort */ }
            }, intervalMs)
            lockCoord.releaseLock = () => {
              try { this.clearIntervalFn(newHandle) } catch { /* best-effort */ }
              try { lockMgr.releaseLock(newName) } catch { /* best-effort */ }
              // Fix 3: emit live lock status when the reconnect key's lock is
              // released on stream terminal. No-op without callback.
              km?.notifyStateChange()
            }
          }
        }
        const r = await this.fetchOnce(url, fetchOpts(newKey))
        if (!r.body) throw new Error("server_error: reconnect returned no body")
        return parseStreamEvents(r.body as ReadableStream<Uint8Array>)
      }

      // streamWithReconnect owns the lock lifecycle (releaseOnce on
      // close/error/cancel reads the CURRENT lockCoord.releaseLock, which the
      // reconnect closure may have swapped to the new key). The usage wrapper
      // (applied only when a KeyManager is present) transparently attributes
      // the finish event's usage to lockCoord.keyUsed; it is the outermost
      // stream the consumer reads.
      const innerStream = this.streamWithReconnect(makeStream, reconnect, isAborted, lockCoord)
      const stream =
        km && keyUsed
          ? this.wrapStreamForUsage(innerStream, km, lockCoord, this.modelId)
          : innerStream

      return {
        stream,
        request: { body: requestBody },
        response: { headers: responseHeaders },
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options)

    const textParts: string[] = []
    const reasoningParts: string[] = []
    const content: LanguageModelV3Content[] = []
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" }
    let usage: LanguageModelV3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    }

    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        switch (value.type) {
          case "text-delta":
            textParts.push(value.delta)
            break
          case "reasoning-delta":
            reasoningParts.push(value.delta)
            break
          case "tool-call":
            content.push({
              type: "tool-call",
              toolCallId: value.toolCallId,
              toolName: value.toolName,
              input: value.input,
            })
            break
          case "finish":
            finishReason = value.finishReason
            usage = value.usage
            break
        }
      }
    } finally {
      reader.releaseLock()
      stream.cancel()
    }

    const text = textParts.join("")
    if (text) content.unshift({ type: "text", text })

    const reasoning = reasoningParts.join("")
    if (reasoning) content.unshift({ type: "reasoning", text: reasoning })

    return {
      content,
      finishReason,
      usage,
      warnings: [],
    }
  }
}
