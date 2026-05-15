import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type LineageScenario = {
  parentId: string
  childId: string
}

function worktreeOption(page: Page, worktreeId: string) {
  return page.locator(`[id="worktree-list-option-${encodeURIComponent(worktreeId)}"]`)
}

async function seedLineageScenario(page: Page): Promise<LineageScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    state.setShowWorkspaceLineage(true)

    const worktrees = Object.values(state.worktreesByRepo)
      .flat()
      .filter((worktree) => !worktree.isArchived)
    if (worktrees.length < 2) {
      throw new Error('Worktree lineage E2E needs at least two worktrees')
    }

    const [parent, child] = worktrees
    store.setState((current) => ({
      worktreesByRepo: Object.fromEntries(
        Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
          repoId,
          repoWorktrees.map((worktree) => {
            if (worktree.id === parent.id) {
              return { ...worktree, displayName: 'E2E lineage parent', sortOrder: 0 }
            }
            if (worktree.id === child.id) {
              return { ...worktree, displayName: 'E2E lineage child', sortOrder: 1 }
            }
            return worktree
          })
        ])
      )
    }))

    store.getState().setActiveWorktree(parent.id)
    return { parentId: parent.id, childId: child.id }
  })
}

test.describe('Worktree Lineage', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('groups a child under the active workspace from the sidebar context menu', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await expect(parentRow).toContainText('E2E lineage parent')
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toContainText('E2E lineage child')
    await childRow.click({ button: 'right' })
    await orcaPage.getByRole('menuitem', { name: 'Group under Active Workspace' }).click()

    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await orcaPage.evaluate(
      ({ parentId, childId }) => {
        const parent = document.getElementById(
          `worktree-list-option-${encodeURIComponent(parentId)}`
        )
        const child = document.getElementById(`worktree-list-option-${encodeURIComponent(childId)}`)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)

    await childToggle.click()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeHidden()
  })
})
