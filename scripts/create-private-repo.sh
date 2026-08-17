#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-Shahbazi-Amir/GitHub-Control-Center}"
command -v gh >/dev/null || { echo "gh is required"; exit 1; }
gh auth status >/dev/null
if gh repo view "$TARGET" >/dev/null 2>&1; then
  echo "$TARGET already exists; refusing to overwrite it."
  exit 2
fi
if [[ ! -d .git ]]; then git init -b main; fi
git add .
git commit -m "Initial private GitHub Control Center"
gh repo create "$TARGET" --private --source=. --remote=origin --push
echo "Created private repository: https://github.com/$TARGET"
