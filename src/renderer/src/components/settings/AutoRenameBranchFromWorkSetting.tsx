/* eslint-disable max-lines -- Why: the setting owns one collapsed form with
   queued writes, model selection, and prompt draft state. Splitting the
   tiny subcontrols would make the settings write flow harder to audit. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import type {
  SourceControlAiModelChoice,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { buildBranchNamePrompt } from '../../../../shared/branch-name-from-work'
import {
  clearSourceControlAiModelChoiceForHost,
  normalizeSourceControlAiSettings,
  readSourceControlAiModelChoiceForHost,
  selectSourceControlAiModelChoiceForHost
} from '../../../../shared/source-control-ai'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  resolveCommitMessageAgentChoice,
  type CommitMessageAgentCapability,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import {
  getCommitMessageModelDiscoveryHostKeyForScope,
  LOCAL_COMMIT_MESSAGE_HOST_KEY
} from '../../../../shared/commit-message-host-key'
import { getConnectionId } from '@/lib/connection-context'
import { cn } from '@/lib/utils'
import { getRuntimeGitScope } from '../../runtime/runtime-git-client'
import { useAppStore } from '../../store'
import { useActiveWorktree } from '../../store/selectors'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'

type AutoRenameBranchFromWorkSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

type SourceControlAiConfigPatch =
  | Partial<SourceControlAiSettings>
  | ((current: SourceControlAiSettings) => Partial<SourceControlAiSettings>)

const INHERIT_BRANCH_MODEL_VALUE = '__inherit_branch_model__'
const BUILT_IN_BRANCH_NAME_PROMPT = buildBranchNamePrompt({
  firstPrompt: '{first agent prompt}',
  assistantMessage: '{agent initial response, when available}'
})

function readSourceControlSettings(settings: GlobalSettings): SourceControlAiSettings {
  return normalizeSourceControlAiSettings(settings.sourceControlAi, settings.commitMessageAi)
}

function mergeModelCapabilities(
  fallbackModels: CommitMessageModelCapability[],
  discoveredModels: CommitMessageModelCapability[] | undefined
): CommitMessageModelCapability[] {
  const models: CommitMessageModelCapability[] = []
  const seen = new Set<string>()
  for (const model of [...(discoveredModels ?? []), ...fallbackModels]) {
    if (!model.id || seen.has(model.id)) {
      continue
    }
    seen.add(model.id)
    models.push(model)
  }
  return models
}

function getCapabilityWithDiscoveredModels(
  config: SourceControlAiSettings,
  capability: CommitMessageAgentCapability,
  hostKey: string
): CommitMessageAgentCapability {
  const discoveredModels =
    config.discoveredModelsByAgentByHost?.[hostKey]?.[capability.id] ??
    (hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY
      ? config.discoveredModelsByAgent?.[capability.id]
      : undefined)
  const models = mergeModelCapabilities(capability.models, discoveredModels)
  const defaultModelId = models.some((model) => model.id === capability.defaultModelId)
    ? capability.defaultModelId
    : (models[0]?.id ?? capability.defaultModelId)
  return { ...capability, models, defaultModelId }
}

function resolveSelectedThinking(
  config: SourceControlAiSettings,
  model: CommitMessageModelCapability,
  operationChoice: SourceControlAiModelChoice | undefined
): string | undefined {
  if (!model.thinkingLevels) {
    return undefined
  }
  const persisted =
    operationChoice?.selectedThinkingByModel?.[model.id] ?? config.selectedThinkingByModel[model.id]
  return model.thinkingLevels.some((level) => level.id === persisted)
    ? persisted
    : model.defaultThinkingLevel
}

export function AutoRenameBranchFromWorkSetting({
  settings,
  updateSettings
}: AutoRenameBranchFromWorkSettingProps): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeConnectionId = getConnectionId(activeWorktree?.id ?? null)
  const discoveryHostKey = getCommitMessageModelDiscoveryHostKeyForScope(
    activeWorktree?.id ? getRuntimeGitScope(settings, activeConnectionId) : activeConnectionId
  )
  const config = readSourceControlSettings(settings)
  const latestConfigRef = useRef(config)
  latestConfigRef.current = config
  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [builtInPromptOpen, setBuiltInPromptOpen] = useState(false)
  const persistedBranchNamePrompt = config.instructionsByOperation.branchName ?? ''
  const [branchNamePromptDraft, setBranchNamePromptDraft] = useState(persistedBranchNamePrompt)
  const [isSavingPrompt, setIsSavingPrompt] = useState(false)
  const branchNamePromptDirty = branchNamePromptDraft !== persistedBranchNamePrompt

  useEffect(() => {
    if (!branchNamePromptDirty) {
      setBranchNamePromptDraft(persistedBranchNamePrompt)
    }
  }, [branchNamePromptDirty, persistedBranchNamePrompt])

  const resolvedAgentId = resolveCommitMessageAgentChoice(
    config.agentId,
    settings.defaultTuiAgent,
    settings.disabledTuiAgents
  )
  const activeAgentId =
    resolvedAgentId && !isCustomAgentId(resolvedAgentId) ? resolvedAgentId : null
  const activeCapability = useMemo(() => {
    if (!activeAgentId) {
      return undefined
    }
    const capability = getCommitMessageAgentCapability(activeAgentId)
    return capability
      ? getCapabilityWithDiscoveredModels(config, capability, discoveryHostKey)
      : undefined
  }, [activeAgentId, config, discoveryHostKey])
  const branchModelChoice = config.modelOverridesByOperation?.branchName
  const branchModelOverrideId = activeCapability
    ? readSourceControlAiModelChoiceForHost(
        branchModelChoice,
        discoveryHostKey,
        activeCapability.id
      )
    : undefined
  const selectedBranchModel = branchModelOverrideId
    ? activeCapability?.models.find((model) => model.id === branchModelOverrideId)
    : undefined
  const selectedBranchThinking = selectedBranchModel
    ? resolveSelectedThinking(config, selectedBranchModel, branchModelChoice)
    : undefined

  const writeConfig = (patch: SourceControlAiConfigPatch): Promise<void> => {
    const next = settingsWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const latestSettings = useAppStore.getState().settings ?? settings
        const latestConfig = latestSettings
          ? readSourceControlSettings(latestSettings)
          : latestConfigRef.current
        const resolvedPatch = typeof patch === 'function' ? patch(latestConfig) : patch
        await updateSettings({ sourceControlAi: { ...latestConfig, ...resolvedPatch } })
      })
    settingsWriteQueueRef.current = next
    return next
  }

  const onBranchModelChange = (modelId: string): void => {
    if (!activeCapability) {
      return
    }
    if (modelId === INHERIT_BRANCH_MODEL_VALUE) {
      void writeConfig((current) => {
        const nextOverrides = { ...current.modelOverridesByOperation }
        const nextChoice = clearSourceControlAiModelChoiceForHost(
          nextOverrides.branchName,
          discoveryHostKey,
          activeCapability.id
        )
        if (nextChoice) {
          nextOverrides.branchName = nextChoice
        } else {
          delete nextOverrides.branchName
        }
        return { modelOverridesByOperation: nextOverrides }
      })
      return
    }
    const model = activeCapability.models.find((candidate) => candidate.id === modelId)
    if (!model) {
      return
    }
    void writeConfig((current) => {
      const nextChoice = selectSourceControlAiModelChoiceForHost(
        current.modelOverridesByOperation?.branchName,
        discoveryHostKey,
        activeCapability.id,
        model.id
      )
      if (
        model.thinkingLevels &&
        model.defaultThinkingLevel &&
        !nextChoice.selectedThinkingByModel?.[model.id]
      ) {
        nextChoice.selectedThinkingByModel = {
          ...nextChoice.selectedThinkingByModel,
          [model.id]: model.defaultThinkingLevel
        }
      }
      return {
        modelOverridesByOperation: {
          ...current.modelOverridesByOperation,
          branchName: nextChoice
        }
      }
    })
  }

  const onBranchThinkingChange = (modelId: string, thinkingId: string): void => {
    void writeConfig((current) => ({
      modelOverridesByOperation: {
        ...current.modelOverridesByOperation,
        branchName: {
          ...current.modelOverridesByOperation?.branchName,
          selectedThinkingByModel: {
            ...current.modelOverridesByOperation?.branchName?.selectedThinkingByModel,
            [modelId]: thinkingId
          }
        }
      }
    }))
  }

  const onSavePrompt = async (): Promise<void> => {
    if (!branchNamePromptDirty || isSavingPrompt) {
      return
    }
    setIsSavingPrompt(true)
    try {
      await writeConfig((current) => ({
        instructionsByOperation: {
          ...current.instructionsByOperation,
          branchName: branchNamePromptDraft
        }
      }))
    } finally {
      setIsSavingPrompt(false)
    }
  }

  const onDiscardPrompt = (): void => {
    setBranchNamePromptDraft(persistedBranchNamePrompt)
  }

  return (
    <SearchableSetting
      title="Auto-Rename Branch From Work"
      description="Rename the auto-generated branch based on the work once an agent starts."
      keywords={[
        'branch',
        'rename',
        'auto',
        'creature name',
        'agent',
        'prompt',
        'worktree',
        'model',
        'prompt',
        'slug'
      ]}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>Auto-Rename Branch From Work</Label>
          <p className="text-xs text-muted-foreground">
            When an agent starts working in a new workspace, Orca renames its auto-generated branch
            (e.g. <code>Nautilus</code>) to a short name summarizing the task. Only branches Orca
            named itself are renamed, and never after they have been pushed.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.autoRenameBranchFromWork}
          onClick={() =>
            updateSettings({
              autoRenameBranchFromWork: !settings.autoRenameBranchFromWork
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.autoRenameBranchFromWork ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.autoRenameBranchFromWork ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Branch rename options
            <ChevronDown
              className={cn('size-3.5 transition-transform', optionsOpen && 'rotate-180')}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
            <div className="space-y-2">
              <div className="space-y-0.5">
                <Label htmlFor="git-auto-rename-branch-name-prompt">Branch name prompt</Label>
                <p className="text-xs text-muted-foreground">
                  Appended to Orca&apos;s built-in branch-name prompt. The built-in prompt still
                  requires a short lowercase kebab-case branch leaf.
                </p>
              </div>
              <textarea
                id="git-auto-rename-branch-name-prompt"
                rows={4}
                value={branchNamePromptDraft}
                onChange={(event) => setBranchNamePromptDraft(event.target.value)}
                placeholder="Prefer domain nouns from the task, avoid ticket IDs, and keep names reviewer-friendly."
                className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  {branchNamePromptDirty ? 'Unsaved changes' : 'Saved'}
                </p>
                <div className="flex items-center gap-2">
                  {branchNamePromptDirty ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={onDiscardPrompt}
                      disabled={isSavingPrompt}
                    >
                      Discard
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => void onSavePrompt()}
                    disabled={!branchNamePromptDirty || isSavingPrompt}
                  >
                    {isSavingPrompt ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              </div>
            </div>

            <Collapsible open={builtInPromptOpen} onOpenChange={setBuiltInPromptOpen}>
              <div className="border-t border-border/50 pt-3">
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="-ml-2 h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Built-in prompt
                    <ChevronDown
                      className={cn(
                        'size-3.5 transition-transform',
                        builtInPromptOpen && 'rotate-180'
                      )}
                    />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Your Branch name prompt is appended as{' '}
                      <code className="font-mono">Additional user prompt</code>.
                    </p>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                      {BUILT_IN_BRANCH_NAME_PROMPT}
                    </pre>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <div className="flex flex-col gap-3 border-t border-border/50 pt-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-0.5">
                <Label>Branch name model</Label>
                <p className="text-xs text-muted-foreground">
                  Use a different model for branch name generation.
                </p>
              </div>
              {activeCapability ? (
                <div className="flex w-full flex-col items-end gap-2 sm:w-auto">
                  <Select
                    value={branchModelOverrideId ?? INHERIT_BRANCH_MODEL_VALUE}
                    onValueChange={onBranchModelChange}
                  >
                    <SelectTrigger size="sm" className="h-8 w-full shrink-0 text-xs sm:w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT_BRANCH_MODEL_VALUE} className="cursor-pointer">
                        Use default model
                      </SelectItem>
                      {activeCapability.models.map((model) => (
                        <SelectItem key={model.id} value={model.id} className="cursor-pointer">
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedBranchModel?.thinkingLevels && selectedBranchThinking ? (
                    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                      <span className="text-[11px] text-muted-foreground">Thinking</span>
                      <Select
                        value={selectedBranchThinking}
                        onValueChange={(value) =>
                          onBranchThinkingChange(selectedBranchModel.id, value)
                        }
                      >
                        <SelectTrigger size="sm" className="h-7 w-[150px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedBranchModel.thinkingLevels.map((level) => (
                            <SelectItem key={level.id} value={level.id} className="cursor-pointer">
                              {level.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="max-w-[260px] text-right text-xs text-muted-foreground">
                  Choose a Source Control AI agent that supports model selection.
                </p>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SearchableSetting>
  )
}
