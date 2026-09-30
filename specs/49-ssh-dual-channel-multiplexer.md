# Spec: PR #49 SSH Dual-Channel Multiplexer Quality & CI Compliance

## Current State

PR #49 (`feat/ssh-dual-channel-multiplexer`) implements `SshDualChannelMultiplexer`, an additive module separating interactive traffic (`pty.*`) and background scans (`fs.*`, `git.*`) across two physical transports to eliminate Head-of-Line blocking.

- **Unit tests**: 27/27 passing in `src/main/ssh/ssh-dual-channel.test.ts` (including Round 3 Inverse Falsification and Round 4 Adversarial Boundary Resilience).
- **Quality Gates**: `pnpm run check:code-quality:changed` passes with **0 findings**. All 7 prior type-assertion violations (`typescript/consistent-type-assertions`) have been eliminated through checked property type guards and documented `SAFETY:` comments adhering to `AGENTS.md`.
- **TypeScript**: Passes clean typecheck via `config/tsconfig.node.json`.
- **Upstream Findings & Convergence Audit**: Fully documented in `docs/audits/ssh-dual-channel-convergence-findings.md`, covering 14 upstream convergence PRs and Layer 2 stabilization RFCs (#16741, #22635, #23299, #24133, #24148, #24147, #24156, #24181, #24185, #24180, #21556, #21793, #22415, #21394, #21403, #21150).

## Summary

The dual-channel multiplexer isolates interactive PTY traffic onto an independent physical transport, preventing latency spikes and terminal freezing caused by background git and filesystem activity.

Vertical slices delivered:
1. **Additive Architecture**: Introduced `SshDualChannelMultiplexer` and `SingleChannelState` without modifying legacy single-channel implementations, preserving backward compatibility and zero blast-radius.
2. **Quality Compliance**: Resolved all casting violations:
   - Native error property assignment (`err.name = 'AbortError'`).
   - Compliant `SAFETY:` annotations for JSON-RPC frame payload casts.
   - Checked type guard for error code extraction (`typeof err === 'object' && err !== null && 'code' in err`).
   - Strict numeric ID checks in test suites.
3. **Comprehensive Test Coverage**: Expanded test suite to 27 tests verifying custom error codes, incoming request handlers, abort signal handling, cancellation routing to originating channel, disposal behavior, multi-channel routing, synchronous write error cleanup, and post-disposal boundary resilience.
4. **Upstream Alignment**: Grounded in upstream precedents (Bun 1.4.2 runtime #22635, Plain SSH multi-channel #24147, Node runtime ladder #24133/#24148, stream drains #24185, RFC #21556).

## Files Touched

- `src/main/ssh/ssh-dual-channel-multiplexer.ts` (Core dual-channel multiplexer implementation)
- `src/main/ssh/ssh-dual-channel-state.ts` (Channel state machine and registry)
- `src/main/ssh/ssh-dual-channel.test.ts` (Unit test suite, 21 tests)
- `docs/audits/ssh-dual-channel-convergence-findings.md` (Upstream convergence analysis)
- `specs/49-ssh-dual-channel-multiplexer.md` (Specification and readiness audit)

## Verification Commands & Evidence

- **Lint & Quality Gate**:
  ```bash
  pnpm run check:code-quality:changed
  ```
  *Result*: 0 errors, 0 warnings.
- **Unit Tests**:
  ```bash
  pnpm test src/main/ssh/ssh-dual-channel.test.ts
  ```
  *Result*: 27/27 tests passing across all suites.
- **Typecheck**:
  ```bash
  node --stack-size=4096 --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit -p config/tsconfig.node.json
  ```
  *Result*: 0 type errors.

## Next Steps for Merge

PR #49 is verified and ready for review and merge into `main`. Subsequent follow-up PRs will wire `SshDualChannelMultiplexer` into the SSH connection factory once transport capability negotiation is integrated.
