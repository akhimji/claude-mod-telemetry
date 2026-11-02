#!/usr/bin/env bash
# Build dist/session-telemetry-<version>.tar.gz from this mod folder.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="session-telemetry"
MANIFEST="$ROOT/.claude-plugin/plugin.json"

VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "pack: could not read version from $MANIFEST" >&2
  exit 1
fi

# What ships. Everything else (tests/, dist/, node_modules, .claude-plugin/types/,
# scratch or backup dirs) is left out because it is never copied into staging.
INCLUDE=(
  hooks
  types
  .claude-plugin/plugin.json
  .claude-plugin/marketplace.json
  README.md
  NOTES.md
  tsconfig.json
  scripts/install.sh
  scripts/pack.sh
)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/$NAME"
mkdir -p "$DEST"

for item in "${INCLUDE[@]}"; do
  if [[ -e "$ROOT/$item" ]]; then
    mkdir -p "$DEST/$(dirname "$item")"
    cp -R "$ROOT/$item" "$DEST/$item"
  elif [[ "$item" == "tsconfig.json" ]]; then
    : # optional
  else
    echo "pack: missing $item" >&2
    exit 1
  fi
done

# Strip OS/editor junk and nested build/scratch dirs.
find "$DEST" \( -name .DS_Store -o -name '*~' -o -name '*.bak' -o -name '*.orig' \
  -o -name '*.swp' -o -name '*.log' \) -type f -exec rm -f {} +
find "$DEST" -depth -type d \( -name node_modules -o -name dist -o -name tests \
  -o -name scratch -o -name 'backup*' -o -name '*.bak' -o -name .mcpb-cache \) -exec rm -rf {} +
rm -rf "$DEST/.claude-plugin/types"

mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$NAME-$VERSION.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT" "$NAME"

if command -v shasum >/dev/null 2>&1; then
  SUM="$(shasum -a 256 "$OUT" | awk '{print $1}')"
else
  SUM="$(sha256sum "$OUT" | awk '{print $1}')"
fi

echo "$OUT"
echo "sha256: $SUM"
