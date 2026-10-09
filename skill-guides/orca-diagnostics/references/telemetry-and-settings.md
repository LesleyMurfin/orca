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

State is not always JSON. A profile whose `profile-state.db` exists is SQLite-authoritative, and
`orca-data.json` is then a stale export: edits to it are ignored and silently overwritten.
Establish which store is live before editing anything:

```bash
ORCA profile state exports --json   # names the active profile's data file and SQLite family
```

- SQLite-backed profile: do not hand-edit. Stop Orca and use
  `ORCA profile state rollback --backup <id>` / `--revision <n>`, which validates and archives
  before replacing state.
- JSON-backed profile: `orca-data.json` may be edited, but only while Orca is stopped — a running
  app rewrites the file from memory on shutdown. Project settings stay in `orca.yaml`.
- Validate JSON syntax before relaunching.

---

## 3. Corrupted Open Tabs / Ghost Tab Loop Recovery

If file tabs flicker or repeatedly reopen due to a deleted worktree or reconciliation conflict:

1. Quit Orca completely (Cmd+Q on macOS; on Linux the process is `orca-ide`, not `orca` — a bare
   `killall orca` hits the GNOME screen reader instead).
2. Confirm the profile is JSON-backed (section 2). On a SQLite profile, use
   `ORCA profile state rollback` instead of the steps below.
3. Open the platform-specific `orca-data.json`.
4. Under `"openFilesByWorktree"`, find the affected workspace/worktree ID and reset its list to empty:
   ```json
   "openFilesByWorktree": {
     "<affected-workspace-id>": []
   }
   ```
5. Reset `"activeFileIdByWorktree"` for that workspace.
6. Save, validate JSON formatting, and relaunch Orca.
