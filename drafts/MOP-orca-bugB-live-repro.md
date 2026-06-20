# MOP-ORCA-BUGB-001 — Live-repro Bug B (floating-terminal over remote runtime) on the patched fork serve

| Field | Value |
|---|---|
| **MOP ID** | MOP-ORCA-BUGB-001 |
| **Status** | 🟡 DRAFT — PLANNING (awaiting Lesley approval; nothing executes until approved) |
| **Author** | Claude (Opus 4.8) |
| **Date** | 2026-06-20 (Calgary) |
| **Objective** | Empirically confirm the Bug B fix (`src/main/runtime/orca-runtime.ts`, commit `e62673a69`) resolves the floating-workspace terminal `selector_not_found` / black-pane failure when a client is paired to a remote `orca serve`. |
| **Engagement** | Orca fork (LesleyMurfin/orca) live-test. **Nothing filed upstream.** |
| **Risk tier (CRA)** | **T2** (recommended design) — spawns an isolated parallel runtime; touches no prod *userData*. Shared `~/.orca` + `~/.local/share/orca` are confirmed read-only during the repro (PRE-8 mtime proof). The rejected alternative (binary swap) is **T3**. |
| **Approval gate** | Lesley must approve this MOP before any step runs. Per RULE #21 / RULE #30. |
| **Hardened** | 2026-06-20 — incorporated all 6 required fixes from the SRE adversarial safety review (PGID teardown, MD5 extract-dir gate, XDG_DATA_HOME+HOME isolation, client-is-sole-acceptance-gate, xvfb rationale, resource STOP trigger). **Round 2 (NotebookLM adversarial review):** +4 fixes — fix #7 `XDG_RUNTIME_DIR` socket isolation, fix #8 `/tmp` disk-space + extract-size PRE-check, fix #9 acceptance-cwd corrected to the scratch HOME (avoids a false-negative), fix #10 documented prod-recovery pointer (STOP-first retained). |

---

## 1. Critical context — why NOT a binary swap

The **production serve** (PID 130447, port **6768**, systemd user unit `orca-serve.service`, active symlink → `versions/orca-linux-1.4.88.AppImage`) **currently hosts all live workspaces** — the active Claude Code sessions, the **other session building the client**, and terminals tied to this engagement.

➡️ **Restarting the production serve to swap in the patched binary would disrupt all live work (T3, high blast radius). We do NOT do that.**

Instead: run the patched build as a **second, isolated serve instance** on a free port with its own data dir. From a paired client's perspective it is a genuine "remote runtime," so it reproduces Bug B's exact condition — while the production serve keeps running untouched.

| Approach | Risk | Decision |
|---|---|---|
| **A — Parallel test serve** (free port + isolated `XDG_CONFIG_HOME`) | T2 | ✅ **RECOMMENDED** |
| B — Swap prod serve binary via `orca-serve-version` + restart | T3 | ❌ Rejected — disrupts live workspaces; unnecessary for a repro |

---

## 2. Parameters

