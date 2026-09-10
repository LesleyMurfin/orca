# Orca Serve Troubleshooting Matrix

Triaging the headless `orca serve` runtime from symptom to root cause. Every failure lands in
exactly one of four buckets; the hard part is picking the right bucket before you reach for a
fix. Start at the flowchart, then read that bucket's table and run its **≤ 5**-command cheat
sheet. Evidence before remedies: snapshot first (`orca-serve-diag --phase after`), then act.

---

## 1. Decision flowchart

```mermaid
flowchart TD
    A["Symptom: serve down / clients broken"] --> B{"Unit failed or\nconstantly restarting?"}
    B -- yes --> C{"systemctl status shows\ncode=exited, status=<n>?"}
    B -- no --> D{"Clients report\n'Unknown environment'/\nconnection refused?"}

    C -- "status=137\n(killed / SIGKILL)" --> B2[**Bucket 2** — Server Resource]
    C -- "status=203\n(EXEC)" --> B3[**Bucket 3** — Server Config]
    C -- "SIGSEGV/SIGTRAP/\nunhandled rejection" --> B1[**Bucket 1** — Orca Bug]
    C -- "start-limit hit /\nrate-limited" --> B2

    D -- yes --> E{"Client error mentions\nenvironment id mismatch?"}
    D -- no --> F{"Port 6768 not bound?\nfallback port bound?"}

    E -- yes --> B4[**Bucket 4** — Client Config]
    F -- yes --> B3
    F -- no --> B2
```

ASCII fallback (same routing):

```text
 serve down / clients broken
        │
        ├─ unit failed / restart-looping ──► status=137 ────────────► BUCKET 2 (resource)
        │                                   status=203 (EXEC) ─────► BUCKET 3 (server config)
        │                                   SIGSEGV/SIGTRAP /
        │                                   unhandled rejection ────► BUCKET 1 (orca bug)
        │                                   start-limit hit ───────► BUCKET 2 (resource)
        │
        └─ clients "Unknown environment" / "connection refused"
                │
                ├─ environment-id mismatch ──► BUCKET 4 (client config)
                ├─ 6768 not bound /
                │   fallback bound          ──► BUCKET 3 (server config)
                └─ OOM / ENOSPC / fd        ──► BUCKET 2 (resource)
```

**Cross-bucket discriminator (5 questions):**

| # | Question | Points to |
|---|----------|-----------|
| 1 | Does `systemctl status orca-serve@<slot>` show `status=137` (`n/a` or 128+9)? | **2** — OOM-kill |
| 2 | Does it show `status=203` (`Failed at step EXEC`)? | **3** — exec/mount/path |
| 3 | Is `6768`/`<pin>` LISTENing, or is a fallback port bound instead? | **3** — port/override |
| 4 | Does the journal carry `SIGSEGV`, `SIGTRAP`, `UnhandledPromiseRejection`, `RuntimeEnvironmentStoreError`? | **1** — in-process bug |
| 5 | Does the client error name an environment id not in the registry, or a stale runtimeId? | **4** — client state |

---

## 2. Bucket 1 — Orca bug (in-process)

Faults *inside* the Electron/TS runtime itself. You cannot fix these with config or resources;
you pin the build, capture a bundle, and fix upstream or via fork patch.

