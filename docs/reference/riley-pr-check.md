# Riley PR Check

## Current State

Lesley wants one check she can run on **any repo / any code** so issues are caught **before a maintainer** (nwparker-class) sees them; and the **same check in maintainer mode** on **dot-ai-grafana** (and later other repos she owns) so inbound PRs don’t land slop. Free wedge toward aicostoptimizer later — **not** a feature inside that app. No public brand. Command: `riley pr-check`. Slice 1 is being built as the author-side gate only.

This document represents the definitive design freeze and single source of truth (SSOT).

## Product

- **Audience:** Vibe coders / AI engineers. `nwparker` is the bar (the standard of quality and maintainer rigor), not the user.
- **Two Modes (Same Engine, Different Report Destination):**
  1. **Author mode:** Run locally before submission to block `create-pr` / `create-upstream-pr` until the code is verified as real, operational, and non-hallucinatory.
  2. **Maintainer mode:** Inbound PR validation on repos owned by Lesley, starting at **dot-ai-grafana** (and expanding to other repos later) to prevent inbound PRs from landing slop. Same underlying verification engine, routing report output to maintainer PR comments/verdicts.
- **Any-Repo Universal Contract:**
  - Operates across any repository or codebase.
  - Auto-detects supported project layers and runtime conventions.
  - Refuses inapplicable layers cleanly — **never silent PASS**. If a layer cannot be run or detected, it explicitly skips or flags rather than reporting an ungrounded pass.
- **Go-To-Market / Positioning:**
  - Free wedge toward `aicostoptimizer` later.
  - Distinct and separate from the `aicostoptimizer` binary — **not** a feature or tab inside that app.
- **Naming:**
  - Unnamed product with no public brand.
  - Invoked strictly as the CLI command: `riley pr-check`.
- **Dead Names (Names We Will NOT Use):**
  - `aicodegate`: Avoids confusion with existing tooling (Stacklok CodeGate).
  - `aicode`: Collides with other existing command-line interfaces.
  - `aitestgate`: Category description rather than a command identifier.
  - `aicodeoptimizer`: Focuses on the wrong verb (optimization instead of verification).
  - `aislopcheck`: Conflicts with package naming.
  - `bverify` in the UI: Retired alias.

## Compose, Don't Clone

- **Static analysis integration:** Required composed step executes `aislop` (default: `npx --yes aislop@latest ci --changes --base <target>`, fallback: `npx --yes aislop@latest scan --changes --base <target> --json`) as a fail-closed gate unless `--skip-aislop` is passed. Clean aislop exit 0 allows execution to proceed to tests (never `VERIFIED_PASS` from aislop alone). Exit 1 fails the check (`FAIL`), crash or missing runner blocks with `MANUAL_REVIEW`, and withheld score or unsupported language triggers `MANUAL_REVIEW` (withhold ≠ PASS). Do not clone its logic into our codebase. Do not name ourselves `aislop`.
- **Core verification engine:** The gate independently performs:
  - `merge-tree` comparison against `origin/main` to detect drift, conflicts, and resurrected deleted files.
  - Execution of targeted tests capable of failing.
  - Live probing if runtime, PTY, or cgroup boundaries are touched by the diff (in later iterations).
  - Fail-closed execution posture on error or uncertainty.
- **Separation of concerns:** Prose slop stays in `no-ai-slop`; natural-language evaluation is explicitly out of scope for this code gate.

## ADW Integration

Code gate, not agent self-grade. Operates across four call sites only:
1. **PLAN:** `riley pr-check plan` (pre-flight sanity check on plan boundaries).
2. **After BUILD:** Fast-path validation on modified assets.
3. **TEST:** Full verification suite execution.
4. **FINISH:** Hard block preventing pull request creation if checks fail.

Must not be hooked into: scout exploration runs, every intermediary execution hop, or Temporal worker workflows. No 3K PR drain.

## First Slice (Author-Side Gate Only)

The first slice builds the author-side gate only across four steps:
1. **`merge-tree` / resurrected deleted files check:** Compares branch against `origin/main` to catch resurrected files and branch drift.
2. **`aislop` check (required composed step):** Runs `aislop` against changes (`ci` with fallback to `scan --changes --base <target> --json`). Fail-closed: findings fail the gate, crash or withheld score yields `MANUAL_REVIEW` (withhold ≠ PASS), `--skip-aislop` provides an escape hatch. Never treats an aislop score alone as `VERIFIED_PASS`.
3. **Targeted tests + "tests can fail" check:** Runs targeted tests on touched code and verifies tests can fail (no in-house mutator required for slice 1).
4. **Verdict gate:** Emits `FAIL` or `MANUAL_REVIEW` → hard blocks PR creation (`create-pr`).

Outputs a concise, plain English report.

## Later Expansions (Post-Slice 1)

- Live PTY / cgroup probing if diff touches them.
- Maintainer mode comments and PR reviews on `dot-ai-grafana` (and other owned repos).
- Profiles for payload-next / `aicostoptimizer` monetization.

## Non-Goals for Slice 1

- Maintainer mode automation on `dot-ai-grafana` (deferred to subsequent slice; slice 1 is author mode only).
- Not a tab or feature inside `aicostoptimizer`.
- 3K PR drain automation.
- Temporal workflow integration.
- FitNesse test fixtures.
- In-house mutation engine (uses targeted tests + basic "tests can fail" check without building a custom mutator).
- Debian systemd test matrices.
- Payload or `aicostoptimizer` profiling suites.
