import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, ExternalLink, Plus, Save, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { getDefaultRepoHookSettings } from '../../../../shared/constants'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { RepoHookSettings, Worktree } from '../../../../shared/types'
import { getRepositoryLocalCommandsSectionId } from '../settings/repository-settings-targets'
import { AddReposAnimatedVisual } from './AddReposAnimatedVisual'
import { SetupTwoAgentsVisual, SetupWorkspacesVisual } from './FeatureWallSetupStepVisuals'
import { SetupScriptAnimatedVisual } from './SetupScriptAnimatedVisual'

export function AddReposAction(props: { reducedMotion: boolean }): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  return (
    <div className="space-y-4">
      <AddReposAnimatedVisual reducedMotion={props.reducedMotion} />
      <Button type="button" size="sm" className="w-fit gap-2" onClick={() => openModal('add-repo')}>
        <Plus className="size-3.5" />
        Add project
      </Button>
    </div>
  )
}

export function TwoAgentsAction(props: { reducedMotion: boolean }): React.JSX.Element {
  const targetWorktree = useSetupTargetWorktree()
  const openModal = useAppStore((s) => s.openModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const requestContextualTour = useAppStore((s) => s.requestContextualTour)
  const handlePrimaryAction = useCallback(() => {
    if (!targetWorktree) {
      openModal('new-workspace-composer', { telemetrySource: 'unknown' })
      window.setTimeout(() => {
        requestContextualTour('workspace-creation', 'setup_guide_try_it_out', false, {
          force: true
        })
      }, 80)
      return
    }
    closeModal()
    window.requestAnimationFrame(() => {
      activateAndRevealWorktree(targetWorktree.id)
      window.setTimeout(() => {
        requestContextualTour('workspace-agent-sessions', 'setup_guide_try_it_out', false, {
          force: true
        })
      }, 120)
    })
  }, [closeModal, openModal, requestContextualTour, targetWorktree])

  return (
    <div className="space-y-4">
      <SetupTwoAgentsVisual reducedMotion={props.reducedMotion} />
      <Button type="button" size="sm" className="w-fit gap-2" onClick={handlePrimaryAction}>
        <ArrowUpRight className="size-3.5" />
        Try it out
      </Button>
    </div>
  )
}

export function WorkspacesAction(props: { reducedMotion: boolean }): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const requestContextualTour = useAppStore((s) => s.requestContextualTour)
  return (
    <div className="space-y-4">
      <SetupWorkspacesVisual reducedMotion={props.reducedMotion} />
      <Button
        type="button"
        size="sm"
        className="w-fit gap-2"
        onClick={() => {
          openModal('new-workspace-composer', {
            ...(activeRepoId ? { initialRepoId: activeRepoId } : {}),
            telemetrySource: 'unknown'
          })
          window.setTimeout(() => {
            requestContextualTour('workspace-creation', 'setup_guide_try_it_out', false, {
              force: true
            })
          }, 80)
        }}
      >
        <ArrowUpRight className="size-3.5" />
        Try it out
      </Button>
    </div>
  )
}

