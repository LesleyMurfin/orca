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
TimeoutStopSec=45
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Replace `1001` with `id -u orca`. Resolve the absolute path with
`readlink -f "$(command -v orca-ide)"` as the service user and write that in `ExecStart=`: the
deb/rpm symlink is `/usr/bin/orca-ide`, an AppImage registers `~/.local/bin/orca-ide`, and a bare
`orca` on Linux is the GNOME Orca screen reader.

## Directives that carry weight

- `Type=simple` — `serve` stays in the foreground, never forks, and writes no PID file, so the
  process systemd starts is the main process. The unit is active as soon as it spawns; the bound
  endpoint, advertised endpoint, and pairing URL arrive afterwards, in the journal.
- `RestartPreventExitStatus=3 78` — two statuses a restart cannot repair. `78`
  (`ORCAD_EXIT_CONFIGURATION`): a data root held by another orcad, a malformed `--bind` address,
  an unusable bundled runtime, or an unreadable profile store. `3`: another process already owns
  this userData profile — a desktop app, or a `serve` still running. A port conflict is neither;
  see "Reading a failure".
- `KillMode=mixed` — `SIGTERM` reaches only the main process. `serve`'s graceful stop deliberately
  leaves the terminal daemon running so a restarted runtime can adopt the PTYs;
  `KillMode=control-group` would signal the daemon and every agent at once and lose that work. The
  final `SIGKILL` still sweeps whatever remains in the cgroup, which is why the daemon has to live
  in its own scope.
- `TimeoutStopSec` — use `45`, not `120`. The runtime caps its own stop: bounded daemon retirement
  (2 × 5s) then a 15s shutdown deadline, after which it logs `shutdown after SIGTERM exceeded
  15000ms — exiting` and exits `1`. Anything past ~30s is the cgroup sweep after the main process
  is gone, not the runtime finishing work.
- `StartLimitIntervalSec` / `StartLimitBurst` — a backstop for failure modes no exit status
  classifies: five starts in five minutes and the unit stays down instead of thrashing.
- `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` — optional, and not what places the daemon in its
  scope: Orca derives the bus path from `getuid()` and only falls back to this variable, then sets
  it explicitly on the `systemd-run` call. Keep it for other tooling that reads it (SSH control
  sockets, agent CLIs); if you set it, it must be the real per-UID path from `id -u orca`.

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
own Xvfb on display `:99` when none is present. Installed from the deb or rpm, Xvfb is already a
package dependency; on an AppImage host install it yourself:

```bash
sudo apt-get install -y xvfb          # Debian/Ubuntu
sudo dnf install -y xorg-x11-server-Xvfb  # RPM-based
```

Orca disables hardware acceleration and GPU use for this path itself; no `LIBGL_*` or
`--disable-gpu` wiring belongs in the unit. If the host already exports a working `DISPLAY`, Orca
uses it instead of starting Xvfb — but a `DISPLAY` that is not verifiably live is refused and no
Xvfb is started (`DISPLAY=… is not verifiably live`). Do not set `Environment=DISPLAY=` in the
unit; leave it unset so Orca owns `:99`.

## Reading a failure

1. `systemctl is-active orca-serve.service` and `systemctl show -p ExecMainStatus
   orca-serve.service` — the exit status says which class of failure happened. `78` is a
   configuration fault: fix the data root, the `--bind` value, the bundled runtime, or the profile
   store. `3` means another process already owns the profile — stop the desktop app or the other
   `serve`. A busy port is **not** 78: it exits `1`, which `Restart=on-failure` retries forever, so
   a journal line with `EADDRINUSE` means change `--port` or stop the other listener.
2. `journalctl -u orca-serve.service -n 100 --no-pager` — the runtime prints the reason on the
   way out.
3. A unit that is `active` while clients cannot connect is an address problem, not a supervision
   problem: compare the bound endpoint and the advertised endpoint in the startup lines and fix
   `--pairing-address`.
