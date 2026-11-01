#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Narrow commit/push helper for frontend migration milestones. It stages only
# explicitly named paths, checks the staged diff and pushes the current wip
# branch. This keeps regular checkpoint commits fast while preventing accidental
# staging of unrelated or parallel-agent changes.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

MESSAGE=""
PUSH=1
DRY_RUN=0
FILES=()

usage() {
  cat <<'EOF'
Usage:
  build/scripts/server/frontend-migration-commit-push.sh -m <message> -- <path>...

Options:
  -m, --message <text>  Commit message. Required.
  --file <path>         Add one path to stage. Repeatable.
  --no-push             Commit but do not push.
  --dry-run             Show what would be staged without committing.
  --help, -h            Show this help.

Examples:
  yarn frontend:migration:commit-push -m "frontend: add migration helpers" -- \
    build/scripts/server/frontend-migration-scope-audit.sh \
    build/scripts/server/frontend-migration-commit-push.sh \
    package.json

The helper intentionally rejects implicit "stage everything" behavior. Keep the
path list explicit so local or parallel changes stay untouched.
EOF
}

fail() {
  echo "[FAIL] $*" >&2
  exit 2
}

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$option requires a value"
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --message|-m)
      require_value "$1" "${2:-}"
      MESSAGE="$2"
      shift
      ;;
    --message=*)
      MESSAGE="${1#*=}"
      ;;
    --file)
      require_value "$1" "${2:-}"
      FILES+=("$2")
      shift
      ;;
    --file=*)
      FILES+=("${1#*=}")
      ;;
    --no-push)
      PUSH=0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --)
      shift
      FILES+=("$@")
      break
      ;;
    --*)
      fail "unknown argument: $1"
      ;;
    *)
      FILES+=("$1")
      ;;
  esac
  shift
done

[[ -n "$MESSAGE" ]] || fail "commit message is required"
[[ "${#FILES[@]}" -gt 0 ]] || fail "at least one explicit path is required"

BRANCH="$(git branch --show-current)"
[[ "$BRANCH" == "wip" ]] || fail "expected branch wip, got ${BRANCH:-detached}"

echo "==> git status before staging"
git status --short --branch

for file in "${FILES[@]}"; do
  if [[ ! -e "$file" ]] && ! git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
    fail "path does not exist and is not tracked: $file"
  fi
done

echo
echo "==> paths to stage"
printf '%s\n' "${FILES[@]}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "Dry run complete; no files staged, committed or pushed."
  exit 0
fi

git add -- "${FILES[@]}"

echo
echo "==> staged diff"
if git diff --cached --quiet; then
  fail "no staged changes after adding explicit paths"
fi
git diff --cached --name-status

echo
echo "==> staged whitespace check"
git diff --cached --check

echo
echo "==> commit"
git commit -m "$MESSAGE"

if [[ "$PUSH" -eq 1 ]]; then
  echo
  echo "==> push"
  git push origin "$BRANCH"
else
  echo
  echo "[INFO] --no-push selected; commit was not pushed."
fi

echo
echo "Frontend migration commit helper complete."
