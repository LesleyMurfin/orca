import { useEffect, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { Briefcase, FolderGit2, House } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '../status-bar/icons'
import { CodexInlineIcon, WorkingSpinner } from './feature-tour-preview-glyphs'

type RepoFocus = 'personal' | 'work' | 'both'

type RepoVisual = {
  id: Exclude<RepoFocus, 'both'>
  label: string
  name: string
  worktree: string
  agent: 'Claude Code' | 'Codex'
  icon: ReactNode
}

const REPOS: readonly RepoVisual[] = [
  {
    id: 'personal',
    label: 'Personal',
    name: 'recipe-box',
    worktree: 'weekend polish',
    agent: 'Claude Code',
    icon: <House className="size-3.5" />
  },
  {
    id: 'work',
    label: 'Work',
    name: 'billing-app',
    worktree: 'checkout fix',
    agent: 'Codex',
    icon: <Briefcase className="size-3.5" />
  }
]

const FOCUS_SEQUENCE: readonly RepoFocus[] = ['personal', 'both', 'work', 'both', 'both']

export function AddReposAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const focus = useRepoFocus(props.reducedMotion)

  return (
    <div className="grid min-h-[282px] gap-3 rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:grid-cols-2">
      {REPOS.map((repo) => (
        <RepoProjectCard
          key={repo.id}
          repo={repo}
          active={focus === repo.id || focus === 'both'}
          reducedMotion={props.reducedMotion}
        />
      ))}
    </div>
  )
}

function RepoProjectCard(props: {
  repo: RepoVisual
  active: boolean
  reducedMotion: boolean
}): JSX.Element {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-lg border bg-background transition-[border-color,box-shadow,background-color] duration-500',
        props.active ? 'border-primary/35 bg-primary/5 shadow-xs' : 'border-border'
      )}
    >
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <span
          className={cn(
            'flex size-5 items-center justify-center rounded-md border border-border bg-card transition-colors',
            props.active ? 'text-primary' : 'text-muted-foreground'
          )}
        >
          {props.repo.icon}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold leading-none text-foreground">
            {props.repo.name}
          </div>
          <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {props.repo.label}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
              <FolderGit2 className="size-3.5" />
            </span>
            <span className="min-w-0 truncate text-xs font-semibold text-foreground">
              {props.repo.worktree}
            </span>
          </div>
          <div className="mt-3 rounded-md border border-border bg-background p-2.5 font-mono text-[11px]">
            <TerminalLine>
              <Prompt>&gt;</Prompt>
              {props.repo.id === 'personal' ? 'refine recipe search' : 'fix checkout bug'}
            </TerminalLine>
            <TerminalLine muted>
              <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
              {props.repo.agent} working
            </TerminalLine>
            <TerminalLine muted>
              {props.repo.agent === 'Codex' ? <CodexInlineIcon /> : <ClaudeIcon size={12} />}
              {props.repo.id === 'personal' ? 'Updating UI' : 'Editing tests'}
            </TerminalLine>
          </div>
        </div>
      </div>
    </section>
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

function useRepoFocus(reducedMotion: boolean): RepoFocus {
  const [idx, setIdx] = useState(() => (reducedMotion ? FOCUS_SEQUENCE.indexOf('both') : 0))

  useEffect(() => {
    if (reducedMotion) {
      setIdx(FOCUS_SEQUENCE.indexOf('both'))
      return
    }
    const id = window.setInterval(() => {
      setIdx((current) => (current + 1) % FOCUS_SEQUENCE.length)
    }, 1700)
    return () => window.clearInterval(id)
  }, [reducedMotion])

  return FOCUS_SEQUENCE[idx] ?? 'both'
}
