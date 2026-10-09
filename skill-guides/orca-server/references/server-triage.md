# Reference: Headless Server Triage & Root-Cause Classification

When a headless `orca serve` runtime goes down, refuses connections, or crashes, do not restart blindly. Run this 5-command diagnostic sequence to isolate the failure to one of 4 root-cause buckets.

---

## 1. Non-Destructive 5-Command Triage Sequence

Run these commands on the server host:

```bash
# 1. Check unit exit code and cgroup status (active vs status=137 OOM vs 203 EXEC)
systemctl status orca-serve.service --no-pager -l

# 2. Check journal for crash signatures, unhandled rejections, or port collisions
journalctl -u orca-serve.service -n 50 --no-pager

# 3. Check who LISTENs and detect port pre-emption (e.g. 6768 vs mobile fallback port)
ss -ltnp | grep -E ':(6768|6769|6770|6771|45175)'

# 4. Check lingering and user systemd runtime directory
loginctl show-user orca -p Linger
ls -ld /run/user/$(id -u orca) 2>/dev/null

# 5. Check client reachable network interfaces
ip -brief addr show
```

---

## 2. The 4 Root-Cause Classification Buckets

Map the triage output directly to the correct bucket and apply the targeted fix:

| Evidence / Exit Code | Root-Cause Bucket | Cause & Verification | Targeted Fix |
| :--- | :--- | :--- | :--- |
| `status=137` (OOM/SIGKILL), `ENOSPC`, CPU stall | **Bucket 1: Server Resource** | Server ran out of memory or disk space during build. | Raise systemd `MemoryMax=` / `LimitNOFILE=` or clear disk cache. |
| `status=203` (EXEC), port 6768 collision, bind error | **Bucket 2: Server Config** | Bad `ExecStart` path (must be absolute path to `orca-ide`), or port already held. | Resolve the real path with `readlink -f "$(command -v orca-ide)"` as the service user and write that in `ExecStart=` (deb/rpm `/usr/bin/orca-ide`, AppImage `~/.local/bin/orca-ide`); kill rogue listener on 6768. |
| `SIGSEGV`, `SIGTRAP`, unhandled rejection in journal | **Bucket 3: Orca Bug** | Electron / headless runtime crash or missing graphics library. | Verify software GL: `LIBGL_ALWAYS_SOFTWARE=1` in unit Environment; report trace upstream. |
| Connection refused, pairing timeout, bad endpoint | **Bucket 4: Client Reachability** | Advertised `127.0.0.1` or client cannot reach host over private route. | Specify `--pairing-address <tailscale-or-lan-ip>`; check client firewall. |

---

## 3. Recovery Protocol

- **Never edit internal runtime files while `serve` is running**: Phantom PID files in the state directory will clear automatically on startup.
- **Port pre-emption**: If port 6768 is busy, Orca may bind a dynamic ephemeral port. Pin `--port 6768` explicitly in your unit `ExecStart`.
- **Zero-Downtime Upgrades**: Package upgrades (`.deb` / `.rpm`) can replace the binary while running. Restart the service during a quiet window; client sessions will reconnect automatically.
