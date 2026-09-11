# Orca Serve — Logging & Diagnostic Setup

Reproduce the headless `orca serve` logging and triage arrangement on any Linux/systemd
host in under 5 minutes. One script installs the systemd instance unit, provisions the
config layer and per-instance state tree, and wires log rotation + journal retention. It
does **not** download or start the serve — it arranges the *observability* surface only.

```bash
sudo bash install-logging-setup.sh --dry-run   # audit first, change nothing
sudo bash install-logging-setup.sh             # then install
```

## 1. What lives where

**`templates/`** — the reproducible sources:

| File | Purpose |
|------|---------|
| `install-logging-setup.sh` | One-command installer / auditor (this setup) |
| `orca-serve@.service.template` | systemd instance unit; `@PREFIX@`/`@PORT@`/`@PAIRING_ADDRESS@` are substituted at install |
| `orca-serve.conf.template` | Host-wide config (shared, loaded first) |
| `orca-serve-instance.env.template` | Per-instance config (loaded second, overrides host) |
| `orca-client-diagnostics.md` | Client-side reachability/pairing runbook (Bucket 4) |
| `test-logging-setup.sh` | Sandbox self-test (install → verify → idempotency; never touches production) |

**`docs/reference/serve-logging/`** — the operational docs:

| File | Purpose |
|------|---------|
| `orca-serve-logging-guide.md` | Architecture, env vars, sinks, client log locations |
| `orca-serve-troubleshooting-matrix.md` | Symptom → bucket → ≤5-command triage (Buckets 1–4) |

## 2. Deploy in 5 steps

1. **Audit** — `sudo bash install-logging-setup.sh --dry-run`. Fix any `FAIL` line.
2. **Install** — `sudo bash install-logging-setup.sh` (uses `/opt/orca_serve`).
   For another prefix: `sudo INSTALL_PREFIX=/opt/orca_serve bash install-logging-setup.sh`.
3. **Create the service account** (if the audit warned it was missing):
   `useradd -r -s /usr/sbin/nologin orca`.
4. **Reload + enable** — the installer runs `daemon-reload`; then
   `sudo systemctl enable --now orca-serve@default.service`.
5. **Verify** — run the 5 commands below; then `sudo systemctl restart systemd-journald`
   to apply the journal retention drop-in.

Config knobs (env or flags): `INSTALL_PREFIX`, `SYSTEMD_DIR`, `DEFAULT_INSTANCE`,
`SERVE_PORT`, `PAIRING_ADDRESS`, `LOGROTATE_DIR`, `JOURNALD_DIR`. Flags: `--prefix`,
`--systemd-dir`, `--instance`, `--port`, `--pairing-address`, `--dry-run`.

## 3. Five diagnostic commands

```bash
systemctl status orca-serve@default.service --no-pager            # 137=OOM, 203=EXEC, active/…
journalctl -u orca-serve@default.service -n 50 --no-pager         # serve's journal sink
ss -ltnp | grep -E ':(6768|6769|6770|6771)'                       # who actually LISTENs
orca --environment <id> status --json | jq '.runtime'             # client view vs serve truth
logrotate -d /etc/logrotate.d/orca-serve                          # rotation validity
```

> Not sure which failure you have? Open `../orca-serve-troubleshooting-matrix.md`
> and run the ≤5-command cheat sheet for the matching bucket first.

## 4. Test (without touching production)

A self-contained sandbox test verifies the installer end-to-end — syntax, dry-run,
sandbox install (all destinations under a temp dir), placeholder substitution,
idempotency, `logrotate -d`, and `systemd-analyze verify`:

```bash
bash test-logging-setup.sh
```

Exit 0 = all checks pass. Safe to run anywhere; it never writes outside a temp dir.
