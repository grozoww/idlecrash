#!/bin/bash
# Publishes the GitHub Release for the version in mod/.claude-plugin/plugin.json, unless it already has one.
# The notes are that version's entry in CHANGELOG.md, and how to update. Run by the deploy workflow once the
# server of this commit is live. By hand: DRY_RUN=1 tools/release.sh prints the notes and makes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(jq -r .version mod/.claude-plugin/plugin.json)
tag="idlecrash--v$version"

if gh release view "$tag" >/dev/null 2>&1; then
  echo "$tag is already released"
  exit 0
fi

notes=$(awk -v head="## $version" '$0 == head { on = 1; next } /^## / { on = 0 } on' CHANGELOG.md)
if [ -z "$(tr -d '[:space:]' <<<"$notes")" ]; then
  echo "CHANGELOG.md has no entry under '## $version'" >&2
  exit 1
fi

file=$(mktemp)
trap 'rm -f "$file"' EXIT
cat >"$file" <<NOTES
$notes

**Update**

\`\`\`bash
claude plugin marketplace update grozoww-mods
claude plugin update idlecrash@grozoww-mods
\`\`\`

Restart Claude Code afterwards.
NOTES

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "would release $tag at $(git rev-parse HEAD):"
  cat "$file"
  exit 0
fi

gh release create "$tag" --target "${GITHUB_SHA:-$(git rev-parse HEAD)}" --title "IdleCrash $version" --notes-file "$file" --latest
echo "released $tag"
