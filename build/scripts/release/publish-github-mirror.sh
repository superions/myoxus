#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
DEFAULT_URL="https://github.com/superions/myoxus.git"
DEFAULT_API="https://api.github.com/repos/superions/myoxus"

usage() {
  cat <<'EOF'
Usage:
  publish-github-mirror.sh prepare --revision <forgejo-sha> --expected-parent <github-sha> --workdir <new-dir>
  publish-github-mirror.sh publish --workdir <prepared-dir> --expected-source <sha> --expected-parent <sha> \
    --expected-commit <sha> --expected-tree <sha> --expected-archive-sha256 <digest> \
    --expected-manifest-sha256 <digest> --expected-settings-sha256 <digest>

One-time cleanup: prepare-baseline / publish-baseline accept the same options.
Options: --github-url <url> --github-api <url> --branch main
Baseline only: --replace-tag <tag> --expected-tag <previous-object-sha>

Preparation is anonymous and read-only. Publication requires the exact reviewed
identities and, for GitHub, GITHUB_MIRROR_TOKEN. The isolated checkout contains
only a deliberately named github-mirror remote. Ordinary publication is
fast-forward only; baseline replacement requires the exact previous main.
EOF
}

fail() { echo "[FAIL] $*" >&2; exit 1; }
full_sha() { [[ "$2" =~ ^[0-9a-f]{40}$ ]] || fail "$1 must be a full Git SHA"; }
sha256() { [[ "$2" =~ ^[0-9a-f]{64}$ ]] || fail "$1 must be a SHA-256 digest"; }
digest() { sha256sum "$1" | awk '{print $1}'; }

remote_main() {
  local line
  line="$(git ls-remote --exit-code "$1" "refs/heads/$2")" || fail "cannot resolve public $2"
  [[ "$(printf '%s\n' "$line" | wc -l)" -eq 1 ]] || fail "public $2 is ambiguous"
  printf '%s\n' "${line%%[[:space:]]*}"
}

desired_settings() {
  cat >"$1" <<'EOF'
{
  "repository": {"default_branch":"main","has_issues":true,"has_projects":false,"has_wiki":false,"has_discussions":false,"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true,"delete_branch_on_merge":true},
  "branch_protection": {"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null,"required_linear_history":true,"allow_force_pushes":false,"allow_deletions":false,"block_creations":false,"required_conversation_resolution":true,"lock_branch":false,"allow_fork_syncing":true},
  "actions_permissions": {"enabled":false},
  "workflow_permissions": {"default_workflow_permissions":"read","can_approve_pull_request_reviews":false},
  "public_services": {"pull_requests":"enabled","security_reporting":"SECURITY.md","pages":"disabled","packages":"no publication or package-write permission","github_hosted_release_builds":"disabled with GitHub Actions"},
  "publication_credential": {"kind":"repository-scoped fine-grained token","repository":"superions/myoxus only","permissions":{"metadata":"read","contents":"write","administration":"write","actions":"write"}}
}
EOF
}

current_settings() {
  if [[ "$1" == file://* ]]; then
    printf '{"fixture":true,"note":"local Git fixture has no GitHub settings"}\n' >"$3"
    return
  fi
  curl --fail --silent --show-error "$1" >"$3.repo" || fail "cannot read public repository settings"
  curl --fail --silent --show-error "$1/branches/$2" >"$3.branch" || fail "cannot read public branch settings"
  node --input-type=module - "$3.repo" "$3.branch" "$3" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const r=JSON.parse(readFileSync(process.argv[2],"utf8"));
const b=JSON.parse(readFileSync(process.argv[3],"utf8"));
const out={repository:{default_branch:r.default_branch,has_issues:r.has_issues,has_projects:r.has_projects,has_wiki:r.has_wiki,has_discussions:r.has_discussions,allow_merge_commit:r.allow_merge_commit,allow_squash_merge:r.allow_squash_merge,allow_rebase_merge:r.allow_rebase_merge,delete_branch_on_merge:r.delete_branch_on_merge},branch:{name:b.name,protected:b.protected},authenticated_settings:"unavailable during credential-free preparation"};
writeFileSync(process.argv[4],JSON.stringify(out,null,2)+"\n");
NODE
  rm -f "$3.repo" "$3.branch"
}

api_write() {
  printf 'header = "Authorization: Bearer %s"\n' "$4" | \
    curl --fail --silent --show-error -X "$1" --config - \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      -H 'Content-Type: application/json' --data "$3" "$2" >/dev/null
}

apply_settings() {
  local body
  for spec in 'PATCH repository ' 'PUT branch_protection /branches/main/protection' 'PUT actions_permissions /actions/permissions' 'PUT workflow_permissions /actions/permissions/workflow'; do
    read -r method key suffix <<<"$spec"
    body="$(node -e 'const x=require(process.argv[1]);process.stdout.write(JSON.stringify(x[process.argv[2]]))' "$2" "$key")"
    api_write "$method" "$1$suffix" "$body" "$3"
  done
}

MODE="${1:-}"; BASELINE=false
case "$MODE" in prepare-baseline|publish-baseline) BASELINE=true; MODE="${MODE%-baseline}";; esac
[[ "$MODE" == prepare || "$MODE" == publish ]] || { usage >&2; exit 2; }; shift
REVISION=""; SOURCE=""; PARENT=""; COMMIT=""; TREE=""; ARCHIVE_SHA=""; MANIFEST_SHA=""; SETTINGS_SHA=""
BRANCH=main; WORKDIR=""; URL="$DEFAULT_URL"; API="$DEFAULT_API"
REPLACE_TAG=""; EXPECTED_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revision) REVISION="${2:-}";; --expected-source) SOURCE="${2:-}";;
    --expected-parent) PARENT="${2:-}";; --expected-commit) COMMIT="${2:-}";;
    --expected-tree) TREE="${2:-}";; --expected-archive-sha256) ARCHIVE_SHA="${2:-}";;
    --expected-manifest-sha256) MANIFEST_SHA="${2:-}";; --expected-settings-sha256) SETTINGS_SHA="${2:-}";;
    --branch) BRANCH="${2:-}";; --workdir) WORKDIR="${2:-}";; --github-url) URL="${2:-}";; --github-api) API="${2:-}";;
    --replace-tag) REPLACE_TAG="${2:-}";; --expected-tag) EXPECTED_TAG="${2:-}";;
    -h|--help) usage; exit 0;; *) fail "unknown argument: $1";;
  esac
  shift 2
