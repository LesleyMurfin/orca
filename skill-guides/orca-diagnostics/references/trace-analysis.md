# Reference: Internal Trace & NDJSON Log Inspection

## Trace File Locations

- **Linux / WSL**: `~/.config/Orca/logs/main.trace.ndjson`
- **macOS**: `~/Library/Application Support/Orca/logs/main.trace.ndjson` (not `~/Library/Logs`;
  Orca writes under `userData`, never Electron's `logs` path)
- **Windows**: `%APPDATA%\Orca\logs\main.trace.ndjson`

A headless `orcad` host writes `orcad.trace.ndjson` under `<data-root>/logs/` instead.

## Record shape

Every line is one span envelope:
`{"type":"effect-span","name","traceId","spanId","kind","startTimeUnixNano","endTimeUnixNano","durationMs","attributes","events","exit":{"_tag","cause"}}`.
There is no `level`, `status`, `error`, or ISO `timestamp` field — filters on those match nothing.

## Useful Filter Pipelines

```bash
# Failures, with the redacted stack in .exit.cause
jq -c 'select(.exit._tag == "Failure")' ~/.config/Orca/logs/main.trace.ndjson

# Narrow to one subsystem by span name, e.g. IPC
jq -c 'select(.name | startswith("ipc.")) | select(.exit._tag != "Success")' \
  ~/.config/Orca/logs/main.trace.ndjson
```
