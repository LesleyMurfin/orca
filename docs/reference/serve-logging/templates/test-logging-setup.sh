#!/usr/bin/env bash
# test-logging-setup.sh — verify install-logging-setup.sh WITHOUT touching production.
#
# Sandbox-installs to a temp dir (overriding every destination under $TMP), then
# checks rendering, validity, and idempotency. Run on any Linux/systemd host:
#
#     bash test-logging-setup.sh
#
# Exit 0 = all checks pass; non-zero = at least one check failed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$HERE/install-logging-setup.sh"
TMP="$(mktemp -d /tmp/orca-serve-test.XXXXXX)"
chmod 0755 "$TMP"
trap 'sudo rm -rf "$TMP"' EXIT

PREFIX="$TMP/prefix"; SYSD="$TMP/systemd"; LR="$TMP/logrotate.d"; JD="$TMP/journald.conf.d"
FAKE_HOME="$TMP/userhome"
sudo mkdir -p "$FAKE_HOME/.agents"
PASS=0; FAIL=0
ok()  { printf 'PASS  %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf 'FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }

echo "== test-logging-setup (sandbox: $TMP) =="

# 1. syntax
if bash -n "$INSTALLER"; then ok "bash -n"; else bad "bash -n"; fi

# 2. dry-run audit (read-only) + reports skill target
dry_out="$(sudo env TARGET_HOME="$FAKE_HOME" HOME="$FAKE_HOME" SUDO_USER="" bash "$INSTALLER" --dry-run 2>&1)"
if printf '%s' "$dry_out" | grep -q "would install agent skill -> $FAKE_HOME/.claude/skills/orca-serve-troubleshoot/SKILL.md"; then
  ok "--dry-run audit (reports skill target)"
else
  bad "--dry-run audit (reports skill target)"
fi

# 3. sandbox install — NO pre-created dirs (proves SYSTEMD_DIR is mkdir'd)
if sudo env TARGET_HOME="$FAKE_HOME" HOME="$FAKE_HOME" SUDO_USER="" INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
     bash "$INSTALLER" --instance test --port 6771 --pairing-address 10.0.0.5 >/dev/null 2>&1; then
  ok "sandbox install (no pre-created dirs)"
else
  bad "sandbox install (no pre-created dirs)"
fi

# 4. every installed artifact is placeholder-free
missing=""; leftover=""
for f in "$SYSD/orca-serve@.service" "$PREFIX/etc/orca-serve.conf" "$PREFIX/etc/instances/test.env" "$LR/orca-serve" "$JD/orca-serve.conf" \
         "$FAKE_HOME/.claude/skills/orca-serve-troubleshoot/SKILL.md" "$FAKE_HOME/.agents/skills/orca-serve-troubleshoot/SKILL.md"; do
  if [ ! -f "$f" ]; then missing="$missing $f"; continue; fi
  if grep -Eq '@(PREFIX|PORT|PAIRING_ADDRESS|USER|GROUP)@' "$f"; then leftover="$leftover $f"; fi
done
if [ -z "$missing" ]; then ok "all expected artifacts present (including agent skills)"; else bad "missing artifacts:$missing"; fi
if [ -z "$leftover" ]; then ok "no leftover @..@ placeholders"; else bad "leftover placeholders:$leftover"; fi

# 4b. verify skill content is valid and matches orca-serve-troubleshoot
if grep -q 'name: orca-serve-troubleshoot' "$FAKE_HOME/.claude/skills/orca-serve-troubleshoot/SKILL.md" \
   && grep -q 'name: orca-serve-troubleshoot' "$FAKE_HOME/.agents/skills/orca-serve-troubleshoot/SKILL.md"; then
  ok "skill installation content verified"
else
  bad "skill installation content verified"
fi

# 5. idempotency — re-run reports 'keep (already present)' (capture, avoid pipe+SIGPIPE)
idem_out="$(sudo env TARGET_HOME="$FAKE_HOME" HOME="$FAKE_HOME" SUDO_USER="" INSTALL_PREFIX="$PREFIX" SYSTEMD_DIR="$SYSD" LOGROTATE_DIR="$LR" JOURNALD_DIR="$JD" \
     bash "$INSTALLER" --instance test --port 6771 --pairing-address 10.0.0.5 2>&1)"
if printf '%s' "$idem_out" | grep -q 'keep (already present)'; then
  ok "idempotency (keep already present)"
else
  bad "idempotency (keep already present)"
fi

# 6. logrotate validity
if logrotate -d "$LR/orca-serve" >/dev/null 2>&1 || sudo logrotate -d "$LR/orca-serve" >/dev/null 2>&1; then
  ok "logrotate -d"
else
  bad "logrotate -d"
fi

# 7. systemd-analyze verify (stub the orca binary the installer intentionally omits)
sudo mkdir -p "$PREFIX/bin"
sudo tee "$PREFIX/bin/orca" >/dev/null <<'EOF'
#!/bin/sh
exit 0
EOF
sudo chmod +x "$PREFIX/bin/orca"
if systemd-analyze verify "$SYSD/orca-serve@.service" >/dev/null 2>&1; then
  ok "systemd-analyze verify"
else
  bad "systemd-analyze verify"
fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
