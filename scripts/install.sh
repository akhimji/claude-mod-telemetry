#!/usr/bin/env bash
# Install (or upgrade) session-telemetry on this machine from the unpacked folder.
# Usage: ./scripts/install.sh [--dest DIR] [--dry-run]
set -euo pipefail

NAME="session-telemetry"
MARKETPLACE="session-telemetry-local"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${HOME}/.claude/local-plugins/${NAME}"
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest) [[ $# -ge 2 ]] || { echo "install: --dest needs a path" >&2; exit 2; }; DEST="$2"; shift 2 ;;
    --dest=*) DEST="${1#--dest=}"; shift ;;
    --dry-run|-n) DRY=1; shift ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "install: unknown argument $1" >&2; exit 2 ;;
  esac
done
DEST="${DEST/#\~/$HOME}"

run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [[ $DRY -eq 0 ]]; then "$@"; fi
}

if ! command -v claude >/dev/null 2>&1; then
  echo "install: 'claude' is not on PATH. Install Claude Code first." >&2
  exit 1
fi
echo "Claude Code: $(claude --version)"
[[ $DRY -eq 1 ]] && echo "(dry run: nothing will be changed)"

if [[ ! -f "$SRC/.claude-plugin/plugin.json" || ! -f "$SRC/.claude-plugin/marketplace.json" ]]; then
  echo "install: $SRC is not the unpacked $NAME folder" >&2
  exit 1
fi

# 1. Copy the folder to a stable location (re-run replaces it).
if [[ "$SRC" != "$(cd "$(dirname "$DEST")" 2>/dev/null && pwd)/$(basename "$DEST")" ]]; then
  run mkdir -p "$(dirname "$DEST")"
  run rm -rf "$DEST"
  run cp -R "$SRC" "$DEST"
else
  echo "Already running from $DEST; no copy needed."
fi

# 2. Add the folder marketplace (once) and install, or update on a re-run.
already_mp=0
if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then already_mp=1; fi
already_pl=0
if claude plugin list 2>/dev/null | grep -q "${NAME}@${MARKETPLACE}"; then already_pl=1; fi

if [[ $already_mp -eq 0 ]]; then
  run claude plugin marketplace add "$DEST" --scope user
else
  run claude plugin marketplace update "$MARKETPLACE"
fi

if [[ $already_pl -eq 0 ]]; then
  run claude plugin install "${NAME}@${MARKETPLACE}" --scope user
else
  run claude plugin update "${NAME}@${MARKETPLACE}" --scope user
fi

cat <<MSG

Done. ${NAME} is read from: ${DEST}
Restart running Claude Code sessions, or run /reload-plugins in them.
Open the pane with /telemetry.
MSG