| Param | Value | Source |
|---|---|---|
| `PATCHED_APPIMAGE` | `/home/lesley/orca-wsl-floating-wt/dist/orca-linux.AppImage` (~186 MB, v1.4.88; Bug B fix verified compiled into `out/main/index.js`) | server-build agent — **SUCCESS 2026-06-20** |
| `TEST_PORT` | `6769` | verified free this session |
| `TEST_HOME` | `/tmp/orca-bugB-test` — scratch root | new scratch dir |
| Env isolation | `XDG_CONFIG_HOME=$TEST_HOME/config`, `XDG_DATA_HOME=$TEST_HOME/data`, `HOME=$TEST_HOME/home` (fix #3), **`XDG_RUNTIME_DIR=$TEST_HOME/run` (mode 0700 — fix #7)** | review fix #3, NLM fix #7 |
| `TEST_PID_FILE` | `$TEST_HOME/serve.pid` (records the launched process-group leader — fix #1) | review fix #1 |
| `PAIR_ADDR` | `192.168.1.167` | matches prod serve `--pairing-address` |
| `PROD_PORT` | `6768` (DO NOT TOUCH) | running prod serve |
| Prod userData | `~/.config/orca` (E2EE keypair, `orca-data.json`, `orchestration.db`, `daemon-v11.sock`) — all under prod's `XDG_CONFIG_HOME`, isolated by the test's override | review Q1 (verified) |

> **Isolation mechanism (verified by SRE review Q1):** Electron derives `userData` from `$XDG_CONFIG_HOME/orca` (`"name":"orca"`). Every prod state path — `orca-data.json`, `orchestration.db`, E2EE keypair, device-registry, daemon socket/pid, runtime RPC sockets, SingletonLock — resolves under `app.getPath('userData')`, so overriding `XDG_CONFIG_HOME` isolates all of them. **But** `~/.orca/*` and `~/.local/share/orca/*` (XDG_DATA_HOME) are `HOME`-rooted and NOT under XDG_CONFIG_HOME — hence we also override `XDG_DATA_HOME` and `HOME` (fix #3) and empirically prove no prod-state mutation via the PRE-8/teardown mtime check.
>
> **Runtime-socket isolation (fix #7 — NLM review):** Chromium/Electron also place IPC/named sockets under `XDG_RUNTIME_DIR` (default `/run/user/$UID`, shared with the prod serve), which `app.getPath('userData')` does NOT cover. We therefore also override `XDG_RUNTIME_DIR=$TEST_HOME/run` (created mode `0700`, as the spec requires) so the test serve cannot collide with prod's runtime sockets. `/dev/shm` and the session D-Bus remain shared, but Orca's own IPC is socket-based under the now-isolated dirs; the PRE-8/teardown mtime proof remains the empirical backstop.
>
> **Extract-dir safety (verified):** the AppImage extract dir is `/tmp/appimage_extracted_<MD5-of-AppImage>`. Prod MD5 = `c84b81423a0c06f6805d16e48eed570e`; patched MD5 = `319c5f2bc26ccba302e53b105fcb73ec` (different content → different dir → **no clobber**). PRE-6 re-confirms this at execution.

---

## 3. Pre-checks (read-only — no gate)

- [ ] PRE-1: Server-build agent reported SUCCESS and `PATCHED_APPIMAGE` exists: `ls -la "$PATCHED_APPIMAGE"`.
- [ ] PRE-2: `git -C /home/lesley/orca-wsl-floating-wt log -1 --oneline` HEAD = `85d3b489d`; build came from this branch (Bug B fix `e62673a69` present).
- [ ] PRE-3: `ss -ltnp | grep :6769` returns nothing (test port still free).
- [ ] PRE-4: Prod serve still healthy & untouched: `systemctl --user is-active orca-serve.service` = `active`; `ss -ltnp | grep :6768` bound.
- [ ] PRE-5: `<PATCHED_APPIMAGE> serve --help` reviewed — confirm port + data-dir flags (record actual flags here before execution).
- [ ] PRE-6 (fix #2): `md5sum "$PATCHED_APPIMAGE"` = `319c5f2bc26ccba302e53b105fcb73ec` (≠ prod `c84b81423a0c06f6805d16e48eed570e`) AND `/tmp/appimage_extracted_319c5f2bc26ccba302e53b105fcb73ec` does not already exist. If the MD5 EQUALS prod's → **STOP** (extract-dir collision).
- [ ] PRE-7 (fix #6): free RAM can absorb a second ~1–2 GB Electron + Xvfb (`free -m`); prod 6768 (PID 130486) has CPU/RSS headroom. Note any concurrent prod load (e.g. a running vitest suite) — prefer to wait for it to finish. If headroom is insufficient → **STOP**.
- [ ] PRE-7b (fix #8 — NLM review): `df -h /tmp` shows ample free space. `--appimage-extract-and-run` unpacks the FULL squashfs (~400–600 MB, not just the 186 MB AppImage) into `/tmp/appimage_extracted_<MD5>`, and `/tmp` is shared with the prod serve. Require ≥2 GB free on `/tmp` (margin for extract + scratch userData + serve.log). If `/tmp` is tight → **STOP** (a full `/tmp` could hang prod's own temp/socket writes — a prod-impact path, not just a test failure).
- [ ] PRE-8 (empirical isolation baseline — fix #3 / RULE #2): record `stat -c '%Y %n'` mtimes of prod `~/.config/orca/orca-data.json`, `~/.config/orca/orchestration.db`, the prod E2EE keypair, and `ls -la ~/.orca ~/.local/share/orca`. These are re-checked at teardown to PROVE the test serve mutated no prod state.

**Any PRE failing → STOP, do not start.**

## 4. Execution steps (each: command → expected → verify; STOP on any deviation)

**Step 1 — Create isolated scratch dirs (all isolation roots, incl. runtime-socket dir)**
`mkdir -p /tmp/orca-bugB-test/{config,data,home,run}` then `chmod 700 /tmp/orca-bugB-test/run` (fix #7 — `XDG_RUNTIME_DIR` must be mode `0700` or Chromium/Electron refuse it).
→ Expected: dirs exist, empty; `run` is `drwx------`. Verify: `ls -la /tmp/orca-bugB-test`.

**Step 2 — Launch the patched serve (parallel, headless, fully isolated, PGID-tracked)** _(background process)_
```
setsid env \
  XDG_CONFIG_HOME=/tmp/orca-bugB-test/config \
  XDG_DATA_HOME=/tmp/orca-bugB-test/data \
  XDG_RUNTIME_DIR=/tmp/orca-bugB-test/run \
  HOME=/tmp/orca-bugB-test/home \
  xvfb-run -a --server-args="-screen 0 1280x1024x24 -nolisten tcp" \
  /home/lesley/orca-wsl-floating-wt/dist/orca-linux.AppImage \
  --appimage-extract-and-run serve --port 6769 --pairing-address 192.168.1.167 --json \
  > /tmp/orca-bugB-test/serve.log 2>&1 &
echo $! > /tmp/orca-bugB-test/serve.pid     # process-group leader for clean teardown (fix #1)
```
> **fix #1:** `setsid` makes the launched process a process-group leader; `serve.pid` records it so teardown can `kill -- -$PGID` the WHOLE tree (the old `pkill -f "--port 6769"` could NOT match the port-bound Electron main, which carries `--serve-port`, and left a zombie).
> **fix #5:** `xvfb-run -a` is MANDATORY — it pre-sets `$DISPLAY` so the serve's internal `:99` self-start path (`ensureVirtualDisplayForHeadlessServe` → `removeStaleDisplayArtifacts(:99)`) never executes and cannot disturb prod's Xvfb. Do NOT let the serve self-start its display.
> Launch syntax verified by the build agent: `--appimage-extract-and-run` avoids the WSL `libfuse.so.2` limitation; `serve --port N --pairing-address ADDR --json` matches the prod serve's invocation.
→ Expected: process starts; `/tmp/orca-bugB-test/serve.log` shows serve boot + a pairing code.
Verify: `ss -ltnp | grep :6769` bound within ~40s; prod `:6768` still bound and `orca-serve.service` still `active` (**isolation proof**); the test serve's userData lives under `/tmp/orca-bugB-test/` (e.g. `ls /tmp/orca-bugB-test/config/orca`), NOT in `~/.config/orca`.

**Step 3 — Pair a client to the test serve** _(requires a GUI client — see §6 dependency)_
Pair a desktop/GUI client to `ws://192.168.1.167:6769` (or `localhost:6769`) using the pairing code from `serve.log`.
→ Expected: client shows the test environment connected. Verify: `serve.log` logs the pairing handshake success.

**Step 4 — Reproduce Bug B (the actual test) — CLIENT outcome is the sole acceptance gate (fix #4)**
In the paired client: open the **floating workspace** and create a **terminal** in it.
→ **PASS (FIX WORKS) — CLIENT-OBSERVED, authoritative:** a live PTY spawns (interactive shell prompt). **No** black pane, **no** `selector_not_found` error toast in the client.
> **cwd expectation (fix #9 — NLM review):** the fix resolves cwd to `homedir()`, and Node's `os.homedir()` returns `$HOME` — which this MOP overrides to `/tmp/orca-bugB-test/home`. So the **expected** PTY cwd is the scratch HOME (`/tmp/orca-bugB-test/home`), **NOT** the real `~`. Do not flag the scratch cwd as a wrong-directory failure (that would be a false negative). The scratch home has no dotfiles; bash spawns fine without them (it just doesn't source `.bashrc`) — an interactive prompt is the gate, not a populated home.
→ **FAIL:** black pane and/or `selector_not_found` toast in the client.
> **fix #4 — why the client is authoritative:** `selector_not_found` is `throw`n and serialized into the RPC **error reply to the client** (`runtime-rpc.ts:642`), NOT written to `serve.log`. So **absence of `selector_not_found` in `serve.log` is NOT proof of success** — a silent black-pane failure would also leave the log clean. The resolver is also not the only surface (create/activate swallow errors; the visible failure is the client transport `onError → TerminalErrorToast`, per REVIEW-FINDINGS:50). Therefore the live PTY in the client is the gate.
→ Server-side corroboration (supporting evidence ONLY, never sole proof): tail `/tmp/orca-bugB-test/serve.log` for a positive PTY-spawn / virtual-session-resolve line for the floating id. If `selector_not_found` *does* appear → hard FAIL.
→ **STOP trigger:** client shows black pane or error toast → halt, capture `serve.log` + client screenshot, report FAIL.

**Step 5 — Capture evidence**
Save: `serve.log`, a screenshot of the client floating terminal (PTY prompt or the failure), and the teardown isolation-proof output (Step 6.4). These are the acceptance evidence.

## 5. Teardown (cleanup, not recovery — isolation proven, then verified empirically)

1. **Kill the test serve by process group (fix #1):**
   `TESTPID=$(cat /tmp/orca-bugB-test/serve.pid); kill -TERM -- -"$TESTPID"` (negative = process group; kills xvfb-run + AppImage launcher + Electron main + all children).
2. **Verify the kill is COMPLETE:** `ss -ltnp | grep :6769` returns nothing AND no process remains under `/tmp/appimage_extracted_319c5f2bc26ccba302e53b105fcb73ec` (`pgrep -af 319c5f2bc26ccba302e53b105fcb73ec` empty). If anything survives → escalate to `kill -KILL -- -"$TESTPID"`; do NOT proceed to `rm -rf` while processes hold files there.
3. `rm -rf /tmp/orca-bugB-test` (only after step 2 confirms dead).
4. **Empirical isolation proof (fix #3 / RULE #2/#3):** re-`stat` the prod paths from PRE-8. The mtimes of prod `~/.config/orca/orca-data.json`, `orchestration.db`, the E2EE keypair, and `~/.orca` / `~/.local/share/orca` MUST be UNCHANGED from baseline. If ANY changed → the isolation leaked → **STOP + PRB**.
5. Confirm prod serve untouched: `systemctl --user is-active orca-serve.service` = `active`; `ss -ltnp | grep :6768` still bound.

**If at any point the production serve (6768) is affected:** STOP immediately, do NOT improvise fixes, alert Lesley — any prod impact is an unexpected deviation requiring a PRB (per change-management "deviation = STOP" and the never-hotfix rule).

> **Documented recovery pointer (fix #10 — NLM review):** STOP-first is deliberate — by design this MOP runs a *parallel* serve and never mutates prod, so there is nothing for the runbook to "roll back"; if prod is nonetheless degraded, the cause is unknown and improvising could worsen it. For Lesley's reference only (NOT an auto-run step), the known-good recovery for the prod serve is the existing tooling: `systemctl --user restart orca-serve.service`, or `infrastructure/orca-serve/orca-serve-version restore` to re-pin the prior version (MOP-FIX-080 fixed its stop-kill/readiness race). Lesley decides whether/when to invoke; the MOP does not.

## 6. Open dependencies / honesty

- ✅ **`PATCHED_APPIMAGE` path** — RESOLVED. Build SUCCESS 2026-06-20: `/home/lesley/orca-wsl-floating-wt/dist/orca-linux.AppImage`, Bug B fix verified compiled in. PRE-1 satisfied.
- 🧑‍💻 **GUI client needed for Step 3–4** — the floating workspace + its terminal are client-side UI; the repro requires a real client paired to the test serve. Bug B's fix is **server-side**, so the client need NOT be patched — a stock desktop client works. This step likely needs Lesley (or a spare GUI client instance). Coordinate with the client-build session so we don't collide on the desktop.
- 🔎 **`serve --help` flag confirmation** (PRE-5) — XDG isolation is the planned mechanism; verify the serve honors it (or use the explicit data-dir flag) before trusting isolation.

## 7. Acceptance criteria (Bug B fix is CONFIRMED iff all hold)

1. Floating-workspace terminal over the remote (test) serve spawns a **live PTY** — no `selector_not_found`, no black pane.
2. PTY cwd is `homedir()` per the fix's contract — which under this MOP's `HOME` override is the scratch home `/tmp/orca-bugB-test/home` (fix #9). The *contract* (cwd == `homedir()`) is what's verified; the absolute path differs only because `HOME` is overridden for isolation.
3. Production serve (6768) and all live workspaces are **provably unaffected** throughout.
4. Evidence captured (log + screenshot + grep).

---

**Approval:** ⛔ This MOP is DRAFT. Do not execute any step until Lesley reviews and explicitly approves. Continuous CRA: if the risk tier escalates (e.g. the only viable repro turns out to require touching the prod serve), STOP and re-plan.
