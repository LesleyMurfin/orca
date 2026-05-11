import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CircleDot, Github, GitPullRequest, Link2, X } from 'lucide-react'
import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import { cn } from '@/lib/utils'
import { LinearIcon } from '@/components/icons/LinearIcon'
import type { WorktreeMeta } from '../../../../shared/types'

type LinkedArtifactInput =
  | { kind: 'none' }
  | { kind: 'github-issue'; number: number; url: string | null }
  | { kind: 'github-pr'; number: number; url: string | null }
  | { kind: 'linear'; identifier: string; url: string | null }

function parseLinearIssueIdentifier(input: string): string | null {
  const match = /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*-\d+)(?=$|[^A-Za-z0-9_])/i.exec(input)
  return match ? match[1].toUpperCase() : null
}

function parseLinkedArtifactInput(input: string): LinkedArtifactInput | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return { kind: 'none' }
  }

  const ghLink = parseGitHubIssueOrPRLink(trimmed)
  if (ghLink) {
    return ghLink.type === 'pr'
      ? { kind: 'github-pr', number: ghLink.number, url: trimmed }
      : { kind: 'github-issue', number: ghLink.number, url: trimmed }
  }

  const prMatch = /^pr\s*#?(\d+)$/i.exec(trimmed)
  if (prMatch) {
    return { kind: 'github-pr', number: Number.parseInt(prMatch[1], 10), url: null }
  }

  const issueNumber = parseGitHubIssueOrPRNumber(trimmed)
  if (issueNumber !== null) {
    return { kind: 'github-issue', number: issueNumber, url: null }
  }

  const linearIdentifier = parseLinearIssueIdentifier(trimmed)
  return linearIdentifier
    ? {
        kind: 'linear',
        identifier: linearIdentifier,
        url: /^https?:\/\//i.test(trimmed) ? trimmed : null
      }
    : null
}

function formatCurrentArtifact(
  issue: number | null,
  pr: number | null,
  linear: string | null,
  artifactUrl: string | null
) {
  if (artifactUrl) {
    return artifactUrl
  }
  if (pr !== null) {
    return `PR #${pr}`
  }
  if (issue !== null) {
    return `#${issue}`
  }
  return linear ?? ''
}

function getArtifactSummary(parsedArtifact: LinkedArtifactInput | null) {
  if (!parsedArtifact) {
    return {
      tone: 'invalid' as const,
      label: 'Invalid artifact',
      detail: 'Use a GitHub issue/PR URL, PR #123, issue #123, or Linear ID.',
      Icon: Link2
    }
  }
  if (parsedArtifact.kind === 'none') {
    return {
      tone: 'empty' as const,
      label: 'No linked artifact',
      detail: 'Leave empty to keep this workspace unlinked.',
      Icon: Link2
    }
  }
  if (parsedArtifact.kind === 'github-pr') {
    return {
      tone: 'valid' as const,
      label: `GitHub PR #${parsedArtifact.number}`,
      detail: 'PR metadata will show on the workspace card.',
      Icon: GitPullRequest
    }
  }
  if (parsedArtifact.kind === 'github-issue') {
    return {
      tone: 'valid' as const,
      label: `GitHub issue #${parsedArtifact.number}`,
      detail: 'Issue metadata will show on the workspace card.',
      Icon: CircleDot
    }
  }
  return {
    tone: 'valid' as const,
    label: `Linear ${parsedArtifact.identifier}`,
    detail: 'Linear metadata will show on the workspace card.',
    Icon: LinearIcon
  }
}

