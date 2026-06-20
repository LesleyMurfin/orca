# Floating-workspace terminal on a remote `orca serve` runtime fails with `selector_not_found`

## Summary

When the desktop client is paired to a **remote `orca serve` runtime** (bridge-free
serve topology), opening a terminal in the **floating workspace** produces a **black
terminal pane** and the error:

> `selector_not_found` — "If this persists, please file an issue."

The same action works correctly when the client is **not** connected to a serve
runtime (local mode), because the floating terminal then spawns a local PTY that
needs no server-side worktree.

Root cause: the floating workspace identifies itself with a **synthetic worktree id**
(`global-floating-terminal`) that is not a real registered worktree. When a serve
runtime is active, the client asks the serve to spawn the terminal session for that
worktree id; the serve's worktree-selector resolver has no entry that matches the
synthetic id and throws `selector_not_found`.

## Environment

- **Orca version:** v1.4.88 (`package.json` `"version": "1.4.88"`)
- **Topology:** Windows desktop client paired to a remote `orca serve` runtime
  running in WSL (bridge-free serve topology — client is a thin pairing client, the
  serve owns the real worktrees).
- **Trigger:** floating workspace (not a repo workspace), open a terminal, while a
  runtime environment is active (`settings.activeRuntimeEnvironmentId` set and the
  web-runtime session is active).

## Reproduction

1. Start `orca serve` on a remote/WSL host with one or more real repos/worktrees
   registered.
2. From the desktop client, pair to that serve runtime and confirm it is the active
   runtime environment.
3. Switch to the **floating workspace** (the global, repo-less workspace).
4. Open a new terminal in the floating workspace.

### Expected

A working terminal pane in the floating workspace (the same behavior as local mode).

### Actual

A **black/blank** terminal pane plus the error `selector_not_found`
("If this persists, please file an issue.").

When the client is **not** connected to a serve runtime, step 4 works: a local PTY
opens normally.

## Root-cause chain (verified against the v1.4.88 checkout)

All citations below were opened and confirmed in
`/home/lesley/projects/external/orca-cursorfix` on branch `ai/remote-cursor-fix`.

### 1. The floating workspace uses a synthetic worktree id

`src/shared/constants.ts:125`

```ts
// Why: the floating workspace is a local synthetic workspace, so persistence
// pruning must classify it without consulting the repo catalog.
export const FLOATING_TERMINAL_WORKTREE_ID = 'global-floating-terminal'
```

This id is **not** a real registered worktree. The renderer routing layer already
documents this assumption at `src/renderer/src/lib/http-link-routing.ts:45-47`:

```ts
if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
  // Why: the floating workspace uses a synthetic worktree id. Promoting it
  // to the global activeWorktreeId deselects the real repo workspace.
  state.setActiveWorktree(worktreeId)
}
```

### 2. With a serve runtime active, the client asks the serve to spawn the session

Creation path — `src/renderer/src/lib/floating-workspace-tab-creation.ts:32-43`:

```ts
if (
  await createWebRuntimeSessionTerminal({
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    environmentId: runtimeEnvironmentId,
    targetGroupId,
    command: shellOverride,
    activate: true,
    selectWorktree: false
  })
) {
  return null
}
// local-PTY fallback (only reached when the call above returns false):
const tab = store.createTab(FLOATING_TERMINAL_WORKTREE_ID, targetGroupId, shellOverride, {
  activate: false
})
```

Activate/cycle path — `src/renderer/src/lib/floating-workspace-terminal-actions.ts:140-147`:

```ts
if (next.type === 'terminal') {
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    void activateWebRuntimeSessionTab({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabId: next.id,
      environmentId: runtimeEnvironmentId
    })
  }
  ...
}
```

The actual RPC is issued in `src/renderer/src/runtime/web-runtime-session.ts:45-99`
(`createWebRuntimeSessionTerminal`). It converts the worktree id to a runtime
selector before sending it to the serve — `web-runtime-session.ts:72`:

```ts
params: {
  worktree: toRuntimeWorktreeSelector(args.worktreeId),
  ...
}
```

`toRuntimeWorktreeSelector` (`src/renderer/src/runtime/runtime-worktree-selector.ts:3-9`)
prefixes a bare id with `id:`, so the serve receives the selector
**`id:global-floating-terminal`**:

```ts
export function toRuntimeWorktreeSelector(worktreeId: string): string {
  const trimmed = worktreeId.trim()
  if (!trimmed || trimmed.startsWith('id:')) return trimmed
  return `id:${trimmed}`
}
```

### 3. The serve's selector resolver cannot match the synthetic id → throws

`src/main/runtime/orca-runtime.ts:15484` — `OrcaRuntimeService.resolveWorktreeSelector(selector)`.

The selector `id:global-floating-terminal` enters the `id:` branch
(`orca-runtime.ts:15491-15509`): it filters the runtime's **real** worktrees by
`worktree.id === 'global-floating-terminal'` (no match), then tries the
`buildResolvedWorktreeFromId` fallback, which requires real repo/worktree metadata
that does not exist for the synthetic id. `candidates` stays empty, and at the end of
the resolver:

