---
name: orca-server
description: >-
  Install, configure, run, supervise, and troubleshoot a headless Orca runtime started with
  `orca serve`: choosing a host mode, first-run setup and verification, the systemd unit that
  keeps it up, pairing clients to it, agent accounts and skills on the server, terminals that
  must outlive a service restart, and where to send someone for docs or community help. Use
  when the user says "$orca-server", "orca serve", "orca-ide serve", "headless Orca", "remote
  Orca server", "how do I set up an Orca server", "install Orca on my server", "Orca server
  won't start", "pairing URL", "orca-serve.service", or "restart the Orca server". Use
  `orca-cli` for ordinary worktree, terminal, and browser work once a runtime is already
  reachable.
---

# Orca Server

This discovery stub loads the version-matched guide from the Orca executable used for this session.
The guide covers installing Orca on a host, choosing a host mode, first-run verification,
systemd supervision, pairing, and the docs and community channels to point a stuck operator at.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-server
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
