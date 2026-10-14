import { describe, expect, it } from 'vitest'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { OrcaRuntimeService } from '../orca-runtime'

function snapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: 'folder:constructor-test',
    publicationEpoch: 'headless:before',
    snapshotVersion: 1,
    activeGroupId: 'group',
    activeTabId: 'tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'tab::leaf',
        title: 'Terminal',
        parentTabId: 'tab',
        leafId: 'leaf',
        isActive: true
      }
    ]
  }
}

class SessionTabRuntime extends OrcaRuntimeService {
  move(
    model: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    return this.moveHeadlessMobileSessionTab(model.worktree, model, move)
  }

  seed(model: RuntimeMobileSessionTabsSnapshot): void {
    this.storeMobileSessionSnapshot(model.worktree, model)
  }

  applyProps(worktreeId: string, tabId: string): void {
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, tabId, { title: 'Updated' })
  }

  readSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined {
    return this.mobileSessionTabsByWorktree.get(worktreeId)
  }

  wait(signal?: AbortSignal): Promise<void> {
    return this.waitForSessionTabsInventoryPublication(signal)
  }

  resolveHostTabMethod() {
    return this.resolveMobileSessionHostTabId
  }

  normalizeOrderMethod() {
    return this.normalizeMobileSessionTabOrder
  }

  lengths(): number[] {
    return [
      this.persistHeadlessSessionTabProps.length,
      this.applyHeadlessSessionTabPropsToSnapshot.length,
      this.getMobileSessionTopLevelTabId.length,
      this.persistHeadlessTerminalPaneLayout.length,
      this.applyHeadlessTerminalPaneLayoutToSnapshot.length,
      this.moveHeadlessMobileSessionTab.length,
      this.splitHeadlessMobileSessionTabGroup.length,
      this.moveHeadlessMobileSessionTabToGroup.length,
      this.requireHeadlessTargetGroup.length,
      this.persistHeadlessTabGroups.length,
      this.waitForSessionTabsInventoryPublication.length,
      this.getAuthoritativeSessionTabsInventoryEpoch.length,
      this.markSessionTabsInventoryPublished.length
    ]
  }
}

class GroupDispatchRuntime extends SessionTabRuntime {
  readonly calls: string[] = []

  protected override splitHeadlessMobileSessionTabGroup(): RuntimeMobileSessionTabMoveResult {
    this.calls.push('split')
    return { moved: true }
  }

  protected override moveHeadlessMobileSessionTabToGroup(): RuntimeMobileSessionTabMoveResult {
    this.calls.push('move-to-group')
    return { moved: true }
  }

  protected override requireHeadlessTargetGroup(
    model: RuntimeMobileSessionTabsSnapshot,
    groupId: string
  ): RuntimeMobileSessionTabGroup {
    this.calls.push('require-group')
    return super.requireHeadlessTargetGroup(model, groupId)
  }

  protected override persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode | null | undefined
  ): void {
    this.calls.push('persist-groups')
    super.persistHeadlessTabGroups(worktreeId, groups, layout)
  }
}

