#!/usr/bin/env bash
# setup.sh — one-time setup for rtl433-ui on macOS
set -euo pipefail

echo "==> rtl433-ui setup"
echo ""

# ── Homebrew ───────────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "❌  Homebrew is required. Install from https://brew.sh and re-run."
  exit 1
fi

# ── System deps ────────────────────────────────────────────────────────────
echo "→ Installing rtl-sdr, rtl_433, mosquitto via Homebrew..."
brew install rtl-sdr rtl_433 mosquitto

# ── Node.js ────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "→ Installing Node.js..."
  brew install node
fi

echo "   Node $(node -v)  npm $(npm -v)"

# ── npm packages ───────────────────────────────────────────────────────────
echo "→ Installing npm packages..."
npm install

# ── Config files ───────────────────────────────────────────────────────────
mkdir -p config

if [ ! -f config/mappings.json ]; then
  echo "{}" > config/mappings.json
  echo "→ Created config/mappings.json"
fi

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "→ Created .env from .env.example (edit if needed)"
fi

echo ""
echo "✅  Setup complete!"
echo ""
echo "   Plug in your RTL-SDR dongle, then:"
echo ""
echo "   ./start.sh          # starts Mosquitto + the UI"
echo "   open http://localhost:3000"
echo ""
echo "   Or manually:"
echo "   brew services start mosquitto"
echo "   npm start"
