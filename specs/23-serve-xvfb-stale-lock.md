# SSSF Spec: Xvfb Stale Lock Self-Healing on Headless Linux Serve

## Current State

In headless `orca serve` mode on Linux, Electron requires an X server display platform to avoid segmentation faults when offscreen `BrowserWindow` instances load web content (verified: `--headless` and `--ozone-platform=headless` still crash without an X server). Startup guarantees a virtual display via `ensureVirtualDisplayForHeadlessServe` in `src/main/startup/ensure-virtual-display.ts`.

When no external `DISPLAY` is provided, Orca attempts to reuse or initialize virtual display `:99` (`VIRTUAL_DISPLAY_NUMBER = 99`).
Currently, lines 250–258 check for an existing display:
```typescript
if (isUnixSocket(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER))) {
  if (isManagedDisplayServerAlive(VIRTUAL_DISPLAY_NUMBER)) {
    process.env.DISPLAY = VIRTUAL_DISPLAY
    return true
  }
  // Why: stale socket/lock — clean them up so Xvfb can rebind the display
  // below instead of refusing to start on an "in use" number.
  removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
}
```

### The Bug (Fork Issue #23 / PRB-0015)
The existing cleanup routine is strictly coupled to the existence of the UNIX domain socket `/tmp/.X11-unix/X99` (`if (isUnixSocket(...))`).
However, during ungraceful process terminations, system reboots with tmpfs preservation, OOM killer invocations (`SIGKILL`), or unhandled container exits:
1. The socket `/tmp/.X11-unix/X99` can be deleted or never created.
2. The lock file `/tmp/.X99-lock` remains on disk containing the PID of the dead server process.
3. When `isUnixSocket(xvfbSocketPath(99))` evaluates to `false`, Orca bypasses cleanup and directly executes `spawn('Xvfb', [':99', ...])`.
4. `Xvfb` checks `/tmp/.X99-lock`, detects an existing lock file, logs `Fatal server error: Server is already active for display 99`, and exits immediately with a non-zero exit code.
5. `waitForDisplayReady` times out after 5,000ms (`XVFB_STARTUP_TIMEOUT_MS`), `ensureVirtualDisplayForHeadlessServe` fails, and systemd enters a rapid restart/crash loop (`exit 133` / failure).

---

## Summary

### ELI5
When headless `orca serve` crashes on Linux, it can leave behind an abandoned lock file (`/tmp/.X99-lock`) without its socket. The next time Orca starts, Xvfb refuses to start because it thinks another server is already running, breaking browser panes and causing crash loops. We teach Orca to check if the process holding that lock is actually dead, reap the stale lock, and start fresh cleanly.

### What Changed
1. Decoupled stale lock detection from socket presence in `src/main/startup/ensure-virtual-display.ts`.
2. Added an explicit probe helper `isStaleDisplayLock(display: number): boolean` that inspects `/tmp/.X${display}-lock`, parses the recorded integer PID, and probes process liveness via `process.kill(pid, 0)`.
   - `ESRCH`: The process is dead -> lock is stale (`true`).
   - `EPERM`: Process exists under another user/namespace -> lock is active (`false`).
   - Invalid / corrupt / empty / negative PID -> lock is corrupt/unowned -> stale (`true`).
   - `ENOENT`: Lock does not exist -> not stale (`false`).
3. Added unconditional pre-spawn cleanup: prior to launching `Xvfb`, if `isStaleDisplayLock(VIRTUAL_DISPLAY_NUMBER)` is true, reap both `/tmp/.X99-lock` and any residual `/tmp/.X11-unix/X99` socket via `removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)`.
4. Added comprehensive unit tests in `src/main/startup/ensure-virtual-display.test.ts` covering live locks, dead process locks, corrupt/empty lock files, and socket-absent orphan lock recovery.

