#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
REMOTE="${MYOXUS_RELEASE_REMOTE:-origin}"
BRANCH="${MYOXUS_RELEASE_BRANCH:-wip}"
FORGEJO_RELEASE="$REPO_ROOT/build/scripts/release/forgejo-client-release.mjs"
SCOPE=clients

usage() {
  cat <<'EOF'
Usage:
  build/scripts/release/release-clients.sh release [version] [clients|linux|windows|macos]
  build/scripts/release/release-clients.sh prepare [current-version]
  build/scripts/release/release-clients.sh publish <version> [clients|linux|windows|macos]
  build/scripts/release/release-clients.sh check <version>
  build/scripts/release/release-clients.sh verify <version> [clients|linux|windows|macos]

Commands:
  release  Synchronize wip, let Forgejo update and check the desktop release
           dependencies, synchronize the resulting commit, set only the desktop
           version, atomically publish clients-v<version>, then build and verify
           Linux, Windows and macOS in Forgejo.
           Without a version, select the next unused desktop patch automatically.
  prepare  Validate the current desktop version without changing files.
  publish  Tag and publish an already prepared clean commit, then build and
           verify the selected client platforms in Forgejo.
  check    Verify the desktop release declaration without building.
  verify   Verify selected public platform releases and their shared overview.

The optional scope defaults to all three client platforms. A single platform
does not rebuild the others and never changes an existing source tag.

Forgejo dispatch uses configured HTTPS Git credentials. Set
MYOXUS_FORGEJO_TOKEN only for headless execution. No client is built locally.
EOF
}

fail() {
  echo "Client release failed: $*" >&2
  exit 1
}

section() {
  echo
  echo "==> $*"
}

validate_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    fail "version must be a complete semantic version, got '$1'"
}

require_repo_context() {
  local top_level
  cd "$REPO_ROOT"
  top_level="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
  test "$top_level" = "$REPO_ROOT" ||
    fail "script must run in the Myoxus repository"
}

require_release_branch() {
  test "$(git branch --show-current)" = "$BRANCH" ||
    fail "expected branch '$BRANCH'"
}

require_clean_tracked_worktree() {
  test -z "$(git status --porcelain --untracked-files=no)" ||
    fail "tracked working tree is not clean; commit or move unrelated work first"
}

sync_release_branch() {
  section "Synchronizing $BRANCH with $REMOTE/$BRANCH"
  git fetch "$REMOTE" "$BRANCH"
  if test "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/$BRANCH")"; then
    git rebase "$REMOTE/$BRANCH"
  fi
}

resolve_release_version() {
  node - "$REMOTE" "$REPO_ROOT/build/scripts/release/archived-release-reservations.json" <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [remote, reservations] = process.argv.slice(2);
const local = execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/tags/clients-v*'], {encoding:'utf8'});
const published = execFileSync('git', ['ls-remote', '--tags', remote, 'refs/tags/clients-v*'], {encoding:'utf8'});
const versions = [JSON.parse(fs.readFileSync('client/apps/electron/package.json')).version,
  ...Object.keys(JSON.parse(fs.readFileSync(reservations)).components.clients),
  ...[...`${local}\n${published}`.matchAll(/refs\/tags\/clients-v([^\s^]+)/g)].map(m => m[1])]
  .map(v => { const m=v.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/); if(!m)throw new Error(`Invalid desktop version: ${v}`); return m.slice(1).map(BigInt); });
versions.sort((a,b) => { for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1; return 0; });
const [major,minor,patch]=versions.at(-1);
process.stdout.write(`${major}.${minor}.${patch+1n}`);
NODE
}

refresh_release_dependencies() {
  local revision
  revision="$(git rev-parse HEAD)"
  section "Updating and checking desktop release dependencies in Forgejo"
  node "$FORGEJO_RELEASE" refresh "$BRANCH" "$revision"
  sync_release_branch
}

set_version() {
  local version="$1"
  section "Setting the independent desktop release version to $version"
  node - "$version" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = "client/apps/electron/package.json";
const manifest = JSON.parse(readFileSync(path, "utf8"));
manifest.version = process.argv[2];
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

verify_expected_changes() {
  local unexpected
  unexpected="$(
    git status --porcelain --untracked-files=no |
      sed -E 's/^.. //' |
      grep -Ev '^client/apps/electron/package.json$' || true
  )"
  test -z "$unexpected" || fail "desktop preparation changed unexpected files:\n$unexpected"
}

