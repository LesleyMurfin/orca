# SSSF Spec: Upstream Bundled Skill Guide for `orca-serve-troubleshoot`

## Current State

Currently, the `orca-serve-troubleshoot` skill exists only as a loose, standalone markdown file at `skills/orca-serve-troubleshoot/SKILL.md`.

In the Orca architecture, all authoritative agent skill documentation adheres to the bundled skill guide subsystem:
1. **Authoritative Guide:** Comprehensive guides live in `skill-guides/<name>.md` with full frontmatter, operational procedures, diagnostic workflows, and environment matrices.
2. **Registry:** Skills are registered in `config/scripts/generate-bundled-skill-guides.mjs` across `CANONICAL_GUIDE_NAMES`, `GUIDE_ALIASES`, and `STUB_TOPICS`.
3. **Compiled Bundle:** Running `node config/scripts/generate-bundled-skill-guides.mjs` compiles the markdown guides into `src/cli/bundled-skill-guides.ts`, allowing Orca's native binary to serve the guide via `orca skills get <name>`.
4. **Hybrid Discovery Stub:** A minimal projection stub is maintained in `skill-stubs/<name>.md` and composed into `skills/<name>/SKILL.md` via `config/scripts/skill-stub-composition.mjs`. This provides agent harnesses with fast semantic routing without burning context window tokens until invoked.

Because `orca-serve-troubleshoot` was added as an unbundled loose file:
- Running `orca skills get orca-serve-troubleshoot` fails with an unknown skill topic error.
- Running `node config/scripts/generate-bundled-skill-guides.mjs --check` or CI verification would detect unregistered loose skills or drift.
- The comprehensive triage steps, environment divergence traps (bare-metal, WSL2, Docker, macOS), and integration with the newly specified `orca serve doctor` command lack an authoritative upstream guide home.

---

## Summary

### ELI5
We are integrating the `orca-serve-troubleshoot` skill into Orca's official bundled skill system so any agent can retrieve the full troubleshooting guide using `orca skills get orca-serve-troubleshoot`, while keeping the installable discovery stub lean and token-efficient.

### What Changed
1. **Authoritative Skill Guide:** Created `skill-guides/orca-serve-troubleshoot.md` containing the full operational guide, environment fingerprinting, installation/preflight instructions, the non-destructive triage sequence, the 4 root-cause classification buckets, platform-specific divergence traps (Xvfb stale locks, WSL2 NAT IP drift, Docker `/dev/shm` exhaustion, macOS launchd), and the native `orca serve doctor` command workflows.
2. **Discovery Stub Template:** Created `skill-stubs/orca-serve-troubleshoot.md` using standard shared stub composition markers (`<!-- shared: resolver -->`, `<!-- shared: no-guessing -->`).
3. **Generator Registration:** Registered `orca-serve-troubleshoot` in `config/scripts/generate-bundled-skill-guides.mjs` under `CANONICAL_GUIDE_NAMES`, `GUIDE_ALIASES`, and `STUB_TOPICS`.
4. **Generated Artifacts Compilation:** Compiled `src/cli/bundled-skill-guides.ts` and generated the composed `skills/orca-serve-troubleshoot/SKILL.md` stub via the generator script.
5. **Contract Test Suite:** Created `config/scripts/orca-serve-troubleshoot-skill-guidance.test.mjs` verifying routing triggers, bucket classifications, CLI doctor workflows, and stub composition.

### Why
Upstream Orca requires all bundled agent skills to be compiled into the binary CLI and published as lightweight discovery stubs. This ensures consistent CLI discovery (`orca skills list`, `orca skills get`), prevents context window bloat, guarantees version alignment between the running Orca binary and its guidance, and standardizes how agents triage headless serve incidents.

---

## Files to Touch

1. **`skill-guides/orca-serve-troubleshoot.md`** (New File)
   - The authoritative upstream guide.
   - Contains YAML frontmatter (`name: orca-serve-troubleshoot`, `description: ...`).
   - Detailed troubleshooting workflows, `orca serve doctor` command usage, and failure recovery matrices.

2. **`skill-stubs/orca-serve-troubleshoot.md`** (New File)
   - The hybrid discovery stub template.
   - References shared resolver and no-guessing fragments.

