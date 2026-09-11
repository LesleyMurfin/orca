#!/usr/bin/env bash
# ============================================================================
# install-logging-setup.sh — reproduce the Orca Serve logging & diagnostic setup.
#
# One-command provisioning of the logging/triage arrangement for an external
# administrator. It installs the systemd instance unit, provisions the config
# layer and per-instance state tree, and wires log rotation + journal retention
# from the templates in this directory. It does NOT download, build, or start the
# serve — this script arranges the *logging & diagnostics* surface only.
#
# Invocation (the same script audits or installs; no flags enables install):
#   sudo bash install-logging-setup.sh --dry-run                # audit, change nothing
#   sudo bash install-logging-setup.sh                          # install default instance
#   sudo INSTALL_PREFIX=/opt/orca_serve bash install-logging-setup.sh
#   sudo bash install-logging-setup.sh --instance staging --port 6769 --pairing-address 10.0.0.5
#
# Environment (flags override env — see parse_args):
#   INSTALL_PREFIX    serve tree root        (default /opt/orca_serve)
#   SYSTEMD_DIR       systemd unit dir       (default /etc/systemd/system)
#   DEFAULT_INSTANCE  instance name to make  (default default)
#   SERVE_PORT        pinned listener port   (default 6768)
#   PAIRING_ADDRESS   client-advertised addr (default 127.0.0.1)
#   LOGROTATE_DIR     logrotate drop-in dir  (default /etc/logrotate.d)
#   JOURNALD_DIR      journald drop-in dir   (default /etc/systemd/journald.conf.d)
#
# Requires root (writes /etc/systemd + /etc/logrotate.d), Linux, and systemd.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Env-configurable defaults. Flags below override these.
INSTALL_PREFIX="${INSTALL_PREFIX:-/opt/orca_serve}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DEFAULT_INSTANCE="${DEFAULT_INSTANCE:-default}"
SERVE_PORT="${SERVE_PORT:-6768}"
PAIRING_ADDRESS="${PAIRING_ADDRESS:-127.0.0.1}"
LOGROTATE_DIR="${LOGROTATE_DIR:-/etc/logrotate.d}"
JOURNALD_DIR="${JOURNALD_DIR:-/etc/systemd/journald.conf.d}"

# Service identity.
SERVICE_USER="${SERVICE_USER:-orca}"
SERVICE_GROUP="${SERVICE_GROUP:-orca}"

# Template sources (siblings of this script — keeps the installer relocatable).
UNIT_TEMPLATE="$SCRIPT_DIR/orca-serve@.service.template"
CONF_TEMPLATE="$SCRIPT_DIR/orca-serve.conf.template"
INSTANCE_ENV_TEMPLATE="$SCRIPT_DIR/orca-serve-instance.env.template"

# Install destinations.
UNIT_DEST="$SYSTEMD_DIR/orca-serve@.service"
CONF_DEST="$INSTALL_PREFIX/etc/orca-serve.conf"
ENV_DEST="$INSTALL_PREFIX/etc/instances/$DEFAULT_INSTANCE.env"
LOG_SNIPPET_DEST="$LOGROTATE_DIR/orca-serve"
JOURNAL_DROPIN="$JOURNALD_DIR/orca-serve.conf"

DRY_RUN=0
INSTANCE="$DEFAULT_INSTANCE"

