#!/bin/sh
# Keep term-hub running in the background: starts at login and restarts if it
# dies. (While it's on, the server holds off idle sleep itself — see
# lib/power.js; the panel's Turn off / Turn on don't need this script.)
#
#   scripts/launchd.sh install     install + start
#   scripts/launchd.sh stop        stop the process, and keep it stopped (also after login) until start
#   scripts/launchd.sh start       start it again
#   scripts/launchd.sh restart     restart (after editing config.json or code)
#   scripts/launchd.sh uninstall   stop + remove
#
# HUB_LABEL=<label> manages another job (with its own plist and log), for tests.
# Settings come from config.json, read on every start.
set -eu

LABEL=${HUB_LABEL:-com.matheuscorreiag.term-hub}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/${LABEL##*.}.log"
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
DOMAIN="gui/$(id -u)"

xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

case "${1:-}" in
  install)
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$DIR/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$NODE")"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
EOF
    launchctl enable "$DOMAIN/$LABEL" # in case it was stopped
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout can return before the old job is gone, and bootstrapping then fails (error 5).
    i=0
    while launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && [ $i -lt 100 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed: $PLIST"
    echo "log: $LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed"
    ;;
  stop)
    # Disabled too: KeepAlive would restart it, and RunAtLoad at the next login.
    launchctl disable "$DOMAIN/$LABEL"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "stopped — turn it back on with: $0 start"
    ;;
  start)
    [ -f "$PLIST" ] || { echo "not installed — run: $0 install" >&2; exit 1; }
    launchctl enable "$DOMAIN/$LABEL"
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "already running"
    else
      launchctl bootstrap "$DOMAIN" "$PLIST"
      echo "started"
    fi
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  *)
    echo "usage: $0 install | start | stop | restart | uninstall" >&2
    exit 1
    ;;
esac
