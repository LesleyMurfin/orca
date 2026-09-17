#!/usr/bin/env bash
# run-xvfb-test.sh - Verification suite for Xvfb stale display lock fix (Fork Issue #23 / PRD-1)
set -euo pipefail

echo "============================================================"
echo "Starting Xvfb Stale Display Lock Verification in Docker"
echo "============================================================"

DISPLAY_NUM=99
LOCK_FILE="/tmp/.X${DISPLAY_NUM}-lock"
SOCK_DIR="/tmp/.X11-unix"
SOCK_FILE="${SOCK_DIR}/X${DISPLAY_NUM}"

# Cleanup any previous runs
rm -f "$LOCK_FILE" "$SOCK_FILE"
mkdir -p "$SOCK_DIR"
chmod 1777 "$SOCK_DIR"

echo ""
echo "=== Step 1: Install workspace dependencies for test execution ==="
pnpm install --frozen-lockfile --ignore-scripts

echo ""
echo "=== Step 2: Run Vitest Unit Tests (mocked) ==="
node -e "const { execSync } = require('child_process'); console.log(execSync('./node_modules/.bin/vitest run --config config/vitest.config.ts src/main/startup/ensure-virtual-display.test.ts', {encoding: 'utf8'}));"

echo ""
echo "=== Step 3: Run Vitest Container Tests (real Xvfb process) ==="
node -e "const { execSync } = require('child_process'); console.log(execSync('./node_modules/.bin/vitest run --config config/vitest.config.ts src/main/startup/xvfb-stale-lock.container.test.ts', {encoding: 'utf8'}));"

echo ""
echo "=== Step 4: Standalone Integration Verification ==="
# Test scenario per spec:
# a) Create orphan /tmp/.X99-lock with dead PID 999999 without /tmp/.X11-unix/X99
echo "999999" > "$LOCK_FILE"
rm -f "$SOCK_FILE"

echo "Created orphan lock file:"
ls -la "$LOCK_FILE"
echo "Lock file content (PID): $(cat "$LOCK_FILE")"
echo "Socket exists: $([ -e "$SOCK_FILE" ] && echo 'YES' || echo 'NO')"

# b) Run the test verifying isStaleDisplayLock(99) detects it and reaps it cleanly, allowing Xvfb to start without error.
node -e "
const { execSync } = require('child_process');
const result = execSync('./node_modules/.bin/vitest run --config config/vitest.config.ts src/main/startup/xvfb-stale-lock.container.test.ts -t \"reaps orphan stale lock and allows real Xvfb to start cleanly\"', {encoding: 'utf8'});
console.log(result);
"

echo "Verifying post-startup state on system:"
echo "Current lock file on disk: $(ls -la "$LOCK_FILE" 2>/dev/null || echo 'NONE')"
if [ -f "$LOCK_FILE" ]; then
  echo "Current PID in lock file: $(cat "$LOCK_FILE")"
fi
echo "Current socket on disk: $(ls -la "$SOCK_FILE" 2>/dev/null || echo 'NONE')"

echo ""
echo "============================================================"
echo "ALL TESTS PASSED: Orphan stale lock reaped and Xvfb started cleanly!"
echo "============================================================"
