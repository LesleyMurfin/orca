import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { FolderGit2, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkingSpinner } from './feature-tour-preview-glyphs'

type SetupScriptPhase = 'create' | 'setup' | 'agent'

const SETUP_SCRIPT_PHASES: readonly SetupScriptPhase[] = [
  'create',
  'setup',
  'setup',
  'agent',
  'agent'
]

export function SetupScriptAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const phase = useSetupScriptPhase(props.reducedMotion)
  const setupRunning = phase === 'setup'
  const agentReady = phase === 'agent'

  return (
    <div className="grid min-h-[228px] gap-3 rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:grid-cols-[170px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
        <div className="flex h-8 items-center gap-2 px-1.5">
          <FolderGit2 className="size-3.5 text-muted-foreground" />
          <span className="truncate text-[13px] font-semibold">orca</span>
        </div>
        <div
          className={cn(
            'mt-1 rounded-md border border-sidebar-border bg-sidebar-accent px-2.5 py-2 transition-[opacity,transform]',
            phase === 'create' ? 'translate-y-1 opacity-70' : 'translate-y-0 opacity-100'
          )}
        >
          <div className="truncate text-xs font-medium text-sidebar-foreground">checkout fix</div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-sidebar-foreground/65">
            <span
              className={cn(
                'size-1.5 rounded-full',
                setupRunning || agentReady ? 'bg-primary' : 'bg-muted-foreground/35'
              )}
            />
            setup script
          </div>
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-2.5">
          <TerminalSquare className="size-3.5 text-muted-foreground" />
          <span className="truncate text-[11px] font-medium text-muted-foreground">Setup</span>
        </div>
        <div className="space-y-2 p-3 font-mono text-[12px]">
          <TerminalLine>
            <Prompt>$</Prompt> pnpm install
          </TerminalLine>
          <TerminalLine muted>
            {setupRunning ? (
              <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
            ) : (
              <span className="size-1.5 rounded-full bg-primary" />
            )}
            {agentReady ? 'Dependencies ready' : 'Installing dependencies'}
          </TerminalLine>
          <div
            className={cn(
              'mt-3 rounded-md border border-border bg-card px-2.5 py-2 transition-[opacity,transform]',
              agentReady ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'
            )}
          >
            <TerminalLine muted>
              <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
              Agent starts in a ready worktree
            </TerminalLine>
          </div>
        </div>
      </div>
    </div>
  )
}

function TerminalLine(props: { children: ReactNode; muted?: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 truncate leading-[1.45]',
        props.muted ? 'text-muted-foreground' : 'text-foreground'
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-primary">{props.children}</span>
}

function useSetupScriptPhase(reducedMotion: boolean): SetupScriptPhase {
  const [idx, setIdx] = useState(() => (reducedMotion ? SETUP_SCRIPT_PHASES.indexOf('agent') : 0))

  useEffect(() => {
    if (reducedMotion) {
      setIdx(SETUP_SCRIPT_PHASES.indexOf('agent'))
      return
    }
    const id = window.setInterval(() => {
      setIdx((current) => (current + 1) % SETUP_SCRIPT_PHASES.length)
    }, 1200)
    return () => window.clearInterval(id)
  }, [reducedMotion])

  return SETUP_SCRIPT_PHASES[idx] ?? 'agent'
}