3. **`config/scripts/generate-bundled-skill-guides.mjs`** (Modify)
   - Add `'orca-serve-troubleshoot'` to `CANONICAL_GUIDE_NAMES`.
   - Add `'orca-serve-troubleshoot': []` to `GUIDE_ALIASES`.
   - Add `'orca-serve-troubleshoot'` to `STUB_TOPICS`.

4. **`config/scripts/orca-serve-troubleshoot-skill-guidance.test.mjs`** (New File)
   - Vitest contract tests for frontmatter trigger assertions, bucket definitions, doctor integration, and stub projection checks.

5. **`skills/orca-serve-troubleshoot/SKILL.md`** (Generated / Overwritten)
   - Output of `node config/scripts/generate-bundled-skill-guides.mjs`.

6. **`src/cli/bundled-skill-guides.ts`** (Generated / Overwritten)
   - Output of `node config/scripts/generate-bundled-skill-guides.mjs`.

---

## Step-by-Step

### Step 1: Create `skill-stubs/orca-serve-troubleshoot.md`
Create the discovery stub template following the pattern of `skill-stubs/orca-cli.md`:
```markdown
# Orca Serve Troubleshoot

This discovery stub loads the version-matched guide from the Orca executable used for this session.

<!-- shared: resolver -->

## Load the version-matched guide before running Orca serve diagnostics

```text
ORCA skills get orca-serve-troubleshoot
```

<!-- shared: no-guessing -->
```

### Step 2: Create `skill-guides/orca-serve-troubleshoot.md`
Port the contents of `skills/orca-serve-troubleshoot/SKILL.md` into `skill-guides/orca-serve-troubleshoot.md` while enhancing it with native `orca serve doctor` workflows:
- **Frontmatter:**
  ```yaml
  ---
  name: orca-serve-troubleshoot
  description: >-
    Automate Orca Serve logging installation, connectivity verification, and root-cause
    diagnostic triage across the 4 buckets (Orca Bug, Server Resource, Server Config,
    Client Config). Triggers: diagnose orca serve, orca serve down, orca serve troubleshooting,
    install orca serve logging, orca connection refused, orca serve status, orca unknown
    environment, orca serve doctor. Not for orca-cli, orchestration, or generic server health.
  ---
  ```
- **Structure:**
  1. `# Orca Serve Troubleshoot`
  2. `## Purpose & Two-Mode Router` (Install/preflight vs. Triage)
  3. `## Primary Command: orca serve doctor` (Native CLI diagnostics, `--json`, `--tail-lines`, `--environment`)
  4. `## Action 0: Environment Fingerprinting` (Linux bare-metal, WSL2, Docker/container, macOS Darwin)
  5. `## Action 1: Install / Preflight Mode` (`install-logging-setup.sh --dry-run` and systemd unit installation)
  6. `## Action 2: Manual 5-Command Triage (Fallback Sequence)` (`systemctl`, `journalctl`, `ss -ltnp`, `orca status`, `orca-runtime.json`)
  7. `## Action 3: Root-Cause Classification & Remediations`
     - Bucket 1: Orca Bug (`SIGSEGV`, `SIGTRAP`, exit code 133)
     - Bucket 2: Server Resource (OOM exit code 137, `ENOSPC`, file descriptor limits)
     - Bucket 3: Server Config (systemd exit code 203, port collision, stale `/tmp/.X99-lock` Xvfb trap, stale fallback port)
     - Bucket 4: Client Config (Environment ID drift, NAT IP mismatch, pairing address mismatch)
  8. `## Action 4: Host-Specific Divergence Traps & Workarounds` (Detailed matrix for Linux, WSL2, Docker, macOS)

### Step 3: Register in Generator Script (`config/scripts/generate-bundled-skill-guides.mjs`)
1. In `CANONICAL_GUIDE_NAMES`, insert `'orca-serve-troubleshoot'` in alphabetical order:
   ```javascript
   const CANONICAL_GUIDE_NAMES = [
     'computer-use',
     'linear-tickets',
     'orca-cli',
     'orca-emulator',
     'orca-emulator-android',
     'orca-linear',
     'orca-per-workspace-env',
     'orca-serve-troubleshoot',
     'orchestration'
   ]
   ```
