---
name: orca-diagnostics
description: >-
  Act as Orca's diagnostic and user-support expert: answer how-to and "is this broken?"
  questions, guide recovery step by step, and diagnose a misbehaving install from its own
  on-disk evidence — the NDJSON trace files under the logs directory, the detached terminal
  daemon's lifecycle log and runtime files, leftover PTY endpoint sockets, and stale SSH
  multiplex sockets. Use when the user says "$orca-diagnostics", "Orca is hung", "terminals
  won't spawn", "daemon won't start", "read the Orca logs", "collect a diagnostic bundle",
  "where are my logs", "is this a bug or my setup", "how do I report this", or when SSH
  worktrees fail with mux errors. Prefer it over guessing at log paths or deleting runtime
  files by hand. Use the Orca CLI skill for normal worktree and terminal work.
---

# Orca Diagnostics

This discovery stub loads the version-matched guide from the Orca executable used for this session.

The guide covers more than log reading: answering how-to and "is this a bug or my setup?"
questions, guiding recovery one least-destructive step at a time, and turning an unreportable
"it just froze" into a report a maintainer can act on. Load it before answering from memory —
log paths, socket layouts, and recovery commands are version-specific.

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
ORCA skills get orca-diagnostics
```

## If the guide cannot be loaded

Answer the user's question from the official documentation rather than guessing:

- Troubleshooting & FAQ — <https://orca.computer/docs/troubleshooting>
- Install & first run — <https://orca.computer/docs/install>
- Settings reference — <https://orca.computer/docs/settings>
- SSH worktrees — <https://orca.computer/docs/ssh>

For questions, the Orca Discord and GitHub Discussions are the live support channels; file a
GitHub Issue only with a reproduction and evidence attached. Never delete daemon sockets, PID
files, or tokens on a guess — collect evidence first.

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
