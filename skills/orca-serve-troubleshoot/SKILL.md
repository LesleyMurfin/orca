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

Run all five over the failing instance and keep the output for Action 3.

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

## Action 3 — Root-Cause Classification

Map the evidence to one bucket, then apply the exact fix from
`docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md`.

| Evidence | Bucket | Recommended fix |
|----------|--------|-----------------|
| `SIGSEGV` / `SIGTRAP` / unhandled rejection in the journal | **1 — Orca Bug** | reproduce on a spare instance, pin/roll back `ORCA_VERSION` |
| `status=137` (OOM/SIGKILL), `ENOSPC`, `EMFILE`, CPU starvation | **2 — Server Resource** | raise unit `MemoryHigh`/`MemoryMax`/`LimitNOFILE`, free the resource |
| `status=203` (EXEC), port collision, stale fallback-port override, missing path | **3 — Server Config** | fix `ExecStart`/`WorkingDirectory`/permissions, remove stale fallback file, free/pin the port |
| env-id mismatch / stale `activeRuntimeEnvironmentId` / connection refused | **4 — Client Config** | reconcile env id + pairing address, relaunch the client, align versions |

Never hand-edit `orca-runtime.json` to clear a phantom pid — that masks the crash, not the
cause.

## References

- Troubleshooting matrix: `docs/reference/serve-logging/orca-serve-troubleshooting-matrix.md`
- Logging guide: `docs/reference/serve-logging/orca-serve-logging-guide.md`
- Install script: `docs/reference/serve-logging/templates/install-logging-setup.sh`
