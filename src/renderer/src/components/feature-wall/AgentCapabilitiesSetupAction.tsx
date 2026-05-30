import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, Globe2, Loader2, MonitorCog, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { FeatureSetupInlineTerminal } from '../onboarding/FeatureSetupInlineTerminal'
import {
  DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION,
  hasSelectedOnboardingFeatureSetup,
  runOnboardingFeatureSetup,
  type OnboardingFeatureSetupId,
  type OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import { AgentsOrchestrationVisual } from './AgentsOrchestrationVisual'
import { BrowserAnimatedVisual } from './BrowserAnimatedVisual'
import { ComputerUseAnimatedVisual } from './ComputerUseAnimatedVisual'

export function AgentCapabilitiesSetupAction(props: {
  reducedMotion: boolean
  onOrchestrationSkillInstalledChange: (installed: boolean) => void
  onBrowserUseSkillInstalledChange: (installed: boolean) => void
}): React.JSX.Element {
  const { reducedMotion, onBrowserUseSkillInstalledChange, onOrchestrationSkillInstalledChange } =
    props
  const [featureSetup, setFeatureSetup] = useState<OnboardingFeatureSetupSelection>(
    DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION
  )
  const [featureSetupCommand, setFeatureSetupCommand] = useState<string | null>(null)
  const [featureSetupCommandSelection, setFeatureSetupCommandSelection] =
    useState<OnboardingFeatureSetupSelection | null>(null)
  const [setupBusyLabel, setSetupBusyLabel] = useState<string | null>(null)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const handleStartFeatureSetup = useCallback(async (): Promise<void> => {
    if (setupBusyLabel !== null || featureSetupCommand !== null) {
      return
    }
    setSetupBusyLabel('Setting up capabilities...')
    try {
      const result = await runOnboardingFeatureSetup(featureSetup)
      if (featureSetup.browserUse) {
        recordFeatureInteraction('agent-browser-setup')
        onBrowserUseSkillInstalledChange(true)
      }
      if (featureSetup.computerUse) {
        recordFeatureInteraction('computer-use-setup')
      }
      if (featureSetup.orchestration) {
        recordFeatureInteraction('agent-orchestration-setup')
        onOrchestrationSkillInstalledChange(true)
      }
      const firstWarning = result.warnings[0]
      if (firstWarning) {
        toast.warning('Some capability setup needs attention', {
          description: firstWarning.message
        })
      }
      if (result.skillCommandsCopied) {
        toast.success('Capability setup ready', {
          description: 'Skill command copied and inserted below for review.'
        })
      }
      if (result.computerUsePermissionsOpened) {
        toast.message('Opened Computer Use permissions')
      }
      if (result.skillInstallCommand) {
        setFeatureSetupCommandSelection(featureSetup)
        setFeatureSetupCommand(result.skillInstallCommand)
      }
    } finally {
      setSetupBusyLabel(null)
    }
  }, [
    featureSetup,
    featureSetupCommand,
    onBrowserUseSkillInstalledChange,
    onOrchestrationSkillInstalledChange,
    recordFeatureInteraction,
    setupBusyLabel
  ])

  return (
    <div className="space-y-5">
      <AgentCapabilityAnimationCarousel reducedMotion={reducedMotion} />
      <AgentCapabilitySetupControls
        featureSetup={featureSetup}
        onFeatureSetupChange={setFeatureSetup}
        featureSetupCommand={featureSetupCommand}
        featureSetupCommandSelection={featureSetupCommandSelection}
        setupBusyLabel={setupBusyLabel}
        onStartFeatureSetup={() => void handleStartFeatureSetup()}
      />
    </div>
  )
}

type AgentCapabilitySetupRow = {
  id: OnboardingFeatureSetupId
  title: string
  icon: ReactNode
}

type AgentCapabilitySlide = {
  id: string
  title: string
  icon: ReactNode
  widthClassName: string
  node: ReactNode
}

const AGENT_CAPABILITY_SETUP_ROWS: readonly AgentCapabilitySetupRow[] = [
  {
    id: 'browserUse',
    title: 'Agent Browser Use',
    icon: <Globe2 className="size-4" />
  },
  {
    id: 'computerUse',
    title: 'Computer Use',
    icon: <MonitorCog className="size-4" />
  },
  {
    id: 'orchestration',
    title: 'Agent Orchestration',
    icon: <Workflow className="size-4" />
  }
]

function AgentCapabilitySetupControls(props: {
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
  setupBusyLabel: string | null
  onStartFeatureSetup: () => void
}): React.JSX.Element {
  const hasSelectedFeatures = hasSelectedOnboardingFeatureSetup(props.featureSetup)
  const showSetupAction = !props.featureSetupCommand

  return (
    <>
      <AgentCapabilitySetupChecklist
        value={props.featureSetup}
        onChange={props.onFeatureSetupChange}
      />
      {showSetupAction ? (
        <div className="mt-4 flex items-center">
          <Button
            type="button"
            variant="default"
            className="shrink-0"
            disabled={!hasSelectedFeatures || Boolean(props.setupBusyLabel)}
            onClick={props.onStartFeatureSetup}
          >
            {props.setupBusyLabel ? <Loader2 className="size-4 animate-spin" /> : null}
            {props.setupBusyLabel ?? 'Enable capabilities'}
          </Button>
        </div>
      ) : null}
      {props.featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={props.featureSetupCommand}
          selection={props.featureSetupCommandSelection ?? props.featureSetup}
        />
      ) : null}
    </>
  )
}