const WorktreeMetaDialog = React.memo(function WorktreeMetaDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)

  const isEditMeta = activeModal === 'edit-meta'
  const isOpen = isEditMeta

  const worktreeId = typeof modalData.worktreeId === 'string' ? modalData.worktreeId : ''
  const currentDisplayName =
    typeof modalData.currentDisplayName === 'string' ? modalData.currentDisplayName : ''
  const currentIssue = typeof modalData.currentIssue === 'number' ? modalData.currentIssue : null
  const currentPR = typeof modalData.currentPR === 'number' ? modalData.currentPR : null
  const currentLinearIssue =
    typeof modalData.currentLinearIssue === 'string' ? modalData.currentLinearIssue : null
  const currentArtifactUrl =
    typeof modalData.currentArtifactUrl === 'string' ? modalData.currentArtifactUrl : null
  const currentComment =
    typeof modalData.currentComment === 'string' ? modalData.currentComment : ''
  const focusField = typeof modalData.focus === 'string' ? modalData.focus : 'comment'

  const [displayNameInput, setDisplayNameInput] = useState('')
  const [artifactInput, setArtifactInput] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [saving, setSaving] = useState(false)
  const isMac = navigator.userAgent.includes('Mac')

  const artifactInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevIsOpenRef = useRef(false)
  const displayNameInputRef = useRef<HTMLInputElement>(null)
  if (isOpen && !prevIsOpenRef.current) {
    setDisplayNameInput(currentDisplayName)
    setArtifactInput(
      formatCurrentArtifact(currentIssue, currentPR, currentLinearIssue, currentArtifactUrl)
    )
    setCommentInput(currentComment)
  }
  prevIsOpenRef.current = isOpen

  const autoResize = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) {
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [])

  useEffect(() => {
    if (isEditMeta) {
      autoResize()
    }
  }, [isEditMeta, commentInput, autoResize])

  const canSave = useMemo(() => {
    if (!worktreeId) {
      return false
    }
    return parseLinkedArtifactInput(artifactInput) !== null
  }, [worktreeId, artifactInput])
  const parsedArtifact = useMemo(() => parseLinkedArtifactInput(artifactInput), [artifactInput])
  const artifactSummary = useMemo(() => getArtifactSummary(parsedArtifact), [parsedArtifact])
  const ArtifactIcon = artifactSummary.Icon
  const isArtifactInvalid = parsedArtifact === null

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  const handleSave = useCallback(async () => {
    if (!worktreeId) {
      return
    }
    setSaving(true)
    try {
      const parsedArtifact = parseLinkedArtifactInput(artifactInput)
      if (!parsedArtifact) {
        return
      }

      const trimmedDisplayName = displayNameInput.trim()
      const updates: Partial<WorktreeMeta> = {
        comment: commentInput.trim(),
        ...(trimmedDisplayName !== currentDisplayName && {
          displayName: trimmedDisplayName || undefined
        })
      }
      if (parsedArtifact.kind === 'none') {
        updates.linkedIssue = null
        updates.linkedPR = null
        updates.linkedLinearIssue = null
        updates.linkedArtifactUrl = null
      } else if (parsedArtifact.kind === 'github-issue') {
        updates.linkedIssue = parsedArtifact.number
        updates.linkedPR = null
        updates.linkedLinearIssue = null
        updates.linkedArtifactUrl = parsedArtifact.url
      } else if (parsedArtifact.kind === 'github-pr') {
        updates.linkedIssue = null
        updates.linkedPR = parsedArtifact.number
        updates.linkedLinearIssue = null
        updates.linkedArtifactUrl = parsedArtifact.url
      } else {
        updates.linkedIssue = null
        updates.linkedPR = null
        updates.linkedLinearIssue = parsedArtifact.identifier
        updates.linkedArtifactUrl = parsedArtifact.url
      }

      await updateWorktreeMeta(worktreeId, updates)
      closeModal()
    } finally {
      setSaving(false)
    }
  }, [
    worktreeId,
    displayNameInput,
    currentDisplayName,
    artifactInput,
    commentInput,
    updateWorktreeMeta,
    closeModal
  ])

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        handleSave()
      }
    },
    [handleSave]
  )

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSave()
      }
    },
    [handleSave]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          if (focusField === 'displayName') {
            displayNameInputRef.current?.focus()
          } else if (focusField === 'issue') {
            artifactInputRef.current?.focus()
          } else {
            textareaRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base">Workspace Details</DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Update the sidebar name, linked artifact, and workspace notes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="worktree-display-name" className="text-[11px] text-muted-foreground">
              Display Name
            </Label>
            <Input
              id="worktree-display-name"
              ref={displayNameInputRef}
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Use branch or folder name"
              className="h-8 text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Only changes the sidebar label. The folder on disk stays the same.
            </p>
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="worktree-linked-artifact"
              className="gap-1.5 text-[11px] text-muted-foreground"
            >
              <span>Linked Artifact</span>
              <span className="flex items-center gap-1 text-muted-foreground/70">
                <Github className="size-3" aria-label="GitHub" />
                <LinearIcon className="size-3" aria-label="Linear" />
              </span>
            </Label>
            <div className="relative">
              <ArtifactIcon
                className={cn(
                  'pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground',
                  artifactSummary.tone === 'invalid' && 'text-destructive'
                )}
              />
              <Input
                id="worktree-linked-artifact"
                ref={artifactInputRef}
                value={artifactInput}
                onChange={(e) => setArtifactInput(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="GitHub URL, PR #123, #123, or ENG-123"
                aria-invalid={isArtifactInvalid}
                className="h-8 pr-8 pl-8 text-xs"
              />
              {artifactInput.trim() ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setArtifactInput('')}
                  className="absolute right-1 top-1/2 size-6 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
                  aria-label="Clear linked artifact"
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>
            <p
              className={cn(
                'text-[10px] leading-4 text-muted-foreground',
                artifactSummary.tone === 'invalid' && 'text-destructive'
              )}
            >
              {artifactSummary.detail}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="worktree-comment" className="text-[11px] text-muted-foreground">
              Comment
            </Label>
            <textarea
              id="worktree-comment"
              ref={textareaRef}
              value={commentInput}
              onChange={(e) => setCommentInput(e.target.value)}
              onKeyDown={handleCommentKeyDown}
              placeholder="Notes about this worktree..."
              rows={3}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto"
            />
            <p className="text-[10px] text-muted-foreground">
              Supports **markdown** — bold, lists, `code`, links. Press Enter or{' '}
              {isMac ? 'Cmd' : 'Ctrl'}+Enter to save, Shift+Enter for a new line.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || saving} className="text-xs">
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default WorktreeMetaDialog
