import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from '@orca/process-host'
import { verifyRequiredPrContext } from '../../.github/scripts/check-required-pr-context.mjs'

it('reserves the required PR context for the full aggregate with both YAML parsers', () => {
  expect(() => verifyRequiredPrContext(parse)).not.toThrow()
  const result = runProcessSync({
    program: 'bun',
    args: ['.github/scripts/check-required-pr-context.mjs'],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 10_000
  })
  expect(result.code, result.stderr).toBe(0)
})

it('checks context names even when workflow-only changes skip root tests', () => {
  const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
  const job = workflow.jobs.code_paths
  const step = job.steps.find(
    (candidate) => candidate.run === 'bun .github/scripts/check-required-pr-context.mjs'
  )
  expect(step).toBeDefined()
  expect(job.if).toBeUndefined()
  expect(step.if).toBeUndefined()
  expect(step['continue-on-error']).toBeUndefined()
  const checkout = job.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'))
  for (const path of [
    '/.github/workflows/',
    '/.github/scripts/check-required-pr-context.mjs',
    '/config/.bun-version'
  ]) {
    expect(checkout.with['sparse-checkout'].split('\n')).toContain(path)
  }
})