### Why
Xvfb lock management must be self-healing against hard crashes (`SIGKILL`, OOM) and container restarts. Coupling lock file deletion to socket existence leaves a critical blind spot where socket-less lock orphans cause permanent denial of service for headless serve on Linux until manual administrator intervention.

### Linked Issue
Fixes Fork Issue #23 (PRB-0015: "Headless serve fails to start Xvfb when stale /tmp/.X99-lock exists without socket").

### Visual Proof
`N/A`: Headless backend startup diagnostic and process lifecycle change. No UI or visual surface is modified.

### Cross-Platform & Environment Guarantees
- **Linux:** Active display guard. Xvfb lock probing is only executed on Linux in headless serve mode (`process.platform === 'linux' && options.isServeMode`).
- **macOS / Darwin:** No-op. Always returns `true` immediately; virtual displays are not needed.
- **Windows / WSL2:** No-op on native Windows. In WSL2/Linux environments, adheres to Linux rules while respecting WSLg external sockets without lock files.
- **Remote / SSH:** Headless serve runs over SSH / systemd services; prevents service crash-loops on unattended remote hosts.

---

## Files to Touch

1. `src/main/startup/ensure-virtual-display.ts`
   - Implement `isStaleDisplayLock(displayNumber: number): boolean`.
   - Update `ensureVirtualDisplayForHeadlessServe` to check and reap stale display locks independently of `isUnixSocket`.
2. `src/main/startup/ensure-virtual-display.test.ts`
   - Add unit test: reap stale lock file when socket is missing and PID is dead (`ESRCH`).
   - Add unit test: preserve lock file and do not spawn when PID is alive (`kill(pid, 0)` succeeds).
   - Add unit test: preserve lock file when PID belongs to another user (`EPERM`).
   - Add unit test: reap corrupt / non-integer / empty lock files.
   - Add unit test: clean boot when lock does not exist (`ENOENT`).

---

## Step-by-Step

### Step 1: Add `isStaleDisplayLock` Helper in `src/main/startup/ensure-virtual-display.ts`

Inspect lines 44–65 (`probeDisplayLock`) and add or adapt `isStaleDisplayLock(displayNumber: number): boolean`:
```typescript
/**
 * Checks whether an X display lock file exists for a dead or corrupt process.
 * If the process holding the lock is dead (ESRCH) or the lock file is malformed,
 * the lock is stale and should be cleared before Xvfb spawn.
 */
export function isStaleDisplayLock(displayNumber: number): boolean {
  let pid: number
  try {
    const content = readFileSync(xDisplayLockPath(displayNumber), 'utf8').trim()
    pid = Number.parseInt(content, 10)
  } catch (error) {
    // If the lock file does not exist, it is not a stale lock.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false
    }
    // Any other read error (EACCES/corrupt inode) indicates an invalid lock state.
    return true
  }

  // Corrupt or non-positive PID in lock file
  if (!Number.isInteger(pid) || pid <= 0) {
    return true
  }

  try {
    // Signal 0 checks process existence without killing it
    process.kill(pid, 0)
    // Process is alive
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    // ESRCH: No such process -> stale
    if (code === 'ESRCH') {
      return true
    }
    // EPERM: Process exists but owned by another user -> alive
    if (code === 'EPERM') {
      return false
    }
    // Fallback: any other kill error treated as stale
    return true
  }
}
```

### Step 2: Update `ensureVirtualDisplayForHeadlessServe` Pre-Spawn Logic

