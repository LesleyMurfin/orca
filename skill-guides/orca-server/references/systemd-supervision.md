# Supervising `orca serve` with systemd

Load this before writing, repairing, or diagnosing the unit that keeps a headless Orca runtime
up. The guide's kernel states the three load-bearing directives; this document is the whole unit
plus what each line protects against.

## Unit template

Install as `/etc/systemd/system/orca-serve.service`:

```ini
[Unit]
Description=Orca runtime server
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=orca
Group=orca
WorkingDirectory=/home/orca
Environment=HOME=/home/orca
Environment=XDG_RUNTIME_DIR=/run/user/1001
ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address <server-tailscale-ip-or-hostname>
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 78
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=120
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Replace `1001` with `id -u orca`. Write the absolute `/usr/bin/orca-ide`: a bare `orca` on Linux
is the GNOME Orca screen reader.

## Directives that carry weight

- `Type=simple` — `serve` stays in the foreground, never forks, and writes no PID file, so the
  process systemd starts is the main process. The unit is active as soon as it spawns; the bound
  endpoint, advertised endpoint, and pairing URL arrive afterwards, in the journal.
- `RestartPreventExitStatus=3 78` — `78` is the runtime's configuration-fault status
  (`ORCAD_EXIT_CONFIGURATION`): a data root held by another runtime, a bind address it cannot
  use, an unusable bundled runtime, or an unreadable profile store. None of those are repaired by
  starting again, so a plain `Restart=on-failure` would crash-loop on them. `3` is reserved for
  the unit's own `ExecStartPre=` preflight to report the same "do not retry".
- `KillMode=mixed` — `SIGTERM` reaches only the main process, so the runtime shuts its own
  children down in order; the final `SIGKILL` still sweeps the cgroup. `KillMode=control-group`
  would `SIGTERM` every agent at once.
- `TimeoutStopSec=120` — the window the main process gets before that `SIGKILL`. It applies only
  while the main process is alive; anything left in the cgroup after it exits is killed at once.
- `StartLimitIntervalSec` / `StartLimitBurst` — a backstop for failure modes no exit status
  classifies: five starts in five minutes and the unit stays down instead of thrashing.
- `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` — the per-UID path that hosts the user's systemd
  bus. The terminal daemon needs it to place itself in a scope; see
  `references/daemon-scope.md`.

## Install and watch

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orca-serve.service
systemctl status orca-serve.service
journalctl -u orca-serve.service -f
```

The pairing URL is printed once at startup. Read it back out of the journal rather than
restarting the service to see it again.

## Linux prerequisite: a display for browser panes

Headless `serve` backs browser panes with offscreen Electron windows, and on Linux those need an
X display — Electron has no headless display platform and crashes without one. Orca starts its
own Xvfb on display `:99` when none is present, so the host needs the package installed:

```bash
sudo apt-get install -y xvfb          # Debian/Ubuntu
sudo dnf install -y xorg-x11-server-Xvfb  # RPM-based
```

Orca disables hardware acceleration and GPU use for this path itself; no `LIBGL_*` or
`--disable-gpu` wiring belongs in the unit. If the host already exports a working `DISPLAY`,
Orca uses it instead of starting Xvfb.

## Reading a failure

1. `systemctl is-active orca-serve.service` and `systemctl show -p ExecMainStatus
   orca-serve.service` — the exit status says which class of failure happened. `78` means a
   configuration fault; fix the data root, port, or profile before touching the unit.
2. `journalctl -u orca-serve.service -n 100 --no-pager` — the runtime prints the reason on the
   way out.
3. A unit that is `active` while clients cannot connect is an address problem, not a supervision
   problem: compare the bound endpoint and the advertised endpoint in the startup lines and fix
   `--pairing-address`.
