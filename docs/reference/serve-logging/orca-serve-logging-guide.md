# Orca Serve Logging Guide

Reference for the headless `orca serve` runtime's logging architecture, client log
locations, and diagnostic bundle integration. This is the operational companion to the
systemd unit (`templates/orca-serve/orca-serve@.service.template`), the config layer
(`orca-serve.conf.template` / `orca-serve-instance.env.template`), and the troubleshooting
matrix (`orca-serve-troubleshooting-matrix.md`).

The runtime is **config-driven**: every value below that changes by host or instance lives in
the config layer, never in a script or a rebuilt unit. "Everything is configuration" is the
governing principle (see `orca/orca-serve/design/iac-drafts/serve-runtime/CONTRACT.md`).

---

## 1. Architecture

Every serve process writes to **two independent sinks**, so a failure of either still leaves a
usable record:

```text
                               orca-serve@.service (systemd)
                                        │
                             ExecStart=orca-serve-fg
                                        │
                     stdout ────────────┼──────────── stderr
                        │               │                │
                        │     exec > >(tee -a serve-fg.log) 2>&1
                        │               │                │
                        ▼               ▼                ▼
                   ┌─────────┐   ┌──────────────────┐
                   │ journald │◄──│ passthrough (fd1)│
                   │ (system) │   └──────────────────┘
                   └─────────┘           │ file append (tee)
                        │                ▼
                        │      $ORCA_SERVE_LOGDIR/serve-fg.log   (rotated at 10 MiB)
                        ▼
          journalctl -u orca-serve@<slot>.service
```

**Two sinks, one stream.** The launcher rewires the shell's fd1/fd2 through `tee` so the
serve's *own words* — pinned-port fallback notices, single-instance relaunch, fuse/sandbox/GPU
errors — are captured both to the journal and to a durable file. This is deliberate: on
`--user` units the journal can drop output and gets flooded by the AppImage extract listing; the
file always survives. `tee` passes the stream through to the original stdout, so journald still
receives it.

| Sink | Path / accessor | Survives | Rotates |
|------|-----------------|----------|---------|
| **journald** | `journalctl -u orca-serve@<slot>.service` | system restart (persistent journal) | journald's own vacuum policy |
| **serve-fg.log** | `$ORCA_SERVE_LOGDIR/serve-fg.log` (`state/<slot>/logs/serve-fg.log`) | log-dir on `/data` (never `/tmp`) | 10 MiB threshold → `serve-fg.log.1` |
| **poststart.log** | `$ORCA_SERVE_LOGDIR/poststart.log` | same dir | unbounded (small volume) |
| **diag bundles** | `$DIAG_DIR/*.json` (`state/<slot>/diagnostics/`) | persistent, `/data` | rolling, newest N kept |

### Rotation (single-file, launcher-owned)

`orca-serve-fg` performs a tiny inline rotation before it execs:

```bash
LOGFILE="$LOGDIR/serve-fg.log"
if [ -f "$LOGFILE" ] && [ "$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv -f "$LOGFILE" "$LOGFILE.1"
fi
```

- Threshold: **10 MiB**. One prior copy (`serve-fg.log.1`) is kept; a second trigger overwrites it.
- This is *not* logrotate — it is fast, has no external dependency, and cannot race a restart.
  For long-term retention, rely on the **diag bundles** (snapshot JSON) and the **journal**, not
  on `serve-fg.log` longevity.
- The unit sets `ORCA_SERVE_LOGDIR=<PREFIX>/state/%i/logs` (`%i` = slot), so each instance has
  its own log dir pre-created 0700 by the instance-tree provisioner.

---

## 2. Environment variables

All of these are **config-layer values** (host-wide in `orca-serve.conf`, per-instance in
`<slot>.env`) or structural env set by the unit. They are never baked into the launcher.