In `src/main/startup/ensure-virtual-display.ts`, revise the existing socket check (around line 250):
```typescript
  // 1. If a socket exists, check if it is backed by an active server.
  if (isUnixSocket(xvfbSocketPath(VIRTUAL_DISPLAY_NUMBER))) {
    if (isManagedDisplayServerAlive(VIRTUAL_DISPLAY_NUMBER)) {
      process.env.DISPLAY = VIRTUAL_DISPLAY
      return true
    }
    // Stale socket/lock combination
    removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
  } else if (isStaleDisplayLock(VIRTUAL_DISPLAY_NUMBER)) {
    // 2. Fork Issue #23: Orphan lock file with NO socket, left by hard exit or dead PID.
    // Unconditionally remove stale lock artifacts before Xvfb attempts to bind :99.
    console.warn(
      `[serve] Detected stale display lock at ${xDisplayLockPath(VIRTUAL_DISPLAY_NUMBER)} ` +
        'without an active server. Cleaning up prior to starting Xvfb.'
    )
    removeStaleDisplayArtifacts(VIRTUAL_DISPLAY_NUMBER)
  }
```

### Step 3: Extend Unit Tests in `src/main/startup/ensure-virtual-display.test.ts`

Add test cases in `ensureVirtualDisplayForHeadlessServe` test suite:
1. **Orphan lock with dead PID (socket missing):**
   - Setup: `statSyncMock` throws `ENOENT` (no socket). `readFileSyncMock` returns `'9999\n'`.
   - Setup: `process.kill(9999, 0)` throws `ESRCH`.
   - Expected: `rmSyncMock` called on `/tmp/.X99-lock` and `/tmp/.X11-unix/X99`. `spawnMock` successfully invoked for `Xvfb`.
2. **Lock with active PID (socket missing or socket dead):**
   - Setup: `readFileSyncMock` returns `'4321\n'`. `process.kill(4321, 0)` returns `true`.
   - Expected: `rmSyncMock` is NOT called; lock is not reaped.
3. **Corrupt / empty lock file (socket missing):**
   - Setup: `statSyncMock` throws `ENOENT`. `readFileSyncMock` returns `''` or `'not-a-pid'`.
   - Expected: `isStaleDisplayLock` returns `true`, `rmSyncMock` called, `Xvfb` spawned.
4. **Lock owned by another user (`EPERM`):**
   - Setup: `process.kill` throws error with `code: 'EPERM'`.
   - Expected: Treated as alive, not reaped.

---

## Verification

Run target test commands in repository worktree:

```bash
# 1. Run virtual display startup test suite
pnpm test src/main/startup/ensure-virtual-display.test.ts

# 2. Typecheck main startup files
pnpm --filter @orca/main exec tsc --noEmit

# 3. Verify lint / oxlint
pnpm lint
```

### Reproducible Manual Test Scenario
On a Linux host:
```bash
# Create an orphan stale lock with a dead PID (e.g. 999999) and ensure no socket exists
echo "999999" > /tmp/.X99-lock
rm -f /tmp/.X11-unix/X99

# Run headless serve (or doctor)
./out/orca serve --headless --verbose

# Expected:
# Log emits: "[serve] Detected stale display lock at /tmp/.X99-lock without an active server. Cleaning up prior to starting Xvfb."
# /tmp/.X99-lock is reaped and Xvfb binds :99 successfully.
```

---

## Notes for Next Agent

- **DO NOT OPEN UPSTREAM PR:** This change is an internal fork resilience fix addressing Fork Issue #23. Keep in fork for local testing until PR #21207 / `RuntimeHostContact` lands upstream.
- **Edge Case - `EPERM`:** If a system Xvfb was started by `root` and Orca runs as user `orca`, `process.kill(pid, 0)` throws `EPERM`. Do NOT treat `EPERM` as dead/stale; attempting `rmSync` on a root-owned lock will fail with `EACCES` and killing or stealing the display of an active root X server will break the host.
- **Edge Case - `/tmp` permissions:** `removeStaleDisplayArtifacts` uses `{ force: true }` and catches exceptions. Ensure warnings are logged but startup does not crash if `/tmp` filesystem permissions prevent file removal.
- **Pure Function Export:** Export `isStaleDisplayLock` so `orca serve doctor` (Layer 1 host diagnostics probe) can directly import and report virtual display lock health without code duplication.
