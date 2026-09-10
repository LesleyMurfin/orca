# Orca Serve — Logging & Diagnostic Setup

Reproduce the headless `orca serve` logging and triage arrangement on any Linux/systemd
host in under 5 minutes. One script installs the systemd instance unit, provisions the
config layer and per-slot state tree, and wires log rotation + journal retention. It does
**not** download or start the serve — it arranges the *observability* surface only.

```bash
sudo bash templates/orca-serve/install-logging-setup.sh --dry-run   # audit first, change nothing
sudo bash templates/orca-serve/install-logging-setup.sh             # then install
```

## 1. What lives where

**`templates/orca-serve/`** — the reproducible sources:

| File | Purpose |
|------|---------|
| `install-logging-setup.sh` | One-command installer / auditor (this setup) |
| `orca-serve@.service.template` | systemd instance unit; `@PREFIX@` is substituted at install |
| `orca-serve.conf.template` | Host-wide config (shared, loaded first) |
| `orca-serve-instance.env.template` | Per-slot config (loaded second, overrides host) |
| `orca-client-diagnostics.md` | Client-side reachability/pairing runbook (Bucket 4) |

**`docs/guides/`** — the operational docs:

| File | Purpose |
|------|---------|
| `orca-serve-logging-guide.md` | Architecture, env vars, sinks, client log locations |
| `orca-serve-troubleshooting-matrix.md` | Symptom → bucket → ≤5-command triage (Buckets 1–4) |

## 2. Deploy in 5 steps

1. **Audit** — `sudo bash templates/orca-serve/install-logging-setup.sh --dry-run`. Fix any `FAIL` line.
2. **Install** — `sudo bash templates/orca-serve/install-logging-setup.sh` (uses `/data/opt/revive/orca_serve`).
   For `/opt/orca_serve`: `sudo INSTALL_PREFIX=/opt/orca_serve bash templates/orca-serve/install-logging-setup.sh`.
3. **Create the service account** (if the audit warned it was missing):
   `useradd -r -u 985 -g 1200 -s /usr/sbin/nologin svc_orca`.
4. **Reload + enable** — the installer runs `daemon-reload`; then
   `sudo systemctl enable --now orca-serve@factory.service`.
5. **Verify** — run the 5 commands below; then `sudo systemctl restart systemd-journald`
   to apply the journal retention drop-in.

Config knobs (env or flags): `INSTALL_PREFIX`, `SYSTEMD_DIR`, `DEFAULT_SLOT`,
`LOGROTATE_DIR`, `JOURNALD_DIR`. Flags: `--prefix`, `--systemd-dir`, `--slot`, `--dry-run`.

## 3. Five diagnostic commands

```bash
systemctl status orca-serve@factory.service --no-pager            # 137=OOM, 203=EXEC, active/…
journalctl -u orca-serve@factory.service -n 50 --no-pager         # serve's journal sink
tail -f /data/opt/revive/orca_serve/state/factory/logs/serve-fg.log   # tee file sink; SIGSEGV/SIGTRAP live here
ss -ltnp | grep -E ':(6768|6769|6770|6771)'                        # who actually LISTENs
orca-serve-diag --phase after && logrotate -d /etc/logrotate.d/orca-serve   # snapshot + rotation validity
```

> Not sure which failure you have? Open `docs/guides/orca-serve-troubleshooting-matrix.md`
> and run the ≤5-command cheat sheet for the matching bucket first.