# Spec: PR #49 SSH Channel Multiplexer 1..N Transports

## Current State

PR #49 extends **`SshChannelMultiplexer`** (the one production mux) to accept **1..N physical transports**. There is no second public multiplexer class.

- **Constructor input:** `MultiplexerTransport` | `MultiplexerTransport[]` | `{ interactive, background }`
- **N === 1:** Full legacy single-pipe behavior (writer lanes, health timer, keepalives) — all existing callers unchanged.
- **N >= 2:** Internal `MultiChannelMuxBackend` routes interactive vs background/bulk by transport index.
- **Unit tests:** `ssh-channel-multiplexer-multi.test.ts` + dual-mode tests + legacy `ssh-channel-multiplexer.test.ts` — **93 related tests green**.
- **E2E:** `ssh-dual-channel-system-transport.integration.test.ts` drives two real SSH exec channels via `new SshChannelMultiplexer([t0, t1])`.
- **WAN:** Calgary ↔ Montreal benchmark uses `SshChannelMultiplexer` single vs array-of-two under 5MB flood.
- **Quality:** `pnpm run check:code-quality:changed` / typecheck clean targets.

## Summary

One public type. Hosts with one session keep one pipe. Hosts that can open more pipes pass 2..N transports; keystrokes stay on index 0 while bulk fs/git can use the last index when N≥3.

## Files to Touch

- `src/main/ssh/ssh-channel-multiplexer.ts` — constructor + multi delegation
- `src/main/ssh/ssh-multi-channel-backend.ts` — N-channel backend
- `src/main/ssh/ssh-dual-channel-state.ts` — normalize/selectTransportIndex/registry
- `src/main/ssh/ssh-channel-multiplexer-multi.test.ts` — 1/2/3 transport matrix
- `src/main/ssh/ssh-dual-channel.test.ts` — dual-mode coverage via SshChannelMultiplexer
- `src/main/ssh/ssh-dual-channel-system-transport.integration.test.ts`
- `scripts/calgary-montreal-wan-benchmark.ts`
- `specs/49-ssh-dual-channel-multiplexer.md`

## Step-by-Step

1. Normalize transports (single | array | dual pair).
2. N≥2 → `MultiChannelMuxBackend`; N===1 → existing single-pipe path.
3. `selectTransportIndex(method, count)` for lane mapping.
4. Tests prove routing, HoL isolation, cancel, liveness, dispose for 1/2/3.
5. Follow-up: wire `ssh-relay-session` to open 2nd `--connect` when possible (MaxSessions fallback stays N=1).

## Verification

```bash
pnpm test src/main/ssh/ssh-channel-multiplexer-multi.test.ts \
  src/main/ssh/ssh-channel-multiplexer.test.ts \
  src/main/ssh/ssh-dual-channel.test.ts \
  src/main/ssh/ssh-dual-channel-system-transport.integration.test.ts
pnpm run check:code-quality:changed
node --stack-size=4096 --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json
```

## Notes for Next Agent

- **Do not** reintroduce `SshDualChannelMultiplexer` as a public class.
- Wiring slice: `deployAndLaunchRelay` + second `relay.js --connect`; on `isSshSessionLimitError` keep N=1.
- Public API remains `SshChannelMultiplexer` only.