2. In `GUIDE_ALIASES`, register the alias ledger entry:
   ```javascript
   const GUIDE_ALIASES = {
     'computer-use': [],
     'linear-tickets': [],
     'orca-cli': [],
     'orca-emulator': [],
     'orca-emulator-android': [],
     'orca-linear': [],
     'orca-per-workspace-env': [],
     'orca-serve-troubleshoot': [],
     orchestration: []
   }
   ```
3. In `STUB_TOPICS`, register:
   ```javascript
   const STUB_TOPICS = [
     'computer-use',
     'linear-tickets',
     'orca-cli',
     'orca-emulator',
     'orca-emulator-android',
     'orca-linear',
     'orca-per-workspace-env',
     'orca-serve-troubleshoot',
     'orchestration'
   ]
   ```

### Step 4: Run Code Generator
Run the generator script to compile TypeScript artifacts and generate the discovery stub:
```bash
node config/scripts/generate-bundled-skill-guides.mjs
```
Verify git status touches:
- `src/cli/bundled-skill-guides.ts` (now includes `orca-serve-troubleshoot` entry)
- `skills/orca-serve-troubleshoot/SKILL.md` (now contains generated discovery stub)

### Step 5: Implement Vitest Contract Test (`config/scripts/orca-serve-troubleshoot-skill-guidance.test.mjs`)
Write test coverage mirroring `orchestration-skill-guidance.test.mjs`:
1. **Frontmatter Trigger Tests:** Assert exact triggers are contained in the description (`diagnose orca serve`, `orca serve down`, `orca connection refused`, `orca unknown environment`, `orca serve doctor`).
2. **Negative Triggers:** Assert that non-goals are excluded (`Not for orca-cli, orchestration, or generic server health`).
3. **Four Buckets Verification:** Assert that the guide defines Bucket 1 through Bucket 4 with their exact classifications.
4. **Stub Match Test:** Assert that `skills/orca-serve-troubleshoot/SKILL.md` contains `ORCA skills get orca-serve-troubleshoot` and the shared resolver instructions.
5. **CLI Bundle Test:** Assert that `src/cli/bundled-skill-guides.ts` exports `orca-serve-troubleshoot`.

---

## Verification

### Automated Checks
Execute from workspace root:
1. **Regenerate & Check Bundled Assets:**
   ```bash
   node config/scripts/generate-bundled-skill-guides.mjs
   node config/scripts/generate-bundled-skill-guides.mjs --check
   ```
   *Expected:* Exit code `0` with no unstaged changes or drift.

2. **Run Contract Tests:**
   ```bash
   pnpm test config/scripts/orca-serve-troubleshoot-skill-guidance.test.mjs
   ```
   *Expected:* All tests pass.

3. **Verify CLI Skills Commands:**
   ```bash
   # Build CLI or run via tsx/node
   pnpm build:cli
   orca-dev skills list | grep orca-serve-troubleshoot
   orca-dev skills get orca-serve-troubleshoot
   ```
   *Expected:* Output lists `orca-serve-troubleshoot` and `skills get` prints the full guide content.

4. **Verify TypeScript Typecheck & Linter:**
   ```bash
   pnpm tc
   pnpm lint
   ```
   *Expected:* Clean compilation with no errors.

---

## Notes for Next Agent

- **DO NOT PR NOTICE:**
  > **ATTENTION:** Keep in fork for local testing. Do NOT open an upstream PR. This branch (`feature/serve-logging-setup`) is for local fork integration and testing alongside `specs/serve-doctor.md` and `specs/23-serve-xvfb-stale-lock.md`.

- **Stub Overwrite Warning:** Do not hand-edit `skills/orca-serve-troubleshoot/SKILL.md`. It is completely generated by `config/scripts/generate-bundled-skill-guides.mjs` from `skill-stubs/orca-serve-troubleshoot.md` and `skill-guides/orca-serve-troubleshoot.md`.
- **Alphabetical Ordering:** Keep `CANONICAL_GUIDE_NAMES`, `GUIDE_ALIASES`, and `STUB_TOPICS` in `config/scripts/generate-bundled-skill-guides.mjs` strictly sorted alphabetically.
- **Cross-Platform Portability:** All file path references in `skill-guides/orca-serve-troubleshoot.md` must mention the cross-platform variations (e.g., Linux `$HOME/.config/orca` vs macOS `$HOME/Library/Application Support/orca` vs Windows `%APPDATA%\orca`).
