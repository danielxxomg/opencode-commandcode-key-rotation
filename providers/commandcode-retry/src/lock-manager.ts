/**
 * LockManager — per-key file locks using O_EXCL atomic creation.
 * Prevents two instances from using the same API key simultaneously.
 *
 * Each key gets a file at `~/.commandcode/.key-locks/{sanitized-name}`
 * containing `{ instanceId, acquiredAt, expiresAt }`.
 *
 * Lock operations:
 * - acquireLock: open(O_EXCL) → write(fd) → close(fd) — atomic create, no overwrite
 * - releaseLock: unlink (only if owned by this instance)
 * - refreshLock: read → update expiresAt → writeFileSync (we own the lock)
 * - isLocked: read file → check expiresAt
 * - getLockOwner: read file → return instanceId (or null)
 * - getActiveLocks: read all files → filter expired
 *
 * O_EXCL guarantees: if the file already exists, open() fails with EEXIST.
 * This is the POSIX-correct mechanism for exclusive file creation — rename()
 * would overwrite the target (not fail), so it's unsuitable for locks.
 * The brief window between open() and write() is safe: another process
 * calling open(O_EXCL) on the same path gets EEXIST regardless of file content.
 */

import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, readFileSync, unlinkSync, renameSync, statSync, readdirSync } from "node:fs"

// POSIX open(2) flags — numeric values per Linux/fs.constants
const O_WRONLY = 0o1
const O_CREAT = 0o100
const O_EXCL = 0o200

export interface LockEntry {
  keyName: string
  instanceId: string
  acquiredAt: number
  expiresAt: number
}

export interface LockManagerDeps {
  now?: () => number
  mkdirSync?: (path: string) => void
  openSync?: (path: string, flags: number) => number
  closeSync?: (fd: number) => void
  writeSync?: (fd: number, content: string) => void
  writeFileSync?: (path: string, content: string) => void
  readFileSync?: (path: string) => string
  unlinkSync?: (path: string) => void
  renameSync?: (oldPath: string, newPath: string) => void
  statSync?: (path: string) => import("fs").Stats
  readdirSync?: (path: string) => string[]
}

/**
 * Sanitize key name for use as filename.
 * Replaces filesystem-unsafe chars with underscores.
 */
