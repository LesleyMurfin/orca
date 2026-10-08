# Reference: Telemetry Map & Offline Settings Recovery

## 1. Cross-Platform Telemetry Map

| Platform | Log Directory | State & Settings (`orca-data.json`) | Sleep/Wake Diagnostics |
| :--- | :--- | :--- | :--- |
| **macOS** | `~/Library/Application Support/Orca/logs/` | `~/Library/Application Support/Orca/orca-data.json` | `pmset -g log \| tail -n 50 \| grep -E "Sleep\|Wake"` |
| **Linux** | `~/.config/Orca/logs/` | `~/.config/Orca/orca-data.json` | `journalctl -u systemd-suspend` |
| **Windows**| `%APPDATA%\Orca\logs\` | `%APPDATA%\Orca\orca-data.json` | `powercfg /lastwake` |

Sockets:
- SSH multiplex sockets: `/tmp/orca-ssh-<UID>/` or `$XDG_RUNTIME_DIR/orca-ssh/`
- Terminal daemon sockets: `<userData>/daemon/daemon-v<N>.sock` (or named pipe on Windows)

---

## 2. Offline Disk Editing Rules

When Orca is closed, global settings can be edited at `orca-data.json` and project settings at `orca.yaml`:
- **Never edit `orca-data.json` while Orca is running**: Orca will overwrite file changes on shutdown.
- Validate JSON syntax before restarting the application.

---

## 3. Corrupted Open Tabs / Ghost Tab Loop Recovery

If file tabs flicker or repeatedly reopen due to a deleted worktree or reconciliation conflict:

1. Quit Orca completely (`killall orca` or Cmd+Q).
2. Open the platform-specific `orca-data.json`.
3. Under `"openFilesByWorktree"`, find the affected workspace/worktree ID and reset its list to empty:
   ```json
   "openFilesByWorktree": {
     "<affected-workspace-id>": []
   }
   ```
4. Reset `"activeFileIdByWorktree"` for that workspace.
5. Save, validate JSON formatting, and relaunch Orca.