done
[[ "$BRANCH" == main ]] || fail "the public branch is fixed to main"
[[ -n "$WORKDIR" ]] || fail "--workdir is required"
if [[ -n "$REPLACE_TAG$EXPECTED_TAG" ]]; then
  [[ "$BASELINE" == true ]] || fail "tag replacement is baseline-only"
  git check-ref-format "refs/tags/$REPLACE_TAG" >/dev/null || fail "invalid replacement tag"
  full_sha --expected-tag "$EXPECTED_TAG"
  [[ "$(git ls-remote "$URL" "refs/tags/$REPLACE_TAG" | cut -f1)" == "$EXPECTED_TAG" ]] || fail "replacement tag moved"
fi

if [[ "$MODE" == prepare ]]; then
  [[ -n "$REVISION" ]] || fail "prepare requires --revision"
  full_sha --expected-parent "$PARENT"
  SOURCE="$(git -C "$REPO_ROOT" rev-parse --verify "${REVISION}^{commit}" 2>/dev/null)" || fail "unknown source revision"
  full_sha source "$SOURCE"
  [[ "$(remote_main "$URL" "$BRANCH")" == "$PARENT" ]] || fail "public main moved or differs from reviewed parent"
  if [[ -e "$WORKDIR" ]]; then
    [[ -d "$WORKDIR" && -z "$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail "workdir must be new or empty"
  else mkdir -p "$WORKDIR"; fi
  WORKDIR="$(cd "$WORKDIR" && pwd -P)"
  case "$WORKDIR/" in "$REPO_ROOT/"*) fail "scratch workdir must be outside the canonical checkout";; esac
  ARCHIVE="$WORKDIR/source-export.tar"; EXTRACT="$WORKDIR/extracted"; SNAPSHOT="$WORKDIR/snapshot"
  CURRENT="$WORKDIR/github-settings-current.json"; DESIRED="$WORKDIR/github-settings-desired.json"
  "$REPO_ROOT/build/scripts/release/export-public-source.sh" --revision "$SOURCE" --output "$ARCHIVE"
  node "$REPO_ROOT/build/scripts/ci/verify-public-source-export.mjs" --archive "$ARCHIVE"
  mkdir "$EXTRACT"; tar -xf "$ARCHIVE" -C "$EXTRACT"
  node "$REPO_ROOT/build/scripts/ci/scan-public-source-secrets.mjs" --dir "$EXTRACT"
  git clone -q --no-checkout --origin github-mirror "$URL" "$SNAPSHOT"
  [[ "$(git -C "$SNAPSHOT" remote)" == github-mirror ]] || fail "unexpected scratch remote"
  git -C "$SNAPSHOT" checkout -q "$BRANCH"
  [[ "$(git -C "$SNAPSHOT" rev-parse HEAD)" == "$PARENT" ]] || fail "fetched parent changed"
  git -C "$SNAPSHOT" rm -rq --ignore-unmatch .
  cp -R "$EXTRACT"/. "$SNAPSHOT"/
  # The verified export is the complete public tree. Force-staging is required
  # because private-checkout ignore rules intentionally match public root
  # policies such as README.md and SECURITY.md.
  git -C "$SNAPSHOT" add --force --all
  SOURCE_TIME="$(git -C "$REPO_ROOT" show -s --format=%aI "$SOURCE")"
  if [[ "$BASELINE" == true ]]; then
    # A clean root reuses qualified blobs but carries no old public/private parents.
    NEW_ROOT="$(printf 'Public Myoxus source baseline\n' | GIT_AUTHOR_DATE="$SOURCE_TIME" GIT_COMMITTER_DATE="$SOURCE_TIME" git -C "$SNAPSHOT" \
      -c user.name='Myoxus Release' -c user.email=release@myoxus.invalid commit-tree "$(git -C "$SNAPSHOT" write-tree)")"
    git -C "$SNAPSHOT" update-ref "refs/heads/$BRANCH" "$NEW_ROOT" "$PARENT"
  else
    GIT_AUTHOR_DATE="$SOURCE_TIME" GIT_COMMITTER_DATE="$SOURCE_TIME" git -C "$SNAPSHOT" \
      -c user.name='Myoxus Release' -c user.email=release@myoxus.invalid commit -q -m "Public Myoxus source snapshot"
  fi
  COMMIT="$(git -C "$SNAPSHOT" rev-parse HEAD)"; TREE="$(git -C "$SNAPSHOT" rev-parse 'HEAD^{tree}')"
  if [[ "$BASELINE" == true ]]; then
    [[ "$(git -C "$SNAPSHOT" rev-list --count "$COMMIT")" == 1 ]] || fail "baseline must be parentless"
  else
  [[ "$(git -C "$SNAPSHOT" rev-parse HEAD^)" == "$PARENT" ]] || fail "candidate parent changed"
  [[ "$(git -C "$SNAPSHOT" rev-list --count "$PARENT..$COMMIT")" == 1 ]] || fail "candidate is not exactly one child commit"
  [[ "$(git -C "$SNAPSHOT" merge-base "$PARENT" "$COMMIT")" == "$PARENT" ]] || fail "candidate diverged"
  fi
  current_settings "$API" "$BRANCH" "$CURRENT"; desired_settings "$DESIRED"
  diff -u "$CURRENT" "$DESIRED" >"$WORKDIR/github-settings.diff" || [[ $? -eq 1 ]]
  git -C "$SNAPSHOT" diff --binary "$PARENT..$COMMIT" >"$WORKDIR/candidate-full.diff"
  git -C "$SNAPSHOT" ls-tree -r --full-tree "$COMMIT" >"$WORKDIR/candidate-tree.txt"
  ARCHIVE_SHA="$(digest "$ARCHIVE")"; MANIFEST_SHA="$(digest "$ARCHIVE.manifest")"; SETTINGS_SHA="$(digest "$DESIRED")"
  cat >"$WORKDIR/candidate-identities.txt" <<EOF
source_revision=$SOURCE
baseline_replacement=$BASELINE
replace_tag=$REPLACE_TAG
expected_tag=$EXPECTED_TAG
public_parent=$PARENT
candidate_commit=$COMMIT
candidate_tree=$TREE
archive_sha256=$ARCHIVE_SHA
manifest_sha256=$MANIFEST_SHA
settings_sha256=$SETTINGS_SHA
full_diff_sha256=$(digest "$WORKDIR/candidate-full.diff")
tree_list_sha256=$(digest "$WORKDIR/candidate-tree.txt")
EOF
  sha256sum "$WORKDIR/candidate-identities.txt" >"$WORKDIR/candidate-identities.txt.sha256"
  [[ "$(remote_main "$URL" "$BRANCH")" == "$PARENT" ]] || fail "public main moved during preparation"
  [[ -z "$(git -C "$SNAPSHOT" status --porcelain)" ]] || fail "candidate checkout is dirty"
  echo "[PASS] qualified GitHub source candidate prepared (baseline=$BASELINE)"; cat "$WORKDIR/candidate-identities.txt"
  echo "candidate_evidence=$WORKDIR"; echo 'No credential was used and no public state was changed.'
  exit 0
fi

full_sha --expected-source "$SOURCE"; full_sha --expected-parent "$PARENT"; full_sha --expected-commit "$COMMIT"; full_sha --expected-tree "$TREE"
sha256 archive "$ARCHIVE_SHA"; sha256 manifest "$MANIFEST_SHA"; sha256 settings "$SETTINGS_SHA"
WORKDIR="$(cd "$WORKDIR" && pwd -P)" || fail "prepared workdir is missing"
SNAPSHOT="$WORKDIR/snapshot"; ARCHIVE="$WORKDIR/source-export.tar"; DESIRED="$WORKDIR/github-settings-desired.json"
[[ -d "$SNAPSHOT/.git" && "$(git -C "$SNAPSHOT" remote)" == github-mirror ]] || fail "invalid scratch checkout"
[[ "$(git -C "$SNAPSHOT" remote get-url github-mirror)" == "$URL" ]] || fail "reviewed remote changed"
[[ -z "$(git -C "$SNAPSHOT" status --porcelain)" ]] || fail "candidate checkout is dirty"
[[ "$(git -C "$SNAPSHOT" rev-parse HEAD)" == "$COMMIT" && "$(git -C "$SNAPSHOT" rev-parse 'HEAD^{tree}')" == "$TREE" ]] || fail "candidate identity changed"
if [[ "$BASELINE" == true ]]; then
  [[ "$(git -C "$SNAPSHOT" rev-list --count "$COMMIT")" == 1 ]] || fail "baseline must be parentless"
else
  [[ "$(git -C "$SNAPSHOT" rev-parse HEAD^)" == "$PARENT" ]] || fail "candidate parent changed"
fi
grep -Fxq "baseline_replacement=$BASELINE" "$WORKDIR/candidate-identities.txt" || fail "publication mode differs from preparation"
grep -Fxq "replace_tag=$REPLACE_TAG" "$WORKDIR/candidate-identities.txt" || fail "replacement tag differs from preparation"
grep -Fxq "expected_tag=$EXPECTED_TAG" "$WORKDIR/candidate-identities.txt" || fail "previous tag differs from preparation"
grep -Fxq "source_revision=$SOURCE" "$WORKDIR/candidate-identities.txt" || fail "source identity changed"
[[ "$(digest "$ARCHIVE")" == "$ARCHIVE_SHA" && "$(digest "$ARCHIVE.manifest")" == "$MANIFEST_SHA" && "$(digest "$DESIRED")" == "$SETTINGS_SHA" ]] || fail "reviewed digest changed"
# Preparation qualified these exact archive/manifest bytes; their reviewed
# digests above bind that result. Publication does not repeat the source audit.
[[ "$(remote_main "$URL" "$BRANCH")" == "$PARENT" ]] || fail "public main moved or diverged"
push_candidate() {
  local args=() refs=("$COMMIT:refs/heads/$BRANCH")
  if [[ "$BASELINE" == true ]]; then
    args+=(--force-with-lease="refs/heads/$BRANCH:$PARENT")
    if [[ -n "$REPLACE_TAG" ]]; then
      args+=(--force-with-lease="refs/tags/$REPLACE_TAG:$EXPECTED_TAG")
      refs+=("$COMMIT:refs/tags/$REPLACE_TAG")
    fi
  fi
  git -C "$SNAPSHOT" push --atomic "${args[@]}" github-mirror "${refs[@]}"
}
if [[ "$API" == file://* ]]; then
  push_candidate
else
  [[ -n "${GITHUB_MIRROR_TOKEN:-}" ]] || fail "GITHUB_MIRROR_TOKEN is required"
  apply_settings "$API" "$DESIRED" "$GITHUB_MIRROR_TOKEN"
  [[ "$(remote_main "$URL" "$BRANCH")" == "$PARENT" ]] || fail "public main moved after settings; source not pushed"
  ASKPASS="$WORKDIR/github-askpass.sh"
  printf '#!/usr/bin/env bash\ncase "$1" in *Username*) echo x-access-token;; *Password*) echo "$GITHUB_MIRROR_TOKEN";; *) exit 1;; esac\n' >"$ASKPASS"; chmod 700 "$ASKPASS"
  if [[ "$BASELINE" == true ]]; then
    PROTECTION="$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1]).branch_protection))' "$DESIRED")"
    restore_protection() { api_write PUT "$API/branches/main/protection" "$PROTECTION" "$GITHUB_MIRROR_TOKEN"; }
    trap restore_protection EXIT
    TEMP_PROTECTION="$(node -e 'process.stdout.write(JSON.stringify({...require(process.argv[1]).branch_protection,allow_force_pushes:true}))' "$DESIRED")"
    api_write PUT "$API/branches/main/protection" "$TEMP_PROTECTION" "$GITHUB_MIRROR_TOKEN"
    GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 push_candidate
    restore_protection
    trap - EXIT
  else
    GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 push_candidate
  fi
  rm -f "$ASKPASS"
fi
[[ "$(remote_main "$URL" "$BRANCH")" == "$COMMIT" ]] || fail "public read-back differs"
echo "[PASS] approved source published (baseline=$BASELINE): $COMMIT"
