#!/usr/bin/env bash
# run-test-in-container.sh - Runner script to execute the verification suite inside the container
set -euo pipefail

echo "============================================================"
echo "Starting Orca Serve Logging Setup verification in container"
echo "============================================================"

# Ensure /run/systemd/system exists so preflight detects systemd environment if not booted as PID 1
mkdir -p /run/systemd/system

cd /workspace

echo ""
echo "=== Step 1: Run test-logging-setup.sh ==="
bash docs/reference/serve-logging/templates/test-logging-setup.sh

echo ""
echo "=== Step 2: Run install-logging-setup.sh --dry-run ==="
sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh --dry-run

echo ""
echo "=== Step 3: Run install-logging-setup.sh (real install) ==="
sudo bash docs/reference/serve-logging/templates/install-logging-setup.sh

echo ""
echo "=== Step 4: Verify installed files ==="
echo "--- /etc/systemd/system/ ---"
ls -la /etc/systemd/system/orca-serve*

echo "--- /opt/orca_serve/ ---"
ls -la /opt/orca_serve/
ls -la /opt/orca_serve/etc/
ls -la /opt/orca_serve/etc/instances/

echo "--- /etc/logrotate.d/ ---"
ls -la /etc/logrotate.d/orca-serve

echo "--- /etc/systemd/journald.conf.d/ ---"
ls -la /etc/systemd/journald.conf.d/orca-serve.conf

echo ""
echo "=== Step 5: Verify logrotate syntax ==="
logrotate -d /etc/logrotate.d/orca-serve

echo ""
echo "=== Step 6: Verify systemd unit with systemd-analyze ==="
# Stub orca binary so systemd-analyze verify doesn't fail on ExecStart path check
mkdir -p /opt/orca_serve/bin
cat <<'EOF' > /opt/orca_serve/bin/orca
#!/bin/sh
exit 0
EOF
chmod +x /opt/orca_serve/bin/orca

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify /etc/systemd/system/orca-serve@default.service
  echo "systemd-analyze verify PASS"
else
  echo "systemd-analyze not available"
fi

echo ""
echo "============================================================"
echo "All steps completed successfully!"
echo "============================================================"
