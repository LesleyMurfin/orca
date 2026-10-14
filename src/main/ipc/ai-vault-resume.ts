import { ipcMain } from 'electron'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult,
  AiVaultSessionResumePreparation
} from '../../shared/ai-vault-resume-preparation'
import { isUnresolvedOwnerHostId, parseExecutionHostId } from '../../shared/execution-host'
import { isWslUncPath } from '../../shared/wsl-paths'
import { assertLegacyAiVaultResumeAllowed } from '../ai-vault/structured-session-ownership'
import { tryEnsureStructuredAgentSessionHostForResume } from '../runtime/structured-agent-session-host-refusal'

export type AiVaultResumeHandlerOptions = {
  ensureStructuredSessionOwnership?: () => Promise<void>
  prepareSessionResume?: AiVaultSessionResumePreparation
  prepareRuntimeSessionResume?: (
    environmentId: string,
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
}

export function registerAiVaultResumeHandler(options: AiVaultResumeHandlerOptions): void {
  ipcMain.handle('aiVault:prepareSessionResume', (_event, args: AiVaultPrepareSessionResumeArgs) =>
    prepareAiVaultSessionResume(args, options)
  )
}

export async function prepareAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: AiVaultResumeHandlerOptions
): Promise<AiVaultPrepareSessionResumeResult> {
  const executionHost = parseExecutionHostId(args.executionHostId)
  if (executionHost?.kind === 'runtime') {
    if (!options.prepareRuntimeSessionResume || isUnresolvedOwnerHostId(executionHost.id)) {
      throw new Error('The session host is unavailable. Reconnect it and retry resume.')
    }
    return options.prepareRuntimeSessionResume(executionHost.environmentId, args)
  }
  // Why: the desktop process must never materialize transcript paths owned by an SSH host.
  if (executionHost?.kind === 'ssh') {
    return { useRealCodexHome: false }
  }
  if (!isWslUncPath(args.filePath)) {
    if (options.ensureStructuredSessionOwnership) {
      await (args.codexHome === null && !args.fork
        ? tryEnsureStructuredAgentSessionHostForResume(options.ensureStructuredSessionOwnership)
        : options.ensureStructuredSessionOwnership())
    }
    assertLegacyAiVaultResumeAllowed(args)
  }
  return options.prepareSessionResume?.(args) ?? { useRealCodexHome: false }
}
