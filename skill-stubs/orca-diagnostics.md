# Orca Diagnostics

This discovery stub loads the version-matched guide from the Orca executable used for this session.

The guide covers more than log reading: answering how-to and "is this a bug or my setup?"
questions, guiding recovery one least-destructive step at a time, and turning an unreportable
"it just froze" into a report a maintainer can act on. Load it before answering from memory —
log paths, socket layouts, and recovery commands are version-specific.

<!-- shared: resolver -->

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-diagnostics
```

## If the guide cannot be loaded

Answer the user's question from the official documentation rather than guessing:

- Troubleshooting & FAQ — <https://www.onorca.dev/docs/troubleshooting>
- Install & first run — <https://www.onorca.dev/docs/install>
- Settings reference — <https://www.onorca.dev/docs/settings>
- SSH worktrees — <https://www.onorca.dev/docs/ssh>

For questions, the Orca Discord and GitHub Discussions are the live support channels; file a
GitHub Issue only with a reproduction and evidence attached. Never delete daemon sockets, PID
files, or tokens on a guess — collect evidence first.

<!-- shared: no-guessing -->
