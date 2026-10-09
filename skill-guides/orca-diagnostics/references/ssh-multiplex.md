# Reference: SSH Multiplex Socket Triage

## Diagnosing Zombie Multiplex Sockets

Orca manages multiplexed SSH connections through OpenSSH ControlMaster sockets located at:
- `$XDG_RUNTIME_DIR/orca-ssh/` when `XDG_RUNTIME_DIR` is set (usually `/run/user/<uid>/orca-ssh/`),
  else `$TMPDIR/orca-ssh-<uid>/` — on macOS `$TMPDIR` is a per-user `/var/folders/...` path, not `/tmp`.

Orca never multiplexes on Windows (the control path resolves to null there), so this page does not
apply on that platform.

The directory must be a real directory owned by you with no group or other permission bits
(`mode & 0o77 == 0`). If it is not, Orca silently stops multiplexing and no socket is ever created —
the symptom is a slow repeated handshake, not a hang. Check with `stat -c '%U %a' "$SOCKDIR"`
(expect your user and `700`).

Orca also self-heals: on any non-definitive connect or probe failure it removes the socket and
retries once with multiplexing disabled. A hang that survives that retry is usually the network
path, not the socket.

## Safe Recovery Sequence

If an SSH worktree hangs indefinitely upon reconnection:

```bash
# 0. Resolve Orca's private socket directory. Orca passes ControlPath only on the command line,
#    never into ~/.ssh/config, and names each socket with a 16-hex digest of the target plus its
#    resolved `ssh -G` config — so `ssh -O` without `-S` talks to the wrong master, or none.
SOCKDIR="${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/orca-ssh}"
[ -d "$SOCKDIR" ] || SOCKDIR="${TMPDIR:-/tmp}/orca-ssh-$(id -u)"
ls -l "$SOCKDIR"            # names are 16 hex chars, not hostnames

# 1. Check socket state (-S is mandatory)
ssh -O check -S "$SOCKDIR/<16-hex-name>" <ssh-host>

# 2. Gracefully exit that master — this stops the process, not just the socket file
ssh -O exit -S "$SOCKDIR/<16-hex-name>" <ssh-host>

# 3. Only if the master is already gone, drop the leftover socket file. Orca does this itself on
#    the next connect attempt, so this is rarely needed. Never glob /tmp blindly: the trailing
#    wildcard also matches OpenSSH's setup temporaries for LIVE masters.
ss -xlp 2>/dev/null | grep "$SOCKDIR"   # confirm no process still owns it
rm -f "$SOCKDIR/<16-hex-name>"
```
