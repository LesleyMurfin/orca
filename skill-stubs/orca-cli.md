# Orca CLI

This discovery stub loads the version-matched guide from the Orca executable used for this session.

These commands start a separate CLI agent process in a worktree; use them only when the
user asked for one — a handoff, another worktree, a named agent, or supervision to report
on. For plain concurrent work, use your own harness's subagents instead, and pass `--agent`
only with the id the user named (there is no default).

<!-- shared: resolver -->

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-cli
```

<!-- shared: no-guessing -->