# --- UI helpers ------------------------------------------------------------
log()  { printf '%s\n' "$*" >&2; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
pass() { printf 'PASS  %s\n' "$*" >&2; }
fail() { printf 'FAIL  %s\n' "$*" >&2; hard_fail=$((hard_fail + 1)); }
die() {
  printf "[FATAL] %s\n" "$*" >&2
  exit 1
}
hard_fail=0

usage() {
  cat >&2 <<'USAGE'
Usage: install-logging-setup.sh [options]

  --dry-run | --check     Audit only: verify permissions, mounts, dependencies;
                          print the exact actions that WOULD run; change nothing.
  --prefix DIR            Override INSTALL_PREFIX (default /opt/orca_serve).
  --systemd-dir DIR       Override SYSTEMD_DIR (default /etc/systemd/system).
  --instance NAME         Instance name to provision (default default).
  --port PORT             Pinned listener port for the instance (default 6768).
  --pairing-address ADDR  Client-advertised address (default 127.0.0.1).
  -h | --help             Show this help.

Environment: INSTALL_PREFIX, SYSTEMD_DIR, DEFAULT_INSTANCE, SERVE_PORT,
             PAIRING_ADDRESS, LOGROTATE_DIR, JOURNALD_DIR.
USAGE
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "${1:-}" in
      --dry-run|--check) DRY_RUN=1 ;;
      --prefix)        INSTALL_PREFIX="${2:?--prefix needs a value}"; shift ;;
      --prefix=*)      INSTALL_PREFIX="${1#*=}" ;;
      --systemd-dir)   SYSTEMD_DIR="${2:?--systemd-dir needs a value}"; shift ;;
      --systemd-dir=*) SYSTEMD_DIR="${1#*=}" ;;
      --instance)      INSTANCE="${2:?--instance needs a value}"; shift ;;
      --instance=*)    INSTANCE="${1#*=}" ;;
      --port)          SERVE_PORT="${2:?--port needs a value}"; shift ;;
      --port=*)        SERVE_PORT="${1#*=}" ;;
      --pairing-address)   PAIRING_ADDRESS="${2:?--pairing-address needs a value}"; shift ;;
      --pairing-address=*) PAIRING_ADDRESS="${1#*=}" ;;
      -h|--help)       usage; exit 0 ;;
      *)               warn "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
    shift
  done

  # Re-derive destination paths that depend on any overridden vars.
  ENV_DEST="$INSTALL_PREFIX/etc/instances/$INSTANCE.env"
}

# --- preflight (read-only; used by both --check and install) ----------------
# Hard fails block install. Soft warnings (missing service account, prefix on the
# boot drive) are reported but do not block: an external box may legitimately
# differ, and the full serve installer creates those accounts.
preflight() {
  log "== Preflight: dependencies, mounts, permissions =="
  hard_fail=0

  # Dependencies
  if command -v systemctl >/dev/null 2>&1; then pass "systemctl found"; else fail "systemctl not in PATH"; fi
  if [ -d /run/systemd/system ]; then pass "systemd is the running init"; else fail "systemd not booted (/run/systemd/system missing)"; fi
  if command -v awk >/dev/null 2>&1; then pass "awk found"; else fail "awk missing (required for placeholder substitution)"; fi

  # Source templates
  if [ -f "$UNIT_TEMPLATE" ]; then pass "unit template readable"; else fail "missing $UNIT_TEMPLATE"; fi
  if [ -f "$CONF_TEMPLATE" ]; then pass "conf template readable"; else fail "missing $CONF_TEMPLATE"; fi
  if [ -f "$INSTANCE_ENV_TEMPLATE" ]; then pass "instance env template readable"; else fail "missing $INSTANCE_ENV_TEMPLATE"; fi

  # Identity (soft — the full serve installer provisions these)
  if command -v getent >/dev/null 2>&1; then
    getent passwd "$SERVICE_USER" >/dev/null 2>&1 && pass "user $SERVICE_USER exists" || warn "user $SERVICE_USER absent — create before starting the unit"
    getent group  "$SERVICE_GROUP" >/dev/null 2>&1 && pass "group $SERVICE_GROUP exists" || warn "group $SERVICE_GROUP absent — create before starting the unit"
  else
    warn "getent absent — cannot verify $SERVICE_USER:$SERVICE_GROUP"
  fi

  # Mounts / drives (soft). Single-disk hosts are a valid external choice; on
  # multi-disk hosts /<prefix> should NOT share a filesystem with /.
  prefix_fs() { local p="$INSTALL_PREFIX"; while [ ! -e "$p" ] && [ "$p" != "/" ]; do p="$(dirname "$p")"; done; stat -c %d "$p" 2>/dev/null || echo "?"; }
  local root_dev prefix_dev
  root_dev="$(stat -c %d / 2>/dev/null || echo '?')"
  prefix_dev="$(prefix_fs)"
  if [ "$prefix_dev" = "?" ] || [ "$root_dev" = "?" ]; then
    warn "cannot stat filesystem device for $INSTALL_PREFIX — assuming on data volume"
  elif [ "$prefix_dev" = "$root_dev" ]; then
    warn "$INSTALL_PREFIX shares the root filesystem — prefer a data volume e.g. /data"
  else
    pass "prefix on a non-root filesystem (device $prefix_dev)"
  fi

  # Write permissions (hard in install mode via actual commands; report here)
  for d in "$SYSTEMD_DIR" "$LOGROTATE_DIR" "$JOURNALD_DIR"; do
    if [ -d "$d" ] && [ -w "$d" ]; then pass "writable: $d"
    elif [ "$(id -u)" -eq 0 ]; then pass "root: will create/write $d"
    else fail "not writable by this user: $d"; fi
  done

  if [ "$(id -u)" -eq 0 ]; then pass "running as root"; else
    if [ "$DRY_RUN" -eq 0 ]; then fail "must run as root to install"; else warn "not root — install will fail; check mode only"; fi
  fi
}

