import { describe, test, expect } from "bun:test"
import { LockManager } from "./lock-manager.js"
import type { LockManagerDeps } from "./lock-manager.js"

/**
 * Helper: create a LockManager with in-memory filesystem (no real disk).
 * All deps are injected — tests are deterministic and fast.
 */
function createTestLockManager(opts?: {
  lockDir?: string
  lockTimeoutMs?: number
  instanceId?: string
  now?: () => number
  files?: Map<string, string> // pre-seed lock files
}) {
  const lockDir = opts?.lockDir ?? "/tmp/test-locks"
  const lockTimeoutMs = opts?.lockTimeoutMs ?? 300_000
  const instanceId = opts?.instanceId ?? "inst-abc123"
  const now = opts?.now ?? (() => 1000)

  // In-memory filesystem for lock files
  const files = opts?.files ?? new Map<string, string>()
  const createdDirs = new Set<string>()
  const fdMap = new Map<number, string>() // fd → path
  let nextFd = 10

  const deps: LockManagerDeps = {
    now,
    mkdirSync: (path: string) => {
      createdDirs.add(path)
    },
    openSync: (path: string, flags: number) => {
      // O_EXCL = 0o200 (128) — only throw EEXIST when O_EXCL is set AND file exists
      const hasExcl = (flags & 0o200) !== 0
      if (hasExcl && files.has(path)) {
        const err = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException
        err.code = "EEXIST"
        throw err
      }
      files.set(path, "") // placeholder — writeSync fills it
      const fd = nextFd++
      fdMap.set(fd, path)
      return fd
    },
    closeSync: (fd: number) => {
      fdMap.delete(fd)
    },
    writeSync: (fd: number, content: string) => {
      const path = fdMap.get(fd)
      if (path === undefined) {
        throw new Error(`EBADF: bad file descriptor, write fd=${fd}`)
      }
      files.set(path, content)
    },
    writeFileSync: (path: string, content: string) => {
      files.set(path, content)
    },
    readFileSync: (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      }
      return content
    },
    unlinkSync: (path: string) => {
      files.delete(path)
    },
    renameSync: (oldPath: string, newPath: string) => {
      const content = files.get(oldPath)
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, rename '${oldPath}'`) as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      }
      // Real rename(2) overwrites target silently — atomicity is about
      // the rename being a single operation, not about EEXIST.
      // Protection against double-acquire comes from readLockEntry check.
      files.delete(oldPath)
      files.set(newPath, content)
    },
    statSync: (path: string) => {
      if (!files.has(path)) {
        // Also check if it's the lockDir (always exists after mkdirSync)
        if (createdDirs.has(path)) {
          return { isDirectory: () => true } as import("fs").Stats
        }
        const err = new Error(`ENOENT: no such file or directory, stat '${path}'`) as NodeJS.ErrnoException
        err.code = "ENOENT"
        throw err
      }
      return { isDirectory: () => false } as import("fs").Stats
    },
    readdirSync: (path: string) => {
      // Return filenames of all files that start with this directory path
      const prefix = path.endsWith("/") ? path : `${path}/`
      const entries: string[] = []
      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const name = filePath.slice(prefix.length)
          // Only direct children (no subdirs)
          if (!name.includes("/")) {
            entries.push(name)
          }
        }
      }
      return entries
    },
  }

  const lm = new LockManager(lockDir, lockTimeoutMs, instanceId, deps)
  return { lm, files, createdDirs }
}

// ────────────────────────────────────────────────────────────────
// L0-T1: acquire success (O_EXCL), acquire EEXIST fail, release,
//        expired lock auto-cleanup, tolerant read, getLockOwner,
//        getActiveLocks
// ────────────────────────────────────────────────────────────────

describe("LockManager", () => {
  describe("acquireLock", () => {
    test("acquire succeeds on fresh key (no existing lock)", () => {
      const { lm } = createTestLockManager()

      const result = lm.acquireLock("personal")

      expect(result).toBe(true)
    })

    test("acquire fails when key already locked by this instance (EEXIST)", () => {
      const { lm } = createTestLockManager()

      const first = lm.acquireLock("personal")
      expect(first).toBe(true)

      // Same instance tries again — still EEXIST on file
      const second = lm.acquireLock("personal")
      expect(second).toBe(false)
    })

    test("acquire writes lock file with instanceId, acquiredAt, expiresAt", () => {
      const { lm, files } = createTestLockManager({ now: () => 5000 })

      lm.acquireLock("personal")

      // Find the lock file
      const lockPath = [...files.keys()].find((p) => p.includes("personal"))
      expect(lockPath).toBeDefined()

      const entry = JSON.parse(files.get(lockPath!)!)
      expect(entry.instanceId).toBe("inst-abc123")
      expect(entry.acquiredAt).toBe(5000)
      expect(entry.expiresAt).toBe(5000 + 300_000) // default 5min timeout
    })
  })

  describe("releaseLock", () => {
    test("release removes the lock file", () => {
      const { lm, files } = createTestLockManager()

      lm.acquireLock("personal")
      expect(files.size).toBe(1)

      lm.releaseLock("personal")
      expect(files.size).toBe(0)
    })

    test("release on non-existent key is a no-op (no error)", () => {
      const { lm } = createTestLockManager()

      // Should not throw
      expect(() => lm.releaseLock("nonexistent")).not.toThrow()
    })
  })

  describe("expired lock auto-cleanup", () => {
    test("acquire succeeds on expired lock (auto-reclaim)", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({
        now: () => currentTime,
      })

      // Instance "other" acquires lock
      lm.acquireLock("personal")

      // Time passes — lock expires
      currentTime = 1000 + 300_000 + 1

      // New acquire should succeed (expired lock auto-cleaned)
      const result = lm.acquireLock("personal")
      expect(result).toBe(true)
    })

    test("acquire fails on active (non-expired) lock", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({
        now: () => currentTime,
      })

      lm.acquireLock("personal")

      // Time passes but lock NOT expired yet
      currentTime = 1000 + 60_000 // 1 min, lock is 5 min

      // Create new instance to simulate "other instance"
      const { lm: lm2 } = createTestLockManager({
        now: () => currentTime,
        // Share the same files map would be more realistic,
        // but O_EXCL is file-level so this still tests the pattern
      })

      // This instance's acquire should fail (lock still active)
      const result = lm.acquireLock("personal")
      expect(result).toBe(false)
    })
  })

  describe("isLocked", () => {
    test("returns false for unlocked key", () => {
      const { lm } = createTestLockManager()

      expect(lm.isLocked("personal")).toBe(false)
    })

    test("returns true for actively locked key", () => {
      const { lm } = createTestLockManager()

      lm.acquireLock("personal")
      expect(lm.isLocked("personal")).toBe(true)
    })

    test("returns false for expired lock", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({ now: () => currentTime })

      lm.acquireLock("personal")

      currentTime = 1000 + 300_000 + 1
      expect(lm.isLocked("personal")).toBe(false)
    })
  })

  describe("getLockOwner", () => {
    test("returns null for unlocked key", () => {
      const { lm } = createTestLockManager()

      expect(lm.getLockOwner("personal")).toBeNull()
    })

    test("returns instanceId for locked key", () => {
      const { lm } = createTestLockManager({ instanceId: "inst-uuid-42" })

      lm.acquireLock("personal")
      expect(lm.getLockOwner("personal")).toBe("inst-uuid-42")
    })

    test("returns null for expired lock", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({
        instanceId: "inst-uuid-42",
        now: () => currentTime,
      })

      lm.acquireLock("personal")

      currentTime = 1000 + 300_000 + 1
      expect(lm.getLockOwner("personal")).toBeNull()
    })
  })

  describe("getActiveLocks", () => {
    test("returns empty array when no locks exist", () => {
      const { lm } = createTestLockManager()

      expect(lm.getActiveLocks()).toEqual([])
    })

    test("returns all active locks with metadata", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({ now: () => currentTime })

      lm.acquireLock("personal")
      lm.acquireLock("work")

      const locks = lm.getActiveLocks()
      expect(locks).toHaveLength(2)
      expect(locks.every((l) => l.instanceId === "inst-abc123")).toBe(true)
      expect(locks.every((l) => l.acquiredAt === 1000)).toBe(true)
      expect(locks.every((l) => l.expiresAt === 1000 + 300_000)).toBe(true)
    })

    test("excludes expired locks", () => {
      let currentTime = 1000
      const { lm } = createTestLockManager({ now: () => currentTime })

      lm.acquireLock("personal")

      currentTime = 1000 + 300_001
      lm.acquireLock("work")

      const locks = lm.getActiveLocks()
      expect(locks).toHaveLength(1)
      expect(locks[0]!.keyName).toBe("work")
    })
  })

  describe("tolerant read (missing/malformed file)", () => {
    test("isLocked returns false when lock file is missing", () => {
      const { lm } = createTestLockManager()

      // No file exists — should be tolerant
      expect(lm.isLocked("nonexistent")).toBe(false)
    })

    test("getLockOwner returns null when lock file is missing", () => {
      const { lm } = createTestLockManager()

      expect(lm.getLockOwner("nonexistent")).toBeNull()
    })

    test("malformed lock file → key unlocked + warning logged", () => {
      const files = new Map<string, string>()
      const lockDir = "/tmp/test-locks"
      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = (msg: string) => { warnings.push(msg) }

      try {
        // Seed a malformed lock file
        files.set(`${lockDir}/personal`, "not valid json{{{")

        const lm = new LockManager(lockDir, 300_000, "inst-test", {
          now: () => 5000,
          mkdirSync: () => {},
          openSync: (path: string, flags: number) => {
            if ((flags & 0o200) !== 0 && files.has(path)) {
              const e = new Error("EEXIST") as NodeJS.ErrnoException; e.code = "EEXIST"; throw e
            }
            files.set(path, "")
            return 1
          },
          closeSync: () => {},
          writeSync: () => {},
          writeFileSync: (path: string, content: string) => { files.set(path, content) },
          readFileSync: (path: string) => {
            const c = files.get(path)
            if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
            return c
          },
          unlinkSync: (path: string) => { files.delete(path) },
          statSync: (path: string) => {
            if (files.has(path) || path === lockDir) return { isDirectory: () => path === lockDir } as import("fs").Stats
            const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
          },
          readdirSync: () => [],
        })

        // Malformed lock → key is unlocked
        expect(lm.isLocked("personal")).toBe(false)

        // Warning was logged
        expect(warnings.length).toBeGreaterThan(0)
        expect(warnings[0]!).toContain("Malformed")
        expect(warnings[0]!).toContain("personal")
      } finally {
        console.warn = originalWarn
      }
    })
  })

  // ──────────────────────────────────────────────────────────────
  // L0-T2: refresh extends expiry, concurrent acquire race,
  //        lock timeout configurable
  // ──────────────────────────────────────────────────────────────

  describe("refreshLock", () => {
    test("refresh extends expiresAt on existing lock", () => {
      let currentTime = 1000
      const { lm, files } = createTestLockManager({ now: () => currentTime })

      lm.acquireLock("personal")

      // Advance time partially through lock window
      currentTime = 1000 + 120_000 // 2 min in

      const refreshed = lm.refreshLock("personal")
      expect(refreshed).toBe(true)

      // Verify new expiresAt
      const lockPath = [...files.keys()].find((p) => p.includes("personal"))
      const entry = JSON.parse(files.get(lockPath!)!)
      expect(entry.expiresAt).toBe(currentTime + 300_000) // reset from current time
    })

    test("refresh returns false for non-existent lock", () => {
      const { lm } = createTestLockManager()

      expect(lm.refreshLock("nonexistent")).toBe(false)
    })
  })

  describe("concurrent acquire race (O_EXCL prevents double-acquire)", () => {
    test("second acquire on same key returns false (EEXIST)", () => {
      const { lm } = createTestLockManager()

      expect(lm.acquireLock("personal")).toBe(true)
      expect(lm.acquireLock("personal")).toBe(false)
    })

    test("acquire after release succeeds", () => {
      const { lm } = createTestLockManager()

      lm.acquireLock("personal")
      lm.releaseLock("personal")

      expect(lm.acquireLock("personal")).toBe(true)
    })
  })

  describe("lock timeout configurable", () => {
    test("default timeout is 5 minutes (300000ms)", () => {
      const { lm, files } = createTestLockManager({ now: () => 2000 })

      lm.acquireLock("personal")

      const lockPath = [...files.keys()].find((p) => p.includes("personal"))
      const entry = JSON.parse(files.get(lockPath!)!)
      expect(entry.expiresAt).toBe(2000 + 300_000)
    })

    test("custom timeout applied", () => {
      const { lm, files } = createTestLockManager({
        now: () => 2000,
        lockTimeoutMs: 120_000,
      })

      lm.acquireLock("personal")

      const lockPath = [...files.keys()].find((p) => p.includes("personal"))
      const entry = JSON.parse(files.get(lockPath!)!)
      expect(entry.expiresAt).toBe(2000 + 120_000)
    })
  })

  describe("lockDir auto-creation", () => {
    test("lockDir is created on first acquire", () => {
      let mkdirCalled = false
      const lockDir = "/tmp/my-locks"
      const files = new Map<string, string>()
      const fdMap = new Map<number, string>()
      let nextFd = 10

      const lm = new LockManager(lockDir, 300_000, "inst-test", {
        now: () => 1000,
        mkdirSync: (path: string) => { if (path === lockDir) mkdirCalled = true },
        openSync: (path: string, flags: number) => {
          if ((flags & 0o200) !== 0 && files.has(path)) {
            const e = new Error("EEXIST") as NodeJS.ErrnoException; e.code = "EEXIST"; throw e
          }
          files.set(path, "")
          const fd = nextFd++; fdMap.set(fd, path); return fd
        },
        closeSync: (fd: number) => { fdMap.delete(fd) },
        writeSync: (fd: number, content: string) => {
          const p = fdMap.get(fd); if (p) files.set(p, content)
        },
        readFileSync: (path: string) => {
          const c = files.get(path)
          if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
          return c
        },
        unlinkSync: (path: string) => { files.delete(path) },
        writeFileSync: (path: string, content: string) => { files.set(path, content) },
        statSync: (path: string) => {
          if (files.has(path)) return { isDirectory: () => false } as import("fs").Stats
          if (mkdirCalled && path === lockDir) return { isDirectory: () => true } as import("fs").Stats
          const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
        },
        readdirSync: () => [],
      })

      lm.acquireLock("personal")

      // mkdirSync MUST have been called for the lockDir on first acquire
      expect(mkdirCalled).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // L0-T3: Additional edge cases
  // ──────────────────────────────────────────────────────────────

  describe("key name sanitization", () => {
    test("key names with special chars are sanitized in file path", () => {
      const { lm, files } = createTestLockManager()

      lm.acquireLock("user/test@example")

      // Should have created a file (sanitized name)
      expect(files.size).toBe(1)
      const lockPath = [...files.keys()][0]!
      // Extract filename (after last /) — should not contain / or @ in filename
      const filename = lockPath.split("/").pop()!
      expect(filename).not.toContain("/")
      expect(filename).not.toContain("@")
      expect(filename).toBe("user_test_example")
    })
  })

  describe("multiple keys independent", () => {
    test("releasing one key does not affect another", () => {
      const { lm } = createTestLockManager()

      lm.acquireLock("personal")
      lm.acquireLock("work")

      lm.releaseLock("personal")

      expect(lm.isLocked("personal")).toBe(false)
      expect(lm.isLocked("work")).toBe(true)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Fix 1: acquireLock uses O_EXCL — atomic exclusive creation
  // ──────────────────────────────────────────────────────────────

  describe("Fix 1: acquireLock uses O_EXCL for atomic exclusive creation", () => {
    test("lock file contains valid JSON with instanceId, acquiredAt, expiresAt", () => {
      const { lm, files } = createTestLockManager({ now: () => 5000 })

      lm.acquireLock("personal")

      const lockPath = [...files.keys()].find((p) => p.includes("personal"))
      expect(lockPath).toBeDefined()
      const entry = JSON.parse(files.get(lockPath!)!)
      expect(entry.instanceId).toBe("inst-abc123")
      expect(entry.acquiredAt).toBe(5000)
      expect(entry.expiresAt).toBe(5000 + 300_000)
    })

    test("acquireLock uses O_EXCL flag (break-test: removing O_EXCL allows double-acquire)", () => {
      const lockDir = "/tmp/test-locks"
      const files = new Map<string, string>()
      const fdMap = new Map<number, string>()
      let nextFd = 10
      const openFlags: number[] = [] // track all flags passed to openSync

      const lm = new LockManager(lockDir, 300_000, "inst-abc", {
        now: () => 5000,
        mkdirSync: () => {},
        openSync: (path: string, flags: number) => {
          openFlags.push(flags)
          const hasExcl = (flags & 0o200) !== 0
          if (hasExcl && files.has(path)) {
            const err = new Error("EEXIST") as NodeJS.ErrnoException
            err.code = "EEXIST"
            throw err
          }
          files.set(path, "")
          const fd = nextFd++
          fdMap.set(fd, path)
          return fd
        },
        closeSync: (fd: number) => { fdMap.delete(fd) },
        writeSync: (fd: number, content: string) => {
          const path = fdMap.get(fd)
          if (path) files.set(path, content)
        },
        readFileSync: (path: string) => {
          const c = files.get(path)
          if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
          return c
        },
        unlinkSync: (path: string) => { files.delete(path) },
        writeFileSync: (path: string, content: string) => { files.set(path, content) },
        statSync: (path: string) => {
          if (files.has(path)) return { isDirectory: () => false } as import("fs").Stats
          if (path === lockDir) return { isDirectory: () => true } as import("fs").Stats
          const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
        },
        readdirSync: () => [],
      })

      lm.acquireLock("personal")

      // Verify O_EXCL (0o200) was passed — this is the atomicity mechanism
      expect(openFlags.length).toBeGreaterThan(0)
      expect((openFlags[0]! & 0o200) !== 0).toBe(true) // O_EXCL flag was set
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Fix 2: releaseLock verifies ownership before unlinking
  // ──────────────────────────────────────────────────────────────

  describe("Fix 2: releaseLock checks ownership before unlinking", () => {
    test("instance B cannot release a lock owned by instance A", () => {
      const files = new Map<string, string>()
      const lockDir = "/tmp/test-locks"
      const fdMap = new Map<number, string>()
      let nextFd = 10

      const makeDeps = (): LockManagerDeps => ({
        now: () => 1000,
        mkdirSync: () => {},
        openSync: (path: string, flags: number) => {
          if ((flags & 0o200) !== 0 && files.has(path)) {
            const e = new Error("EEXIST") as NodeJS.ErrnoException; e.code = "EEXIST"; throw e
          }
          files.set(path, "")
          const fd = nextFd++; fdMap.set(fd, path); return fd
        },
        closeSync: (fd: number) => { fdMap.delete(fd) },
        writeSync: (fd: number, content: string) => {
          const p = fdMap.get(fd); if (p) files.set(p, content)
        },
        writeFileSync: (path: string, content: string) => { files.set(path, content) },
        readFileSync: (path: string) => {
          const c = files.get(path)
          if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
          return c
        },
        unlinkSync: (path: string) => { files.delete(path) },
        statSync: (path: string) => {
          if (files.has(path)) return { isDirectory: () => false } as import("fs").Stats
          if (path === lockDir) return { isDirectory: () => true } as import("fs").Stats
          const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
        },
        readdirSync: () => [],
      })

      const lmA = new LockManager(lockDir, 300_000, "inst-A", makeDeps())
      const lmB = new LockManager(lockDir, 300_000, "inst-B", makeDeps())

      lmA.acquireLock("personal")
      expect(files.size).toBe(1)

      // Instance B tries to release A's lock — should be no-op
      lmB.releaseLock("personal")
      expect(files.size).toBe(1) // file still exists

      // Instance A releases its own lock — should succeed
      lmA.releaseLock("personal")
      expect(files.size).toBe(0)
    })
  })

  // ──────────────────────────────────────────────────────────────
  // Fix 3: adversarial race test — concurrent cross-instance
  //        O_EXCL prevents double-acquire at the OS level
  // ──────────────────────────────────────────────────────────────

  describe("Fix 3: adversarial concurrent cross-instance acquisition (O_EXCL)", () => {
    test("two instances with shared FS — exactly one acquires, other gets EEXIST", () => {
      const files = new Map<string, string>()
      const lockDir = "/tmp/test-locks"
      const fdMap = new Map<number, string>()
      let nextFd = 10

      // Shared mock FS — models real O_EXCL semantics
      const sharedDeps = (): LockManagerDeps => ({
        now: () => 1000,
        mkdirSync: () => {},
        openSync: (path: string, flags: number) => {
          // O_EXCL = 0o200 — only reject if O_EXCL flag set AND file exists
          if ((flags & 0o200) !== 0 && files.has(path)) {
            const e = new Error(`EEXIST: file already exists, open '${path}'`) as NodeJS.ErrnoException
            e.code = "EEXIST"
            throw e
          }
          files.set(path, "")
          const fd = nextFd++; fdMap.set(fd, path); return fd
        },
        closeSync: (fd: number) => { fdMap.delete(fd) },
        writeSync: (fd: number, content: string) => {
          const p = fdMap.get(fd); if (p) files.set(p, content)
        },
        writeFileSync: (path: string, content: string) => { files.set(path, content) },
        readFileSync: (path: string) => {
          const c = files.get(path)
          if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
          return c
        },
        unlinkSync: (path: string) => { files.delete(path) },
        statSync: (path: string) => {
          if (files.has(path)) return { isDirectory: () => false } as import("fs").Stats
          if (path === lockDir) return { isDirectory: () => true } as import("fs").Stats
          const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
        },
        readdirSync: () => [],
      })

      const lmA = new LockManager(lockDir, 300_000, "inst-A", sharedDeps())
      const lmB = new LockManager(lockDir, 300_000, "inst-B", sharedDeps())

      // Both try to acquire the same key
      const resultA = lmA.acquireLock("personal")
      const resultB = lmB.acquireLock("personal")

      // Exactly one succeeds
      expect(resultA).toBe(true)
      expect(resultB).toBe(false)

      // Only one lock file exists — owned by A
      expect(files.size).toBe(1)
      const content = [...files.values()][0]!
      const parsed = JSON.parse(content)
      expect(parsed.instanceId).toBe("inst-A")
    })

    test("break-test: if O_EXCL flag removed, both instances acquire (test fails)", () => {
      const files = new Map<string, string>()
      const lockDir = "/tmp/test-locks"
      const fdMap = new Map<number, string>()
      let nextFd = 10
      let exclFlagUsed = false

      const sharedDeps = (): LockManagerDeps => ({
        now: () => 1000,
        mkdirSync: () => {},
        openSync: (path: string, flags: number) => {
          // Track whether O_EXCL was ever used
          if ((flags & 0o200) !== 0) exclFlagUsed = true
          // Only reject if O_EXCL flag set AND file exists
          if ((flags & 0o200) !== 0 && files.has(path)) {
            const e = new Error("EEXIST") as NodeJS.ErrnoException; e.code = "EEXIST"; throw e
          }
          files.set(path, "")
          const fd = nextFd++; fdMap.set(fd, path); return fd
        },
        closeSync: (fd: number) => { fdMap.delete(fd) },
        writeSync: (fd: number, content: string) => {
          const p = fdMap.get(fd); if (p) files.set(p, content)
        },
        writeFileSync: (path: string, content: string) => { files.set(path, content) },
        readFileSync: (path: string) => {
          const c = files.get(path)
          if (c === undefined) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e }
          return c
        },
        unlinkSync: (path: string) => { files.delete(path) },
        statSync: (path: string) => {
          if (files.has(path)) return { isDirectory: () => false } as import("fs").Stats
          if (path === lockDir) return { isDirectory: () => true } as import("fs").Stats
          const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e
        },
        readdirSync: () => [],
      })

      const lmA = new LockManager(lockDir, 300_000, "inst-A", sharedDeps())
      const lmB = new LockManager(lockDir, 300_000, "inst-B", sharedDeps())

      lmA.acquireLock("personal")
      lmB.acquireLock("personal")

      // O_EXCL must have been used — if it wasn't, the mock wouldn't reject B
      // and both would "acquire" (which is the bug we're testing against)
      expect(exclFlagUsed).toBe(true)
    })

    test("EEXIST on acquire returns false (not throw)", () => {
      const { lm } = createTestLockManager()

      lm.acquireLock("personal")

      // Second acquire must not throw — must return false
      expect(() => lm.acquireLock("personal")).not.toThrow()
      expect(lm.acquireLock("personal")).toBe(false)
    })

    test("acquire after release succeeds (lock file removed)", () => {
      const { lm } = createTestLockManager()

      lm.acquireLock("personal")
      lm.releaseLock("personal")

      expect(lm.acquireLock("personal")).toBe(true)
    })
  })
})
