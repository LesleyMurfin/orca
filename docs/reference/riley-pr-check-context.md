# Progressive Context: `riley pr-check` (revive_labs)

## Current State

- **Project home:** `revive_labs` product, sourced from factory workspace `nwparker-behavioral-verification`. CLI command is `riley pr-check`. No public brand / no separate branded package name.
- **Product:** Generic AI-assisted gate for **any repo / any code**. Dynamically configures itself from the target repo. Progressive context persists in durable repo state under `.riley/`. Overlays (Orca, Grafana plugins, Agent Deck, studio, `aicostoptimizer`) are example targets/overlays, not the product. Lesley explicitly rejected picking studio vs cost optimizer as the product to build.
- **Audience:** Vibe coders / AI engineers. `nwparker` represents the maintainer quality bar, not the end user. Maintainer mode arrives later (e.g., Grafana inbound PR reviews).
- **AI proposes, code disposes:** AI proposes `.riley/pr-check-plan.yml` and test tables; deterministic code executes merge-tree diff, `aislop` composition, and test runners, computing the score. Ticket/PR description is not instruction for the scoring gate. Code truth wins over PR descriptions. AI judgment alone never equals PASS.
- **Slice 1 CLI exists:**
  - Script: `scripts/riley-pr-check.mjs`
  - Tests: `scripts/riley-pr-check.test.mjs` (TDD with `node:test`, 16 tests passing)
  - Subcommands:
    - `plan`: computes git merge-tree diff, outputs verification plan, triggers repo bootstrap if needed.
    - `check`: executes merge-tree diff + required `aislop` compose (`npx aislop@latest ci --changes --base`, not vendored, withhold != PASS, `--skip-aislop` escape hatch) + targeted tests.
  - Process exit codes: `0` (pass), `1` (fail), `2` (blocked/error).
- **Plan bootstrap EXISTS:**
  - Automatically triggered during `plan` when no `.riley/` context exists.
  - Samples core paths and manifests + `git log` recent files.
  - Generates `.riley/map.yml` and a stub `.riley/context.md`.
  - **Never fakes `AGENTS.md`**.
  - The CLI contains zero LLM calls.
  - Backed by 16 passing unit and integration tests in `scripts/riley-pr-check.test.mjs`.
- **`.riley/` layout & lifecycle:**
  - **Committed:** `context.md`, `map.yml`, `misses.yml`, `themes.yml`.
  - **Gitignored:** `plan.yml`, `last-run.json`, `history.jsonl`.
  - `map.yml` is populated from dynamic repo detection.
  - `history.jsonl` is readable context, never instructions for the scorer.
  - `misses.yml` acts as a ratchet ledger after confirmed test misses or regression escapes.
  - `standards` / `intent` in configs are pointers to actual repo files or empty.
- **Uncle Bob verification model:** Two test suites at L1; related PRs shape suite 1 test tables only; mutation testing is sequestered and empty-grown; Accept gate equals Orca L2–L5 or standard repo CI; 8-cell campaign is strictly opt-in, not default.
- **ADW integration:** Code gate placed at PLAN / after BUILD / TEST / FINISH (blocks `create-pr`). Does not run on scout hops, does not trigger on every intermediate hop, does not depend on Temporal, and does not require a 3K token drain.
- **Not started:** GitHub PR action/hook, Grafana `themes.yml` ingestion, live L2–L5 runtime execution harness, `.riley/` automated writer inside CLI (bootstrap exists for map/context), and extraction to the standalone `revive_labs` repository.

## Map

