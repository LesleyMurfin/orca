import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['host', 'name'],
    summary: 'Show or set the name this Orca runtime reports to connected clients',
    usage: 'orca host name [--name <name>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    notes: [
      'With --name, updates the answering runtime over its authenticated connection. Use an empty value to return to the detected computer name.',
      'Without --name, prints the name and platform the answering runtime reports.'
    ],
    examples: ['orca host name', 'orca host name --name build-server']
  },
  {
    path: ['host', 'list'],
    summary: 'List every machine this Orca host can target, and how to name each one',
    usage: 'orca host list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers "what can I target and what do I pass" in one place: this machine, the SSH targets registered on it, and the Orca servers paired with it.',
      'The three kinds are reached differently. A paired Orca server is a connection, selected with --environment <name>. An SSH target is a machine the connected Orca host reaches, selected with --host ssh:<id>. Passing one where the other belongs is the most common way to get an empty or missing-host answer.',
      'SSH rows include the detected remote platform after that target has connected (linux, darwin, or win32); disconnected or older targets report platform unknown.',
      'SSH rows also include whether the target is currently connected and its lifecycle status when known.',
      'Paired-server rows come from the pairing store and report platform unknown; ask one server directly with `orca host name --environment <name>`.',
      "SSH targets are read from this machine's own Orca runtime, so this lists that machine's targets and not another server's. Run `orca host list` on the other machine to see the targets registered there.",
      '--environment and --pairing-code are rejected rather than ignored: paired servers come from this machine\u2019s pairing store, so a routed answer would describe two machines at once.'
    ],
    examples: ['orca host list', 'orca host list --json']
  },
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
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Answers from this machine\u2019s pairing store. --environment and --pairing-code are rejected rather than ignored, because there is no other host that could answer.'
    ]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Orca runtime environment',
    usage: 'orca environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
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
    summary: 'Read one portable setting from a remote Orca runtime',
    usage: 'orca environment config get <key> --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'key'],
    positionalArgs: ['key'],
    examples: ['orca environment config get terminalCursorStyle --environment work-laptop']
  },
  {
    path: ['environment', 'config', 'set'],
    summary: 'Write one portable setting on a remote Orca runtime',
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
