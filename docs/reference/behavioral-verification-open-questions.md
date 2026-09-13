# Behavioral Verification: Open Questions & Critical Gaps

This document defines the 5 load-bearing open questions and design gaps that must be resolved to ensure behavioral verification succeeds in production without destroying maintainer trust or operational reliability.

This is not a generic feature roadmap or speculative wishlist. Each gap represents an adoption-killing failure mode and the boring, mechanical fix required.

---

## Explicit Operational Scope Boundary

**HTW Calibration stays strictly OFF the default path** for both Orca (`orca-maintainer-triage`) and aicostoptimizer (`aicostoptimizer-maintainer-eval`). 

HTW (Hypothesis Testing Walk / high-touch calibration) is an exploratory research mode, not a triage gate. Running HTW on automated triage burns maintainer attention, consumes unbounded compute, and creates ambiguous verdict histories. Automated evaluation runs deterministic classification, targeted tests, and pinned container/live rigs only.

---

## Gap 1: The False-Green Budget (Zero-Tolerance Trust Invariant)

### Why It Kills Adoption
In high-stakes open-source maintainership (such as Orca evaluating ~3K pull requests) or production cost tooling, **a single false green destroys maintainer trust permanently**. 

If the verification harness emits a `PASS` verdict on a PR modifying cgroup hierarchies, systemd daemon lifecycles, PTY allocations, or financial cost algorithms, and that change subsequently breaks production or panics user machines, maintainers will immediately discard the tool. Maintainers would rather inspect an unclassified PR by hand than waste hours debugging why an automated badge lied to them.

An automated pass badge is an absolute claim of safety within tested invariants. The moment it cannot be trusted, its utility drops below zero: it creates negative information.

### The Boring Fix
- **Fail-Closed Verification**: Any ambient uncertainty (unresolved merge conflict, skipped probe, flaky test assertion, missing container capability, or unexpected exit code) yields `FAIL: UNRESOLVED_INVARIANT`, never `PASS` or `SKIP`.
- **Tri-State Verdict Architecture**: Replace binary `PASS`/`FAIL` with strict categorical outcomes:
  1. `VERIFIED_PASS`: Every scoped layer ran, all invariants asserted, zero ambient errors.
  2. `VERIFIED_FAIL`: Explicit failure detected with reproduction artifact attached.
  3. `MANUAL_REVIEW_REQUIRED`: Harness detected scope beyond verified invariants, missing capability, or ambient anomaly.
- **Pre-Merge Invariant Assertions**: For kernel/runtime layers (cgroup, PTY, systemd), tests must assert negative conditions (leak check: resource count strictly transitions $0 \to 1 \to 0$; file descriptor leak check; process cleanup check). If leak invariant checks cannot execute, the job aborts to `MANUAL_REVIEW_REQUIRED`.

---

## Gap 2: Queue & Backlog Scaling (Classifying 3K PRs Without GitHub Rate-Limit Suicide)

### Why It Kills Adoption
Orca has a backlog of approximately 3,000 open PRs. Naive automation loops that query GitHub's REST/GraphQL API for diffs, commits, and comments exhaust secondary rate limits (and primary 5,000 req/hr limits) within minutes, leading to API bans, broken CI webhooks, and abandoned triage runs.

Furthermore, naive `HEAD`-only diffing misclassifies changes whose base has drifted significantly from `origin/main`, producing invalid test selections or testing against phantom code states.

### The Boring Fix
- **Local Git Clone & Merge-Base Caching**: Never fetch individual PR file diffs via GitHub API. Operate against a bare local mirror.
  ```bash
  # Fetch all PR heads in bulk refspec
  git fetch origin '+refs/pull/*/head:refs/remotes/pull/*'
  # Compute classification diff strictly against merge-base
  MERGE_BASE=$(git merge-base origin/main pull/1234/head)
  git diff --name-only "$MERGE_BASE" pull/1234/head
  ```
- **Content-Addressed Diff Classification Cache**: Key the classification layer by the tuple `(merge_base_commit, pr_head_commit)`. If neither SHA has changed, classification is instantaneous and zero-cost.
- **Local SQLite Triage Queue**: Decouple PR intake from execution. Ingest PR metadata into a local SQLite queue (`triage.db`) using paginated GraphQL with exponential backoff and conditional `ETag` headers.
- **Batch Processing**: Drain the queue locally in priority batches (docs $\to$ types $\to$ renderer $\to$ runtime $\to$ kernel). Post back GitHub comment updates using a token bucket rate-limiter capped at 25 comments per minute.

---

## Gap 3: Toolchain Independence & Version Pinning (Don't Replace Stryker / Playwright / Vitest)

### Why It Kills Adoption
Harnesses that attempt to reimplement, wrap in custom DSLs, or shadow underlying testing engines (such as Vitest, Playwright, or Stryker) break as soon as projects update their framework configurations, plugins, or flags. 

Conversely, relying on unpinned global binaries or assuming ambient node_modules availability causes silent version mismatch errors, subtle assertion divergence, or misleading "pass" runs where tests were silently skipped due to unrecognized configuration flags.

