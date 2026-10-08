# Reference: Chrome DevTools Protocol (CDP) Remote Debugging

## Connecting to Orca via CDP

When the Electron UI is wedged, unresponsive, or experiencing white-screen renderer crashes, connect directly via Chrome DevTools Protocol without stealing focus or opening test windows.

### 1. Launch with Remote Debugging Port

Restart Orca with the debugging port exposed. Use the executable you resolved in the stub —
on Linux it is `orca-ide`, because `/usr/bin/orca` is the GNOME Orca screen reader:

```bash
ORCA --remote-debugging-port=9222
```

The port is only open on a process started this way; a running instance cannot be attached to
retroactively, so collect the trace file first — the restart destroys the wedged state.

### 2. Inspect Target Endpoints

Fetch active browser targets, webview tabs, and renderer frames via the local HTTP endpoint:

```bash
# List all inspectable target pages and webviews
curl -s http://127.0.0.1:9222/json | jq '.[] | {id: .id, title: .title, type: .type, webSocketDebuggerUrl: .webSocketDebuggerUrl}'

# Query version and browser endpoint metadata
curl -s http://127.0.0.1:9222/json/version
```

### 3. Evaluating Renderer State Non-Destructively

Use websocat or a headless Node/Playwright CDP connection to evaluate JavaScript and capture runtime console errors directly from the wedged renderer:

```bash
# Connect to the target's webSocketDebuggerUrl and inspect runtime logs
websocat "ws://127.0.0.1:9222/devtools/page/<target-id>"
```

Send the CDP command to enable console and runtime event capture:
```json
{"id": 1, "method": "Runtime.enable"}
{"id": 2, "method": "Console.enable"}
```

To take a non-destructive screenshot of a frozen background window:
```json
{"id": 3, "method": "Page.captureScreenshot", "params": {"format": "png"}}
```