| Variable | Typical value | Scope | Effect |
|----------|---------------|-------|--------|
| `ELECTRON_ENABLE_LOGGING=1` | `1` | host | Turn on Electron/Chromium internal logging (GPU, renderer, IPC channels) to stderr→ journal + serve-fg.log. Use when chasing a WebGL/GPU/SIGTRAP fault. |
| `ORCA_LOG_LEVEL=debug` | `debug` (also `info`, `warn`, `error`) | instance | Raise the serve's own app-level log verbosity. `debug` floods; set per-slot on the suspect instance only. |
| `--verbose` | (CLI flag) | instance | Equivalent front-door to `ORCA_LOG_LEVEL=debug`; passed on the `orca serve` command line. |
| `LIBGL_ALWAYS_SOFTWARE=1` | `1` | host | Force software GL for GPU-less hosts (mtl-02). Missing on a GPU-less host ⇒ WebGL2 blocklisted ⇒ SIGTRAP / renderer crash. |
| `ORCA_DEBUG=1` | `1` | client | Client-side debug mode — timestamps every client request, dumps transport handshakes, and enables the `--json` machine-readable output path. |
| `--json` | (CLI flag) | client / serve | Emit structured JSON output instead of human text. `orca-serve-fg` already appends `--json` to the serve invocation so tooling can parse the serve stream. |
| `ORCA_ENVIRONMENT` | `mtl-02` \| `pc` | host | Host's Orca environment id. Also a **client selector** for CLI calls — must exactly match a `name` in the environment registry. |
| `ORCA_SERVE_LOGDIR` | `<PREFIX>/state/%i/logs` | unit (structural) | Where the tee writes `serve-fg.log`/`poststart.log`. |
| `OSV_DIAG_DIR` | `<PREFIX>/state/%i/logs` | unit | Legacy alias for the log/diag dir; diag tooling keys off it. |
| `ORCA_INSTANCE` | `factory` \| `lesley` \| `jessica` \| `canary` | unit | Slot name (`%i`) — keys every per-instance path and the scope-dispatched service name. |
| `OSV_SYSTEMD_SCOPE` | `system` | unit | Scope dispatch: `systemctl`/`journalctl` vs `--user` variants. `system` under the `--system` model. |

> **Set debug where it bites, not everywhere.** `ORCA_LOG_LEVEL=debug` + `ELECTRON_ENABLE_LOGGING=1`
> on an always-on slot can multiply journald volume and mask the failure you are chasing. Prefer:
> (1) reproduce on the `canary` slot, (2) snapshot with the diag tool first, (3) raise verbosity last.

---

## 3. Client log locations

The **client** (desktop Orca app / CLI) is a different process from the headless **serve**.
Its userData/log layout follows the platform's Electron convention. `$USERDATA` here is the Orca
Electron userData dir; the serve-side equivalent is `$XDG_CONFIG_HOME/orca` (the unit exports
`ORCA_CONFIG_DIR=<PREFIX>/state/%i/config/orca`).

| Platform | Client logs / state | Notes |
|----------|---------------------|-------|
| **macOS** | `~/Library/Logs/orca/` (main process + renderer logs) · `~/Library/Application Support/orca/` (userData, `crash-reports.json`, `Crashpad/`, `orca-e2ee-keypair.json`) | Console.app `Orca` filter mirrors stderr; `--enable-logging --v=1` exposes Chromium verbosity via `ORCA_DEBUG`. |
| **Windows** | `%USERPROFILE%\AppData\Roaming\orca\logs\` · `%USERPROFILE%\AppData\Roaming\orca\` (userData, `crash-reports.json`, `orca-e2ee-keypair.json`) | Pairing keypair and `activeEnvironmentId`/runtime bindings live under the same userData tree — do not lose `orca-e2ee-keypair.json`. |
| **Linux** | `~/.local/share/orca/logs/` (serve-side default log dir) · `~/.config/orca/` (userData, `profiles/local-default/orca-data.json`, `orca-runtime.json`, `crash-reports.json`, `Crashpad/`) | The headless serve uses `$ORCA_SERVE_LOGDIR` (state/<slot>/logs) instead of the `~/.local/share` default. |

### Client CLI flags

| Flag | Effect |
|------|--------|
| `ORCA_DEBUG=1` | Full request/response tracing, transport handshake dumps, redacted-secrets logger. Sets `--json` behavior on by default in most paths. |
| `--json` | Structured JSON on stdout for every subcommand — pipe to `jq`, capture to file, or feed the diag tool. |
| `--environment <id>` | Pin the CLI to a specific environment id (local unix-socket vs remote WebSocket/E2EE dispatch). A mismatch here is the "Unknown environment" failure signature. |

---

## 4. Transport layer

Two transports serve the same runtime, dispatched by the client based on `--environment` /
`ORCA_ENVIRONMENT`:

```text
 Remote client ── ws://<addr>:6768 ──► [ WebSocketTransport  +  TLS  +  E2EE ]  ──► orca serve
                       (paired)
 Local CLI / agent ─► unix socket o-*.sock ─► [ UnixSocketTransport ]           ──► orca serve
                       (same host)
