# Spec: PR #49 SSH Channel Multiplexer 1..N + Session Wiring

## Current State

PR #49 extends **`SshChannelMultiplexer`** to accept **1..N physical transports** and wires multi-channel into the live relay session.

- **Constructor:** `MultiplexerTransport` | `MultiplexerTransport[]` | `{ interactive, background }`
- **N === 1:** Legacy single-pipe path (unchanged callers).
- **N >= 2:** `MultiChannelMuxBackend` routes by `selectTransportIndex`.
- **Production wiring:** `createRelaySessionMultiplexer` (`ssh-relay-session-multiplexer.ts`) on `establish` + reconnect:
  - Second `relay.js --connect` when sock/dir/node/credential known.
  - **Fallback** to N=1 on `MaxSessions` or any second-connect failure.
- **Tests:** multi matrix + factory fallback + session regression + E2E dual exec — green.
- **Quality / typecheck:** clean on changed paths.

## Summary

One public mux. Session opens two pipes when the host allows; otherwise single pipe. Typing stays on transport 0; bulk can use later indices when N≥3.

## Files Touched

- `src/main/ssh/ssh-channel-multiplexer.ts`
- `src/main/ssh/ssh-multi-channel-backend.ts`
- `src/main/ssh/ssh-multiplexer-transports.ts`
- `src/main/ssh/ssh-dual-channel-state.ts`
- `src/main/ssh/ssh-relay-session-multiplexer.ts` + `.test.ts`
- `src/main/ssh/ssh-relay-session.ts` (establish + reconnect)
- `src/main/ssh/ssh-channel-multiplexer-multi.test.ts`
- E2E dual transport integration + WAN benchmark script

## Verification

```bash
pnpm test src/main/ssh/ssh-channel-multiplexer-multi.test.ts \
  src/main/ssh/ssh-channel-multiplexer.test.ts \
  src/main/ssh/ssh-relay-session-multiplexer.test.ts \
  src/main/ssh/ssh-relay-session.test.ts \
  src/main/ssh/ssh-dual-channel-system-transport.integration.test.ts
pnpm run check:code-quality:changed
```

## Notes for Next Agent

- Do not reintroduce a second public multiplexer class.
- Calgary↔Montreal WAN re-run after deploy with sockPath-bearing hosts confirms production multi path.
