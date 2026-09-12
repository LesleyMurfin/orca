# Orca Serve — Logging & Diagnostic Setup

Reproduce the headless `orca serve` logging, observability, and triage arrangement on any Linux/systemd
host in under 5 minutes. The provided installation script (`install-logging-setup.sh`) provisions the
systemd template unit, configuration hierarchy, per-instance state tree, logrotate rules, journald
retention policies, and automatically installs an AI Agent troubleshooting skill.

It does **not** download, build, or start the serve binary — it prepares and hardens the operational
and diagnostic surface.

```bash
# Quick Audit & Install (Local Repo)
sudo bash install-logging-setup.sh --dry-run   # audit first, change nothing
sudo bash install-logging-setup.sh             # provision observability surface
```

---

## Table of Contents

- [1. Quick Start](#1-quick-start)
  - [Option A: From a Cloned Repository](#option-a-from-a-cloned-repository)
  - [Option B: Standalone / Remote Curl Execution](#option-b-standalone--remote-curl-execution)
- [2. Architecture & Process Flow](#2-architecture--process-flow)
  - [System & Observability Architecture](#system--observability-architecture)
  - [Script Execution Lifecycle (3 Phases)](#script-execution-lifecycle-3-phases)
- [3. Step-by-Step Breakdown](#3-step-by-step-breakdown)
  - [1. Preflight Environment Check](#1-preflight-environment-check)
  - [2. Systemd Unit Installation](#2-systemd-unit-installation)
  - [3. Config Hierarchy Provisioning](#3-config-hierarchy-provisioning)
  - [4. Log Directory & Retention Policies](#4-log-directory--retention-policies)
  - [5. Automatic AI Agent Skill Installation](#5-automatic-ai-agent-skill-installation)
- [4. Configuration & Knobs](#4-configuration--knobs)
- [5. Verification & Dry-Run Instructions](#5-verification--dry-run-instructions)
  - [Step 1: Preflight Audit (Dry Run)](#step-1-preflight-audit-dry-run)
  - [Step 2: Post-Installation Verification](#step-2-post-installation-verification)
  - [Step 3: Run the Non-Destructive Test Suite](#step-3-run-the-non-destructive-test-suite)
- [6. Five-Command Diagnostic Triage Cheatsheet](#6-five-command-diagnostic-triage-cheatsheet)
  - [Classification Matrix (The 4 Buckets)](#classification-matrix-the-4-buckets)
- [7. Official Documentation & References](#7-official-documentation--references)
  - [External & Platform Documentation](#external--platform-documentation)
  - [Repository Reference Guides](#repository-reference-guides)

---
## 1. Quick Start

### Option A: From a Cloned Repository

Run directly from within `docs/reference/serve-logging/templates/`:

```bash
# 1. Audit preflight prerequisites (read-only)
sudo bash install-logging-setup.sh --dry-run

# 2. Run installation (defaults to /opt/orca_serve and instance 'default')
sudo bash install-logging-setup.sh

# Or customize instance parameters:
sudo bash install-logging-setup.sh \
  --prefix /data/orca_serve \
  --instance production \
  --port 6768 \
  --pairing-address 10.0.0.10
```

### Option B: Standalone / Remote Curl Execution

Provision an external host via a single `curl | bash` command without needing to clone the full repository:

```bash
# 1. Audit remotely (safe dry-run)
curl -fsSL https://raw.githubusercontent.com/LesleyMurfin/orca/feature/serve-logging-setup/docs/reference/serve-logging/templates/install-logging-setup.sh | sudo bash -s -- --dry-run

# 2. Install remotely
curl -fsSL https://raw.githubusercontent.com/LesleyMurfin/orca/feature/serve-logging-setup/docs/reference/serve-logging/templates/install-logging-setup.sh | sudo bash -s -- --instance default --port 6768
```

*(When run standalone via curl, the installer automatically downloads companion template files and the agent skill from GitHub, with a self-contained embedded fallback for air-gapped environments).*

---

## 2. Architecture & Process Flow

### System & Observability Architecture

```
+---------------------------------------------------------------------------------------------------+
| Host System (Linux / systemd)                                                                     |
|                                                                                                   |
|  +------------------------+      Loads host config      +--------------------------------------+  |
|  | /etc/systemd/system/   | --------------------------> | <PREFIX>/etc/orca-serve.conf         |  |
|  |   orca-serve@.service  |                             | (host-wide flags & environment)      |  |
|  +-----------+------------+                             +--------------------------------------+  |
|              |                                                             |                      |
|              | Instantiates for %i                                         v Overrides per %i     |
|              v                                          +--------------------------------------+  |
|  +------------------------+                             | <PREFIX>/etc/instances/%i.env        |  |
|  | orca-serve@<inst>      | <-------------------------- | (instance-specific port, address)    |  |
|  | (Daemon Process)       |                                                                       |
|  +-----------+------------+                                                                       |
|              |                                                                                    |
|       Writes stdout/stderr                                                                        |
|              |                                                                                    |
|              +--------------------------------+-----------------------------------+               |
|              | Primary Sink (default)         | Optional Sink                     |               |
|              v                                v                                   |               |
|  +------------------------+       +------------------------------------+          |               |
|  | systemd-journald       |       | <PREFIX>/state/<inst>/logs/        |          |               |
|  | Storage=persistent     |       |   serve.log (via append sink)      |          |               |
|  | MaxRetentionSec=2week  |       +-----------------+------------------+          |               |
|  +------------------------+                         |                             |               |
|              ^                                      v                             |               |
|              | Managed by                           | Managed by                  |               |
|  +------------------------+       +-----------------+------------------+          |               |
|  | /etc/systemd/          |       | /etc/logrotate.d/                  |          |               |
|  |  journald.conf.d/      |       |   orca-serve                       |          |               |
|  |   orca-serve.conf      |       |   (daily, 7 rotations, maxsize 10M)|          |               |
|  +------------------------+       +------------------------------------+          |               |
|                                                                                   |               |
|  +-----------------------------------------------------------------------------+  |               |
|  | Operator & AI Agent Diagnostic Layer                                        |  |               |
|  |                                                                             |  |               |
|  |  Claude Code / Agents: ~/.claude/skills/orca-serve-troubleshoot/SKILL.md    |  |               |
|  |  Commands: systemctl status, journalctl, ss, orca status, logrotate -d      |  |               |
|  +-----------------------------------------------------------------------------+  |               |
+---------------------------------------------------------------------------------------------------+
```

### Script Execution Lifecycle (3 Phases)

`install-logging-setup.sh` strictly adheres to a three-phase pipeline:

```
+-----------------------------------------------------------------------------+
| Phase 1: Preflight Audit (Read-Only)                                        |
|                                                                             |
|  - Validates OS is Linux with active systemd init (/run/systemd/system)     |
|  - Verifies required utilities: systemctl, awk, stat, id                    |
|  - Audits template accessibility (local sibling files vs curl/wget)         |
|  - Checks service account presence (orca:orca; warns if absent)             |
|  - Verifies mount point topology (warns if prefix is on root filesystem)   |
|  - Validates write permissions for system directories (root check)          |
|  - If --dry-run: reports planned actions and exits 0                        |
+-----------------------------------------------------------------------------+
                                      |
                                      v (Passes preflight)
+-----------------------------------------------------------------------------+
| Phase 2: Observability Provisioning                                         |
|                                                                             |
|  - Substitutes placeholders (@PREFIX@, @PORT@, @PAIRING_ADDRESS@, @USER@)   |
|  - Installs systemd instance unit: /etc/systemd/system/orca-serve@.service  |
|  - Provisions configuration tree: <prefix>/etc/orca-serve.conf              |
|  - Provisions instance config: <prefix>/etc/instances/<instance>.env        |
|    (copy-if-absent: preserves existing operator customizations)             |
|  - Creates per-instance state directory: <prefix>/state/<instance>/logs/    |
|  - Sets directory permissions (0750) and best-effort ownership (orca:orca)  |
|  - Installs logrotate snippet: /etc/logrotate.d/orca-serve (copytruncate)   |
|  - Installs journald drop-in: /etc/systemd/journald.conf.d/orca-serve.conf  |
|  - Triggers systemctl daemon-reload                                         |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| Phase 3: AI Skill Auto-Installation                                         |
|                                                              -------------+
|  - Resolves target invoking user ($TARGET_USER, $SUDO_USER, or current)     |
|  - Locates skill target: ~/.claude/skills/orca-serve-troubleshoot/SKILL.md  |
|    (and ~/.agents/skills/orca-serve-troubleshoot/SKILL.md if present)       |
|  - Resolves skill content (local source -> curl/wget -> embedded fallback)  |
|  - Writes SKILL.md and chowns to target user                                |
|  - Outputs verification commands and triage runbook pointers                |
+-----------------------------------------------------------------------------+
```

---

## 3. Step-by-Step Breakdown

Here is exactly what `install-logging-setup.sh` does during execution:

### 1. Preflight Environment Check
- **Init & Tools:** Checks that systemd is booted (`/run/systemd/system` exists) and that `systemctl` and `awk` are in `$PATH`.
- **Template Availability:** Checks that template files exist locally or can be fetched remotely.
- **Service Identity:** Checks whether service user/group (`orca:orca` by default) exist via `getent`. If missing, issues a non-blocking `WARN` (you can provision the user before starting the service).
- **Mount Point Topology:** Inspects filesystem device IDs for `/` and `$INSTALL_PREFIX`. If `$INSTALL_PREFIX` shares the root device, issues a soft `WARN` recommending a dedicated data mount (e.g. `/data` or `/srv`).
- **Write Permissions:** Verifies write access to `/etc/systemd/system`, `/etc/logrotate.d`, and `/etc/systemd/journald.conf.d`.

### 2. Systemd Unit Installation
- Renders `orca-serve@.service.template` with literal awk replacements for `@PREFIX@`, `@PORT@`, `@PAIRING_ADDRESS@`, `@USER@`, and `@GROUP@`.
- Writes atomic temporary unit and moves to `/etc/systemd/system/orca-serve@.service` with mode `0644`.
- Runs `systemctl daemon-reload` so systemd registers the new unit template immediately.

### 3. Config Hierarchy Provisioning
The runtime uses a two-tier configuration hierarchy loaded by systemd:
1. **Host-wide defaults:** `<INSTALL_PREFIX>/etc/orca-serve.conf` (loaded first via `EnvironmentFile=-...`).
2. **Instance-specific overrides:** `<INSTALL_PREFIX>/etc/instances/%i.env` (loaded second, overriding host settings).
- **Safety guarantee:** Existing configurations are **never overwritten** (`copy_if_absent`). Operator edits are strictly preserved on repeat runs.

### 4. Log Directory & Retention Policies
- **State Tree:** Creates `<INSTALL_PREFIX>/state/<instance>/logs/` with mode `0750` and sets ownership to `orca:orca` (if the account exists).
- **Logrotate Policy:** Writes `/etc/logrotate.d/orca-serve` targeting `<INSTALL_PREFIX>/state/*/logs/*.log`. Uses `daily`, `rotate 7`, `maxsize 10M`, `copytruncate`, `compress`, and `delaycompress`. If service user `orca` exists, adds `su orca orca` and `create 0640 orca orca`; otherwise defaults safely to `root root`.
- **Journal Retention:** Writes `/etc/systemd/journald.conf.d/orca-serve.conf` setting `Storage=persistent`, `SystemMaxUse=500M`, `SystemKeepFree=2G`, and `MaxRetentionSec=2week`.

### 5. Automatic AI Agent Skill Installation
The installer automatically equips your developer environment with the `orca-serve-troubleshoot` skill:
- Determines the active operator user using `$TARGET_USER`, `$SUDO_USER`, or `$USER`.
- Deploys the skill definition to:
  - `~/.claude/skills/orca-serve-troubleshoot/SKILL.md` (Claude Code)
  - `~/.agents/skills/orca-serve-troubleshoot/SKILL.md` (if `.agents` directory exists)
- Acquisition precedence:
  1. Local repository file (`skills/orca-serve-troubleshoot/SKILL.md`)
  2. Remote fetch via `curl` / `wget` from GitHub
  3. Built-in embedded fallback (works offline and standalone)

---

## 4. Configuration & Knobs

The script accepts configuration via command-line flags or environment variables:

| Flag | Env Variable | Default | Purpose |
|------|--------------|---------|---------|
| `--prefix <path>` | `INSTALL_PREFIX` | `/opt/orca_serve` | Root path for serve binaries, configs, and state |
| `--instance <name>` | `DEFAULT_INSTANCE` | `default` | Instance name for the initial configuration file |
| `--port <port>` | `SERVE_PORT` | `6768` | Pinned TCP port for the serve listener |
| `--pairing-address <addr>` | `PAIRING_ADDRESS` | `127.0.0.1` | Client-advertised network address |
| `--systemd-dir <path>` | `SYSTEMD_DIR` | `/etc/systemd/system` | Systemd unit directory |
| `--logrotate-dir <path>` | `LOGROTATE_DIR` | `/etc/logrotate.d` | Drop-in directory for logrotate |
| `--journald-dir <path>` | `JOURNALD_DIR` | `/etc/systemd/journald.conf.d` | Drop-in directory for journald |
| `--dry-run` | `DRY_RUN=1` | `0` | Run preflight check and preview actions without changes |

---

## 5. Verification & Dry-Run Instructions

### Step 1: Preflight Audit (Dry Run)
Before modifying your system, run an audit:
```bash
sudo bash install-logging-setup.sh --dry-run
```
- Ensure output reports `PASS` for all critical checks.
- If you see `WARN user orca absent`, create the service user:
  ```bash
  sudo useradd -r -s /usr/sbin/nologin -d /opt/orca_serve orca
  ```

### Step 2: Post-Installation Verification
Run the verification sequence printed at the conclusion of installation:

```bash
# 1. Verify unit structure syntax
systemd-analyze verify orca-serve@default.service

# 2. Inspect rendered ExecStart launch line
systemctl cat orca-serve@default.service | grep -E '^ExecStart='

# 3. Confirm config files and state log tree permissions
ls -la /opt/orca_serve/etc/ /opt/orca_serve/state/default/logs/

# 4. Test logrotate syntax in debug mode (dry-run)
logrotate -d /etc/logrotate.d/orca-serve

# 5. Confirm AI troubleshooting skill is present
test -f "$HOME/.claude/skills/orca-serve-troubleshoot/SKILL.md" && echo "AI skill installed"

# 6. Apply journald retention drop-in
sudo systemctl restart systemd-journald
```

### Step 3: Run the Non-Destructive Test Suite
Verify installer logic, templating substitutions, and idempotency in an isolated sandbox without affecting production files:
```bash
bash test-logging-setup.sh
```

---

## 6. Five-Command Diagnostic Triage Cheatsheet

When diagnosing an `orca serve` instance, run this non-destructive 5-command triage sequence to collect complete operational evidence:

```
+-----------------------------------------------------------------------------------+
| 5-Command Triage Pipeline                                                         |
+-----------------------------------------------------------------------------------+
| 1. systemctl status orca-serve@<instance>.service --no-pager                      |
|    -> Checks unit state: active, inactive, status=137 (OOM), status=203 (EXEC)     |
|                                                                                   |
| 2. journalctl -u orca-serve@<instance>.service -n 50 --no-pager                   |
|    -> Inspects latest logs for SIGSEGV, SIGTRAP, unhandled errors, or fallbacks   |
|                                                                                   |
| 3. ss -ltnp | grep -E ':(6768|6769|6770|6771)'                                    |
|    -> Identifies which PID is listening and whether port rollover occurred        |
|                                                                                   |
| 4. orca --environment <id> status --json | jq '.runtime'                          |
|    -> Queries client-side perspective of runtime reachability and registration   |
|                                                                                   |
| 5. logrotate -d /etc/logrotate.d/orca-serve                                       |
|    -> Verifies rotation rules, glob matching, and file permissions                |
+-----------------------------------------------------------------------------------+
```

### Classification Matrix (The 4 Buckets)

Match the findings from the 5 commands to the root-cause bucket:

| Findings & Evidence | Root-Cause Bucket | Immediate Corrective Action |
|---------------------|-------------------|-----------------------------|
| `SIGSEGV`, `SIGTRAP`, panic in journal | **Bucket 1 — Orca Bug** | Pin/rollback `ORCA_VERSION`; isolate reproduction |
| `status=137` (OOM / SIGKILL), `ENOSPC`, `EMFILE` | **Bucket 2 — Server Resource** | Increase systemd `MemoryMax` / `LimitNOFILE`; free disk space |
| `status=203` (EXEC), permission denied, port collision | **Bucket 3 — Server Config** | Fix path/binary permissions; resolve port conflict or clean fallback file |
| `activeRuntimeEnvironmentId` mismatch, connection refused | **Bucket 4 — Client Config** | Reconcile environment ID and pairing address in client settings |

For full triage recipes and detailed fix procedures, consult [`../orca-serve-troubleshooting-matrix.md`](../orca-serve-troubleshooting-matrix.md).

---

## 7. Official Documentation & References

### External & Platform Documentation
- **Orca Official Website & Docs:** [https://www.onorca.dev/docs/remote-servers](https://www.onorca.dev/docs/remote-servers)
- **systemd Service & Unit Documentation:** [systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- **systemd Journald Configuration:** [journald.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)
- **Logrotate Utility Documentation:** [logrotate(8) Manual](https://man7.org/linux/man-pages/man8/logrotate.8.html)
- **Claude Code Agent Skills:** [Claude Agent Skills Documentation](https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills)

### Repository Reference Guides
- [Orca Serve Logging Guide](../orca-serve-logging-guide.md) — Comprehensive logging architecture, environment variables, and stream sinks.
- [Orca Serve Troubleshooting Matrix](../orca-serve-troubleshooting-matrix.md) — Exhaustive symptom-to-bucket triage procedures.
- [Orca Client Diagnostics Runbook](orca-client-diagnostics.md) — Client-side connectivity and pairing verification runbook.
- [Agent Skill Specification](../../../../skills/orca-serve-troubleshoot/SKILL.md) — Automated LLM triage skill definition.
