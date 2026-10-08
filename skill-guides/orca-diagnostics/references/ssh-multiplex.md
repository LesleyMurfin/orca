# Reference: SSH Multiplex Socket Triage

## Diagnosing Zombie Multiplex Sockets

Orca manages multiplexed SSH connections through OpenSSH ControlMaster sockets located at:
- `$XDG_RUNTIME_DIR/orca-ssh/` or `$TMPDIR/orca-ssh-<uid>/`

## Safe Recovery Sequence

If an SSH worktree hangs indefinitely upon reconnection:

```bash
# 1. Check socket state
ssh -O check <ssh-host>

# 2. Gracefully exit dead master
ssh -O exit <ssh-host>

# 3. If socket is unresponsive, remove stale socket file
rm -f /tmp/orca-ssh-*/<host-digest>*
```
