import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { hasEffectiveSetupCommand } from '@/lib/setup-script-status'
import {
  getFeatureWallSetupProgress,
  type FeatureWallSetupProgress
} from '../feature-wall/feature-wall-setup-progress'

export function useSetupGuideProgress(
  shouldRefreshCoreState: boolean,
  orchestrationSkillInstalled: boolean,
  browserUseSkillInstalled: boolean,
  options: { refreshAdvancedState?: boolean } = {}
): FeatureWallSetupProgress {
  const settings = useAppStore((s) => s.settings)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const [hasAutomation, setHasAutomation] = useState(false)
  const [hasSetupScript, setHasSetupScript] = useState(false)
  const shouldRefreshAdvancedState = options.refreshAdvancedState ?? shouldRefreshCoreState

  useEffect(() => {
    if (!shouldRefreshCoreState) {
      return
    }
    if (!preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    linearStatusChecked,
    preflightStatusChecked,
    refreshPreflightStatus,
    shouldRefreshCoreState
  ])

  useEffect(() => {
    if (!shouldRefreshAdvancedState) {
      return
    }
    let stale = false
    window.api.automations
      .list()
      .then((automations) => {
        if (!stale) {
          setHasAutomation(automations.length > 0)
        }
      })
      .catch(() => {
        if (!stale) {
          setHasAutomation(false)
        }
      })
    return () => {
      stale = true
    }
  }, [shouldRefreshAdvancedState])

  useEffect(() => {
    if (!shouldRefreshCoreState || !settings) {
      return
    }
    let stale = false
    const gitRepos = repos.filter(isGitRepoKind)
    const activeRepo = activeRepoId
      ? (gitRepos.find((repo) => repo.id === activeRepoId) ?? null)
      : null
    const orderedRepos = activeRepo
      ? [activeRepo, ...gitRepos.filter((repo) => repo.id !== activeRepo.id)]
      : gitRepos

    async function refreshSetupScriptState(): Promise<void> {
      for (const repo of orderedRepos) {
        const hooksResult = await checkRuntimeHooks(settings, repo.id).catch(() => null)
        if (stale) {
          return
        }
        if (hooksResult && hasEffectiveSetupCommand(repo, hooksResult)) {
          setHasSetupScript(true)
          return
        }
      }
      setHasSetupScript(false)
    }

    void refreshSetupScriptState()
    return () => {
      stale = true
    }
  }, [activeRepoId, repos, settings, shouldRefreshCoreState])

  const hasConnectedTaskSource =
    (preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true) ||
    (preflightStatus?.glab?.installed === true && preflightStatus.glab.authenticated === true) ||
    linearStatus.connected === true
  const gitRepoCount = useMemo(() => repos.filter(isGitRepoKind).length, [repos])

  return useMemo(
    () =>
      getFeatureWallSetupProgress({
        settings,
        featureInteractions,
        hasConnectedTaskSource,
        browserUseSkillInstalled,
        orchestrationSkillInstalled,
        gitRepoCount,
        worktreesByRepo,
        tabsByWorktree,
        runtimePaneTitlesByTabId,
        hasAutomation,
        hasSetupScript
      }),
    [
      browserUseSkillInstalled,
      featureInteractions,
      gitRepoCount,
      hasAutomation,
      hasConnectedTaskSource,
      hasSetupScript,
      orchestrationSkillInstalled,
      runtimePaneTitlesByTabId,
      settings,
      tabsByWorktree,
      worktreesByRepo
    ]
  )
}
