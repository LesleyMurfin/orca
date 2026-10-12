# orca-serve systemd KillMode=mixed oracle

Proves the unit emitted by `orca serve --generate-service`:

1. loads under a real `systemctl` in a privileged systemd container, and
2. honors `KillMode=mixed` across a `systemctl restart` cycle — the main process
   receives `SIGTERM`, the in-cgroup child does not, and a `control-group`
   contrast unit does TERM the child.

```bash
ORCA_BACKGROUND_LAUNCH=1 node config/scripts/run-orca-serve-systemd-docker.mjs
```

`ORCA_DOCKER` and `ORCA_DOCKER_PLATFORM` override the executable and architecture.
The runner removes its container and image afterward.