```

| Transport | Endpoint | When used | Security |
|-----------|----------|-----------|----------|
| **WebSocket** | `ws://<pairing-address>:6768` (forwarded / overlay IP, e.g. WireGuard `10.200.0.1`) | Remote desktops/CLIs pair to the serve over the network | TLS on top of the hop when proxied (`wss://`); payload is **E2EE** — the client/server keypair minted at first pair encrypts traffic end-to-end so an intermediary cannot read commands. |
| **Unix domain socket** | `o-*.sock` under the runtime dir (`$XDG_RUNTIME_DIR/orca_serve/<slot>/`) | Local CLI/agents on the serve host (fast path, no network) | File-system permissioning (`0700`, svc_orca-owned) — no network exposure. |

**Port pinning & the fallback-port trap.** The serve is pinned to `--port 6768`
(per-instance ports 6769/6770/6771 for lesley/jessica/canary). Orca's headless serve persists a
"fallback WS port" to `<userData>/mobile-ws-fallback-port.json` and, on start, binds that
remembered port **before** the pinned `--port` (`candidatePorts = [fallback, pinned]`). A stale
file (`{"port":45175}`) makes serve bind the fallback and *never* try 6768, silently breaking
already-paired clients. `orca-serve-fg` therefore deletes
`$USERDATA/mobile-ws-fallback-port.json` before every start so the pin is authoritative
(STA-1511).

**Pairing & key material.** On first pair the client and serve mint an E2EE keypair
(`orca-e2ee-keypair.json`) and a device token. These **survive version swaps and restarts** —
a version-swap or restart is a session rebuild, not a re-pair — but a restart mints a **new
runtimeId**, which a stale client pins to (the "stale pairing id / stale `activeEnvironmentId`"
failure class, covered in the matrix).

---

## 5. Integration with `orca-serve-diag`

`orca-serve-diag` captures the full post-upgrade / crash / restart field set into a
timestamped JSON bundle under a persistent diagnostics dir (never `/tmp`), and can diff two
bundles into a plain-English "what changed / what's now inconsistent" verdict.

```bash
# Snapshot before a change, and again after (or on crash) — scope-dispatched, %i-aware.
orca-serve-diag --phase before
orca-serve-diag --phase after
# systemctl restart orca-serve@factory.service   # …then capture the after state

# Human + machine verdict between two bundles (exit 2 on a critical finding).
orca-serve-diag --delta "$(orca-serve-diag --latest --phase before)" \
                        "$(orca-serve-diag --latest --phase after)"

# Change gate: newest before vs after; exit 2 on dual-serve/port/SIGKILL flags.
orca-serve-diag --change-gate
```

Bundle layout (`schema: 2`, atomic `.tmp`→`.json` publish, rolling retention of newest N under
`$DIAG_DIR`):

```jsonc
{
  "schema": 2, "ts": "2026-09-09T00:00:00Z", "phase": "after",
  "host": "mtl-02-dev-001", "orca_environment": "mtl-02",
  "runtime_identity":  { /* live :6768 listener pid, runtimeId, ports, serve_inventory */ },
  "serve_inventory":   { /* dual-serve probe, SIGKILL/EADDRINUSE signatures */ },
  "config_state":      { /* orca-runtime.json vs live listener, phantom-pid check */ },
  "sessions":          { /* /data sessions, orphan vs preserve set */ },
  "dispatch_health":   { /* environment_error_count, resolveEnvironment signatures */ },
  "crash_evidence":    { /* journal_signatures (SIGTRAP/SIGSEGV/SIGKILL), serve_fg_log,
                            crashpad_minidumps, app_crash_reports, restart_count, start_limit_burst */ },
  "resources":         { /* loadavg, nproc, meminfo, disk free (/ /tmp /data),
                            system_fd_count, serve_rss_kb */ }
}
```

The bundle is read-only w.r.t. the runtime: every external probe is timeout-bounded and
best-effort, a failed probe records `{"error": …}` and collection continues, and the whole
`collect()` pass is budgeted (`DIAG_TOTAL_BUDGET`, default 45 s) so it always returns inside
systemd's stop budget. Point the diag at the same `ORCA_CONFIG_DIR`/`ORCA_SERVE_LOGDIR` the serve
uses, or its runtime-identity and crash-evidence probes go blind.

---

## 6. Quick references

```bash
# Serve's own words, newest first
tail -n 200 "$(systemctl show -p Environment --value orca-serve@factory.service \
  | tr ' ' '\n' | sed -n 's/^ORCA_SERVE_LOGDIR=//p')/serve-fg.log"

# Journal for one instance
journalctl -u orca-serve@factory.service -b --no-pager -n 200

# Latest crash signatures since yesterday
journalctl -u orca-serve@factory.service --since "24 hours ago" -o cat \
  | grep -iE 'SIGTRAP|SIGSEGV|SIGKILL|Unhandled|uncaught'
```