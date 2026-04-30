#!/usr/bin/env bash
# start.sh — start Mosquitto (if not running) then the UI server
set -euo pipefail

# Ensure Homebrew sbin (where mosquitto lives) is on PATH
export PATH="/opt/homebrew/sbin:/usr/local/sbin:$PATH"

# ── Mosquitto ──────────────────────────────────────────────────────────────
# Check if something is already listening on 1883 (more reliable than brew services)
if lsof -i :1883 -sTCP:LISTEN -t &>/dev/null; then
  echo "→ Mosquitto already running on :1883"
else
  echo "→ Starting Mosquitto..."
  # Reset any stuck brew service state, then start
  brew services stop mosquitto &>/dev/null || true
  brew services start mosquitto
  # Wait up to 5s for the port to open
  for i in 1 2 3 4 5; do
    sleep 1
    lsof -i :1883 -sTCP:LISTEN -t &>/dev/null && break
    echo "  waiting for Mosquitto ($i/5)..."
  done
  if ! lsof -i :1883 -sTCP:LISTEN -t &>/dev/null; then
    echo "⚠  Mosquitto didn't start — running directly in background"
    mosquitto -d -c /opt/homebrew/etc/mosquitto/mosquitto.conf 2>/dev/null \
      || mosquitto -d 2>/dev/null \
      || { echo "✗ Could not start Mosquitto. Install: brew install mosquitto"; exit 1; }
  fi
fi

# ── rtl433-ui ─────────────────────────────────────────────────────────────
echo "→ Starting rtl433-ui  (http://localhost:${PORT:-3000})"
exec node server/index.js
