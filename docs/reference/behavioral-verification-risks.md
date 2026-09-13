# Behavioral Verification Operational Risk Register

Operational risk mitigation register for the behavioral verification subsystem. Covers the core execution gaps, maintainer trust requirements, money-domain invariants, and scope boundaries.

Mitigations specify concrete enforcement mechanisms, not aspirational policies.

---

## 1. Risk Register Matrix

| ID | Risk | Impact Mechanism (How it kills the tool) | Mitigation (Concrete Mechanism) | Residual Risk |
| :--- | :--- | :--- | :--- | :--- |
| **R1** | **False Green** | Masked regressions pass CI; broken PTY, leaked cgroups, or billing drifts land upstream undetected, destroying harness credibility. | Tri-state evaluation: `VERIFIED_PASS`, `VERIFIED_FAIL`, `MANUAL_REVIEW`. Probe-not-run strictly cannot evaluate to `PASS`. Exit status `0` without positive assertion signature yields `MANUAL_REVIEW`. Any false green detected on cgroup, PTY allocation, or money invariants is classified as an immediate P0 blocker. | Incomplete assertion coverage on novel runtime edge cases; human reviewer rubber-stamping `MANUAL_REVIEW`. |
| **R2** | **GitHub API Depletion (3K PR backlog)** | Rate limit exhaustion halts pipeline sweeps, stalls PR triage loops, and drops webhook deliveries. | Local raw git fetch via `git fetch +refs/pull/*/head:refs/remotes/pull/*`; compute deterministic triage hash over `(merge_base, head)` tuple in local SQLite cache. Issue comments throttled through SQLite-backed token bucket (max 30 req/min, burst 5). Zero octokit calls on unchanged commits. | Cold-start sync latency for initial git fetch on repos exceeding 100k commits; upstream GitHub webhook delivery dropping under burst. |
| **R3** | **Tool Replacement & Dependency Drift** | Synthetic fallback shims or mocked runners emit artificial passes while skipping actual verification suites. | Harness acts strictly as an orchestrator. Missing harness dependencies (`vitest`, `playwright`, `stryker`) immediately terminate execution with `ERR_MISSING_TOOL` fatal exit code. Never synthesize or inject stub CLI shims. | Host system has outdated tool major versions installed that report valid binaries but miss modern flags. |
| **R4** | **Non-Deterministic Suite Flakiness** | Golden image mismatches and race conditions trigger false alarms, prompting maintainers to disable behavioral gating. | Pin base runner containers to immutable digest (`sha256:...`). Force system clock and wall-time via `LD_PRELOAD` `libfaketime` (`FAKETIME="@2026-01-01 00:00:00"`). Pin pseudo-random seeds (`SEED=42`). Playwright golden snapshots execute strictly on Linux container runtimes (`x86_64` container boundary). | Kernel timing variations under hyper-threaded CPU contention; GPU rendering differences if hardware acceleration is bypassed. |
| **R5** | **Silent Layer Skip** | Skipped or inapplicable test stages silently pass through pipeline gates, producing false clean bills of health. | Any inapplicable or bypassed layer is classified as `REFUSED` with explicit machine-readable `N/A` notation and structured justification log. Pipeline runner disallows translating missing stages to green checks. | Malformed pipeline configuration file marking required layer as optional at specification level. |
| **R6** | **Loss of Maintainer Trust (`nwparker`)** | Heavyweight containerized runs on documentation PRs create cycle-time friction and review noise, alienating maintainers. | Output adheres strictly to the upstream Fresh behavioral verification markdown report format. Documentation-only diffs (`docs/**`, `*.md`) bypass Docker orchestration entirely via fast-path AST diff detection; never queue on Docker daemon. | Misclassified mixed PRs (e.g. documentation update containing executable snippet modifications). |
| **R7** | **Billing Domain Invariant Breach (`aicostoptimizer`)** | Unmatched billing SKUs defaulting to zero, unhandled 429 retries, or duplicate webhook processing result in revenue loss or double billing. | Fail-closed catalog lookup: unmatched SKU throws fatal `ERR_UNKNOWN_SKU` (never default to `$0.00`). Upstream 429 responses strictly honor `Retry-After` header with bounded exponential jitter backoff. Webhook ingestion enforces idempotent delivery via SQLite `txn_ledger` unique constraint `UNIQUE(idempotency_key, event_id)` in single transaction. Stryker mutation testing enforced exclusively on critical money and calculation paths. | Extended upstream billing API downtime exceeding max retry backoff window; stale cached currency exchange tables. |
| **R8** | **Scope Creep & Pipeline Bloat** | Heavyweight HTW/8-cell verification suites running on routine triage PRs inflate queue wait times past acceptable thresholds. | Heavyweight Testing Workflow (HTW) and 8-cell matrix are removed from the default path for `orca-triage` and `aicostoptimizer`. Default PR gate executes fast L1–L3 behavioral sanity checks; 8-cell matrix gates exclusively on scheduled nightly runs or explicit `/run-8cell` PR label. | Critical edge-case regression between cells only caught during nightly runs rather than instant PR merge gate. |

