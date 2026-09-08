/**
 * Artifact share records are pruned as soon as their `expiresAt` passes, so a fixture with a
 * hardcoded expiry is a wall-clock time bomb: the artifact cloud suites went red the day
 * 2026-09-06 arrived, because every saved record was already expired when the next call read it.
 * Fixtures that are not about expiry must therefore stay unexpired relative to the current clock.
 * Suites that do assert expiry behaviour pin the clock with fake timers and pass explicit dates.
 */
export function unexpiredArtifactExpiry(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
}
