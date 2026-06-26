#!/usr/bin/env bash
# One-time installer — points git at the version-controlled hooks dir.
# Idempotent; safe to re-run.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-push

echo "[git-hooks] core.hooksPath -> scripts/git-hooks"
echo "[git-hooks] pre-push hook installed + executable"
echo ""
echo "Test it locally:"
echo "  bash scripts/git-hooks/pre-push  # should print status, not block"
