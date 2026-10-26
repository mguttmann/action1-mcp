#!/usr/bin/env bash
# Build a deployable, bit-for-bit reproducible .mcpb bundle and its SBOM.
#
# Usage:  npm run build:mcpb
#
# Output: dist/action1-mcp-<version>.mcpb
#         dist/action1-mcp-<version>.mcpb.cdx.json          (CycloneDX SBOM)
#         dist/action1-mcp-server-<version>.tgz.cdx.json    (SBOM of the npm package)
#
# Every run is a clean build: dist/ and the staging directory are wiped,
# TypeScript is compiled from scratch, and the bundle's runtime
# dependencies are installed with `npm ci --omit=dev --ignore-scripts`
# from the committed package-lock.json, so the bundle contains exactly the
# dependency versions CI tested. The bundle also carries LICENSE, NOTICE
# (when present) and THIRD_PARTY_NOTICES.md for every bundled package.
# The MCPB CLI is the pinned devDependency @anthropic-ai/mcpb (run
# `npm ci` first).
#
# Reproducible: the packed archive is rewritten by
# scripts/reproducible-zip.mjs (sorted entries, modes 0644/0755, one
# timestamp). The timestamp is SOURCE_DATE_EPOCH, by default the commit
# time of HEAD, so two builds of the same commit give the same SHA-256.
# The SBOMs take their timestamp from it too (scripts/release-sbom.mjs).
# CI checks this (job mcpb-reproducible in .github/workflows/ci.yml).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
STAGE="build/mcpb"
OUT="dist/action1-mcp-${VERSION}.mcpb"
MCPB="node_modules/.bin/mcpb"

if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || true)"
fi
if [ -z "$SOURCE_DATE_EPOCH" ]; then
  echo "error: not a git checkout; set SOURCE_DATE_EPOCH (unix seconds) for the bundle timestamps." >&2
  exit 1
fi
export SOURCE_DATE_EPOCH

if [ ! -x "$MCPB" ]; then
  echo "error: $MCPB not found. Run 'npm ci' first (the MCPB CLI is a pinned devDependency)." >&2
  exit 1
fi

# 1. Clean build: no leftovers from an earlier build or an earlier bundle.
node -e "for (const d of ['dist', 'build/mcpb']) require('fs').rmSync(d, { recursive: true, force: true })"
npm run build

# 2. Stage the bundle: manifest, docs, legal files, compiled server.
mkdir -p "$STAGE/server"
cp mcpb/manifest.json mcpb/README.md LICENSE "$STAGE/"
if [ -f NOTICE ]; then cp NOTICE "$STAGE/"; fi

# Compiled runtime only: no code generator (dev tooling), no type
# declarations, no source maps.
( cd dist && find . -type f -name '*.js' ! -path './codegen/*' -print ) | while read -r f; do
  mkdir -p "$STAGE/server/$(dirname "$f")"
  cp "dist/$f" "$STAGE/server/$f"
done

# package.json (version lookup at runtime, dependency spec) and the
# lockfile, so npm ci installs the tested tree. Lifecycle scripts are
# dropped; they are not needed inside the bundle.
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
delete pkg.scripts;
fs.writeFileSync('$STAGE/server/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
cp package-lock.json "$STAGE/server/package-lock.json"

# 3. Runtime dependencies exactly as locked, without install scripts.
( cd "$STAGE/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
# The bundle has no dev dependencies, so its package.json lists none.
node -e "
const fs = require('fs');
const f = '$STAGE/server/package.json';
const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
delete pkg.devDependencies;
fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\\n');
"

# 4. CycloneDX SBOMs of the runtime tree just installed: one for the
#    bundle and one for the npm package (same runtime tree, same
#    lockfile). Written before the lockfile is removed, because npm takes
#    each component's hash and registry URL from it.
node scripts/release-sbom.mjs "$STAGE/server" application "$OUT.cdx.json"
node scripts/release-sbom.mjs "$STAGE/server" library "dist/action1-mcp-server-${VERSION}.tgz.cdx.json"
rm -f "$STAGE/server/package-lock.json" "$STAGE/server/node_modules/.package-lock.json"

# 5. Third-party license notices for every bundled package; fails on a
#    license outside the allowlist.
node scripts/third-party-notices.mjs "$STAGE/server" "$STAGE/THIRD_PARTY_NOTICES.md"

# 6. Validate and pack, then rewrite the archive reproducibly (mcpb pack
#    stamps the current time and keeps the file system order and modes).
"$MCPB" validate "$STAGE/manifest.json"
"$MCPB" pack "$STAGE" "$OUT"
node scripts/reproducible-zip.mjs "$OUT" "$STAGE"

echo
echo "Built $OUT (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)"
ls -lh "$OUT"
node -e "
const { createHash } = require('crypto');
const f = process.argv[1];
console.log('sha256 ' + createHash('sha256').update(require('fs').readFileSync(f)).digest('hex') + '  ' + f);
" "$OUT"
