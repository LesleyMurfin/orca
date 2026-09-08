import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  },
  {
    path: ['serve', 'stats'],
    summary:
      'Show live runtime counts plus task-status, agent-state and worker-terminal-state breakdowns',
    usage: 'orca serve stats [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Queries a running runtime (local or --environment / pairing). Does not start a server.',
      'JSON shape is a stable contract: version, runtimeId, uptimeSeconds, port, counts.{agents,tasks,terminals,terminalsUnverifiable,worktrees,browserPages,browserPagesRetained,tasksByStatus,agentsByState,workersByTerminalState}. The three breakdowns are objects with every key always present (0, never omitted).',
      'terminalsUnverifiable counts registered ptys with no current host contact — unverifiable, not proof they exited; it does not authorize cleanup.',
      'tasksByStatus does not sum to counts.tasks: it includes the completed/failed rows that counts.tasks excludes. agentsByState reports unknown for any agent whose turn state is not currently provable (all structured sessions, plus ptys with no live status) — unknown is never idle. workersByTerminalState covers every retained dispatch, so reclaimable/release_unknown pileups are visible without worker-list.'
    ],
    examples: ['orca serve stats', 'orca serve stats --json']
  }
]