export function SetupScriptAction(props: { reducedMotion: boolean }): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const closeModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const activeRepo = activeRepoId
    ? repos.find((entry) => entry.id === activeRepoId && isGitRepoKind(entry))
    : undefined
  const repo = activeRepo ?? repos.find((entry) => isGitRepoKind(entry)) ?? null
  const canConfigure = repo && isGitRepoKind(repo)
  const [setupScript, setSetupScript] = useState('pnpm install')

  useEffect(() => {
    if (!canConfigure) {
      setSetupScript('pnpm install')
      return
    }
    setSetupScript(repo.hookSettings?.scripts?.setup?.trim() || 'pnpm install')
  }, [canConfigure, repo])

  const openLocalCommandSettings = useCallback(() => {
    if (!repo || !isGitRepoKind(repo)) {
      return
    }
    setSettingsSearchQuery('')
    openSettingsTarget({
      pane: 'repo',
      repoId: repo.id,
      sectionId: getRepositoryLocalCommandsSectionId(repo.id)
    })
    closeModal()
    openSettingsPage()
  }, [closeModal, openSettingsPage, openSettingsTarget, repo, setSettingsSearchQuery])

  const handleSaveSetupScript = useCallback(async () => {
    if (!repo || !isGitRepoKind(repo)) {
      return
    }
    const current = repo.hookSettings
    const defaults = getDefaultRepoHookSettings()
    const nextHookSettings: RepoHookSettings = {
      ...defaults,
      ...current,
      setupRunPolicy: current?.setupRunPolicy ?? defaults.setupRunPolicy,
      // Why: setup guide edits are local repo commands and must run after save.
      commandSourcePolicy: current?.commandSourcePolicy ?? 'local-only',
      scripts: {
        ...defaults.scripts,
        ...current?.scripts,
        setup: setupScript.trim()
      }
    }
    const updated = await updateRepo(repo.id, { hookSettings: nextHookSettings })
    if (updated) {
      toast.success('Setup script saved')
    } else {
      toast.error('Failed to save setup script')
    }
  }, [repo, setupScript, updateRepo])

  return (
    <div className="space-y-4">
      <SetupScriptAnimatedVisual reducedMotion={props.reducedMotion} />
      <div className="rounded-lg border border-border bg-muted/20 p-3">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            value={setupScript}
            disabled={!canConfigure}
            onChange={(event) => setSetupScript(event.target.value)}
            placeholder="pnpm install"
            aria-label="Setup script"
            className="font-mono text-sm"
          />
          <Button
            type="button"
            size="sm"
            className="gap-2"
            disabled={!canConfigure || setupScript.trim().length === 0}
            onClick={() => void handleSaveSetupScript()}
          >
            <Save className="size-3.5" />
            Save
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 w-fit gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          disabled={!canConfigure}
          onClick={openLocalCommandSettings}
        >
          <Settings className="size-3.5" />
          View in settings
        </Button>
      </div>
      {!canConfigure ? (
        <p className="max-w-[48ch] text-xs text-muted-foreground">
          Add a git project first, then configure the setup script for that repository.
        </p>
      ) : null}
    </div>
  )
}

export function OpenWorkspaceAction(): React.JSX.Element {
  const targetWorktree = useSetupTargetWorktree()
  const openModal = useAppStore((s) => s.openModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const requestContextualTour = useAppStore((s) => s.requestContextualTour)
  return (
    <Button
      type="button"
      size="sm"
      className="w-fit gap-2"
      onClick={() => {
        if (!targetWorktree) {
          openModal('new-workspace-composer', { telemetrySource: 'unknown' })
          window.setTimeout(() => {
            requestContextualTour('workspace-creation', 'setup_guide_try_it_out', false, {
              force: true
            })
          }, 80)
          return
        }
        closeModal()
        window.requestAnimationFrame(() => {
          activateAndRevealWorktree(targetWorktree.id)
          window.setTimeout(() => {
            requestContextualTour('workspace-agent-sessions', 'setup_guide_try_it_out', false, {
              force: true
            })
          }, 120)
        })
      }}
    >
      <ArrowUpRight className="size-3.5" />
      Try it out
    </Button>
  )
}

export function OpenAutomationsAction(): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  return (
    <Button
      type="button"
      size="sm"
      className="w-fit gap-2"
      onClick={() => {
        closeModal()
        openAutomationsPage()
      }}
    >
      <ExternalLink className="size-3.5" />
      Open automations
    </Button>
  )
}

export function AgentTrackingAction(): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  return (
    <Button
      type="button"
      size="sm"
      className="w-fit gap-2"
      onClick={() => {
        openSettingsTarget({ pane: 'agents', repoId: null })
        closeModal()
        openSettingsPage()
      }}
    >
      <ExternalLink className="size-3.5" />
      Open agent settings
    </Button>
  )
}

export function MobileAction(): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  return (
    <Button
      type="button"
      size="sm"
      className="w-fit gap-2"
      onClick={() => {
        closeModal()
        openMobilePage()
      }}
    >
      <ExternalLink className="size-3.5" />
      Open mobile
    </Button>
  )
}

function useSetupTargetWorktree(): Worktree | null {
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  return useMemo(
    () =>
      allWorktrees.find((worktree) => worktree.id === activeWorktreeId) ?? allWorktrees[0] ?? null,
    [activeWorktreeId, allWorktrees]
  )
}
