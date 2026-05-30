export type TerminalFileUrlTarget = {
  filePath: string
  line: number | null
  column: number | null
}

function parseFileUrlLineHash(hash: string): { line: number; column: number | null } | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return {
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : null
  }
}

function parseFilePathTrailingLineTarget(filePath: string): TerminalFileUrlTarget | null {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(filePath)
  if (!match || !match[1] || match[1].endsWith('/') || match[1].endsWith('\\')) {
    return null
  }
  return {
    filePath: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  }
}

export function resolveTerminalFileUrlTarget(parsed: URL): TerminalFileUrlTarget | null {
  const decodedPathname = decodeURIComponent(parsed.pathname)
  let filePath: string
  if (parsed.hostname && parsed.hostname !== 'localhost') {
    // Why: file://server/share/path is the URL form of a Windows UNC path.
    filePath = `//${parsed.hostname}${decodedPathname}`
  } else if (/^\/[A-Za-z]:/.test(decodedPathname)) {
    // Why: on Windows, file:///C:/foo yields pathname "/C:/foo". The leading
    // slash must be stripped to produce a valid Windows path ("C:/foo").
    filePath = decodedPathname.slice(1)
  } else {
    filePath = decodedPathname
  }

  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    return { filePath, line: hashTarget.line, column: hashTarget.column }
  }

  return parseFilePathTrailingLineTarget(filePath) ?? { filePath, line: null, column: null }
}
