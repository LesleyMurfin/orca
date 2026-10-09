# Reference: Worktree, Browser, & Mobile Diagnostic Triage

Use this reference when users or agents hit operational issues with Orca's embedded browser, worktree git states, or mobile pairing synchronization.

---

## 1. Embedded Browser Issues

### Common Symptoms
- Browser tab white-screens, fails to load `localhost`, or reports cookie connection errors (e.g. Issue #26184).
- External markdown links fail to open in system browser.

### Diagnostic & Triage Steps
1. **Differentiate Embedded vs External Browser**:
   - Orca includes an embedded Chromium webview pane for instant local preview.
   - For native external browser automation (Chrome, Edge, Safari), route to the `computer-use` skill.
   - For webview navigation and screenshot capture within Orca, route to `orca-cli` (`orca file open --browser <url>`).
2. **Localhost & Port Forwarding**:
   - If a dev server runs in an SSH worktree or remote server, `localhost` refers to the remote host. Verify the bound interface:
     ```bash
     ss -ltnp | grep :<port>
     ```
   - If bound to `127.0.0.1` on a remote host, it is not reachable from the client without SSH port forwarding (`-L <local_port>:127.0.0.1:<remote_port>`).
3. **Inspect Browser Console via CDP**:
   If the embedded webview is stuck, query the renderer target over CDP port 9222:
   ```bash
   curl -s http://127.0.0.1:9222/json | jq '.[] | select(.type=="page" or .type=="webview")'
   ```

---

## 2. Git & Worktree Desync Issues

### Common Symptoms
- `orca worktree rm` refuses to remove a worktree after daemon restart: *"PTYs stay registered on dead daemon socket"* (Issue #26090).
- Worktree diff view desyncs after external `git rebase` or `git reset`.
- Git lockfile contention (`index.lock`).

### Diagnostic & Triage Steps
1. **Dead Daemon Socket Cleanup**:
   When terminal daemons die unexpectedly, unregister stale PTY sockets before deleting worktrees:
   - Check registered terminals: `orca terminal list`
   - Force close dead sessions: `orca terminal close --tab <tabId>`
2. **Stale Git Index Locks**:
   If background agents crash mid-commit, inspect and clear orphan locks:
   ```bash
   ls -la <worktree-path>/.git/index.lock 2>/dev/null
   ```
   *(Confirm no `git` process is running with `pgrep -fl git` before removing).*
3. **Refresh Worktree Cache**:
   In the Orca diff toolbar, click the **Refresh** icon or trigger an explicit refresh via `orca file diff --refresh`.

---

## 3. Mobile Pairing & Synchronization Issues

### Common Symptoms
- Mobile client cannot reach `localhost` services running on Desktop (Issue #25962).
- Terminal output desyncs or duplicates between Desktop and Mobile app.
- Pairing QR code fails to connect over cellular or restricted Wi-Fi.

### Diagnostic & Triage Steps
1. **Network Path Requirement**:
   - Mobile pairing requires both devices to be on the **same LAN** or connected via a shared **Tailscale tailnet**.
   - Direct cellular connections cannot reach private RFC1918 addresses without a VPN/mesh.
2. **Verify Advertised Pairing Endpoint**:
   - Check which address was advertised when the server started:
     ```bash
     journalctl --user -u orca-serve.service -n 50 | grep -E "advertisedEndpoint|pairing"
     ```
   - Never advertise `127.0.0.1` to a mobile device. Always specify `--pairing-address <tailscale-ip-or-lan-ip>`.
3. **Re-Pairing Protocol**:
   If mobile sessions desync, generate a fresh mobile-scoped pairing offer:
   ```bash
   orca-ide serve --mobile-pairing --pairing-address <tailscale-ip>
   ```
