# Keeping terminals alive across a service restart

Load this when terminals die on `systemctl restart`, when a host must survive an Orca update
with live PTYs, or when deciding whether a long job is safe to start from an Orca terminal.

## What dies, and why

A detached PTY daemon gets its own process group, not its own cgroup. Under
`orca-serve.service` the daemon and every PTY it owns stay in the unit's cgroup, and
`systemctl stop` or `restart` kills whatever is still there: immediately under
`KillMode=control-group`, and the moment the main process exits under `KillMode=mixed`
(`TimeoutStopSec` only runs while that main process is alive). Either way the terminals go with
the unit.

## What Orca already does

On Linux, Orca launches the PTY daemon through a transient systemd scope instead of forking it
directly:

```text
systemd-run --user --scope --unit=orca-daemon-<nonce>.scope --property=TimeoutStopSec=5s --collect -- <daemon command>
```

The scope is registered with the **user's** systemd manager, so the daemon's cgroup is a sibling
of the service's, out of reach of any unit-scoped kill. `--collect` drops the scope once the
daemon exits, so nothing accumulates.

Orca only takes that path when it can prove all of it works, and falls back to a direct fork
otherwise:

- the platform is Linux;
- the host is booted under systemd (`/run/systemd/system` exists — a plain container is not);
- a user bus is reachable, at `/run/user/<uid>` first and the process's own `XDG_RUNTIME_DIR`
  only as a fallback;
- the user manager outlives the caller: `Linger=yes` for the service account, or a caller already
  running inside `user@<uid>.service`. A bus alone is not enough — without linger the manager (and
  every scope in it) stops when the last login session closes. When this gate fails Orca logs
  `daemon-scope-unavailable: linger off`; grep the journal for that string;
- `systemd-run --version` runs and exits 0 within a couple of seconds.

A fallback launch is not an error, but on a service-managed host it means terminals die on
restart. Make the prerequisites true rather than working around the symptom.

## Prerequisite: lingering

A service account has no login session, so its user manager and `/run/user/<uid>` are not
provisioned until you ask for them:

```bash
sudo loginctl enable-linger orca
loginctl show-user orca -p Linger
```

`RuntimeDirectory=` hardening makes systemd export an `XDG_RUNTIME_DIR` that shares the name but
hosts no bus (alongside `DBUS_SESSION_BUS_ADDRESS=disabled:`), while the real bus is live at
`/run/user/<uid>` the whole time. Orca is not fooled by that — it derives the bus path from
`getuid()` first and sets it explicitly on the `systemd-run` call — so the unit's
`Environment=XDG_RUNTIME_DIR=` exists for other tooling, not for the scope.

## Verify the daemon escaped

```bash
systemctl --user list-units 'orca-daemon-*.scope' 'app-orca-*.scope'
systemd-cgls /user.slice/user-$(id -u orca).slice
```

A daemon listed in its own `orca-daemon-*.scope` survives `systemctl restart
orca-serve.service`. A daemon that appears inside `orca-serve.service`'s cgroup will not. An older
daemon may still sit in a legacy `app-orca-*.scope`; Orca migrates it into an `orca-daemon-*`
scope on the next launch, and either name is outside the service cgroup.

## Long jobs you start yourself

The daemon owns the PTY, so work started from an Orca terminal already survives a restart of the
service: the new runtime adopts the surviving daemon and the pane comes back. Give a job its own
unit only when it must also survive the daemon being replaced — an Orca update, or a host where
the scope probe fails closed:

```bash
# A transient service, not a scope: nothing depends on the invoking shell surviving.
systemd-run --user --unit=orca-build-1 --collect --same-dir --property=TimeoutStopSec=5s -- pnpm build
journalctl --user -u orca-build-1 -f
```

To reattach a shell rather than read logs, give tmux its own server, so the request cannot be
answered by a tmux server already running in another cgroup:

```bash
systemd-run --user --scope --unit=orca-build-1 -- tmux -L orca-build-1 new-session -d -s build 'pnpm build'
tmux -L orca-build-1 attach -t build
```

Stop a finished unit with `systemctl --user stop orca-build-1`; one whose process has already
exited is gone on its own.
