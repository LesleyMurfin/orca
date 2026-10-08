# Reference: Internal Trace & NDJSON Log Inspection

## Trace File Locations

- **Linux / WSL**: `~/.config/Orca/logs/main.trace.ndjson`
- **macOS**: `~/Library/Logs/Orca/main.trace.ndjson`
- **Windows**: `%APPDATA%\Orca\logs\main.trace.ndjson`

## Useful Filter Pipelines

Find unhandled exceptions and IPC errors using `jq`:

```bash
# Extract error-level events
cat ~/.config/Orca/logs/main.trace.ndjson | jq 'select(.level == "error" or .level == "fatal")'

# Filter IPC channel rejections
cat ~/.config/Orca/logs/main.trace.ndjson | jq 'select(.type == "ipc" and .error != null)'
```