### The Boring Fix
- **Harness as Orchestrator, Not Evaluator**: Behavioral verification drives the repo's native tooling; it does not replace it.
- **Explicit Version-Floor Invariants**: The profile must declare strict executable floors and verify them prior to running:
  - Vitest: Read package version directly from `package.json` / `node_modules/.bin/vitest --version`.
  - Playwright / CDP: Verify browser binary match and driver protocol version.
  - Stryker: Explicit runner verification.
- **Hard Fail on Missing Tooling**: If a layer requires targeted vitest or Playwright and the local binary is absent or version-incompatible, the run must immediately fail with an actionable resolution (`ERR_MISSING_TOOL: vitest not resolved in node_modules`). Never fallback to generic assertions, mock runners, or silent no-ops.

---

## Gap 4: Environmental Determinism (Seed, Clock, Container Image Digest)

### Why It Kills Adoption
When behavioral tests fail intermittently due to wall-clock drift, random test ordering, unpinned base images, or host-dependent font rendering, engineers ignore all results as "test noise." 

In visual verification (CDP screenshots of the Orca renderer) or financial arithmetic (aicostoptimizer token calculation models), non-determinism is catastrophic:
- Renderer diffs fail because of anti-aliasing variations across host GPU drivers or font packages.
- Cost optimization tests fail because `Date.now()` crossed an hourly billing window or timezone threshold.
- Containerized tests fail because an untagged `node:20` pulled an upstream patch with new glibc or systemd behavior.

### The Boring Fix
- **Immutable Container Image Digests**: Pinned sha256 digests for all host/container environments:
  ```yaml
  runner:
    image: "debian@sha256:713214534f378a9c2e0f... (Debian 12 minimal systemd)"
  ```
- **Frozen Test Clocks & Fixed Random Seeds**:
  - Inject fixed epoch timestamp via environment (`FAKETIME="@2026-01-01 00:00:00"` or `VITEST_TIMESTAMP=1767225600`).
  - Pass deterministic seeds to all test harnesses (`--seed 42`).
- **Headless Display & Font Normalization**:
  - Lock renderer screenshot environments to software rasterization (`--disable-gpu`, `--swiftshader`).
  - Pin standard font packs (`fonts-dejavu-core`, `fonts-liberation`) inside the verification container to eliminate font-fallback layout shifts.

---

## Gap 5: Inapplicable Layer Refusal (Mixed-Version, SSH, Folder-Workspace vs API)

### Why It Kills Adoption
A single monolithic harness that silently skips or no-ops irrelevant test layers creates dangerous blind spots. 

For example:
- In Orca: A PR modifies SSH execution boundaries or remote workspace folders (per `AGENTS.md`). A harness built for local desktop electron runs tests against local paths, sees zero errors, and issues a green pass without ever exercising the SSH transport.
- In aicostoptimizer: A PR changes cost calculations for a cloud provider. A harness running web/UI specs simply marks kernel/cost layers as "skipped" and passes the PR.

Treating an inapplicable or unexecutable layer as a silent success (or neutral skip) allows unverified code to merge under the illusion of test coverage.

### The Boring Fix
- **Explicit Profile Refusal (Fail Incompatible Contexts)**: Profiles must declare strictly supported workspace topologies:
  ```yaml
  profile:
    id: orca-maintainer-triage
    supported_topologies:
      - local_folder
      - pty_session
    refuse_with_reason:
      remote_ssh: "Orca triage profile does not have verified SSH bastion rig. Escalate to remote-wire profile."
      cloud_cost_api: "Incompatible target: this profile verifies Orca desktop runtime only."
  ```
- **Refuse, Never Silent No-Op**: If a PR diff touches files belonging to an unconfigured topology (e.g., `src/remote/ssh/*` or remote daemon protocol specs), the triage runner must explicitly mark that layer as `REFUSED: UNSUPPORTED_TOPOLOGY` with a clear direction to the maintainer.
- **Fail on Empty Test Plan**: If classification matches a non-doc change but resolves zero executable behavioral layers for that profile, the run fails automatically (`ERR_EMPTY_EXECUTION_PLAN`).

---

## Summary Checklist for Maintainer Confidence

| Gap Area | Failure Mode | Boring Required Invariant |
| :--- | :--- | :--- |
| **1. False Greens** | Breaking change merged on false automated badge | Fail-closed tri-state verdicts; $0 \to 1 \to 0$ resource leak invariants. |
| **2. PR Backlog** | GitHub API rate-limit bans while processing 3K PRs | Local clone, merge-base cache, SQLite decoupled queue, 25 comments/min. |
| **3. Toolchain** | Silent pass when native runners drift or go missing | Version-pinned vitest/Playwright/Stryker floors; explicit failure on absence. |
| **4. Determinism** | Flaky screenshots or token cost test noise | Frozen clocks, fixed seeds, locked container image digests, software rasterizer. |
| **5. Layer Scoping** | Silent skip on SSH/folder-workspace or unhandled files | Explicit profile topology refusal; error on empty plan for non-doc diffs. |
