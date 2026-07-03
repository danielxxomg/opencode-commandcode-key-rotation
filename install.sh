#!/usr/bin/env bash
# install.sh — Copy providers into ~/.config/opencode/providers/
# Run from the repo root: ./install.sh

set -euo pipefail

OPENCODE_PROVIDERS="${HOME}/.config/opencode/providers"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Command Code Key Rotation — Installer ==="
echo ""

# Copy provider (modified with KeyManager)
echo "[1/2] Installing commandcode-retry provider..."
mkdir -p "${OPENCODE_PROVIDERS}/commandcode-retry/src"
cp -r "${SCRIPT_DIR}/providers/commandcode-retry/index.ts" "${OPENCODE_PROVIDERS}/commandcode-retry/"
cp -r "${SCRIPT_DIR}/providers/commandcode-retry/models.json" "${OPENCODE_PROVIDERS}/commandcode-retry/"
cp -r "${SCRIPT_DIR}/providers/commandcode-retry/package.json" "${OPENCODE_PROVIDERS}/commandcode-retry/"
cp -r "${SCRIPT_DIR}/providers/commandcode-retry/tsconfig.json" "${OPENCODE_PROVIDERS}/commandcode-retry/"
cp -r "${SCRIPT_DIR}/providers/commandcode-retry/src/"*.ts "${OPENCODE_PROVIDERS}/commandcode-retry/src/"
echo "  ✓ Provider installed"

# Copy plugin
echo "[2/2] Installing commandcode-key-rotation plugin..."
mkdir -p "${OPENCODE_PROVIDERS}/commandcode-key-rotation"
cp -r "${SCRIPT_DIR}/providers/commandcode-key-rotation/"*.ts "${OPENCODE_PROVIDERS}/commandcode-key-rotation/"
cp -r "${SCRIPT_DIR}/providers/commandcode-key-rotation/"*.tsx "${OPENCODE_PROVIDERS}/commandcode-key-rotation/"
cp -r "${SCRIPT_DIR}/providers/commandcode-key-rotation/package.json" "${OPENCODE_PROVIDERS}/commandcode-key-rotation/"
cp -r "${SCRIPT_DIR}/providers/commandcode-key-rotation/tsconfig.json" "${OPENCODE_PROVIDERS}/commandcode-key-rotation/"
echo "  ✓ Plugin installed"

echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Install dependencies:"
echo "   cd ${OPENCODE_PROVIDERS}/commandcode-retry && bun install"
echo "   cd ${OPENCODE_PROVIDERS}/commandcode-key-rotation && bun install"
echo ""
echo "2. Create your keys config:"
echo "   cp providers/commandcode-key-rotation/keys.json.example ~/.commandcode/keys.json"
echo "   # Edit ~/.commandcode/keys.json with your real API keys"
echo ""
echo "3. Register the plugin in ~/.config/opencode/opencode.json:"
echo '   Add to "plugin" array: "commandcode-key-rotation/server"'
echo '   Add to "provider" object:'
echo '     "commandcode": {'
echo '       "npm": "file:./providers/commandcode-retry",'
echo '       "env": ["COMMANDCODE_API_KEY"]'
echo '     }'
echo ""
echo "4. Restart OpenCode"
echo ""
echo "Done!"