describe('original session tab runtime prototypes', () => {
  it('retains all thirteen native parameter counts, including protected helpers', () => {
    expect(new SessionTabRuntime(null).lengths()).toEqual([3, 3, 1, 2, 2, 3, 3, 3, 2, 3, 1, 0, 0])
  })

  it.each(['split', 'move-to-group'] as const)('uses the runtime %s override', (kind) => {
    const runtime = new GroupDispatchRuntime(null)
    const move: RuntimeMobileSessionTabMove =
      kind === 'split'
        ? { kind, tabId: 'tab', targetGroupId: 'group', splitDirection: 'right' }
        : { kind, tabId: 'tab', targetGroupId: 'group' }
    expect(runtime.move(snapshot(), move)).toEqual({ moved: true })
    expect(runtime.calls).toEqual([kind])
  })

  it('uses both protected runtime group validation and persistence hooks', () => {
    const runtime = new GroupDispatchRuntime(null)
    expect(
      runtime.move(snapshot(), {
        kind: 'reorder',
        tabId: 'tab',
        targetGroupId: 'group',
        tabOrder: ['tab']
      })
    ).toEqual({ moved: true })
    expect(runtime.calls).toEqual(['require-group', 'persist-groups'])
  })

  it('uses the runtime top-level tab ID override while applying properties', () => {
    class TopLevelRuntime extends SessionTabRuntime {
      protected override getMobileSessionTopLevelTabId(
        tab: RuntimeMobileSessionSnapshotTab
      ): string {
        return `override:${super.getMobileSessionTopLevelTabId(tab)}`
      }
    }
    const runtime = new TopLevelRuntime(null)
    const model = snapshot()
    runtime.seed(model)
    runtime.applyProps(model.worktree, 'override:tab')
    expect(runtime.readSnapshot(model.worktree)?.tabs[0].title).toBe('Updated')
  })

  it('uses the runtime epoch override before registering a publication waiter', async () => {
    class EpochRuntime extends SessionTabRuntime {
      protected override getAuthoritativeSessionTabsInventoryEpoch(): number {
        return 7
      }
    }
    const runtime = new EpochRuntime(null)
    const controller = new AbortController()
    const waiting = runtime.wait(controller.signal)
    controller.abort()
    await expect(waiting).resolves.toBeUndefined()
  })

  it.each(['split', 'move-to-group', 'reorder'] as const)(
    'captures the runtime resolver before reading %s tabId',
    (kind) => {
      const runtime = new SessionTabRuntime(null)
      const original = runtime.resolveHostTabMethod()
      const trace: string[] = []
      Object.defineProperty(runtime, 'resolveMobileSessionHostTabId', {
        configurable: true,
        get() {
          trace.push('callee')
          return function (
            this: SessionTabRuntime,
            model: RuntimeMobileSessionTabsSnapshot | undefined,
            tabId: string
          ) {
            trace.push('call')
            expect(this).toBe(runtime)
            return original.call(this, model, tabId)
          }
        }
      })
      const tabId = {
        get tabId() {
          trace.push('tabId')
          return 'tab'
        }
      }
      const move: RuntimeMobileSessionTabMove =
        kind === 'split'
          ? {
              kind,
              get tabId() {
                return tabId.tabId
              },
              targetGroupId: 'group',
              splitDirection: 'right'
            }
          : kind === 'move-to-group'
            ? {
                kind,
                get tabId() {
                  return tabId.tabId
                },
                targetGroupId: 'group'
              }
            : {
                kind,
                get tabId() {
                  return tabId.tabId
                },
                targetGroupId: 'group',
                tabOrder: ['tab']
              }
      expect(runtime.move(snapshot(), move)).toEqual({ moved: true })
      expect(trace.slice(0, 3)).toEqual(['callee', 'tabId', 'call'])
    }
  )

  it('captures the runtime normalizer before reading tabOrder', () => {
    const runtime = new SessionTabRuntime(null)
    const original = runtime.normalizeOrderMethod()
    const trace: string[] = []
    Object.defineProperty(runtime, 'normalizeMobileSessionTabOrder', {
      configurable: true,
      get() {
        trace.push('callee')
        return function (
          this: SessionTabRuntime,
          model: RuntimeMobileSessionTabsSnapshot | undefined,
          group: RuntimeMobileSessionTabGroup,
          order: readonly string[]
        ) {
          trace.push('call')
          expect(this).toBe(runtime)
          return original.call(this, model, group, order)
        }
      }
    })
    expect(
      runtime.move(snapshot(), {
        kind: 'reorder',
        tabId: 'tab',
        targetGroupId: 'group',
        get tabOrder() {
          trace.push('tabOrder')
          return ['tab']
        }
      })
    ).toEqual({ moved: true })
    expect(trace).toEqual(['callee', 'tabOrder', 'call'])
  })

  it('keeps the original scalar and one canonical waiter Set through the constructor seam', () => {
    let atSeam: Set<() => void> | undefined
    let initialEpoch: number | null | undefined
    let topLevelId: string | undefined
    class ConstructorRuntime extends SessionTabRuntime {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        atSeam = this.sessionTabsInventoryWaiters
        initialEpoch = this.sessionTabsInventoryPublicationEpoch
        topLevelId = this.getMobileSessionTopLevelTabId(snapshot().tabs[0])
        return super.canonicalFetchKeyCache
      }
      waiterSet(): Set<() => void> {
        return this.sessionTabsInventoryWaiters
      }
    }
    const runtime = new ConstructorRuntime(null)
    expect(atSeam).toBeInstanceOf(Set)
    expect(runtime.waiterSet()).toBe(atSeam)
    expect(initialEpoch).toBeNull()
    expect(topLevelId).toBe('tab')
  })
})
