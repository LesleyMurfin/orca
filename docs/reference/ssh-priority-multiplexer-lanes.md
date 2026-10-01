# SSH priority multiplexer (1..N transports)

**Status:** Implemented on `feat/ssh-dual-channel-multiplexer` (LesleyMurfin/orca#49).  
**Public API:** `SshChannelMultiplexer` only — not a second dual-only class.

## Problem

One SSH RPC pipe head-of-line-blocks interactive PTY traffic behind bulk `fs.*` / `git.*` payloads (WAN freezes of hundreds of ms).

## Design

| Piece | Role |
| :--- | :--- |
| `SshChannelMultiplexer` | Constructor: one transport, `Transport[]`, or `{ interactive, background }` |
| `MultiChannelMuxBackend` | N≥2: per-pipe seq/decoder/dispose |
| `selectMuxPriorityLane` | Method → priority lane |
| `selectTransportIndex` | Lane → transport index `min(rank, N-1)`; interactive stays 0 when N>1 |
| `createRelaySessionMultiplexer` | Opens up to 10 relay `--connect`s; stops on MaxSessions; keeps what opened |

### Priority lanes (highest → lowest)

1. `interactive` — `pty.data`, resize, ack  
2. `control` — `rpc.cancel`, session grace/config  
3. `pty-lifecycle` — spawn / shutdown / kill  
4. `session` — resolveHome, register roots  
5. `ports`  
6. `git-meta` — status / branches  
7. `git-bulk` — diff / log / streams  
8. `fs-meta` — readDir / light probes  
9. `fs-bulk` — listFiles / file streams  
10. `history` — pty history / replay / scrollback  

With **N=10**, each lane owns a pipe. With **N=2**, interactive on 0, everything else on 1. With **N=1**, legacy single-pipe path (writer lanes, health timer).

## Relation to multi-threading

| Axis | Concern | Mechanism |
| :--- | :--- | :--- |
| **Wire** | I/O HoL | Priority transports (this doc) |
| **CPU** | Main-thread block | `WorkerThreadRequestQueue` / `LazyWorkerThreadHost` |

Same lane names can later feed bulk-only worker queues. Do not merge transport routing and worker pools into one controller.

## Now / next / later

- **Now:** routing + session wiring + unit/factory/session tests; real-host smoke with `sockPath`; observe transport count.  
- **Next PRs:** adaptive N, per-transport backpressure, bulk lane → worker queue, connection work ledger per transport.  
- **Later:** optional wire `lane` (capability-negotiated), remote relay workers, WFQ under N=2, BDP/zlib on bulk pipes, speculative echo, QUIC underlay.

Durable lab write-up: **revive_labs** `docs/architecture/orca-ssh-priority-multiplexer-lanes.md` (branch `docs/ssh-priority-mux-lanes`).

## Verification

```bash
pnpm test src/main/ssh/ssh-channel-multiplexer-multi.test.ts \
  src/main/ssh/ssh-channel-multiplexer.test.ts \
  src/main/ssh/ssh-relay-session-multiplexer.test.ts \
  src/main/ssh/ssh-relay-session.test.ts \
  src/main/ssh/ssh-dual-channel-system-transport.integration.test.ts
pnpm run check:code-quality:changed
```