function AgentCapabilitySetupChecklist(props: {
  value: OnboardingFeatureSetupSelection
  onChange: (value: OnboardingFeatureSetupSelection) => void
}): React.JSX.Element {
  return (
    <section className="mt-6">
      <div className="grid gap-3 md:grid-cols-3">
        {AGENT_CAPABILITY_SETUP_ROWS.map((row) => {
          const selected = props.value[row.id]
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={`${selected ? 'Disable' : 'Enable'} ${row.title}`}
              className={cn(
                'flex min-h-28 flex-col rounded-lg border px-4 py-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                selected
                  ? 'border-ring bg-accent text-foreground ring-2 ring-ring/25'
                  : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40'
              )}
              onClick={() => props.onChange({ ...props.value, [row.id]: !selected })}
            >
              <span className="flex items-start justify-between gap-3">
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg border',
                    selected
                      ? 'border-border bg-background text-foreground'
                      : 'border-border bg-muted/40'
                  )}
                >
                  {row.icon}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full border transition-colors',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background'
                  )}
                >
                  {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              </span>
              <span className="mt-3 text-sm font-medium text-foreground">{row.title}</span>
              <span className="mt-auto pt-3 text-[11px] font-medium text-muted-foreground">
                {selected ? 'Included' : 'Skipped'}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

const AGENT_CAPABILITY_SLIDE_COUNT = 3

function AgentCapabilityAnimationCarousel(props: { reducedMotion: boolean }): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(() => (props.reducedMotion ? 1 : 0))
  const advanceSlide = useCallback(() => {
    if (props.reducedMotion) {
      return
    }
    setActiveIndex((current) => (current + 1) % AGENT_CAPABILITY_SLIDE_COUNT)
  }, [props.reducedMotion])

  const slides = useMemo<readonly AgentCapabilitySlide[]>(
    () => [
      {
        id: 'browser-use',
        title: 'Browser use',
        icon: <Globe2 className="size-3.5" />,
        widthClassName: 'w-[460px]',
        node: (
          <BrowserAnimatedVisual
            reducedMotion={props.reducedMotion}
            onCycleComplete={advanceSlide}
          />
        )
      },
      {
        id: 'computer-use',
        title: 'Computer Use',
        icon: <MonitorCog className="size-3.5" />,
        widthClassName: 'w-[520px]',
        node: (
          <ComputerUseAnimatedVisual
            reducedMotion={props.reducedMotion}
            onCycleComplete={advanceSlide}
          />
        )
      },
      {
        id: 'orchestration',
        title: 'Agent orchestration',
        icon: <Workflow className="size-3.5" />,
        widthClassName: 'w-[520px]',
        node: (
          <AgentsOrchestrationVisual
            reducedMotion={props.reducedMotion}
            activeStepId="orchestration"
            widthPx={400}
            heightPx={300}
            onCycleComplete={advanceSlide}
          />
        )
      }
    ],
    [advanceSlide, props.reducedMotion]
  )

  useEffect(() => {
    if (props.reducedMotion) {
      setActiveIndex(1)
    }
  }, [props.reducedMotion])

  const activeSlide = slides[activeIndex] ?? slides[0]

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {activeSlide.title}
        </div>
        <div className="flex items-center gap-1">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              aria-label={`Show ${slide.title}`}
              aria-pressed={index === activeIndex}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors',
                index === activeIndex
                  ? 'border-border bg-card text-foreground shadow-xs'
                  : 'border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
              onClick={() => setActiveIndex(index)}
            >
              {slide.icon}
              <span className="max-w-28 truncate">{slide.title}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="mx-auto flex min-h-[300px] max-w-[560px] items-start justify-center overflow-visible">
        <div className={cn('max-w-full', activeSlide.widthClassName)}>{activeSlide.node}</div>
      </div>
    </div>
  )
}
