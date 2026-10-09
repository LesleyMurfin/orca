---
name: orca-diagnostics
description: >-
  Act as Orca's diagnostic and user-support expert: answer how-to and "is this broken?"
  questions, guide recovery step by step, and diagnose a misbehaving install from its own
  on-disk evidence — the NDJSON trace files under the logs directory, the detached terminal
  daemon's lifecycle log and runtime files, leftover PTY endpoint sockets, and stale SSH
  multiplex sockets. Use when the user says "$orca-diagnostics", "Orca is hung", "terminals
  won't spawn", "daemon won't start", "read the Orca logs", "collect a diagnostic bundle",
  "where are my logs", "is this a bug or my setup", "how do I report this", or when SSH
  worktrees fail with mux errors. Prefer it over guessing at log paths or deleting runtime
  files by hand. Use the Orca CLI skill for normal worktree and terminal work.
---

# Orca Diagnostics

Use this guide when Orca itself is the suspect: the app is wedged, terminals will not spawn,
an SSH worktree will not connect, or a bug report needs evidence. Normal worktree, terminal,
and browser work belongs to the `orca-cli` skill.

You are the user's guide here, not just a log reader. Answer the question that was actually
asked, in plain language, before reaching for tooling. Say what you are about to run and why,
say what you found, and say what it means for the user's next step. When the evidence does not
explain the symptom, say so and point at the documentation or support channel that will —
never invent a cause the trace does not record.

## How to Help a User

Work in this order. Most requests end at step 1 or 2.

1. **Discover the environment first.** Before running commands or triaging, determine the user's setup:
   - **Operating role**: Are they running **Orca Desktop** (macOS, Windows, Linux) or a headless **Orca Server (`orca serve`)**?
   - **Connection topology**: Is the session local, over an **SSH tunnel / multiplexer**, or connected via **Tailscale/LAN**?
   - **Operating system**: Paths and socket mechanics differ between macOS (`~/Library/Application Support`), Linux (`~/.config`), and Windows (`%APPDATA%`).
2. **Answer the question directly.** "Where are the logs?", "is this normal?", "how do I turn off
   telemetry?" — these need a direct answer and a doc link, not a diagnostic sweep.
3. **Separate environment from configuration from Orca.** A failing agent CLI, a stale `PATH`,
   a wrong SSH key, and a renderer crash all look the same to the user:

   | Domain | Signs | Decisive test |
   | :--- | :--- | :--- |
   | Environment | Sleep/wake, VPN shift, stale sockets, `PATH` | Run the same command in a native OS terminal — if it fails there too, it is the environment |
   | Configuration | Project-scoped, wrong SSH key, bad `orca.yaml`, broken hook | Open an empty-directory workspace — if it works there, it is configuration |
   | Orca bug | IPC rejections, renderer white-screen, daemon crash loop | The trace file shows an unhandled exception stack |

4. **Recover with the least destructive step that can work**, and tell the user what it costs.
   Restarting a wedged window destroys the evidence — collect first, then recover.
