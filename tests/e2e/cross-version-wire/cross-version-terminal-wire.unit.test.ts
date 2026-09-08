import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  parseReleaseCommits,
  resolveBaselineRelease,
  unsatisfiedRuntimeDependencies
} from './release-checkout'
import {
  JOURNEY_INPUTS,
  JOURNEY_STEPS,
  runTerminalSkewJourney,
  type JourneyRecord
} from './terminal-skew-journey'
import {
  loadTerminalWireBuild,
  WORKING_TREE,
  type TerminalWireBuild
} from './versioned-terminal-wire'

// Why: a cold CI run extracts the baseline checkout before the first journey.
const SUITE_TIMEOUT_MS = 180_000

/**
 * The frames one journey must produce, named rather than numbered so a diff reads
 * as a protocol change. Any deviation is a change in what a peer publishes or
 * accepts, and needs a human decision against docs/reference/remote-wire-compatibility.md.
 */
const EXPECTED_JOURNEY_FRAMES = [
  'C>H Subscribe',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Input',
  'H>C Output',
  'C>H SnapshotRequest',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Subscribe',
  'H>C SnapshotStart',
  'H>C SnapshotChunk',
  'H>C SnapshotEnd',
  'C>H Input',
  'C>H Unsubscribe'
]

let baselineVersion: string
let current: TerminalWireBuild
let baseline: TerminalWireBuild

beforeAll(async () => {
  const release = resolveBaselineRelease()
  baselineVersion = release.version
  current = await loadTerminalWireBuild(WORKING_TREE)
  // The commit, not the version: a fork's clone has the release commit in its
  // history but not the tag that names it.
  baseline = await loadTerminalWireBuild(release.commit)
}, SUITE_TIMEOUT_MS)

afterEach(() => {
  // Each journey installs and removes its own window stub; fail loudly if one leaked.
  expect(typeof globalThis.window).toBe('undefined')
})

function expectJourneyActuallyRan(record: JourneyRecord): void {
  // The anti-vacuous-pass oracle. A harness that connects and then does nothing
  // fails here, because "nothing threw" is never enough to call a pairing green.
  expect(record.completed).toEqual([...JOURNEY_STEPS])
  expect(record.frameSequence).toEqual(EXPECTED_JOURNEY_FRAMES)
  expect(record.subscribedEvents).toHaveLength(2)
  expect(record.snapshotStarts).toHaveLength(3)
  expect(record.missingRuntimeMethods).toEqual([])
}

function expectWireCompatible(record: JourneyRecord): void {
  // Rule 2 — no frame may be refused by the receiving build's decoder. An opcode
  // the peer does not know is dropped silently, so this is the only signal.
  expect(record.rejected).toEqual([])
  expect(record.clientErrors).toEqual([])

  // The subscribe handshake still negotiates the optional output-pause opcode,
  // which is what keeps opcode 16 legal to send on this pairing.
  for (const event of record.subscribedEvents) {
    expect(event.capabilities).toEqual({ outputPause: 1 })
  }

  // Input reached the process, before and after the reconnect.
  expect(record.inputAtProcess).toEqual([JOURNEY_INPUTS.first, JOURNEY_INPUTS.second])

  // Rule 3 — what the host publishes, as the client actually rendered it.
  expect(record.snapshotsRendered[0]).toBe(JOURNEY_INPUTS.initialBuffer)
  expect(record.dataRendered.join('')).toBe(JOURNEY_INPUTS.output)
  expect(record.revealSnapshot?.data).toBe(
    `${JOURNEY_INPUTS.initialBuffer}${JOURNEY_INPUTS.output}`
  )
  expect(record.revealSnapshot).toMatchObject({ cols: 120, rows: 40 })
  for (const start of record.snapshotStarts) {
    expect(start).toMatchObject({ kind: 'scrollback', cols: 120, rows: 40, source: 'headless' })
  }
}

describe('cross-version remote terminal wire', () => {
  it('reads release points from release commits, ignoring prereleases', () => {
    expect(
      parseReleaseCommits(
        [
          '5e258a94476edef897526c9e648bef34915f6be4\trelease: v1.4.163',
          '00f0c44a23c84f19975fe73fa172bd8ef81f5903\trelease: v1.4.178-rc.2',
          'b11bfe207c30d38bba0a6b4b6b422b56b12d890c\trelease: v1.4.141',
          'bc98655a39e0d1e5f8ba6e0f4bb3d1cf5a09bb11\tfix(remote): stop an empty host inventory'
        ].join('\n')
      )
    ).toEqual([
      { version: 'v1.4.163', commit: '5e258a94476edef897526c9e648bef34915f6be4' },
      { version: 'v1.4.141', commit: 'b11bfe207c30d38bba0a6b4b6b422b56b12d890c' }
    ])
  })

  it('rejects a release whose runtime dependencies this checkout cannot resolve', () => {
    const installed = { zod: '4.4.3', ws: '8.21.0', 'agent-browser': '0.27.4' }
    // Patch and minor drift inside the range's own line is not a reason to reject:
    // rejecting on any range difference is what left CI with no baseline at all.
    expect(
      unsatisfiedRuntimeDependencies(
        { zod: '~4.4.0', ws: '^8.18.0', 'agent-browser': '~0.27.0' },
        (name) => installed[name as keyof typeof installed] ?? null
      )
    ).toEqual([])
    // A package the release needs and this tree never installed cannot resolve.
    expect(unsatisfiedRuntimeDependencies({ 'proper-lockfile': '4.1.2' }, () => null)).toEqual([
      'proper-lockfile (declared 4.1.2, not installed)'
    ])
    // Across a major — or a 0.x minor — the release calls an API that moved.
    expect(unsatisfiedRuntimeDependencies({ zod: '~3.24.1' }, () => '4.4.3')).toEqual([
      'zod (declared ~3.24.1, installed 4.4.3)'
    ])
    expect(unsatisfiedRuntimeDependencies({ 'agent-browser': '~0.26.0' }, () => '0.27.4')).toEqual([
      'agent-browser (declared ~0.26.0, installed 0.27.4)'
    ])
  })

  it(
    'skews current code against a real published release',
    () => {
      expect(baselineVersion).toMatch(/^v\d+\.\d+\.\d+$/)
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'current client against current server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: current, clientBuild: current })
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'old client against new server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: current, clientBuild: baseline })
      expect(record.clientRevision).toBe(baseline.revision)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )

  it(
    'new client against old server completes the journey',
    async () => {
      const record = await runTerminalSkewJourney({ hostBuild: baseline, clientBuild: current })
      expect(record.hostRevision).toBe(baseline.revision)
      expectJourneyActuallyRan(record)
      expectWireCompatible(record)
    },
    SUITE_TIMEOUT_MS
  )
})
