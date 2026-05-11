/**
 * Issue, PR, and Comment meta sections for WorktreeCard.
 *
 * Why extracted: keeps WorktreeCard.tsx under the 400-line oxlint limit
 * while co-locating the HoverCard presentation for each metadata type.
 */
import React from 'react'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card'
import { CircleDot } from 'lucide-react'
import { cn } from '@/lib/utils'
import CommentMarkdown from './CommentMarkdown'
import { PullRequestIcon, prStateLabel, checksLabel } from './WorktreeCardHelpers'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { PRInfo, IssueInfo, LinearIssue } from '../../../../shared/types'

// ── Issue section ────────────────────────────────────────────────────

type IssueSectionProps = {
  issue:
    | IssueInfo
    | {
        number: number
        title: string
        state?: IssueInfo['state']
        url?: string
        labels?: string[]
      }
  onClick: (e: React.MouseEvent) => void
}

export function IssueSection({ issue, onClick }: IssueSectionProps): React.JSX.Element {
  const labels = issue.labels ?? []
  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        <div
          className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
          onClick={onClick}
        >
          <CircleDot className="size-3 shrink-0 text-muted-foreground opacity-60" />
          <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-none">
            <span className="text-foreground opacity-80 font-medium shrink-0">#{issue.number}</span>
            <span className="text-muted-foreground truncate group-hover/meta:text-foreground transition-colors">
              {issue.title}
            </span>
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs space-y-1.5">
        <div className="font-semibold text-[13px]">
          #{issue.number} {issue.title}
        </div>
        {issue.state && (
          <div className="text-muted-foreground">
            State: {issue.state === 'open' ? 'Open' : 'Closed'}
          </div>
        )}
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {labels.map((l) => (
              <Badge key={l} variant="outline" className="h-4 px-1.5 text-[9px]">
                {l}
              </Badge>
            ))}
          </div>
        )}
        {issue.url && (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View on GitHub
          </a>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

// ── PR section ───────────────────────────────────────────────────────

type PrSectionProps = {
  pr:
    | PRInfo
    | {
        number: number
        title: string
        url?: string
        state?: PRInfo['state']
        checksStatus?: PRInfo['checksStatus']
      }
  onClick: (e: React.MouseEvent) => void
}

export function PrSection({ pr, onClick }: PrSectionProps): React.JSX.Element {
  const content = (
    <>
      <PullRequestIcon
        className={cn(
          'size-3 shrink-0',
          pr.state === 'merged' && 'text-purple-600/70 dark:text-purple-400/70',
          pr.state === 'open' && 'text-emerald-500/80',
          pr.state === 'closed' && 'text-muted-foreground/60',
          pr.state === 'draft' && 'text-muted-foreground/50',
          (!pr.state || !['merged', 'open', 'closed', 'draft'].includes(pr.state)) &&
            'text-muted-foreground opacity-60'
        )}
      />
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-none">
        <span className="text-foreground opacity-80 shrink-0 group-hover/meta:underline">
          PR #{pr.number}
        </span>
        <span className="text-muted-foreground truncate group-hover/meta:text-foreground transition-colors">
          {pr.title}
        </span>
      </div>
    </>
  )

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        {pr.url ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
            onClick={(e) => e.stopPropagation()}
          >
            {content}
          </a>
        ) : (
          <div
            className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
            onClick={onClick}
          >
            {content}
          </div>
        )}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs space-y-1.5">
        <div className="font-semibold text-[13px]">
          #{pr.number} {pr.title}
        </div>
        {(pr.state || (pr.checksStatus && pr.checksStatus !== 'neutral')) && (
          <div className="flex items-center gap-2 text-muted-foreground">
            {pr.state && <span>State: {prStateLabel(pr.state)}</span>}
            {pr.checksStatus && pr.checksStatus !== 'neutral' && (
              <span>Checks: {checksLabel(pr.checksStatus)}</span>
            )}
          </div>
        )}
        {pr.url && (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            View on GitHub
          </a>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

// ── Linear section ──────────────────────────────────────────────────

type LinearSectionProps = {
  issue:
    | LinearIssue
    | {
        identifier: string
        title: string
        url?: string
        state?: LinearIssue['state']
        labels?: string[]
      }
  onClick: (e: React.MouseEvent) => void
}

export function LinearSection({ issue, onClick }: LinearSectionProps): React.JSX.Element {
  const labels = issue.labels ?? []
  const content = (
    <>
      <LinearIcon className="size-3 shrink-0 text-muted-foreground opacity-70" />
      <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[11.5px] leading-none">
        <span className="text-foreground opacity-80 font-medium shrink-0">{issue.identifier}</span>
        <span className="text-muted-foreground truncate group-hover/meta:text-foreground transition-colors">
          {issue.title}
        </span>
      </div>
    </>
  )

  return (
    <HoverCard openDelay={300}>
      <HoverCardTrigger asChild>
        {issue.url ? (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
            onClick={(e) => e.stopPropagation()}
          >
            {content}
          </a>
        ) : (
          <div
            className="flex items-center gap-1.5 min-w-0 cursor-pointer group/meta -mx-1.5 px-1.5 py-0.5 rounded transition-colors hover:bg-background/40"
            onClick={onClick}
          >
            {content}
          </div>
        )}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-72 p-3 text-xs space-y-1.5">
        <div className="font-semibold text-[13px]">
          {issue.identifier} {issue.title}
        </div>
        {issue.state && <div className="text-muted-foreground">State: {issue.state.name}</div>}
        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {labels.map((label) => (
              <Badge key={label} variant="outline" className="h-4 px-1.5 text-[9px]">
                {label}
              </Badge>
            ))}
          </div>
        )}
        {issue.url && (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            View on Linear
          </a>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

// ── Comment section ──────────────────────────────────────────────────

type CommentSectionProps = {
  comment: string
  onDoubleClick: (e: React.MouseEvent) => void
}

export function CommentSection({ comment, onDoubleClick }: CommentSectionProps): React.JSX.Element {
  return (
    <HoverCard openDelay={400}>
      <HoverCardTrigger asChild>
        <CommentMarkdown
          content={comment}
          className="text-[11px] text-muted-foreground break-words -mx-1.5 px-1.5 py-0.5 rounded transition-colors leading-normal line-clamp-2 [&_.comment-md-p]:inline [&_.comment-md-p+.comment-md-p]:before:content-['_']"
          onDoubleClick={onDoubleClick}
        />
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-72 max-h-80 overflow-y-auto p-3">
        <CommentMarkdown
          content={comment}
          className="text-[11.5px] text-foreground break-words leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1"
        />
      </HoverCardContent>
    </HoverCard>
  )
}
