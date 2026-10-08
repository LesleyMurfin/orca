---
name: orca-diagnostics
description: >-
  Diagnose a misbehaving Orca install from its own on-disk evidence: the NDJSON trace
  files under the logs directory, the detached terminal daemon's lifecycle log and
  runtime files, leftover PTY endpoint sockets, and stale SSH multiplex sockets. Use
  when the user says "$orca-diagnostics", "Orca is hung", "terminals won't spawn",
  "daemon won't start", "read the Orca logs", "collect a diagnostic bundle", or when
  SSH worktrees fail with mux errors. Prefer it over guessing at log paths or deleting
  runtime files by hand. Use the Orca CLI skill for normal worktree and terminal work.
---

# Orca Diagnostics

Use this guide when Orca itself is the suspect: the app is wedged, terminals will not spawn,
an SSH worktree will not connect, or a bug report needs evidence. Normal worktree, terminal,
and browser work belongs to the `orca-cli` skill.

## Start Here

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.

Work outside-in and stop at the first layer that explains the symptom:

1. `ORCA status --json` — is the app running and is the runtime reachable at all?
2. The trace file — what did the main process record before it went wrong?
3. `daemon.log` and the daemon runtime directory — did the terminal host start, survive, and keep its endpoint?
4. The SSH multiplex socket directory — is a dead OpenSSH master poisoning every new connection?

Prefer `--json` for agent-driven calls. Read evidence before deleting anything: every file named
below is either a live endpoint or the only record of why something died.

## The Logs Directory

Everything in this guide except SSH mux sockets lives under one directory:

| Platform | Logs directory                                    |
| -------- | ------------------------------------------------- |
| macOS    | `~/Library/Application Support/Orca/logs/`         |
| Linux    | `~/.config/Orca/logs/`                             |
| Windows  | `%APPDATA%\Orca\logs\`                             |

**Help → Open Logs** opens the same directory from the app. A headless `orcad` host writes under
its own data root instead: `<data-root>/logs/`.

Never paste raw log contents into a public issue without reading them first; trace records carry
file paths, repo names, and host identity.

## Internal Trace: `main.trace.ndjson`

`main.trace.ndjson` is the main process's error-tracking sink. One JSON object per line, written
synchronously so the last records survive a crash that kills the process mid-write.

- Rotation is size-based: `main.trace.ndjson` → `main.trace.ndjson.1` → … → `.N`, oldest deleted.
  Defaults are 10 MB per file and 10 files, so the family is bounded near 100 MB.
- Read the rotated files in reverse order (`.N` oldest, no suffix newest) when the window you want
  predates the live file.
- `orcad.trace.ndjson` is the same sink for a headless `orcad` host, named for its own process. A
  desktop install has no `orcad.trace.ndjson`, and an `orcad` host writes no `main.trace.ndjson`.
- A record that exceeded the per-line byte cap is replaced by a marker naming the dropped record,
  so a gap in the trace is explicit rather than silent.

Useful passes over the newest file:

```bash
# Span names in order, newest last.
jq -r '[.name // .type, (.attributes | tostring)] | @tsv' main.trace.ndjson

# Only the failure lane.
jq -c 'select(.status == "error" or .level == "error")' main.trace.ndjson

# Everything the trace recorded in a window, across the rotated family.
cat main.trace.ndjson.3 main.trace.ndjson.2 main.trace.ndjson.1 main.trace.ndjson |
  jq -c 'select(.timestamp >= "<iso-start>" and .timestamp <= "<iso-end>")'
```

A line that fails to parse is a torn final write from a crash, not corruption of the whole file;
drop that one line and keep reading.

### Diagnostic bundles

**Help → Send Feedback** collects a diagnostic bundle from this trace family and shows a preview
before anything is uploaded; the preview is editable and can be discarded. Prefer the bundle over
hand-copied log excerpts when filing a bug — it carries the same records with the collection
window and app identity attached.

Setting `ORCA_DIAGNOSTICS_DISABLED=1` (or `true`) is the privacy switch: Orca then launches the
daemon with no `--log-file` argument, so `daemon.log` stops being written. Expect an empty or
stale `daemon.log` on any host that exports it, and do not read that absence as a daemon failure.

## Detached Daemon Logs and Runtime Files

Orca's terminals are hosted by a detached daemon process that outlives an app restart. It writes
lifecycle events — never terminal input/output and never tokens — to `daemon.log` in the logs
directory, as NDJSON with the same rotation discipline.

Its runtime files live in `<userData>/daemon/`, versioned by wire protocol so an older build's
daemon is never reused after a breaking change:

| File                   | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `daemon-v<N>.sock`     | Unix domain socket the app connects to (the PTY endpoint).           |
| `daemon-v<N>.pid`      | JSON record: `pid`, `startedAtMs`, `appVersion`, and launch details. |
| `daemon-v<N>.token`    | Connection token; mode `0600`. Never quote it in a report.           |

On Windows the endpoint is a named pipe, `\\?\pipe\orca-terminal-host-v<N>-<hash>`, not a file.

What to read, in order:

```bash
tail -n 200 "<logs>/daemon.log" | jq -c .
cat "<userData>/daemon/daemon-v<N>.pid" | jq .
ps -p "$(jq -r .pid "<userData>/daemon/daemon-v<N>.pid")" -o pid,etime,command
```

Interpretations that hold:

- PID file present, process alive, socket accepts a connection → the daemon is healthy; the fault
  is above it, in the app or the agent CLI.
- PID file present, process gone → the daemon died without teardown. Session metadata is left
  unclean on purpose, which is what makes the replacement daemon cold-restore scrollback.
- Repeated start records seconds apart → a crash loop. Orca's respawn throttle gives up after 5
  failed starts inside 60 seconds, and only an explicit restart clears that window. Read the
  records between the starts; a fork that succeeds proves nothing about the daemon that follows it.
- `.swap-<pid>-<uuid>` or `.hold-<pid>-<uuid>` scratch names beside the PID or token file are a
  claim in progress. A live one briefly holds the only copy of a real record — never delete these.

## Zombie PTY Endpoint Sockets

A `daemon-v<N>.sock` left behind by a dead daemon is a *zombie endpoint*: the name is occupied, so
nothing new can publish there, but nothing serves it either. Classify it before acting; connecting
is the only test that distinguishes the four states:

| Probe result                             | State       | Meaning                                       |
| ---------------------------------------- | ----------- | --------------------------------------------- |
| Connect succeeds                          | `connected` | A daemon is live. Leave it alone.             |
| `ECONNREFUSED`, or `ENOTSOCK` on macOS    | `refused`   | Nothing can ever serve it. Safe to replace.   |
| Path does not exist                       | `missing`   | Safe to publish.                              |
| Timeout, `EPERM`, anything else           | `unknown`   | **Leave it alone.** No proof of death.        |

```bash
# A connect probe, not an existence check: `test -S` cannot tell a zombie from a live endpoint.
python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.settimeout(0.5); s.connect(sys.argv[1]); print("connected")' \
  "<userData>/daemon/daemon-v<N>.sock"