5. **Prepare a clean report** when it is a real defect. See [Reporting](#reporting).

## Getting Help & Official Resources

Point users at these rather than paraphrasing them:

- **Install & first run** — [https://www.onorca.dev/docs/install](https://www.onorca.dev/docs/install) and
  [first session](https://www.onorca.dev/docs/first-session).
- **Troubleshooting & FAQ** — [https://www.onorca.dev/docs/troubleshooting](https://www.onorca.dev/docs/troubleshooting),
  including the deep-diagnostics section this skill automates.
- **Settings reference** — [https://www.onorca.dev/docs/settings](https://www.onorca.dev/docs/settings).
- **SSH worktrees** — [https://www.onorca.dev/docs/ssh](https://www.onorca.dev/docs/ssh).
- **Remote servers / headless hosts** — [https://www.onorca.dev/docs/remote-servers](https://www.onorca.dev/docs/remote-servers).
- **Community support** — the Orca Discord for questions and live help, GitHub Discussions for
  longer-form questions, and GitHub Issues for reproducible defects with evidence attached.

If a question is about keeping a headless host alive rather than inspecting a runtime, see the
[Remote servers](https://www.onorca.dev/docs/remote-servers) documentation.

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

# Only the failure lane. Records are `type: "effect-span"` envelopes: the outcome is
# `exit._tag` (`Success` / `Failure` / `Interrupted`) and the stack is `exit.cause`.
jq -c 'select(.exit._tag == "Failure")' main.trace.ndjson

# Everything the trace recorded in a window, across the rotated family. Times are
# nanosecond strings, not ISO: compare them numerically.
cat main.trace.ndjson.3 main.trace.ndjson.2 main.trace.ndjson.1 main.trace.ndjson |
  jq -c --argjson from '<start-unix-nano>' --argjson to '<end-unix-nano>' \
    'select((.startTimeUnixNano | tonumber) >= $from and (.startTimeUnixNano | tonumber) <= $to)'
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
daemon is never reused after a breaking change. One exception: when `<userData>` is long enough
that the socket path would overflow the kernel's `sockaddr_un.sun_path` (104 bytes on macOS, 108
on Linux), only the socket moves to `/tmp/.orca-daemon-<uid>/<12-hex of the runtime dir>/`; the
token, PID record, and history stay under `<userData>`. Resolve the real endpoint before probing:

```bash
ls -la "<userData>/daemon/" "/tmp/.orca-daemon-$(id -u)/"*/ 2>/dev/null
```

| File                   | Meaning                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `daemon-v<N>.sock`     | Unix domain socket the app connects to (the PTY endpoint). Relocated under `/tmp/.orca-daemon-<uid>/<hash>/` on long data roots. |
| `daemon-v<N>.pid`      | JSON record, mode `0600`: `pid`, `startedAtMs`, `entryPath`, `appVersion`, `launchNonce`, `linuxStartTicks`, `bootId`, `spawnerExecPath`, `cgroupUnit`. The last five are what prove the record belongs to the process in front of you. Very old records are a bare integer. |
| `daemon-v<N>.token`    | Connection token; mode `0600`. Never quote it in a report.           |

On Windows the endpoint is a named pipe, `\\?\pipe\orca-terminal-host-v<N>-<hash>`, not a file.

What to read, in order:

```bash
tail -n 200 "<logs>/daemon.log" | jq -c .
jq -c 'select(.event == "startup" or .event == "ready" or .event == "shutdown")' "<logs>/daemon.log"
jq . "<userData>/daemon/daemon-v<N>.pid"
PID=$(jq -r 'if type == "object" then .pid else . end' "<userData>/daemon/daemon-v<N>.pid")
ps -p "$PID" -o pid,lstart,etime,args
```

Interpretations that hold:

- PID file present, the process alive **and** its command line carrying `daemon-entry` with this
  endpoint's `.sock` and `.token` paths **and** its start time matching the record's `startedAtMs`,
  socket accepts a connection → the daemon is healthy; the fault is above it, in the app or the
  agent CLI. Liveness alone is not identity: a recycled PID passes `ps` and proves nothing, and a
  PID owned by another user is inconclusive, not dead.
- PID file present, process gone → the daemon died without teardown. Session metadata is left
  unclean on purpose, which is what makes the replacement daemon cold-restore scrollback.
- Repeated `startup` records seconds apart, with no matching `ready` → a crash loop. Orca admits at
  most 5 daemon starts in any 60-second sliding window; the 6th is refused as `daemon_crash_loop`
  with the seconds left. The window drains on its own — fix the environment and wait it out. A UI
  restart also clears it, but costs every persistent terminal. Read the records between the starts;
  a fork that succeeds proves nothing about the daemon that follows it.
- `.swap-<pid>-<uuid>` and `.hold-<pid>-<uuid>` beside the PID or token file, and `.p<10-hex>`
  beside the socket, are work in progress: the first two briefly hold the only copy of a real
  record, the third is the private name a starting daemon binds before it publishes the endpoint.
  Never delete any of them.

## Zombie PTY Endpoint Sockets

A `daemon-v<N>.sock` left behind by a dead daemon is a *zombie endpoint*: the name is occupied and
nothing serves it, and a new daemon may only take it after proving it dead. Classify it before
acting; connecting is the only test that distinguishes the four states:

| Probe result                                           | State       | Meaning                                       |
| ------------------------------------------------------ | ----------- | --------------------------------------------- |
| Connect succeeds                                        | `connected` | A daemon is live. Leave it alone.             |
| `ECONNREFUSED`, or `ENOTSOCK` on macOS                  | `refused`   | Nothing can ever serve it. Safe to replace.   |
| `lstat` saw nothing                                     | `missing`   | Safe to publish.                              |
| Timeout, `EPERM`, anything else                         | `unknown`   | **Leave it alone.** No proof of death.        |

An entry `lstat` saw that `connect` then cannot resolve is a dangling symlink: `refused`, not
`missing`. This probe mirrors Orca's own classifier, including the lstat-before-connect step:

```bash
# A connect probe, not an existence check: `test -S` cannot tell a zombie from a live endpoint.
python3 - "<resolved sock path>" <<'PY'
import errno, os, socket, sys
path = sys.argv[1]
try:
    os.lstat(path)            # lstat, not exists(): a dangling symlink occupies the name
    occupied = True
except FileNotFoundError:
    print("missing"); raise SystemExit
except OSError:
    print("unknown"); raise SystemExit
s = socket.socket(socket.AF_UNIX)
s.settimeout(0.5)
try:
    s.connect(path)
    print("connected")
except (socket.timeout, TimeoutError):
    print("unknown")
except OSError as e:
    if e.errno in (errno.ECONNREFUSED, errno.ENOTSOCK):
        print("refused")
    elif e.errno == errno.ENOENT:
        print("refused" if occupied else "missing")
    else:
        print("unknown")
finally:
    s.close()
PY
```

Rules:

- Only `refused` and `missing` are positive proof the endpoint is dead. A probe that timed out on a
  loaded host proves nothing, and deleting on that basis can unlink a live daemon's endpoint.
- Use `lstat`, not an existence test that follows symlinks: a dangling symlink reads as absent while
  still occupying the name.
- Orca recovers from a proven-dead endpoint on its own at the next launch: a starting daemon binds a
  private `.p<hex>` name beside the endpoint, re-proves the incumbent dead twice, and renames over
  it. Restarting Orca is the fix; hand-deletion is almost never needed.
- If you delete the socket anyway, do it only with Orca fully stopped. A live daemon polls that name
  every 30s and treats two consecutive "entry is gone" readings as lost ownership: it retires itself
  and every persistent terminal on the machine dies within about a minute. `endpoint-ownership-lost`
  in `daemon.log` is the trace of that having already happened.
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

A report a maintainer can act on contains, in this order: Orca version and platform, what the
user did, what happened instead, the smallest reproduction known, and the trace or `daemon.log`
excerpt that shows it. If any of those are missing, collect them before filing rather than filing
a report that will stall in triage. Redact file paths, repo names, host names, and tokens first.

Route by what the user has: a question goes to Discord or GitHub Discussions, a reproducible
defect with evidence goes to GitHub Issues, and anything carrying logs the user would rather not
publish goes through **Help → Send Feedback** instead of a public tracker.

## Action gates

| Trigger / Condition | Action / Routing | Reference Document |
| :--- | :--- | :--- |
| Unhandled exceptions or IPC rejections | Extract stack traces with jq | `references/trace-analysis.md` |
| Reconnecting to SSH host hangs | Triage OpenSSH ControlMaster zombie sockets | `references/ssh-multiplex.md` |
| Electron UI wedged or renderer unresponsive | Connect via CDP port 9222 and inspect targets | `references/cdp-troubleshooting.md` |
| App freeze, slow reconnect, or unknown error | Run 4-step SRE triage sequence and telemetry map | `references/sre-playbook.md` |
| Ghost tabs flicker or reopen in loop | Clear openFilesByWorktree in orca-data.json | `references/telemetry-and-settings.md` |
| Embedded browser, worktree lock/PTY desync, or mobile pairing fail | Triage webview CDP, stale git index lock, and mobile network route | `references/worktree-browser-mobile.md` |
