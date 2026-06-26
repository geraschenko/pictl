#!/usr/bin/env bash
set -euo pipefail

# Pre-publish verification for the `pictl` npm package. Does everything that must
# pass before publishing an update: a clean lockfile-faithful install, the full
# gate (typecheck, lint, format, tests), and a dry-run pack so the tarball can be
# inspected. It then prints the publish and post-publish commands.
#
# It deliberately stops short of running `npm publish`: published npm versions
# are immutable, so the irreversible step stays a manual decision the human makes
# after eyeballing the dry-run file list.

# Run from the repository root regardless of the caller's cwd.
cd "$(dirname "$0")/.."

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"

echo "==> Verifying ${PKG_NAME}@${PKG_VERSION} before publish"

# Guard against forgetting to bump the version: refuse if this exact version is
# already on the registry (a 404 — not yet published — is fine and proceeds).
published="$(npm view "${PKG_NAME}@${PKG_VERSION}" version 2>/dev/null || true)"
if [[ -n "${published}" ]]; then
  echo "ERROR: ${PKG_NAME}@${PKG_VERSION} is already published." >&2
  echo "       Bump \"version\" in package.json before publishing." >&2
  exit 1
fi

# Clean, lockfile-faithful install so a stale node_modules cannot mask a problem
# and the build is reproducible from package-lock.json.
npm ci

# Full gate: typecheck, lint, format check, tests. The build itself is exercised
# by the pack step below via the `prepare` hook.
npm run presubmit

# Show the exact tarball contents without publishing. `npm pack` runs `prepare`,
# so this packs a fresh clean build. Inspect for the expected files (compiled JS
# in dist/core, types in dist/dts) and no stray local files or secrets.
npm pack --dry-run

cat <<MSG

If the dry-run file list looks correct, publish with:

  npm publish

Then tag the release and verify it:

  git tag "v${PKG_VERSION}" && git push --tags
  npm view ${PKG_NAME} version
MSG