`src/main/runtime/orca-runtime.ts:15540-15546`

```ts
if (candidates.length === 1) {
  return candidates[0]
}
if (candidates.length > 1) {
  throw new Error('selector_ambiguous')
}
throw new Error('selector_not_found')
```

Note: the resolver already special-cases one non-worktree selector — the literal
`'active'` selector throws `selector_not_found` deliberately at
`orca-runtime.ts:15487-15489`. There is no analogous branch for the floating /
global synthetic id.

### 4. The renderer recognizes and surfaces `selector_not_found`

`src/renderer/src/store/slices/worktrees.ts:579-586` (`isSelectorNotFoundError`)
matches the error code/message across several response shapes:

```ts
return (
  message === 'selector_not_found' ||
  message.includes('selector_not_found') ||
  code === 'selector_not_found' ||
  responseCode === 'selector_not_found' ||
  responseMessage === 'selector_not_found' ||
  String(error).includes('selector_not_found')
)
```

### 5. Why local mode works

When no serve runtime is active, `isWebRuntimeSessionActive(...)` is false, so
`createWebRuntimeSessionTerminal` short-circuits and returns `false`
(`web-runtime-session.ts:60-62`). The floating tab-creation path then falls through
to the local-PTY branch `store.createTab(FLOATING_TERMINAL_WORKTREE_ID, ...)`
(`floating-workspace-tab-creation.ts:45`), which needs no server-side worktree, so
the terminal opens normally.

## Open detail to confirm at runtime (honesty note)

`createWebRuntimeSessionTerminal` wraps its RPC in a `try/catch` that logs a
`console.warn` and returns `false` on error (`web-runtime-session.ts:92-98`). On the
*creation* path that `false` should route to the local-PTY fallback. The fact that a
**black pane + visible `selector_not_found`** is observed instead means the error is
surfaced (not swallowed to fallback) on at least one path — most likely the tab
**activate** / PTY-attach path (`activateWebRuntimeSessionTab`, and the PTY transport
that attaches to a serve-owned session), where `isSelectorNotFoundError`
(`worktrees.ts:579`) is consulted to render the error rather than silently fall back.
The exact surface point should be confirmed against a live repro before the fix PR so
the fix targets the path that actually fails, not only the creation catch.

## Candidate fix directions

### (a) Serve-side — accept the synthetic/global scope as a virtual session

Teach `resolveWorktreeSelector` (or the `session.tabs.createTerminal` /
`worktree.activate` handlers) to recognize `global-floating-terminal` (and/or an
explicit `global:`/`floating:` selector) as a **virtual, repo-less session** not
bound to a real worktree, and spawn a runtime PTY in a sensible default cwd (e.g. the
serve's home or workspace root) instead of throwing `selector_not_found`.

- Pros: floating terminals then work end-to-end on serve, parity with local mode;
  keeps the synthetic-id design intact; aligns with the resolver already
  special-casing `'active'`.
- Cons: introduces a server-side notion of a worktree-less session; needs a defined
  cwd contract and tab-graph placement for sessions with no worktree.

### (b) Client-side — bind floating terminals to a real worktree when serve-connected

When a serve runtime is active, resolve the floating terminal to a concrete,
serve-known worktree selector (e.g. the active/last worktree, or a designated
default) instead of sending `id:global-floating-terminal`.

- Pros: no server change; reuses the existing renderer selector-normalization layer
  (see `src/renderer/src/runtime/runtime-worktree-selector.ts` and the precedent in
  PR #4582 "Fix remote runtime worktree selectors", which normalizes renderer
  worktree ids to runtime `id:` selectors before RPCs).
- Cons: changes the semantics of the floating workspace under serve (it's no longer
  repo-less); ambiguous when no real worktree exists yet on the serve.

### (c) Client-side — keep floating terminals local even when serve-connected

Skip the web-runtime session path for `FLOATING_TERMINAL_WORKTREE_ID` and always take
the local-PTY fallback, so a floating terminal runs on the **client** machine even
while paired to a serve runtime.

- Pros: smallest, most surgical change; matches the "floating workspace is a local
  synthetic workspace" comment at `constants.ts:123-124`; no server change.
- Cons: floating terminals would run locally, not on the serve host — which may
  surprise users who expect everything in a serve-paired client to run remotely; the
  floating workspace becomes split-brained (local terminals, remote repo terminals).

## Upstream

- Repo: `stablyai/orca` (default branch `main`). Maintainer org `stablyai`.
- No existing upstream issue was found for this specific bug
  (floating terminal on serve → `selector_not_found`) as of 2026-06-20.
- Closest precedent: issue **#5695** / PR **#5696** ("support worktree name
  selectors") added a new `name:` branch to the same `resolveWorktreeSelector` and is
  the template for the serve-side approach (a). PR **#4582** ("Fix remote runtime
  worktree selectors") is the template for the client-side selector-normalization
  approach (b).
