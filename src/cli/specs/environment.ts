import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Orca runtime environment from a pairing code',
    usage: 'orca environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca environment add --name work-laptop --pairing-code orca://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Orca runtime environments',
    usage: 'orca environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Orca runtime environment',
    usage: 'orca environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    summary: 'Remove one saved Orca runtime environment',
    usage: 'orca environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'config', 'list'],
    summary: "List a remote Orca runtime's portable settings",
    usage: 'orca environment config list --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca environment config list --environment work-laptop']
  },
  {
    path: ['environment', 'config', 'get'],
    summary: "Read one portable setting from a remote Orca runtime",
    usage: 'orca environment config get <key> --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca environment config get terminalCursorStyle --environment work-laptop']
  },
  {
    path: ['environment', 'config', 'set'],
    summary: "Write one portable setting on a remote Orca runtime",
    usage: 'orca environment config set <key> <value> --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key', 'value'],
    positionalArgs: ['key', 'value'],
    notes: [
      'Only portable runtime-behavior keys are accepted; the server rejects host-binding, command, proxy, and credential keys.',
      'Numeric and boolean values are JSON-coerced (e.g. 14, true); anything else is sent as a string.'
    ],
    examples: [
      'orca environment config set terminalCursorStyle block --environment work-laptop',
      'orca environment config set terminalFontSize 14 --environment work-laptop'
    ]
  }
  // Follow-up (deferred from this first cut): `config pull <file>` / `config push <file>`
  // for bulk export/apply — still key-scoped through the same allowlist (design §3).
]
