# Key Rotation Lock Specification

## Purpose

Multi-instance coordination via per-key lock files. Prevents two instances from using the same API key simultaneously. Lock files at `~/.commandcode/.key-locks/{sanitized-key-name}` using O_EXCL atomic creation, with 5-minute auto-release timeout.

## Requirements

### Requirement: Lock File Format

Each key has its own lock file at `~/.commandcode/.key-locks/{sanitized-key-name}`. The file MUST contain a JSON object with `instanceId` (instance UUID), `acquiredAt` (epoch ms), and `expiresAt` (epoch ms). Creation uses `open(O_EXCL)` — if the file already exists, the create fails with EEXIST (atomic exclusive creation, no overwrite). If a lock file is missing, the system MUST treat that key as unlocked. If a lock file is malformed JSON, the system MUST treat that key as unlocked and log a warning.

#### Scenario: Missing lock file → all keys unlocked

- GIVEN no lock file exists for a key
- WHEN `selectKey()` reads lock state
- THEN that key is treated as unlocked

#### Scenario: Malformed lock file → key unlocked + warning

- GIVEN a key's lock file contains `not valid json`
- WHEN `selectKey()` reads lock state
- THEN that key is treated as unlocked and a warning is logged

### Requirement: Acquire Lock

`acquireLock(keyName, instanceId)` MUST succeed if no active (non-expired) lock exists for that key. On success, it MUST write a lock entry with `expiresAt = now + lockTimeoutMs`. If an active lock exists owned by a different instance, acquire MUST fail. If an expired lock exists, acquire MUST succeed (auto-release).

#### Scenario: No existing lock → acquire succeeds

- GIVEN key "personal" has no lock entry
- WHEN `acquireLock("personal", "uuid-1")` is called
- THEN lock is written with `lockedBy: "uuid-1"` and correct `expiresAt`

#### Scenario: Active lock by other instance → acquire fails

- GIVEN key "personal" is locked by "uuid-2" (not expired)
- WHEN `acquireLock("personal", "uuid-1")` is called
- THEN acquire returns `false`, no lock entry is modified

#### Scenario: Expired lock → acquire succeeds

- GIVEN key "personal" is locked by "uuid-2" with `expiresAt` in the past
- WHEN `acquireLock("personal", "uuid-1")` is called
- THEN lock is overwritten with `lockedBy: "uuid-1"` and new `expiresAt`

### Requirement: Release Lock

`releaseLock(keyName, instanceId)` MUST remove the lock entry only if the lock is owned by `instanceId`. If owned by a different instance, release MUST be a no-op.

#### Scenario: Owned lock → released

- GIVEN key "personal" locked by "uuid-1"
- WHEN `releaseLock("personal", "uuid-1")` is called
- THEN lock entry is removed

#### Scenario: Other instance lock → no-op

- GIVEN key "personal" locked by "uuid-2"
- WHEN `releaseLock("personal", "uuid-1")` is called
- THEN lock entry remains unchanged

### Requirement: Lock Timeout

Lock timeout MUST default to 5 minutes (300000ms). It MUST be configurable via `rotation.lockTimeoutMs` in `keys.json`. Expired locks MUST be treated as absent on read.

#### Scenario: Default timeout is 5 minutes

- GIVEN no `lockTimeoutMs` configured
- WHEN a lock is acquired
- THEN `expiresAt = now + 300000`

#### Scenario: Custom timeout applied

- GIVEN `rotation.lockTimeoutMs = 120000`
- WHEN a lock is acquired
- THEN `expiresAt = now + 120000`

### Requirement: Lock-Aware Key Selection

`selectKey()` MUST prefer unlocked keys over locked ones. If all keys are locked by other instances, `selectKey()` MUST use the key with the earliest lock expiry and log a warning.

#### Scenario: Unlocked key preferred over locked

- GIVEN key A unlocked, key B locked by other instance
- WHEN `selectKey()` is called
- THEN key A is selected

#### Scenario: All keys locked → earliest expiry selected

- GIVEN key A locked until T+300s, key B locked until T+60s
- WHEN `selectKey()` is called
- THEN key B is selected (earliest expiry), warning logged

### Requirement: Atomic Lock File Creation

Lock files MUST be created using `open(O_EXCL | O_WRONLY | O_CREAT)`. This is the POSIX-correct primitive for exclusive file creation — if the file already exists, `open()` fails with `EEXIST` regardless of file content. This prevents two instances from creating the same lock file simultaneously. The content (JSON lock entry) is written to the file descriptor after the atomic create succeeds. The brief window between `open()` and `write()` is safe: another process calling `open(O_EXCL)` on the same path gets `EEXIST` and cannot acquire the lock, regardless of whether the content has been written yet.

Note: `rename()` is NOT used for lock creation because POSIX `rename()` overwrites the target silently (does not fail with EEXIST) — two concurrent renames would result in the last writer winning, which is incorrect for exclusive locks.

#### Scenario: Crash during create → no partial lock

- GIVEN a lock file create is in progress (open succeeded, write pending)
- WHEN the process crashes before write completes
- THEN the lock file may exist but be empty — however, another process calling `open(O_EXCL)` on the same path still gets `EEXIST` and cannot acquire the lock. The empty file is treated as malformed on read (key unlocked + warning). The crashed instance's lock auto-expires after `lockTimeoutMs`.

### Requirement: Instance Identity

Each provider instance MUST generate a unique instance ID via `crypto.randomUUID()` at construction time. This ID is used for all lock operations.

#### Scenario: Instance ID generated on construction

- GIVEN a new provider instance is created
- WHEN the constructor runs
- THEN `instanceId` is a valid UUID string
