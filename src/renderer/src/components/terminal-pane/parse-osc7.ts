// OSC 7 — "report current working directory". Shells (bash/zsh, plus the
// typical PROMPT_COMMAND / precmd one-liner) emit
//
//     \x1b]7;file://<host>/<percent-encoded-path>\x07   (or ST terminator)
//
// on every prompt so terminal emulators can track the live cwd. xterm's
// parser strips the leading `\x1b]7;` and trailing BEL/ST before handing us
// the payload, so `data` here is just the `file://...` URI.

const OSC7_URI = /^file:\/\/([^/]*)(\/.*)$/

type ParseOsc7Options = {
  preserveHostAsUnc?: boolean
}

/**
 * Parse an OSC 7 payload and return the decoded path, or null if the payload
 * is not a file URI we recognize. Returns the path a `cwd` option of
 * `child_process.spawn` / `node-pty` would accept on the current platform.
 */
export function parseOsc7(data: string, options: ParseOsc7Options = {}): string | null {
  const match = OSC7_URI.exec(data)
  if (!match) {
    return null
  }
  const host = match[1]
  let path: string
  try {
    path = decodeURIComponent(match[2])
  } catch {
    return null
  }
  if (!path) {
    return null
  }
  if (options.preserveHostAsUnc) {
    // Why: Windows UNC OSC-7 payloads use the URI host as the server name.
    if (host && host.toLowerCase() !== 'localhost') {
      return `\\\\${host}${path.replace(/\//g, '\\')}`
    }
  }
  // Why: on Windows the URI looks like file:///C:/Users/... — the path is
  // `/C:/Users/...`, which `spawn`'s cwd option does not accept. Strip the
  // leading slash before the drive letter so we hand back `C:/Users/...`.
  // Renderer runs with sandbox + contextIsolation so process.platform is
  // unavailable; detect Windows paths by shape instead.
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1)
  }
  return path
}