verify_contract() {
  local version="$1"
  section "Verifying desktop release declarations"
  node build/scripts/ci/verify-internal-package-release-surface.mjs
  node build/scripts/ci/verify-component-release-version.mjs \
    --component desktop \
    --release-ref "$version"
  git diff --check
}

tag_target() {
  git rev-list -n 1 "$1" 2>/dev/null || true
}

remote_tag_target() {
  local tag="$1" direct peeled
  direct="$(git ls-remote --tags "$REMOTE" "refs/tags/$tag" | awk '{print $1}')"
  peeled="$(git ls-remote --tags "$REMOTE" "refs/tags/$tag^{}" | awk '{print $1}')"
  printf '%s' "${peeled:-$direct}"
}

ensure_source_tag() {
  local version="$1" commit="$2" tag="clients-v$1" target
  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    target="$(tag_target "$tag")"
    test "$target" = "$commit" ||
      fail "local tag $tag points to $target instead of $commit"
  else
    git tag -a "$tag" -m "Myoxus desktop clients $version" "$commit"
  fi
}

publish_source() {
  local version="$1" commit tag remote_target
  tag="clients-v$version"
  commit="$(git rev-parse HEAD)"
  if test -z "$(remote_tag_target "$tag")"; then
    node "$REPO_ROOT/build/scripts/release/assert-distribution-version-free.mjs" clients "$version"
  fi
  ensure_source_tag "$version" "$commit"
  remote_target="$(remote_tag_target "$tag")"
  test -z "$remote_target" || test "$remote_target" = "$commit" ||
    fail "remote tag $tag already points to $remote_target instead of $commit"
  section "Atomically publishing $BRANCH and $tag"
  git push --atomic "$REMOTE" \
    "HEAD:refs/heads/$BRANCH" \
    "refs/tags/$tag"
  node "$FORGEJO_RELEASE" release "$version" "$tag" "$commit" "$SCOPE"
}

resume_existing_source() {
  local version="$1" tag="clients-v$1" remote_target declared
  remote_target="$(remote_tag_target "$tag")"
  test -n "$remote_target" || return 1
  declared="$(
    git show "$remote_target:client/apps/electron/package.json" |
      node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).version))'
  )"
  test "$declared" = "$version" ||
    fail "$tag points to Electron version $declared"
  section "Resuming existing client source $tag at $remote_target"
  node "$FORGEJO_RELEASE" release "$version" "$tag" "$remote_target" "$SCOPE"
  return 0
}

prepare_release() {
  local version="$1"
  require_clean_tracked_worktree
  set_version "$version"
  verify_expected_changes
  verify_contract "$version"
}

release() {
  local version="$1"
  require_release_branch
  require_clean_tracked_worktree
  sync_release_branch
  if test -z "$version"; then version="$(resolve_release_version)"; fi
  if resume_existing_source "$version"; then
    return
  fi
  refresh_release_dependencies
  if resume_existing_source "$version"; then
    return
  fi
  prepare_release "$version"
  git add client/apps/electron/package.json
  if ! git diff --cached --quiet; then
    git commit -m "chore(release): prepare desktop clients $version [skip ci]"
  fi
  require_clean_tracked_worktree
  publish_source "$version"
}

main() {
  local command="${1:-}" version="${2:-}"
  SCOPE="${3:-clients}"
  test -n "$command" && test "$#" -le 3 &&
    { test "$command" = release || test "$command" = prepare || test -n "$version"; } || {
    usage
    exit 2
  }
  case "$SCOPE" in clients|linux|windows|macos) ;; *) usage; exit 2 ;; esac
  if [ "$#" -eq 3 ] && [ "$command" != release ] && [ "$command" != publish ] && [ "$command" != verify ]; then
    usage
    exit 2
  fi
  if test -n "$version"; then validate_version "$version"; fi
  require_repo_context
  if test -n "$version" && test "$command" != verify && test "$command" != check && test "$command" != prepare; then
    node build/scripts/release/check-archived-version.mjs clients "$version"
  fi

  case "$command" in
    release) release "$version" ;;
    prepare)
      current="$(node -p 'require("./client/apps/electron/package.json").version')"
      test -z "$version" || test "$version" = "$current" ||
        fail "preparation keeps version $current; version allocation belongs to publication"
      verify_contract "$current"
      ;;
    publish)
      require_release_branch
      require_clean_tracked_worktree
      verify_contract "$version"
      publish_source "$version"
      ;;
    check) verify_contract "$version" ;;
    verify) node "$FORGEJO_RELEASE" verify "$version" "$SCOPE" ;;
    *) usage; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  main "$@"
fi