| Signature | Root cause | Evidence to collect |
|-----------|-----------|---------------------|
| **SIGSEGV** in main process | Native crash — most common: headless path self-spawns Xvfb on a stale `:99` lock (upstream gap #5412/#6802), GPU-less host without `LIBGL_ALWAYS_SOFTWARE`, or native module | `journal_signatures.SIGSEGV`, `app_crash_reports.latest_exitCode`, `crashpad_minidumps` |
| **SIGTRAP** | WebGL2/GPU blocklisted, renderer gone — GPU-less host, or wrong DISPLAY wiring (external-DISPLAY early-return skips `disable-gpu`) | `journal_signatures.SIGTRAP` / `WebGL2_blocklisted`, `serve-fg.log` tail |
| **Unhandled rejection** | `UnhandledPromiseRejectionWarning` / uncaught exception in TS — restarts never converge | journal `UnhandledPromiseRejection` / `uncaughtException` signatures |
| **`RuntimeEnvironmentStoreError: Unknown environment`** | Runtime identity churned and `orca-runtime.json` points at a phantom/dead pid; CLI resolves an env id with no live runtime | `dispatch_health.environment_error_count`, `config_state` phantom-pid verdict, `orca-runtime.json` pid vs `ss` listener |
| **Deadlocks / state churn** | Daemon-init vs serve race; `killStaleDaemon` tearing down a live runtime; runtimeId minted anew on every restart while a client pins the old one | `restart_count` vs `start_limit_burst`, bundle-delta between before/after |

**Remediation (in order):** (1) snapshot before/after with the diag tool and read the delta
verdict; (2) reproduce on `canary` at full verbosity (`ORCA_LOG_LEVEL=debug`,
`ELECTRON_ENABLE_LOGGING=1`); (3) pin or roll back the suspect build via `ORCA_VERSION`; (4) fix
upstream / adopt a fork patch and repoint `ORCA_VERSION`. Never hand-edit `orca-runtime.json` to
"unphantasm" it — that masks, not fixes.

**Triage cheat sheet (5):**

```bash
orca-serve-diag --phase after && orca-serve-diag --change-gate      # snapshot + critical flags
journalctl -u orca-serve@<slot>.service -b -o cat --no-pager \
  | grep -iE 'SIGSEGV|SIGTRAP|UnhandledPromiseRejection|uncaughtException|RuntimeEnvironmentStoreError'
tail -n 200 "$ORCA_SERVE_LOGDIR/serve-fg.log"                        # serve's own words
ss -ltnp | grep -E ':(6768|6769|6770|6771)'                          # who actually LISTENs
readlink -f "$ORCA_DIR/serve-root" && cat "$ORCA_CONFIG_DIR/orca-runtime.json" | jq '.pid'
```

---

## 3. Bucket 2 — Server resource

The box (or its cgroup) ran out of a finite resource. The serve usually *was* healthy; the kernel
or systemd killed it.

| Signature | Root cause | Evidence to collect |
|-----------|-----------|---------------------|
| **Exit 137 / `status=137` / OOM killer** | cgroup memory limit hit (systemd) or host OOM — kernel sends SIGKILL (128+9); Electron never logs it itself | `systemctl status` result code, `journalctl -k \| grep -i oom`, `coredumpctl`, `resources.mem`, `serve_rss_kb` |
| **`ENOSPC` (no space left)** | `/data` or `/tmp` full — AppImage self-extract or session writes fail. Never put diag/log state under small `/tmp` fs | `resources.disk` free_mb (/, /tmp, /data), `df -h` |
| **`EMFILE` (too many open files)** | fd exhaustion — fd leak in a plugin/pty loop, or `LimitNOFILE` too low vs session count | `resources.system_fd_count`, `ls /proc/<pid>/fd | wc -l`, `lsof -p <pid>` |
| **CPU starvation** | Pegged cores — runaway renderer/pty loop, or WSL2 `autoMemoryReclaim`/tight slab reclaim; startup TLS/timeout failures | `resources.loadavg` vs `nproc`, `uptime`, `top -bn1`, `pidstat` |

**Remediation (in order):** (1) confirm the resource (free_mb / fd / loadavg) and trend over time;
(2) raise the systemd **resource limits** in the unit (see template's `MemoryHigh`/`MemoryMax`/
`LimitNOFILE` — then `daemon-reload` + restart); (3) free the exhausted resource (prune diag
bundles, purge a dead `/tmp` extraction, close leaked fds); (4) if the killer is the cgroup,
tune `MemoryMax` up or fix the leak, don't just crank the limit.

**Triage cheat sheet (5):**

```bash
systemctl status orca-serve@<slot>.service | sed -n 's/.*status=//p'    # 137/203/…
journalctl -k --since "1 hour ago" -o cat | grep -iE 'oom|killed process'
df -h /data /tmp / && free -h                                         # ENOSPC / memory pressure
ls /proc/$(ss -ltnp | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)/fd 2>/dev/null | wc -l
nginx=0; systemctl show -p MemoryCurrent -p MemoryMax -p NRestarts orca-serve@<slot>.service
```

---

## 4. Bucket 3 — Server configuration

The unit or its config is wrong: exec fails before the process starts, the port is stolen, or
permission/path denies the start.

| Signature | Root cause | Evidence to collect |
|-----------|-----------|---------------------|
| **Exit 203 / `Failed at step EXEC`** | `ExecStart` binary missing/unexecutable, bad `WorkingDirectory`, missing mount (`RequiresMountsFor=/data` not satisfied → not ENOENT but a clean mount error), or a needed `PATH` entry missing | `systemctl status` exec line, `journalctl -u … -b -o cat`, `systemd-analyze verify` |
| **Port 6768 collision** | Another process already LISTENs on the pinned port (dual-serve/split-brain), or an EADDRINUSE at startup | `ss -ltnp \| grep 6768`, `serve_inventory` dual-serve probe, `delta` verdict `dual_serve_risk_after` |
| **`mobile-ws-fallback-port.json` stale override** | A persisted fallback port file is bound *before* the pinned `--port`, so serve binds e.g. 45175 and never 6768 | `ls -la "$ORCA_CONFIG_DIR/mobile-ws-fallback-port.json"`, `serve_inventory.fallback_ports` in a bundle |
| **Permission denied** | `User=`/`Group=` mismatch, a dir owned by another uid, or polkit-declined self-restart (svc_orca restart rule) | `journalctl -u … \| grep -iE 'permission denied|operation not permitted'`, `namei -l <path>` of the failing path |
| **Misconfig fail-loud** | A referenced `EnvironmentFile` is missing → unit fails loudly (no leading `-`) rather than a silent default | `systemctl status` + `journalctl`, `grep EnvironmentFile= orca-serve@.service` |

**Remediation (in order):** (1) fix the exec/path/mount cause (`203`), do not band-aid with
`Restart=always`; (2) remove the stale `mobile-ws-fallback-port.json` if present — the launcher
drops it pre-start, but a missing drop means your pin is being pre-empted; (3) resolve the port
contender (kill the stray listener, or move that slot's `ORCA_SERVE_PORT`); (4) correct
ownership/permissions and re-verify with `systemd-analyze verify` before `daemon-reload`.

**Triage cheat sheet (5):**

```bash
systemctl status orca-serve@<slot>.service --no-pager -l | tail -20       # 203 / EXEC / permission
ss -ltnp | grep -E ':(6768|6769|6770|6771)'                                # who owns the port
ls -la "$ORCA_CONFIG_DIR/mobile-ws-fallback-port.json" 2>/dev/null && \
  cat "$ORCA_CONFIG_DIR/mobile-ws-fallback-port.json"                      # stale override present?
systemd-analyze verify /etc/systemd/system/orca-serve@.service            # pre-reload syntax gate
namei -l "$(systemctl cat orca-serve@<slot>.service 2>/dev/null | sed -n 's/^ExecStart=//p' | awk '{print $1}')"
```

---

## 5. Bucket 4 — Client configuration

The serve is healthy (bound, LISTENing); the *client* cannot resolve, reach, or authenticate to
it.

| Signature | Root cause | Evidence to collect |
|-----------|-----------|---------------------|
| **"Unknown environment: \<id\>"** | Client environment id (registry `name`) has no matching live runtime — served env-id unset/blank, or the selector stripped/mismatched on a local CLI call | client stderr, `--environment` flag, environment registry on the client, serve-side `dispatch_health` |
| **Connection refused** | Wrong host/port, overlay/WireGuard IP unreachable, `localhostForwarding` off in WSL2, or serve not actually bound to the expected address | `nc -zv <addr> 6768`, `curl -s http://<addr>:6768/` (probe), `ss -ltn` on serve host vs advertised pairing address |
| **Token mismatch** | Device token / E2EE keypair on one side ≠ other side (re-paired or a restored-from-stale-backup keypair) | pair logs on both ends, presence of `orca-e2ee-keypair.json` vs its backup copy |
| **Stale pairing id / `activeEnvironmentId`** | Restart minted a **new runtimeId**; client still pins the old id and never detects the change (`scheduleReconnect` retries stale state) — classic orphan-until-relaunch | bundle `runtime_identity.runtimeId` change across before/after, client "disconnected, retrying" stuck state |
| **Version skew** | Client/serve different protocol versions — daemon-init `killStaleDaemon` vs newer runtime, or flag/transport contract drift | `orca-serve-version` on serve vs client `orca --version`, protocol handshake rejection in logs |

**Remediation (in order):** (1) verify the transport ends (address, port, reachability) before
auth — most "connection refused" is network, not token; (2) reconcile environment id + pairing
address between client registry and serve (`ORCA_ENVIRONMENT` / `ORCA_PAIRING_ADDRESS`); (3) if
the runtimeId changed under a pinned client, relaunch the client (or fix the stale-id reconnect
bug) — keypair/token usually persist so this is a session rebuild, not a re-pair; (4) align
client/serve versions.

**Triage cheat sheet (5):**

```bash
nc -zv <pairing-address> 6768                                      # transport reachability
orca --environment <id> status --json | jq '{runtimeId, pid, version}'   # env resolves + live?
cat "$ORCA_CONFIG_DIR/orca-runtime.json" | jq '{runtimeId, pid}'    # vs what the client pins
orca-serve-version status && orca --version                        # version-skew check
cmp "$HOME/.config/orca/orca-e2ee-keypair.json" "$BACKUP/orca-e2ee-keypair.json" && echo matched
```

---

## 6. Evidence-first checklist

Before any remedy, capture a bundle and read the delta — it answers "did the runtime identity,
port, or crash signature change across the restart?".

```bash
# 1. snapshot now
orca-serve-diag --phase after
# 2. read the newest bundle's crash + resource fields
jq '{crash_evidence, resources, dispatch_health}' \
  "$(orca-serve-diag --latest --phase after)"
# 3. against the last 'before' if one exists
orca-serve-diag --change-gate
```