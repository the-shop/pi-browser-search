#!/bin/sh
# Re-apply the local pi-subagents patch. Idempotent: reports and exits if the
# patch is already present or no longer applies cleanly.
set -e
TARGET="${PI_SUBAGENTS_DIR:-$HOME/.pi/agent/npm/node_modules/pi-subagents}"
FILE="$TARGET/src/runs/shared/child-tool-plan.ts"
PATCH="$(dirname "$0")/pi-subagents-extension-tools.patch"

[ -f "$FILE" ] || { echo "not found: $FILE"; exit 1; }
if grep -q 'LOCAL PATCH (pi-browser-search)' "$FILE"; then
  echo "already patched"
  exit 0
fi
# Back up beside the package, not inside src/: a stray .ts next to the
# original is a duplicate module a build or typecheck glob could pick up.
cp "$FILE" "$TARGET/child-tool-plan.ts.orig-$(date +%Y%m%d-%H%M%S)"
if patch -p0 --dry-run "$FILE" < "$PATCH" >/dev/null 2>&1; then
  patch -p0 "$FILE" < "$PATCH"
  echo "patched $FILE"
else
  echo "patch does not apply cleanly — pi-subagents upstream likely changed this file."
  echo "Review $PATCH against $FILE and rebase before applying."
  exit 1
fi