# --- plan / apply ----------------------------------------------------------
# emit unit with placeholders replaced (awk gsub treats each value as a literal
# replacement string, so it is safe for /, &, | characters in a path).
render_unit() {
  awk -v p="$INSTALL_PREFIX" -v port="$SERVE_PORT" -v addr="$PAIRING_ADDRESS" \
    '{ gsub(/@PREFIX@/, p); gsub(/@PORT@/, port); gsub(/@PAIRING_ADDRESS@/, addr); print }' "$UNIT_TEMPLATE"
}

render_logrotate() {
  # Conditional `su`/`create` ownership: reference the service account only when
  # it exists, otherwise logrotate errors and refuses the whole run.
  local ownership
  if command -v getent >/dev/null 2>&1 \
     && getent passwd "$SERVICE_USER" >/dev/null 2>&1 \
     && getent group  "$SERVICE_GROUP" >/dev/null 2>&1; then
    ownership="    create 0640 $SERVICE_USER $SERVICE_GROUP
    su $SERVICE_USER $SERVICE_GROUP"
  else
    ownership="    create 0644 root root"
  fi

  awk -v p="$INSTALL_PREFIX" -v own="$ownership" \
    '{ gsub(/__PREFIX__/, p); gsub(/__OWNERSHIP__/, own); print }' <<'EOF'
# /etc/logrotate.d/orca-serve — generated by install-logging-setup.sh
# Retention-oriented second layer for the optional append file sink (see the
# unit's StandardOutput=append: note). journald handles the primary sink; this
# bounds a plain-file sink to 7 daily copies and compresses them. copytruncate
# keeps the append fd valid (no reopen race).
__PREFIX__/state/*/logs/*.log {
    daily
    rotate 7
    maxsize 10M
    missingok
    notifempty
    copytruncate
    compress
    delaycompress
__OWNERSHIP__
}
EOF
}

render_journald() {
  cat <<'EOF'
# /etc/systemd/journald.conf.d/orca-serve.conf — generated by install-logging-setup.sh
# Persistent journal + bounded retention so `journalctl -u orca-serve@<instance>`
# survives reboots without growing unbounded on the boot drive. Tune the caps per
# host; these are sane headless defaults.
[Journal]
Storage=persistent
SystemMaxUse=500M
SystemKeepFree=2G
MaxRetentionSec=2week
EOF
}

# Copy a template to <dest> only when <dest> is absent — never clobber an
# operator-edited live file.
copy_if_absent() { # <src> <dest>
  local src="$1" dest="$2"
  if [ -e "$dest" ]; then
    log "  keep (already present): $dest"
  elif [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would create: $dest  (from $(basename "$src"))"
  else
    install -m 0644 "$src" "$dest"
    log "  created: $dest  (from $(basename "$src"))"
  fi
}

apply() {
  log "== Actions for prefix=$INSTALL_PREFIX instance=$INSTANCE (dry-run: $([ "$DRY_RUN" -eq 1 ] && echo yes || echo no)) =="

  # 1. systemd instance unit
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would install unit -> $UNIT_DEST (@PREFIX@=$INSTALL_PREFIX @PORT@=$SERVE_PORT @PAIRING_ADDRESS@=$PAIRING_ADDRESS)"
  else
    mkdir -p "$SYSTEMD_DIR"
    render_unit > "$UNIT_DEST.tmp"
    chmod 0644 "$UNIT_DEST.tmp"
    mv -f "$UNIT_DEST.tmp" "$UNIT_DEST"
    log "  installed unit: $UNIT_DEST"
  fi

  # 2. config layer (files)
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would mkdir -p $INSTALL_PREFIX/etc/instances"
  else
    mkdir -p "$INSTALL_PREFIX/etc/instances"
  fi
  copy_if_absent "$CONF_TEMPLATE" "$CONF_DEST"
  copy_if_absent "$INSTANCE_ENV_TEMPLATE" "$ENV_DEST"

  # 3. per-instance state tree (logs for the optional append sink)
  local state_dir="$INSTALL_PREFIX/state/$INSTANCE"
  local dirs=("$state_dir/logs")
  local d
  for d in "${dirs[@]}"; do
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] would mkdir -p $d"
    else
      mkdir -p "$d"
      # Best-effort ownership: match the service identity when it exists, so the
      # unit (User=$SERVICE_USER, Group=$SERVICE_GROUP) can write its logs.
      if command -v getent >/dev/null 2>&1 \
         && getent passwd "$SERVICE_USER" >/dev/null 2>&1 \
         && getent group  "$SERVICE_GROUP" >/dev/null 2>&1; then
        chown -R "$SERVICE_USER:$SERVICE_GROUP" "$d"
      fi
      chmod 0750 "$d"
    fi
  done

  # 4. log rotation + journal retention
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [dry-run] would write logrotate snippet -> $LOG_SNIPPET_DEST"
    log "  [dry-run] would write journald drop-in -> $JOURNAL_DROPIN"
  else
    mkdir -p "$LOGROTATE_DIR" "$JOURNALD_DIR"
    render_logrotate > "$LOG_SNIPPET_DEST"
    chmod 0644 "$LOG_SNIPPET_DEST"
    log "  installed logrotate snippet: $LOG_SNIPPET_DEST"
    render_journald > "$JOURNAL_DROPIN"
    chmod 0644 "$JOURNAL_DROPIN"
    log "  installed journald drop-in: $JOURNAL_DROPIN"
    systemctl daemon-reload
    log "  ran: systemctl daemon-reload"
  fi
}

print_verification() {
  local P="$INSTALL_PREFIX" I="$INSTANCE"
  cat <<EOF

== Verification — run these after install ====================================
# 1. unit structurally valid + not yet active (enable when ready)
systemd-analyze verify orca-serve@$I.service
# 2. unit rendered with YOUR prefix/port/address in the launch line
systemctl cat orca-serve@$I.service | grep -E '^ExecStart='
# 3. state tree + config layer present, owned by the service account
ls -la $P/state/$I/{logs,} $P/etc/ 2>/dev/null
# 4. logrotate config is valid (dry-run = no rotation performed)
logrotate -d $LOG_SNIPPET_DEST
# 5. start the instance, then watch the journal sink
systemctl enable --now orca-serve@$I.service
journalctl -u orca-serve@$I.service -n 50 --no-pager
==============================================================================
journald change is active after:  systemctl restart systemd-journald
EOF
}

# --- main -------------------------------------------------------------------
parse_args "$@"

log "Orca Serve logging/diagnostic installer"
log "  INSTALL_PREFIX=$INSTALL_PREFIX"
log "  SYSTEMD_DIR=$SYSTEMD_DIR"
log "  instance=$INSTANCE"
log "  port=$SERVE_PORT"
log "  pairing-address=$PAIRING_ADDRESS"
log "  mode=$([ "$DRY_RUN" -eq 1 ] && echo 'dry-run (no changes)' || echo 'install')"
echo

preflight

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  apply
  echo
  if [ "$hard_fail" -eq 0 ]; then
    log "Dry-run complete: all hard checks passed, no changes made."
  else
    log "Dry-run complete: $hard_fail hard check(s) failed (see FAIL lines)."
  fi
  exit "$hard_fail"
fi

if [ "$hard_fail" -ne 0 ]; then
  die "preflight failed ($hard_fail issue(s)) — fix FAIL lines or use --dry-run to triage."
fi

apply
echo
print_verification
log "Done. Enable/start with: systemctl enable --now orca-serve@$INSTANCE.service"
