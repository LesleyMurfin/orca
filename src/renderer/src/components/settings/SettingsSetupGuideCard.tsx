import { ArrowRight, ListChecks } from 'lucide-react'
import { useMemo } from 'react'
import { getFeatureWallSetupSteps } from '../../../../shared/feature-wall-setup-steps'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { useSetupGuideProgress } from '../setup-guide/use-setup-guide-progress'

export function SettingsSetupGuideCard(): React.JSX.Element | null {
  const openModal = useAppStore((s) => s.openModal)
  const progress = useSetupGuideProgress(true, false, false, { refreshAdvancedState: true })
  const setupSteps = useMemo(() => getFeatureWallSetupSteps(), [])
  const unfinishedSteps = useMemo(
    () => setupSteps.filter((step) => !progress.stepDone[step.id]),
    [progress.stepDone, setupSteps]
  )
  const completedStepCount = useMemo(
    () => setupSteps.filter((step) => progress.stepDone[step.id]).length,
    [progress.stepDone, setupSteps]
  )
  const firstUnfinishedStepId: FeatureWallSetupStepId = unfinishedSteps[0]?.id ?? 'default-agent'

  if (unfinishedSteps.length === 0) {
    return null
  }

  return (
    <section className="rounded-xl border border-border/60 bg-card/50 px-5 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
              <ListChecks className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-tight text-foreground">
                Getting started with Orca
              </h2>
              <p className="text-sm text-muted-foreground">
                {completedStepCount}/{setupSteps.length} setup workflows complete
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {unfinishedSteps.slice(0, 3).map((step) => (
              <span
                key={step.id}
                className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground"
              >
                {step.name}
              </span>
            ))}
            {unfinishedSteps.length > 3 ? (
              <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
                +{unfinishedSteps.length - 3} more
              </span>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="w-fit shrink-0 gap-1.5"
          onClick={() => openModal('setup-guide', { setupStepId: firstUnfinishedStepId })}
        >
          Continue setup
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </section>
  )
}
