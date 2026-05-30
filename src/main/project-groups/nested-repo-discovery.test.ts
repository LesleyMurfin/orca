import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { scanNestedRepos } from './nested-repo-discovery'

let tempDirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-nested-repos-'))
  tempDirs.push(dir)
  return dir
}

async function makeGitRepo(path: string): Promise<void> {
  await mkdir(join(path, '.git'), { recursive: true })
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('scanNestedRepos', () => {
  it('returns child repos for a non-git parent', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'auth-service'), { recursive: true })
    await mkdir(join(root, 'billing-service'), { recursive: true })
    await makeGitRepo(join(root, 'auth-service'))
    await makeGitRepo(join(root, 'billing-service'))

    const result = await scanNestedRepos({ path: root })

    expect(result.selectedPathKind).toBe('non_git_folder')
    expect(result.repos.map((repo) => repo.displayName)).toEqual([
      'auth-service',
      'billing-service'
    ])
  })

  it('does not scan inside an already discovered repo', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'service', 'nested'), { recursive: true })
    await makeGitRepo(join(root, 'service'))
    await makeGitRepo(join(root, 'service', 'nested'))

    const result = await scanNestedRepos({ path: root })

    expect(result.repos.map((repo) => repo.displayName)).toEqual(['service'])
  })

  it('prefers shallow sibling repos before descending into non-repo folders', async () => {
    const directories = new Map([
      ['/workspace', ['archive', 'z-web-client']],
      [
        '/workspace/archive',
        Array.from(
          { length: 101 },
          (_, index) => `archived-service-${String(index + 1).padStart(3, '0')}`
        )
      ]
    ])
    const gitRepos = new Set([
      '/workspace/z-web-client',
      ...Array.from(
        { length: 101 },
        (_, index) => `/workspace/archive/archived-service-${String(index + 1).padStart(3, '0')}`
      )
    ])

    const result = await scanNestedRepos({
      path: '/workspace',
      options: { maxRepos: 100 },
      filesystem: {
        readDirectory: async (dirPath) =>
          (directories.get(dirPath) ?? []).map((name) => ({ name, isDirectory: true })),
        joinPath: (parentPath, childName) => `${parentPath}/${childName}`,
        basename: (path) => path.split('/').at(-1) ?? path,
        isGitRepoPath: (path) => gitRepos.has(path)
      }
    })

    expect(result.repos).toHaveLength(100)
    expect(result.repos[0].path).toBe('/workspace/z-web-client')
    expect(result.repos.map((repo) => repo.path)).toContain('/workspace/z-web-client')
    expect(result.truncated).toBe(true)
  })

  it('orders discovered repos by BFS parent queue and alphabetical children per directory', async () => {
    const directories = new Map([
      ['/workspace', ['omega-root', 'gamma-folder', 'beta-root', 'alpha-folder']],
      ['/workspace/alpha-folder', ['z-alpha-child', 'm-alpha-child', 'alpha-nested']],
      ['/workspace/gamma-folder', ['a-gamma-child']],
      ['/workspace/alpha-folder/alpha-nested', ['a-alpha-grandchild']]
    ])
    const gitRepos = new Set([
      '/workspace/beta-root',
      '/workspace/omega-root',
      '/workspace/alpha-folder/m-alpha-child',
      '/workspace/alpha-folder/z-alpha-child',
      '/workspace/gamma-folder/a-gamma-child',
      '/workspace/alpha-folder/alpha-nested/a-alpha-grandchild'
    ])
    const readOrder: string[] = []

    const result = await scanNestedRepos({
      path: '/workspace',
      filesystem: {
        readDirectory: async (dirPath) => {
          readOrder.push(dirPath)
          return (directories.get(dirPath) ?? []).map((name) => ({ name, isDirectory: true }))
        },
        joinPath: (parentPath, childName) => `${parentPath}/${childName}`,
        basename: (path) => path.split('/').at(-1) ?? path,
        isGitRepoPath: (path) => gitRepos.has(path)
      }
    })

    expect(readOrder).toEqual([
      '/workspace',
      '/workspace/alpha-folder',
      '/workspace/gamma-folder',
      '/workspace/alpha-folder/alpha-nested'
    ])
    expect(result.repos.map((repo) => repo.path)).toEqual([
      '/workspace/beta-root',
      '/workspace/omega-root',
      '/workspace/alpha-folder/m-alpha-child',
      '/workspace/alpha-folder/z-alpha-child',
      '/workspace/gamma-folder/a-gamma-child',
      '/workspace/alpha-folder/alpha-nested/a-alpha-grandchild'
    ])
    expect(result.repos.map((repo) => repo.depth)).toEqual([1, 1, 2, 2, 2, 3])
  })

  it('skips heavy directories and respects result caps', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await mkdir(join(root, 'one'), { recursive: true })
    await mkdir(join(root, 'two'), { recursive: true })
    await makeGitRepo(join(root, 'node_modules', 'ignored'))
    await makeGitRepo(join(root, 'one'))
    await makeGitRepo(join(root, 'two'))

    const result = await scanNestedRepos({ path: root, options: { maxRepos: 1 } })

    expect(result.repos[0].displayName).toBe('one')
    expect(result.truncated).toBe(true)
  })

  it('treats a selected git repo as the existing repo path', async () => {
    const root = await tempRoot()
    await makeGitRepo(root)
    await mkdir(join(root, 'child'), { recursive: true })
    await makeGitRepo(join(root, 'child'))
    await writeFile(join(root, 'README.md'), '')

    const result = await scanNestedRepos({ path: root })

    expect(result.selectedPathKind).toBe('git_repo')
    expect(result.repos).toEqual([])
  })
})