---

## 2. Mitigation Mechanism Specs

### 2.1 Tri-State Evaluation & Safety Floor (R1, R5)
```
          [ Test Probe Execution ]
                     |
         +-----------+-----------+
         |                       |
    [ Probe Run ]        [ Probe Not Run / Skipped ]
         |                       |
   +-----+-----+                 +--> Status: REFUSED (N/A)
   |           |                      (Never GREEN)
[ Pass ]    [ Fail / Inconclusive ]
   |           |
   |           +--> Status: VERIFIED_FAIL (Exit 1)
   |                or MANUAL_REVIEW
   v
[ Positive Assertions Checked ]
   |-- Yes --> Status: VERIFIED_PASS
   +-- No  --> Status: MANUAL_REVIEW (Exit 2)
```
- Invariant: A probe missing affirmative execution proof cannot transition to `VERIFIED_PASS`.
- Breach protocol: Any false green on cgroup boundary, PTY control channel, or monetary calculations triggers immediate P0 incident and halts automated PR merging.

### 2.2 Rate Limit Defense & Local Compute Offload (R2)
- Network calls minimized by pulling Git refs locally:
  ```bash
  git fetch origin +refs/pull/*/head:refs/remotes/pull/*
  ```
- Cache key: `SHA256(merge_base_commit + head_commit)`.
- If cache hit exists in SQLite state store, verification is read from local ledger; zero GitHub API calls issued.
- Outbound comment token-bucket configuration:
  - Max capacity: 30 tokens.
  - Refill rate: 0.5 tokens/sec (30 tokens/min).
  - Exhaustion state: Buffer to SQLite outbox; flush on next window.

### 2.3 Strict Fail-Closed Execution Contract (R3, R7)
- External binary resolution checks executable path via deterministic resolution:
  ```ts
  if (!resolveExecutable(tool)) {
    throw new FatalHarnessError("ERR_MISSING_TOOL", `Required tool missing: ${tool}`);
  }
  ```
- Financial domain fail-closed catalog:
  ```ts
  function getSkuPrice(skuId: string): Price {
    const sku = catalog.get(skuId);
    if (!sku) {
      throw new BillingInvariantError("ERR_UNKNOWN_SKU", `SKU ${skuId} not mapped; refusing $0 default`);
    }
    return sku.unitPrice;
  }
  ```
- Webhook deduplication schema:
  ```sql
  CREATE TABLE IF NOT EXISTS webhook_ledger (
    idempotency_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (idempotency_key, event_id)
  ) STRICT;
  ```

### 2.4 Golden Environment Determinism (R4)
- Runner container pinned to SHA256 digest: `ghcr.io/stablyai/behavioral-runner@sha256:<digest>`.
- Environmental clock fixed via `libfaketime` environment injection.
- Playwright screenshot tests run exclusively within containerized Linux ABI (`x86_64`); host platform visual diffs disallowed from committing baseline goldens.

---

## 3. CLI vs Temporal Boundary

Clear architectural separation between local assertion execution and durable orchestration:

### 3.1 Responsibilities

| Layer | Component | Execution Context | Responsibilities & Invariants |
| :--- | :--- | :--- | :--- |
| **Local Verification** | `bverify` CLI | Local process, transient container, or developer workstation. Zero cluster/Temporal dependencies. | Runs behavioral assertions directly. Target execution time $\le$ 60s. Evaluates tri-state verdicts (`VERIFIED_PASS`, `VERIFIED_FAIL`, `MANUAL_REVIEW`). Inapplicable layers return `REFUSED` (N/A). Fast path works with zero Temporal services running. |
| **Durable Orchestration** | Temporal Workflows | Temporal cluster / worker fleet. | Long-running coordination: 3K PR queue drain, GitHub rate-limit scheduling, token-bucket throttling, durable pause for human `MANUAL_REVIEW`, retries with backoff. Invokes `bverify` purely as Temporal **activities**. |

### 3.2 Invariants & Anti-Patterns

1. **Workflow Determinism Invariant**:
   - **NEVER** execute `vitest`, `playwright`, or `stryker` directly inside workflow definition code. All testing tools and shell executions are strictly confined to transient Activity workers executing `bverify`.
2. **Fast Path Independence**:
   - Local developer loops and lightweight PR gates must function stand-alone using the `bverify` CLI binary without requiring Temporal server, workers, or database backends.
3. **Idempotency Key Structure**:
   - Temporal workflow execution IDs and activity deduplication keys are strictly derived from Git state:
     ```
     workflow_id = `bverify-${repo}-${pr}-${merge_base}-${head}`
     ```
   - Re-running against an identical `(repo, pr, merge_base, head)` tuple returns cached verification output without re-triggering test suites or duplicate GitHub comments.
4. **Manual Review Suspensions**:
   - When `bverify` yields `MANUAL_REVIEW`, the Temporal workflow registers a durable timer/signal wait (`workflow.condition(() => reviewReceived)`), freeing compute workers until a maintainer issues an explicit approval signal.