- `docs/reference/behavioral-verification-architecture.md` — Core architectural specification defining the L1–L5 verification tiers, Uncle Bob test separation, and gate contracts.
- `docs/reference/behavioral-verification-orca-triage.md` — Triage rubric and classification of Orca behavioral defects and maintainer feedback patterns.
- `docs/reference/behavioral-verification-aicostoptimizer.md` — Analysis of behavioral verification applied to `aicostoptimizer` as a representative consumer repository.
- `docs/reference/behavioral-verification-payload-next.md` — Specification of the machine-readable verification payload and plan exchange formats.
- `docs/reference/behavioral-verification-expert-adoption.md` — Adoption strategy and persona breakdown for vibe coders versus maintainers (`nwparker` bar).
- `docs/reference/behavioral-verification-open-questions.md` — Catalog of open design questions covering runtime environments, gating policies, and persistence.
- `docs/reference/behavioral-verification-risks.md` — Risk register documenting false positives, flakiness, latency, and mitigation strategies for AI gates.
- `docs/reference/behavioral-verification-riley-pr-gate.md` — High-level product definition and ADW pipeline placement for the `riley pr-check` gate.
- `docs/reference/riley-pr-check.md` — CLI command specification for `riley pr-check` (subcommands, exit codes, environment variables, options).
- `docs/reference/riley-pr-check-themes.md` — Taxonomy of recurring PR review themes and failure modes used to construct verification tables.
- `docs/reference/riley-pr-check-coverage-map.md` — Mapping of codebase paths and changes to risk themes and required verification levels.
- `docs/reference/riley-pr-check-orca-fit.md` — Evaluation of how `riley pr-check` integrates with Orca desktop and CLI development workflows.
- `scripts/riley-pr-check.mjs` — Slice 1 executable CLI implementation providing `plan` and `check` subcommands with merge-tree, bootstrap, and `aislop` execution.
- `scripts/riley-pr-check.test.mjs` — Test suite for `scripts/riley-pr-check.mjs` validating merge-tree diffing, bootstrap behavior, aislop integration, and exit codes (16 tests).
- `config/scripts/fault-injector.cjs` — Orca-shaped fault injection prototype used for testing gate sensitivity, not the product UI.

## Decision History

