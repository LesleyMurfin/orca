# templates/ — reproducible `orca serve` logging & diagnostics pack

Templates + installer to reproduce the `orca serve` logging/triage arrangement on any
Linux/systemd host in under 5 minutes. It arranges the **observability surface only** —
systemd instance unit, config layer, log rotation, journal retention — it does **not**
download or start the serve.

## What's here

- `install-logging-setup.sh` — one-command installer/auditor (`--dry-run` first);
  provisions the unit, config seeds, per-instance state tree, logrotate + journald drop-ins.
- `orca-serve@.service.template` — systemd instance unit; `@PREFIX@`/`@PORT@`/
  `@PAIRING_ADDRESS@` substituted at install.
- `orca-serve.conf.template` — host-wide config, loaded first.
- `orca-serve-instance.env.template` — per-instance config, loaded second (overrides host).
- `orca-client-diagnostics.md` — client-side reachability/pairing runbook (Bucket 4).
- `README.md` — the pack's own map: 5-step deploy + the 5 diagnostic commands.

## Where the real docs live

- [`../orca-serve-logging-guide.md`](../orca-serve-logging-guide.md) — architecture, env vars,
  sinks, client log locations.
- [`../orca-serve-troubleshooting-matrix.md`](../orca-serve-troubleshooting-matrix.md) —
  symptom → bucket → ≤5-command triage.
- Headless deployment guide:
  [`../../headless-linux-server.md`](../../headless-linux-server.md).
- Repo model: [`../../../README.md`](../../../README.md).

## Conventions specific to this folder

1. This is the **template** source. The rendered unit/config is produced by the installer at
   install time; edits here touch nothing live.
2. Nothing here is installed/deployed by an agent — deploy is a manual
   `sudo bash install-logging-setup.sh` (run `--dry-run` first).
3. `@PREFIX@`, `@PORT@`, and `@PAIRING_ADDRESS@` are placeholders substituted at install
   time — never hardcode a prefix, port, or pairing address into a template.

## Ask

- `README.md` (this folder) for the deploy steps and diagnostic commands.
- [`../orca-serve-troubleshooting-matrix.md`](../orca-serve-troubleshooting-matrix.md) when a
  symptom appears.
- [`../../headless-linux-server.md`](../../headless-linux-server.md) for the deployment
  prerequisites and foreground-run contract.
