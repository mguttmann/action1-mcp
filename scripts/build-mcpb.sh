#!/usr/bin/env bash
# Build a deployable .mcpb bundle.
#
# Usage:  npm run build:mcpb
#
# Output: dist/action1-mcp-<version>.mcpb
#
# Requires `dist/` to exist (run `npm run build` first) and the
# @anthropic-ai/mcpb CLI (used via npx).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -e "console.log(require('./package.json').version)")"
OUT="dist/action1-mcp-${VERSION}.mcpb"

if [ ! -d "dist" ] || [ -z "$(ls -A dist 2>/dev/null | grep -v '\.mcpb$' || true)" ]; then
  echo "dist/ is empty; running build first…"
  npm run build
fi

# Clean previous staging
rm -rf mcpb/server
mkdir -p mcpb/server

# Copy compiled JS
cp -R dist/* mcpb/server/

# Create a minimal package.json inside the bundle so node resolves modules
node -e "
const pkg = require('./package.json');
const bundled = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type,
  main: 'index.js',
  dependencies: pkg.dependencies,
};
require('fs').writeFileSync('mcpb/server/package.json', JSON.stringify(bundled, null, 2));
"

# Install runtime deps inside the bundle so it ships self-contained
( cd mcpb/server && npm install --omit=dev --no-audit --no-fund --silent )

# Pack
npx -y @anthropic-ai/mcpb pack mcpb "$OUT"

echo
echo "Built $OUT"
ls -lh "$OUT"
