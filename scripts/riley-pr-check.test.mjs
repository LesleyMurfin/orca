import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = resolve(__dirname, 'riley-pr-check.mjs')

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    ...opts,
  })
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  }
}

describe('riley pr-check CLI', () => {
  it('shows help with usage and does not mention forbidden brand names', () => {
    const res = runCli(['--help'])
    assert.strictEqual(res.status, 0)
    assert.match(res.stdout, /riley pr-check/)
    assert.match(res.stdout, /plan/)
    assert.match(res.stdout, /check/)
    // Must not mention bverify or aislopcheck in user-facing strings
    assert.doesNotMatch(res.stdout, /\bbverify\b/i)
    assert.doesNotMatch(res.stdout, /\baislopcheck\b/i)
    assert.doesNotMatch(res.stdout, /\baicodegate\b/i)
  })

  it('fails with MANUAL_REVIEW (exit 2) if directory is not a git repo', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-nogit-'))
    try {
      const res = runCli(['plan', '--cwd', tempDir])
      assert.strictEqual(res.status, 2)
      assert.match(res.stdout, /MANUAL_REVIEW/)
      assert.match(res.stdout, /not inside a git repository/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('fails with MANUAL_REVIEW (exit 2) if target ref does not exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-git-'))
    try {
      // Init a bare git repo with one commit
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'README.md'), '# Test')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      const res = runCli(['plan', '--cwd', tempDir, '--target', 'nonexistent-ref-xyz'])
      assert.strictEqual(res.status, 2)
      assert.match(res.stdout, /MANUAL_REVIEW/)
      assert.match(res.stdout, /Cannot compute merge-base/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('exits 0 with PASS on plan when merge-tree is clean', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-clean-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'file.txt'), 'hello\n')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'commit 1'], { cwd: tempDir })

      // Create branch feature
      spawnSync('git', ['checkout', '-b', 'feature'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'file2.txt'), 'world\n')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'commit 2'], { cwd: tempDir })

      const res = runCli(['plan', '--cwd', tempDir, '--target', 'main'])
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /Status:\s+PASS/)
      assert.match(res.stdout, /CLEAN/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('exits 1 with FAIL on plan when merge-tree has conflicts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-conflict-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'file.txt'), 'line 1\n')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'commit 1'], { cwd: tempDir })

      // Create feature branch and edit file.txt
      spawnSync('git', ['checkout', '-b', 'feature'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'file.txt'), 'feature change\n')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'feature edit'], { cwd: tempDir })

      // Go back to main and make conflicting edit
      spawnSync('git', ['checkout', 'main'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'file.txt'), 'main conflict change\n')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'main edit'], { cwd: tempDir })

      // Switch back to feature and run plan against main
      spawnSync('git', ['checkout', 'feature'], { cwd: tempDir })

      const res = runCli(['plan', '--cwd', tempDir, '--target', 'main'])
      assert.strictEqual(res.status, 1)
      assert.match(res.stdout, /Status:\s+FAIL/)
      assert.match(res.stdout, /DIRTY/)
      assert.match(res.stdout, /file\.txt/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('fails check with MANUAL_REVIEW (exit 2) when no test runner is configured', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-notest-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })
      // package.json without test script
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'dummy' }))
      writeFileSync(join(tempDir, 'index.js'), 'console.log("hi")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      const res = runCli(['check', '--cwd', tempDir, '--target', 'main', '--skip-aislop'])
      assert.strictEqual(res.status, 2)
      assert.match(res.stdout, /MANUAL_REVIEW/)
      assert.match(res.stdout, /Cannot prove tests fail\. Do not open the PR\./)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('exits 0 with VERIFIED_PASS when merge-tree is clean and tests pass', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-pass-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'calc.js'), 'export const add = (a, b) => a + b;')
      writeFileSync(join(tempDir, 'calc.test.js'), 'import "./calc.js";')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      const res = runCli(['check', '--cwd', tempDir, '--target', 'main', '--skip-aislop'])
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /VERIFIED_PASS/)
      assert.match(res.stdout, /Author check passed/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('exits 1 with FAIL when tests fail', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-fail-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(1)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'index.js'), 'console.log("hi")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      const res = runCli(['check', '--cwd', tempDir, '--target', 'main', '--skip-aislop'])
      assert.strictEqual(res.status, 1)
      assert.match(res.stdout, /FAIL/)
      assert.match(res.stdout, /Targeted tests failed/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('composes required aislop step: exits 0 VERIFIED_PASS when aislop exits 0 and tests pass', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-aislop-pass-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'file.js'), 'console.log("hello")')
      writeFileSync(join(tempDir, 'file.test.js'), 'console.log("test")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      // Fake aislop command that exits 0
      const fakeAislop = 'node -e "console.log(\'aislop clean\'); process.exit(0)"'
      const res = runCli(['check', '--cwd', tempDir, '--target', 'main'], {
        env: { ...process.env, RILEY_PR_CHECK_AISLOP_CMD: fakeAislop },
      })
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /VERIFIED_PASS/)
      assert.match(res.stdout, /Author check passed/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('composes required aislop step: exits 1 FAIL when aislop flags findings (exit 1)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-aislop-fail-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'file.js'), 'console.log("hello")')
      writeFileSync(join(tempDir, 'file.test.js'), 'console.log("test")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      const fakeAislop = 'node -e "console.error(\'slop detected\'); process.exit(1)"'
      const res = runCli(['check', '--cwd', tempDir, '--target', 'main'], {
        env: { ...process.env, RILEY_PR_CHECK_AISLOP_CMD: fakeAislop },
      })
      assert.strictEqual(res.status, 1)
      assert.match(res.stdout, /FAIL/)
      assert.match(res.stdout, /aislop found leftover AI slop\. Do not open the PR\./)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('composes required aislop step: exits 2 MANUAL_REVIEW when aislop crashes or is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-aislop-crash-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'file.js'), 'console.log("hello")')
      writeFileSync(join(tempDir, 'file.test.js'), 'console.log("test")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      // Simulated crash/missing command
      const fakeAislop = 'node -e "process.exit(127)"'
      const res = runCli(['check', '--cwd', tempDir, '--target', 'main'], {
        env: { ...process.env, RILEY_PR_CHECK_AISLOP_CMD: fakeAislop },
      })
      assert.strictEqual(res.status, 2)
      assert.match(res.stdout, /MANUAL_REVIEW/)
      assert.match(res.stdout, /Cannot run aislop\. Do not open the PR\./)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('composes required aislop step: exits 2 MANUAL_REVIEW when score withheld / unsupported / empty', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-aislop-withheld-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'file.js'), 'console.log("hello")')
      writeFileSync(join(tempDir, 'file.test.js'), 'console.log("test")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      // Isolated withhold response with exit 0 but output indicates score withheld / unsupported / empty json
      const fakeAislop = 'node -e "console.log(\'Score withheld: unsupported language\'); process.exit(0)"'
      const res = runCli(['check', '--cwd', tempDir, '--target', 'main'], {
        env: { ...process.env, RILEY_PR_CHECK_AISLOP_CMD: fakeAislop },
      })
      assert.strictEqual(res.status, 2)
      assert.match(res.stdout, /MANUAL_REVIEW/)
      assert.match(res.stdout, /aislop did not score this change\. Do not treat that as a pass\./)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('--skip-aislop skips aislop step and proceeds directly to tests', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-skip-aislop-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'file.js'), 'console.log("hello")')
      writeFileSync(join(tempDir, 'file.test.js'), 'console.log("test")')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      // Even if aislop would fail, --skip-aislop ignores it
      const fakeAislop = 'node -e "console.error(\'should not be called\'); process.exit(1)"'
      const res = runCli(['check', '--cwd', tempDir, '--target', 'main', '--skip-aislop'], {
        env: { ...process.env, RILEY_PR_CHECK_AISLOP_CMD: fakeAislop },
      })
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /VERIFIED_PASS/)
      assert.match(res.stdout, /Author check passed/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('warns when production files changed but zero matching test files are in the diff', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-prod-notest-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'dummy',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      writeFileSync(join(tempDir, 'index.js'), 'initial')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir })

      // Create branch and modify only production file index.js
      spawnSync('git', ['checkout', '-b', 'feature'], { cwd: tempDir })
      writeFileSync(join(tempDir, 'index.js'), 'modified production file')
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'modify prod'], { cwd: tempDir })

      const res = runCli(['check', '--cwd', tempDir, '--target', 'main', '--skip-aislop'])
      // Tests still pass, but warning must be printed
      assert.strictEqual(res.status, 0)
      assert.match(res.stdout, /WARNING: Production files changed but zero matching test files/)
      assert.match(res.stdout, /VERIFIED_PASS/)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('bootstraps .riley/map.yml and stub context.md on plan when repo has no standards files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-bootstrap-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(join(tempDir, 'README.md'), '# Dummy Project\n')
      mkdirSync(join(tempDir, 'src'), { recursive: true })
      writeFileSync(join(tempDir, 'src', 'foo.js'), 'export const foo = 42\n')
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'bootstrap-test',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        })
      )
      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'feat: initial commit with src/foo.js'], { cwd: tempDir })

      const res = runCli(['plan', '--cwd', tempDir, '--target', 'main', '--json'])
      assert.strictEqual(res.status, 0)

      const parsed = JSON.parse(res.stdout)
      assert.strictEqual(parsed.status, 'PASS')
      assert.ok(parsed.map, 'map should be included in plan result')
      assert.deepStrictEqual(parsed.map.manifests, ['package.json'])
      assert.ok(parsed.map.core_paths.includes('src/foo.js'), 'core_paths must include src/foo.js')
      assert.strictEqual(parsed.map.standards.length, 0, 'standards must be empty')
      assert.strictEqual(parsed.map.inferred, true, 'inferred must be true when standards empty')
      assert.ok(parsed.map.recent.length > 0, 'recent history must contain commits')
      assert.strictEqual(parsed.map.recent[0].subject, 'feat: initial commit with src/foo.js')
      assert.ok(parsed.map.recent[0].files.includes('src/foo.js'))

      // Check .riley/ files created on disk
      const mapFilePath = join(tempDir, '.riley', 'map.yml')
      const contextFilePath = join(tempDir, '.riley', 'context.md')
      assert.ok(existsSync(mapFilePath), '.riley/map.yml must exist')
      assert.ok(existsSync(contextFilePath), '.riley/context.md must exist')

      const mapContent = readFileSync(mapFilePath, 'utf-8')
      assert.match(mapContent, /manifests:/)
      assert.match(mapContent, /package\.json/)
      assert.match(mapContent, /src\/foo\.js/)
      assert.match(mapContent, /inferred:\s*true/)
      assert.match(mapContent, /standards:\s*\[\]/)

      const contextContent = readFileSync(contextFilePath, 'utf-8')
      assert.match(contextContent, /unconfirmed; inferred from sample; not repo law\./)

      // Must NOT create fake AGENTS.md or STYLEGUIDE
      assert.strictEqual(existsSync(join(tempDir, 'AGENTS.md')), false, 'Must not create fake AGENTS.md')
      assert.strictEqual(existsSync(join(tempDir, 'STYLEGUIDE.md')), false, 'Must not create fake STYLEGUIDE.md')
      assert.strictEqual(existsSync(join(tempDir, '.riley', 'themes.yml')), false, 'Must not write themes.yml in slice')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects existing standards and does not overwrite existing context.md', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'riley-pr-check-test-standards-'))
    try {
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir })
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir })

      writeFileSync(join(tempDir, 'AGENTS.md'), '# Real Agents\n')
      writeFileSync(join(tempDir, 'STYLEGUIDE.md'), '# Real Styleguide\n')
      mkdirSync(join(tempDir, '.riley'), { recursive: true })
      writeFileSync(join(tempDir, '.riley', 'context.md'), '# Existing Custom Context\n')

      spawnSync('git', ['add', '.'], { cwd: tempDir })
      spawnSync('git', ['commit', '-m', 'initial standards commit'], { cwd: tempDir })

      const res = runCli(['plan', '--cwd', tempDir, '--target', 'main', '--json'])
      assert.strictEqual(res.status, 0)

      const parsed = JSON.parse(res.stdout)
      assert.strictEqual(parsed.map.inferred, false)
      assert.ok(parsed.map.standards.includes('AGENTS.md'))
      assert.ok(parsed.map.standards.includes('STYLEGUIDE.md'))

      // Custom context.md was preserved
      const contextContent = readFileSync(join(tempDir, '.riley', 'context.md'), 'utf-8')
      assert.strictEqual(contextContent, '# Existing Custom Context\n')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