```

Rules:

- Only `refused` and `missing` are positive proof the endpoint is dead. A probe that timed out on a
  loaded host proves nothing, and deleting on that basis can unlink a live daemon's endpoint.
- Use `lstat`, not an existence test that follows symlinks: a dangling symlink reads as absent while
  still occupying the name.
- Orca recovers from a proven-dead endpoint on its own at the next launch. Delete the socket by hand
  only when the app cannot be restarted, and only after a `refused`/`missing` probe.
- Never delete the token or PID file to "reset" a daemon you have not proven dead.

## Stale SSH Multiplex Sockets

For SSH worktrees that use system OpenSSH, Orca keeps a private ControlMaster socket directory:

- `$XDG_RUNTIME_DIR/orca-ssh/` when `XDG_RUNTIME_DIR` is an absolute path, else `$TMPDIR/orca-ssh-<uid>/`.
- Created mode `0700` and re-checked on every use: it must be a directory, owned by the current uid,
  with no group or other permissions. A symlink or a loosened directory is refused outright, and
  Orca then runs without multiplexing.
- Each socket is named by a 16-hex digest of the target plus the freshly resolved `ssh -G` config
  plus whether the session is Kerberos-only — so a config change or a GSSAPI-only session never
  reuses a master authenticated some other way.
- A socket path that would exceed the platform's Unix socket limit (104 bytes on macOS, 108 on
  Linux) minus OpenSSH's own 18-byte suffix budget disables multiplexing for that target instead
  of producing a truncated path.

Symptom of a stale master: a system SSH invocation exits `255` with a mux client error while the
host is reachable by plain `ssh`. Orca already handles this — it removes the socket and retries the
same connection with ControlMaster disabled for the rest of the session — so a single occurrence in
the logs is recovery, not a bug. Investigate when it repeats on every connect.

```bash
ls -la "${XDG_RUNTIME_DIR:-/tmp}/orca-ssh"* 2>/dev/null
ssh -O check -S "<socket-path>" <host>     # "Master running" or an error
ssh -O exit  -S "<socket-path>" <host>     # ask the master to exit cleanly
```

Prefer `ssh -O exit` over `rm`: it stops the master process as well as removing the socket. Remove
the file only when `-O check` reports no master. Deleting a live master's socket leaves the process
running with no way to address it, and the next connection silently opens a second master.

Directory-level faults to check when multiplexing never engages: wrong owner after a `sudo` run
created `/tmp/orca-ssh-<uid>`, a group-writable `XDG_RUNTIME_DIR`, or a tmpfs cleaner that removed
the directory mid-session.

## Reporting

When the evidence is collected, prefer in-app reporting so the bundle travels with it:

- **Help → Send Feedback** for a bug with an attached diagnostic bundle.
- **Help → Open Logs** to attach files by hand.
- `ORCA diagnostics memory --json` for a point-in-time memory and CPU sweep across the app, each
  worktree's terminal sessions, and the host — the same sweep behind the Resource Usage popover.

Report what you observed and the exact file and line range it came from. Do not paste tokens, and
do not infer a cause the trace does not record.

## Action gates

| Trigger / Condition | Action / Routing | Reference Document |
| :--- | :--- | :--- |
| Unhandled exceptions or IPC rejections | Extract stack traces with jq | `references/trace-analysis.md` |
| Reconnecting to SSH host hangs | Triage OpenSSH ControlMaster zombie sockets | `references/ssh-multiplex.md` |
| Electron UI wedged or renderer unresponsive | Connect via CDP port 9222 and inspect targets | `references/cdp-troubleshooting.md` |
