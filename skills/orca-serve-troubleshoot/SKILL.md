---
name: orca-serve-troubleshoot
description: >-
  Automate Orca Serve logging installation, connectivity verification, and root-cause
  diagnostic triage across the 4 buckets (Orca Bug, Server Resource, Server Config,
  Client Config). Triggers: diagnose orca serve, orca serve down, orca serve troubleshooting,
  install orca serve logging, orca connection refused, orca serve status, orca unknown
  environment. Not for orca-cli, orchestration, or generic server health.
---

# Orca Serve Troubleshoot

## Purpose

Two-mode router for the headless `orca serve` runtime. **Install / preflight mode** provisions
the logging + diagnostics surface idempotently. **Triage mode** runs a non-destructive
5-command sequence and classifies the failure into exactly one of four root-cause buckets.

## Action 0 — Environment Fingerprinting

Before executing triage commands, fingerprint the host virtualization and init system.
Host divergence determines whether `systemctl` is present, how networking resolves, and where display servers reside.

```bash
# Fast environment detector
if [ "$(uname -s)" = "Darwin" ]; then
  echo "ENV: macOS (Darwin) - launchd supervisor, no X11/Xvfb required"
elif grep -qi microsoft /proc/version 2>/dev/null; then
  echo "ENV: WSL2 - check localhostForwarding, WSLg /tmp/.X11-unix/X0, and IP drift"
elif [ -f /.dockerenv ] || grep -qE 'docker|containerd|kubepods' /proc/1/cgroup 2>/dev/null; then
  echo "ENV: Container / Docker - check /dev/shm >= 2GB, PID 1 init, and 0.0.0.0 bind"
else
  echo "ENV: Native Ubuntu/Linux - systemd multi-instance, Xvfb on display :99"
fi
```

## Action 1 — Install / Preflight mode

Triggered by: "install orca serve logging", "setup orca serve logging".

1. Locate `docs/reference/serve-logging/templates/install-logging-setup.sh`.
2. Always dry-run first — it audits and changes nothing:
   ```bash
   sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh --dry-run
   ```
3. Check the exit code and read every `FAIL` line:
   - Exit `0` with only `WARN` lines → safe to apply.
   - Any `FAIL` line → resolve the hard-fail from the `preflight` output before installing.
4. Apply only when authorized:
   ```bash
   sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh \
     [--instance <instance>] [--prefix <prefix>] [--port <port>] [--pairing-address <addr>]
   ```
5. Verify the unit registers: `systemctl is-enabled orca-serve@<instance>.service`.

## Action 2 — Triage mode (5-command sequence, non-destructive)

Triggered by: "diagnose orca serve", "orca serve down", "orca serve status",
"orca connection refused", "orca unknown environment".

Run all five over the failing instance (or adapt for macOS `launchctl` if Darwin) and keep the output for Action 2.

```bash
systemctl status orca-serve@<instance>.service --no-pager   # active vs status=137 / 203
journalctl -u orca-serve@<instance>.service -n 50 --no-pager
ss -ltnp | grep -E ':(6768|6769|6770|6771)'                  # who LISTENs, fallback port?
orca --environment <id> status --json | jq '.runtime'        # env resolves + live runtime?
cat "${ORCA_USER_DATA_PATH:-$HOME/.config/orca}/orca-runtime.json" | jq '{runtimeId, pid}'
```

Read the journal for `SIGSEGV`, `SIGTRAP`, or unhandled rejections. Compare the client
registry's `activeRuntimeEnvironmentId` against the known environments and the serve-side
runtime id in `orca-runtime.json`.

## Action 3 — Root-Cause Classification & Environment Traps
Map the evidence to one bucket, taking into account any host-specific divergence traps:

| Evidence | Bucket | Recommended fix |
|----------|--------|-----------------|
| `SIGSEGV` / `SIGTRAP` / unhandled rejection in the journal | **1 — Orca Bug** | reproduce on a spare instance, pin/roll back `ORCA_VERSION` |
| `status=137` (OOM/SIGKILL), `ENOSPC`, `EMFILE`, CPU starvation | **2 — Server Resource** | raise unit `MemoryHigh`/`MemoryMax`/`LimitNOFILE`, free the resource |
| `status=203` (EXEC), port collision, stale fallback-port override, missing path | **3 — Server Config** | fix `ExecStart`/`WorkingDirectory`/permissions, remove stale fallback file, free/pin the port |
| env-id mismatch / stale `activeRuntimeEnvironmentId` / connection refused | **4 — Client Config** | reconcile env id + pairing address, relaunch the client, align versions |

### Environment-Specific Divergence Traps

- **Ubuntu Bare-Metal Headless:**
  - *Trap:* Stale `/tmp/.X99-lock` or `/tmp/.X11-unix/X99` file from an ungraceful shutdown blocks internal `Xvfb` self-spawn, resulting in immediate crash (`SIGSEGV` or exit status 1).
  - *Fix:* Remove stale lock files (`rm -f /tmp/.X99-lock /tmp/.X11-unix/X99`) or run managed `xvfb.service`.
- **WSL2 (Windows Subsystem for Linux):**
  - *Trap (Networking):* Windows client dialing `localhost:6768` fails with `Connection refused` because `localhostForwarding=true` is missing in `%USERPROFILE%\.wslconfig` or dynamic NAT IP drifted after Windows sleep.
  - *Trap (Display / GPU):* Stale WSLg display socket hangs or crashing D3D12 GPU drivers cause `SIGTRAP`.
  - *Fix:* Unset `DISPLAY` and `WAYLAND_DISPLAY` in the service to force headless fallback; set `ORCA_DISABLE_GPU=1`.
- **Docker / Container:**
  - *Trap (SHM crash):* Container exits with `status=137` on rendering complex terminal canvas because default `/dev/shm` is only 64MB.
  - *Fix:* Launch container with `--shm-size=2gb` or `--ipc=host`.
  - *Trap (PID 1):* Zombie child processes accumulate without init reaper. Use `docker run --init` (`tini`).
  - *Trap (Binding):* Binding to `127.0.0.1` inside container isolates socket from host. Bind to `0.0.0.0`.
- **macOS (Darwin):**
  - *Trap:* `systemctl` commands fail with command not found. Use `launchctl list | grep orca` and inspect log files under `/tmp/orca-serve.*.log`.

Never hand-edit `orca-runtime.json` to clear a phantom pid — that masks the crash, not the
cause.

## References

- Troubleshooting matrix: `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md`
- Logging guide: `docs/reference/serve-logging/orca-serve-logging-guide.md`
- Install script: `docs/reference/serve-logging/templates/install-logging-setup.sh`
