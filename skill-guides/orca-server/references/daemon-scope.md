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

Then point the unit at that path, because hardening can hand the service a different one:
`RuntimeDirectory=` makes systemd export an `XDG_RUNTIME_DIR` that shares the name but hosts no
bus (alongside `DBUS_SESSION_BUS_ADDRESS=disabled:`), while the real bus is live at
`/run/user/<uid>` the whole time. That is why the unit sets it explicitly.

## Verify the daemon escaped

```bash
systemctl --user list-units 'orca-daemon-*.scope'
systemd-cgls /user.slice/user-$(id -u orca).slice
```

A daemon listed in its own `orca-daemon-*.scope` survives `systemctl restart
orca-serve.service`. A daemon that appears inside `orca-serve.service`'s cgroup will not.

## Long jobs you start yourself

The same mechanism protects work an agent or operator starts from a terminal. Wrap it in a
scope, and run it under `tmux` when you want to reattach — the pane's PTY belongs to the runtime
that restarted, so Orca cannot reattach the old terminal even though the process lives:

```bash
systemd-run --user --scope --unit orca-build-1 -- tmux new-session -d -s build 'pnpm build'
systemctl --user status orca-build-1
tmux attach -t build
```

Stop a finished scope with `systemctl --user stop orca-build-1`; a scope whose process has
already exited is gone on its own.