- **nwparker 3K drain is hypothetical, not a product:** A raw prompt-token drain analyzing PRs is a brittle experiment, not a repeatable software product; the product is deterministic verification driven by structured plan artifacts.
- **Not inside aicostoptimizer:** Embedding this tool inside `aicostoptimizer` was rejected; the free wedge is a go-to-market distribution strategy, not the product architecture.
- **Not CodeGate / aicode / aitestgate / optimizer / aislop as our name:** Unified identity under `riley pr-check` (revive_labs) rather than splintering into separate or generic branded tools.
- **Compose aislop, don't fork:** `aislop` is executed as an external composed CLI check (`npx aislop@latest ci --changes --base`); we do not fork or vendor its codebase.
- **Not 100% catch:** Rejecting the goal of catching 100% of maintainer comments; the gate provides high-leverage theme verification and structural defect prevention, not perfection.
- **Not 8 Orca rewrites:** The 8-cell test matrix is reserved for specialized audit campaigns only; default execution remains standard L1 + selective accept.
- **Not FitNesse runtime:** Heavy wiki-based acceptance testing runtimes like FitNesse were rejected in favor of native YAML plan tables and standard repo test runners.
- **Not Temporal until a queue:** Temporal workflow orchestration is unnecessary overhead for synchronous CLI checks; Temporal is deferred until distributed asynchronous queueing is required.
- **Not fake AGENTS.md:** If a repo lacks `AGENTS.md`, the bootstrap mechanism inspects manifests, git history, and paths to create `.riley/map.yml` and `.riley/context.md`; it never fabricates an `AGENTS.md`.
- **Design-first then TDD slice 1:** Architect the contracts and progressive context specifications before building, followed by strict test-driven development of slice 1 (`riley-pr-check.mjs`).
- **Vibe coder audience:** The primary target audience is vibe coders and AI engineers needing guardrails; maintainers represent the quality bar rather than the initial user base.
- **Prose slop vs code slop split:** Separate natural language PR prose checking from code-level AST/semantic checking; PR bodies are never treated as instructions for the gate scorer.
- **CLI vs Temporal split (assertions vs wait):** The CLI synchronously evaluates deterministic assertions and immediate test runs; long-running waits, external human approvals, or multi-node runs belong to Temporal or orchestration layers later.
- **F.I.R.S.T. & mock boundaries:** Honor F.I.R.S.T. principles; don’t mock what you don’t own. Use FitNesse-shaped verification tables, but never the FitNesse runtime; How to Win (HTW) is calibration only.
- **False green protection:** Tri-state verdicts: `VERIFIED_PASS`, `VERIFIED_FAIL`, and `MANUAL_REVIEW`. Probe not run ≠ PASS.
- **Inapplicable layers:** Inapplicable verification layer results in `REFUSED` or `MANUAL_REVIEW`, never silent skip-as-green.
- **Expert bar:** ~60s blast radius, wrap existing tools, proof ≤15 lines, AI cannot PASS, and test failure leaves a durable keepable artifact.
- **Determinism requirements:** Pin container image digest, clock, and seed; Playwright visual golden baselines are Linux-only.
- **GitHub 3K scale:** Local `git fetch refs/pull` workflow, not a per-PR API poll drain (not a product).
- **Compose aislop via `ci --changes --base`:** Compose external `aislop` via `ci --changes --base`; allow stubbing and test overriding with `RILEY_PR_CHECK_AISLOP_CMD`.
- **.riley authority hierarchy:** `.riley/context.md` > `.riley/map.yml` > `.riley/misses.yml`. `history.jsonl` is historical observation and never instruction.
- **No AGENTS.md behavior:** Missing `AGENTS.md` is not a failure; sample repository paths and git log. If no test runner exists or is discovered, return `MANUAL_REVIEW`.
- **CLI samples without LLM:** CLI samples paths and git log without LLM invocation; AI may propose review themes from that sample + related git log upstream.
- **Related PRs & test isolation:** Related PRs shape suite 1 test tables only; mutation test suite is sequestered.
- **Orca L2–L5 & Agent Deck:** Orca L2–L5 equals accept gate; Grafana target uses plugin themes, not Helm charts; Agent Deck runs tester/coder split with their CI acting as accept.
- **payload-next & money overlays:** `payload-next` and `money` overlays exist as architectural documentation specifications only.
- **fault-injector & docker rig scope:** `config/scripts/fault-injector.cjs` and the docker systemd rig are Orca prototypes, not user-facing product UI.
- **no-ai-slop vs riley pr-check:** `no-ai-slop` evaluates prose; `riley pr-check` gates and verifies code.
- **Rejected names because taken:** Rejected names due to ecosystem collision: Stacklok CodeGate, puntorigen aicode, scanaislop/aislop, and category name “AI test gate”.
- **PR status & extraction:** PR is in flight for slice 1; extraction to standalone `revive_labs` repo is not done.

## Gaps in the SSOT

This document is an evolving progressive context reference and does not claim to fully capture 100% of the conversational transcript or design threads:
- **Full transcript details live across Map files:** Detailed rationales, failure logs, and specific architecture specs are distributed across the individual Map documents (`behavioral-verification-architecture.md`, `behavioral-verification-orca-triage.md`, `riley-pr-check-themes.md`, etc.), not exclusively in this single SSOT context note.
- **Live L2–L5 runner contracts:** Full protocol for invoking and collecting results from live container/systemd L2–L5 harnesses remains documented in architecture references but unbuilt in the Slice 1 CLI.
- **Automated `.riley/` writer beyond bootstrap:** Slice 1 implements zero-LLM bootstrapping of `map.yml` and stub `context.md`; full continuous writing/updating of `themes.yml`, `misses.yml`, and plan tables by LLM-backed stages is specified across design docs rather than finalized here.
- **Upstream extraction boundary:** Extraction specifics for separating `revive_labs` into its independent repo while maintaining compatibility with the current factory workspace are pending slice 1 PR completion.