function sanitizeKeyName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export class LockManager {
  private lockDir: string
  private lockTimeoutMs: number
  private instanceId: string
  private now: () => number
  private mkdirSync: (path: string) => void
  private openSync: (path: string, flags: number) => number
  private closeSync: (fd: number) => void
  private writeSync: (fd: number, content: string) => void
  private writeFileSync: (path: string, content: string) => void
  private readFileSync: (path: string) => string
  private unlinkSync: (path: string) => void
  private renameSync: (oldPath: string, newPath: string) => void
  private statSync: (path: string) => import("fs").Stats
  private readdirSync: (path: string) => string[]
  private dirCreated = false

  constructor(
    lockDir: string,
    lockTimeoutMs: number,
    instanceId: string,
    deps?: LockManagerDeps,
  ) {
    this.lockDir = lockDir
    this.lockTimeoutMs = lockTimeoutMs
    this.instanceId = instanceId

    // DI with real fs defaults
    this.now = deps?.now ?? Date.now
    this.mkdirSync = deps?.mkdirSync ?? ((path: string) => mkdirSync(path, { recursive: true }))
    this.openSync = deps?.openSync ?? openSync
    this.closeSync = deps?.closeSync ?? closeSync
    this.writeSync = deps?.writeSync ?? writeSync
    this.writeFileSync = deps?.writeFileSync ?? writeFileSync
    this.readFileSync = deps?.readFileSync ?? readFileSync
    this.unlinkSync = deps?.unlinkSync ?? unlinkSync
    this.renameSync = deps?.renameSync ?? renameSync
    this.statSync = deps?.statSync ?? statSync
    this.readdirSync = deps?.readdirSync ?? readdirSync
  }

  private ensureLockDir(): void {
    if (this.dirCreated) return
    try {
      this.statSync(this.lockDir)
      this.dirCreated = true
    } catch {
      this.mkdirSync(this.lockDir)
      this.dirCreated = true
    }
  }

  private lockPath(keyName: string): string {
    return `${this.lockDir}/${sanitizeKeyName(keyName)}`
  }

  private readLockEntry(keyName: string): { instanceId: string; acquiredAt: number; expiresAt: number } | null {
    try {
      const raw = this.readFileSync(this.lockPath(keyName))
      try {
        const entry = JSON.parse(raw) as { instanceId: string; acquiredAt: number; expiresAt: number }
        if (typeof entry.instanceId !== "string" || typeof entry.expiresAt !== "number") {
          console.warn(`[key-rotation] Malformed lock file for key '${keyName}' — treating as unlocked`)
          return null // malformed
        }
        return entry
      } catch {
        console.warn(`[key-rotation] Malformed lock file for key '${keyName}' (invalid JSON) — treating as unlocked`)
        return null // malformed JSON
      }
    } catch {
      return null // file missing or unreadable — not an error, key is simply unlocked
    }
  }

  /**
   * Acquire a lock for the given key using O_EXCL atomic file creation.
   * Returns true if acquired, false if already locked (non-expired).
   * If lock exists but is expired, reclaims it.
   *
   * O_EXCL: open() fails with EEXIST if the file already exists — this is
   * the atomic guarantee. No other process can create the same file
   * simultaneously, even if the content isn't written yet.
   */
  acquireLock(keyName: string): boolean {
    this.ensureLockDir()
    const path = this.lockPath(keyName)
    const now = this.now()

    // Check if lock exists and is still active
    const existing = this.readLockEntry(keyName)
    if (existing) {
      if (existing.expiresAt > now) {
        return false // active lock — cannot acquire
      }
      // Expired — reclaim by unlinking
      try { this.unlinkSync(path) } catch { /* already gone */ }
    }

    const entry = {
      instanceId: this.instanceId,
      acquiredAt: now,
      expiresAt: now + this.lockTimeoutMs,
    }

    // O_EXCL atomic create: fails with EEXIST if another process created it
    let fd: number
    try {
      fd = this.openSync(path, O_WRONLY | O_CREAT | O_EXCL)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false // another instance got there first
      }
      throw err
    }

    // Write content to the fd — the file now exists with our lock entry
    try {
      this.writeSync(fd, JSON.stringify(entry))
    } catch (err) {
      // Write failed — clean up the empty file so it doesn't block future acquires
      try { this.closeSync(fd) } catch { /* best-effort */ }
      try { this.unlinkSync(path) } catch { /* best-effort */ }
      throw err
    }

    try { this.closeSync(fd) } catch { /* best-effort */ }
    return true
  }

  /**
   * Release a lock by deleting the lock file.
   * Only removes locks owned by this instance.
   * No-op if file doesn't exist, is malformed, or owned by another instance.
   */
  releaseLock(keyName: string): void {
    const existing = this.readLockEntry(keyName)
    if (!existing) return // file missing or malformed — no-op
    if (existing.instanceId !== this.instanceId) return // not ours — no-op
    try {
      this.unlinkSync(this.lockPath(keyName))
    } catch {
      // Already gone — no-op
    }
  }

  /**
   * Refresh a lock's expiry time.
   * Reads existing entry, updates expiresAt, overwrites the file.
   * Returns false if no lock exists to refresh.
   * Safe to use writeFileSync (not O_EXCL) because we already own the lock.
   */
  refreshLock(keyName: string): boolean {
    const existing = this.readLockEntry(keyName)
    if (!existing) return false

    const now = this.now()
    const updated = {
      ...existing,
      expiresAt: now + this.lockTimeoutMs,
    }

    // We own the lock — safe to overwrite (not create)
    this.writeFileSync(this.lockPath(keyName), JSON.stringify(updated))
    return true
  }

  /**
   * Check if a key is currently locked (non-expired).
   */
  isLocked(keyName: string): boolean {
    const existing = this.readLockEntry(keyName)
    if (!existing) return false
    return existing.expiresAt > this.now()
  }

  /**
   * Get the instanceId that owns the lock, or null if unlocked.
   */
  getLockOwner(keyName: string): string | null {
    const existing = this.readLockEntry(keyName)
    if (!existing || existing.expiresAt <= this.now()) return null
    return existing.instanceId
  }

  /**
   * Get all currently active (non-expired) locks.
   * Lists lockDir, reads each file, filters by expiresAt > now.
   */
  getActiveLocks(): LockEntry[] {
    this.ensureLockDir()
    const now = this.now()
    const entries: LockEntry[] = []

    try {
      const files = this.readdirSync(this.lockDir)
      for (const file of files) {
        // Skip temp files from refreshLock
        if (file.endsWith(".tmp")) continue

        try {
          const raw = this.readFileSync(`${this.lockDir}/${file}`)
          const entry = JSON.parse(raw) as { instanceId: string; acquiredAt: number; expiresAt: number }
          if (typeof entry.instanceId !== "string" || typeof entry.expiresAt !== "number") continue
          if (entry.expiresAt > now) {
            entries.push({
              keyName: file, // sanitized name — close enough for listing
              instanceId: entry.instanceId,
              acquiredAt: entry.acquiredAt,
              expiresAt: entry.expiresAt,
            })
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // lockDir doesn't exist or can't be read
    }

    return entries
  }
}
