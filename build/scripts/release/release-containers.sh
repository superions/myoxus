#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
REMOTE="${MYOXUS_RELEASE_REMOTE:-origin}"
BRANCH="${MYOXUS_RELEASE_BRANCH:-wip}"
REGISTRY="${MYOXUS_REGISTRY:-git.blume29.de}"
REGISTRY_NAMESPACE="myoxus"
POLL_INTERVAL="${MYOXUS_RELEASE_POLL_SECONDS:-20}"
WAIT_TIMEOUT="${MYOXUS_RELEASE_TIMEOUT_SECONDS:-7200}"

usage() {
  cat <<'EOF'
Usage:
  build/scripts/release/release-containers.sh [version]
  build/scripts/release/release-containers.sh release [version]
  build/scripts/release/release-containers.sh prepare [version]
  build/scripts/release/release-containers.sh publish <version>
  build/scripts/release/release-containers.sh check <version>
  build/scripts/release/release-containers.sh verify <version>
  build/scripts/release/release-containers.sh status <version>
  build/scripts/release/release-containers.sh retry-server <version>
  build/scripts/release/release-containers.sh retry-frontends <version>
  build/scripts/release/release-containers.sh publish-server <version>
  build/scripts/release/release-containers.sh publish-frontends <version>

Commands:
  release  Rebase wip, set versions, validate declarations, commit, atomically
           push the branch and both component tags, then verify registry tags.
           Without a version, select the next unused container patch version.
  prepare  Validate the current version without changing files or allocating a
           version. A different version is selected only by release/publication.
  publish  Publish an already prepared clean commit and verify the registry.
  check    Verify the declared release contract without building or testing.
  verify   Wait for version/commit registry tags and their public overview.
  status   Show matching Forgejo runs and individual job states without waiting.
  retry-server
           Resume failed server release jobs through Forgejo's native API.
  retry-frontends
           Resume failed frontend release jobs, preserving successful siblings.
  publish-server / publish-frontends
           Publish completed images and run acceptance, never build. Uses the
           current workflow from wip and source from the unchanged release tag.

Optional environment:
  MYOXUS_RELEASE_REMOTE          Git remote (default: origin)
  MYOXUS_RELEASE_BRANCH          release branch (default: wip)
  MYOXUS_REGISTRY                registry host (default: git.blume29.de)
  MYOXUS_RELEASE_POLL_SECONDS    registry poll interval (default: 20)
  MYOXUS_RELEASE_TIMEOUT_SECONDS registry wait timeout (default: 7200)
EOF
}

fail() {
  echo "Release failed: $*" >&2
  exit 1
}

section() {
  echo
  echo "==> $*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

validate_version() {
  local version="$1"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
    fail "version must be a complete semantic version, got '$version'"
}

validate_registry_host() {
  [[ "$REGISTRY" =~ ^([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]] ||
    fail "MYOXUS_REGISTRY must contain only a registry host and optional port"
}

require_repo_context() {
  local top_level
  cd "$REPO_ROOT"
  top_level="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
  test "$top_level" = "$REPO_ROOT" ||
    fail "script must run in the Myoxus repository"
}

require_release_branch() {
  local current_branch
  current_branch="$(git branch --show-current)"
  test "$current_branch" = "$BRANCH" ||
    fail "expected branch '$BRANCH', current branch is '$current_branch'"
}

require_clean_worktree() {
  test -z "$(git status --porcelain --untracked-files=no)" ||
    fail "tracked working tree is not clean; commit or move unrelated work first"
}

current_release_version() {
  node - <<'NODE'
const fs = require('node:fs');
const root = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const section = fs.readFileSync('server/Cargo.toml', 'utf8').split('[workspace.package]')[1]?.split(/\n\s*\[/)[0];
const server = section?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
if (root !== server) throw new Error('Container version declarations disagree');
process.stdout.write(root);
NODE
}

sync_release_branch() {
  section "Synchronizing $BRANCH with $REMOTE/$BRANCH"
  git fetch "$REMOTE" "$BRANCH"
  if test "$(git rev-parse HEAD)" != "$(git rev-parse "$REMOTE/$BRANCH")"; then
    git rebase "$REMOTE/$BRANCH"
  fi
}

resolve_release_version() {
  node - "$REMOTE" "${1:-}" "$REPO_ROOT/build/scripts/release/archived-release-reservations.json" <<'NODE'
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [remote, requested, reservationFile] = process.argv.slice(2);
const patterns = ["refs/tags/server-v*", "refs/tags/frontends-v*"];
const local = execFileSync("git", ["for-each-ref", "--format=%(refname)", ...patterns], { encoding: "utf8" });
const published = execFileSync("git", ["ls-remote", "--tags", remote, ...patterns], { encoding: "utf8" });
const reserved = new Set([...`${local}\n${published}`.matchAll(/refs\/tags\/(?:server|frontends)-v([^\s^]+)/g)].map(match => match[1]));
const archive = JSON.parse(readFileSync(reservationFile, "utf8")).components;
const archived = new Set([...Object.keys(archive.server), ...Object.keys(archive.frontends)]);
for (const version of archived) reserved.add(version);
if (requested && archived.has(requested)) throw new Error("Archived release versions cannot be rebuilt from the new source; use verify or a new version.");
const rootVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const serverSection = readFileSync("server/Cargo.toml", "utf8").split("[workspace.package]")[1]?.split(/\n\s*\[/)[0];
const serverVersion = serverSection?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
if (requested) {
  if (reserved.has(requested)) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const remoteRefs = new Map(published.trim().split("\n").filter(Boolean).map(line => line.split(/\s+/).reverse()));
    const targets = [];
    for (const component of ["server", "frontends"]) {
      const ref = `refs/tags/${component}-v${requested}`;
      if (local.split("\n").includes(ref)) targets.push(execFileSync("git", ["rev-parse", `${ref}^{}`], { encoding: "utf8" }).trim());
      if (remoteRefs.has(ref)) targets.push(remoteRefs.get(`${ref}^{}`) ?? remoteRefs.get(ref));
    }
    if (rootVersion !== requested || serverVersion !== requested || targets.some(target => target !== head)) {
      throw new Error(`Container version ${requested} is already reserved for another source; use a new version or verify the existing release.`);
    }
  }
  process.stdout.write(requested);
} else {
  const parse = version => {
    const match = String(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
    if (!match) throw new Error(`Invalid container version: ${version}`);
    return match.slice(1).map(BigInt);
  };
  const versions = [parse(rootVersion), parse(serverVersion), ...[...reserved].map(parse)];
  const compare = (a, b) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  const [major, minor, patch] = versions.sort(compare).at(-1);
  process.stdout.write(`${major}.${minor}.${patch + 1n}`);
}
NODE
}

set_versions() {
  local version="$1"
  section "Setting authoritative release versions to $version"
  require_command cargo
  node - "$version" <<'NODE'
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve, sep } = require("node:path");

const version = process.argv[2];

function updatePackage(path) {
  const source = readFileSync(path, "utf8");
  const manifest = JSON.parse(source);
  if (typeof manifest.version !== "string") {
    throw new Error(`${path} has no package version`);
  }
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateServerWorkspace(path) {
  const source = readFileSync(path, "utf8");
  const marker = "[workspace.package]";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${path} has no ${marker} section`);
  const remainder = source.slice(start + marker.length);
  const nextSectionOffset = remainder.search(/\n\s*\[/);
  const end = nextSectionOffset === -1
    ? source.length
    : start + marker.length + nextSectionOffset;
  const section = source.slice(start, end);
  const updated = section.replace(
    /(^\s*version\s*=\s*")[^"]+("\s*$)/m,
    `$1${version}$2`,
  );
  if (updated === section && !section.includes(`version = "${version}"`)) {
    throw new Error(`${path} has no workspace package version`);
  }
  writeFileSync(path, source.slice(0, start) + updated + source.slice(end));
}

function updateServerLock(path) {
  const metadata = JSON.parse(execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path", "server/Cargo.toml",
      "--format-version", "1",
      "--no-deps",
    ],
    { encoding: "utf8" },
  ));
  const serverRoot = `${resolve("server")}${sep}`;
  const releasePackages = metadata.packages.filter(pkg =>
    pkg.source === null &&
    pkg.version === version &&
    pkg.manifest_path.startsWith(serverRoot),
  );
  if (releasePackages.length === 0) {
    throw new Error("cargo metadata returned no versioned server workspace packages");
  }

  let lock = readFileSync(path, "utf8");
  for (const pkg of releasePackages) {
    const name = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(\\[\\[package\\]\\]\\nname = "${name}"\\nversion = ")[^"]+("\\n)`,
      "g",
    );
    let replacements = 0;
    lock = lock.replace(pattern, (_match, prefix, suffix) => {
      replacements += 1;
      return `${prefix}${version}${suffix}`;
    });
    if (replacements !== 1) {
      throw new Error(`${path}: expected one package entry for ${pkg.name}, found ${replacements}`);
    }
  }
  writeFileSync(path, lock);
}

updatePackage("package.json");
updateServerWorkspace("server/Cargo.toml");
updateServerLock("server/Cargo.lock");
NODE
  node build/scripts/ci/generate-security-policy.mjs
}

verify_expected_version_changes() {
  local allowed='^(package.json|server/Cargo.toml|server/Cargo.lock|SECURITY.md|client/REUSE.toml|client/provenance/components.json|virgultum/provenance/sources.json|virgultum/provenance/licenses.json)$'
  local unexpected
  unexpected="$(git status --porcelain --untracked-files=no | sed -E 's/^.. //' | grep -Ev "$allowed" || true)"
  test -z "$unexpected" || fail "version preparation changed unexpected files:\n$unexpected"
}

verify_release_contract() {
  local version="$1"
  section "Verifying release declarations"
  node build/scripts/ci/generate-security-policy.mjs --check
  node build/scripts/ci/verify-internal-package-release-surface.mjs
  node build/scripts/ci/verify-component-release-version.mjs \
    --component server \
    --release-ref "$version"
  node build/scripts/ci/verify-component-release-version.mjs \
    --component frontends \
    --release-ref "$version"
  git diff --check
}

component_tag_target() {
  git rev-list -n 1 "$1" 2>/dev/null || true
}

ensure_release_tag() {
  local tag="$1"
  local message="$2"
  local commit="$3"
  local target

  if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    target="$(component_tag_target "$tag")"
    test "$target" = "$commit" ||
      fail "local tag $tag points to $target instead of $commit"
    return
  fi
  git tag -a "$tag" -m "$message" "$commit"
}

verify_remote_tag_compatibility() {
  local tag="$1"
  local commit="$2"
  local direct peeled target
  direct="$(git ls-remote --tags "$REMOTE" "refs/tags/$tag" | awk '{print $1}')"
  peeled="$(git ls-remote --tags "$REMOTE" "refs/tags/$tag^{}" | awk '{print $1}')"
  target="${peeled:-$direct}"
  test -z "$target" || test "$target" = "$commit" ||
    fail "remote tag $tag already points to $target instead of $commit"
}

publish_release_refs() {
  local version="$1"
  local commit
  local server_tag="server-v$version"
  local frontend_tag="frontends-v$version"
  commit="$(git rev-parse HEAD)"

  if ! git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$server_tag" "refs/tags/$frontend_tag" >/dev/null; then
    node "$REPO_ROOT/build/scripts/release/assert-distribution-version-free.mjs" containers "$version"
  fi

  section "Creating component tags on $commit"
  ensure_release_tag "$server_tag" "Myoxus server $version" "$commit"
  ensure_release_tag "$frontend_tag" "Myoxus frontends $version" "$commit"
  verify_remote_tag_compatibility "$server_tag" "$commit"
  verify_remote_tag_compatibility "$frontend_tag" "$commit"

  section "Atomically publishing branch and component tags"
  git push --atomic "$REMOTE" \
    "HEAD:refs/heads/$BRANCH" \
    "refs/tags/$server_tag" \
    "refs/tags/$frontend_tag"
}

component_operation() {
  local component="$1"
  local version="$2"
  local operation="$3"
  local tag commit remote_target
  case "$component" in
    server) tag="server-v$version" ;;
    frontends) tag="frontends-v$version" ;;
    *) fail "unsupported release component: $component" ;;
  esac
  commit="$(resolve_component_commit "$component" "$version")"

  remote_target="$(git ls-remote --tags "$REMOTE" "refs/tags/$tag^{}" | awk '{print $1}')"
  test "$remote_target" = "$commit" ||
    fail "remote tag $tag does not resolve to the expected release commit $commit"

  section "$operation $component for $version ($commit); release tags remain unchanged"
  local client="$REPO_ROOT/build/scripts/release/forgejo-container-release.mjs"
  if test -n "${MYOXUS_FORGEJO_TOKEN:-}"; then
    node "$client" "$operation" "$component" "$version" "$commit" "$BRANCH"
  else
    local scopes=write:repository
    test "$operation" != status || scopes=read:repository
    "$REPO_ROOT/.agents/skills/myoxus-forgejo-temporary-token/scripts/with-temporary-token.sh" \
      --timeout-seconds 120 --scopes "$scopes" -- \
      node "$client" "$operation" "$component" "$version" "$commit" "$BRANCH"
  fi
}

registry_token() {
  local image="$1"
  curl --fail --silent --show-error --get \
    --connect-timeout 10 \
    --max-time 30 \
    --data-urlencode "service=container_registry" \
    --data-urlencode "scope=repository:${REGISTRY_NAMESPACE}/${image}:pull" \
    "https://${REGISTRY}/v2/token" |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const payload = JSON.parse(input);
        const token = payload.token || payload.access_token;
        if (!token) process.exit(1);
        process.stdout.write(token);
      });
    '
}

registry_digest() {
  local image="$1"
  local tag="$2"
  local token="$3"
  local headers status digest
  headers="$(mktemp)"
  if ! status="$(curl --silent \
    --connect-timeout 10 \
    --max-time 30 \
    --output /dev/null \
    --dump-header "$headers" \
    --write-out '%{http_code}' \
    --header "Authorization: Bearer $token" \
    --header 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://${REGISTRY}/v2/${REGISTRY_NAMESPACE}/${image}/manifests/${tag}")"; then
    rm -f "$headers"
    return 1
  fi
  if test "$status" != "200"; then
    rm -f "$headers"
    return 1
  fi
  digest="$(awk 'tolower($1) == "docker-content-digest:" { gsub("\\r", "", $2); print $2 }' "$headers" | tail -1)"
  rm -f "$headers"
  test -n "$digest" || return 1
  printf '%s' "$digest"
}

resolve_component_commit() {
  local component="$1"
  local version="$2"
  local tag commit

  case "$component" in
    server) tag="server-v$version" ;;
    frontends) tag="frontends-v$version" ;;
    *) fail "unsupported release component: $component" ;;
  esac

  local archived
  archived="$(node - "$component" "$version" <<'NODE'
const fs = require('node:fs');
const history = JSON.parse(fs.readFileSync('build/scripts/release/archived-release-reservations.json', 'utf8'));
process.stdout.write(history.components[process.argv[2]]?.[process.argv[3]] ?? '');
NODE
)"
  if test -n "$archived"; then printf '%s' "$archived"; return; fi

  if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
    git fetch "$REMOTE" "refs/tags/$tag:refs/tags/$tag"
  fi
  commit="$(component_tag_target "$tag")"
  test -n "$commit" || fail "local tag $tag is missing"
  printf '%s' "$commit"
}

verify_registry_release() {
  local version="$1"
  local server_commit frontend_commit commit start now image token version_digest commit_digest key index attempt=0
  local -a images=(myoxus myoxus-web-frontend myoxus-admin-frontend)
  local -a commits=()
  local -a tokens=()
  local -a completed=()
  local -a version_digests=()
  local -a commit_digests=()
  local -a pending=()

  server_commit="$(resolve_component_commit server "$version")"
  frontend_commit="$(resolve_component_commit frontends "$version")"
  commits=("$server_commit" "$frontend_commit" "$frontend_commit")
  section "Waiting for registry release $version (server $server_commit, frontends $frontend_commit)"
  start="$(date +%s)"

  for index in "${!images[@]}"; do
    image="${images[$index]}"
    tokens[$index]="$(registry_token "$image")" ||
      fail "could not obtain anonymous pull token for $image"
  done

  while :; do
    attempt=$((attempt + 1))
    for index in "${!images[@]}"; do
      image="${images[$index]}"
      commit="${commits[$index]}"
      test "${completed[$index]:-false}" = true && continue
      token="${tokens[$index]}"
      version_digest="$(registry_digest "$image" "$version" "$token" || true)"
      commit_digest="$(registry_digest "$image" "$commit" "$token" || true)"
      if test -n "$version_digest" && test -n "$commit_digest"; then
        test "$version_digest" = "$commit_digest" ||
          fail "$image version and commit tags have different digests"
        version_digests[$index]="$version_digest"
        commit_digests[$index]="$commit_digest"
        completed[$index]=true
        echo "  ready  ${REGISTRY}/${REGISTRY_NAMESPACE}/${image}:${version}  $version_digest"
      fi
    done

    if test "${#completed[@]}" -eq "${#images[@]}"; then
      break
    fi
    if (( attempt % 3 == 0 )); then
      pending=()
      for index in "${!images[@]}"; do
        test "${completed[$index]:-false}" = true || pending+=("${images[$index]}")
      done
      echo "  waiting ${pending[*]}"
    fi
    now="$(date +%s)"
    if (( now - start >= WAIT_TIMEOUT )); then
      for index in "${!images[@]}"; do
        test "${completed[$index]:-false}" = true || echo "  missing ${images[$index]}" >&2
      done
      fail "registry verification timed out after ${WAIT_TIMEOUT}s"
    fi
    sleep "$POLL_INTERVAL"
  done

  section "Registry release is complete"
  for index in "${!images[@]}"; do
    image="${images[$index]}"
    commit="${commits[$index]}"
    key="${REGISTRY}/${REGISTRY_NAMESPACE}/${image}"
    printf '  %-65s %s\n' "$key:$version" "${version_digests[$index]}"
    printf '  %-65s %s\n' "$key:$commit" "${commit_digests[$index]}"
  done

  section "Waiting for the public distribution overview"
  node build/scripts/ci/publish-distribution-overview.mjs \
    verify-containers \
    --version "$version" \
    --server-commit "$server_commit" \
    --frontend-commit "$frontend_commit" \
    --server-digest "${version_digests[0]}" \
    --web-digest "${version_digests[1]}" \
    --admin-digest "${version_digests[2]}" \
    --wait-seconds "$WAIT_TIMEOUT" \
    --poll-seconds "$POLL_INTERVAL"
}

prepare_release() {
  local version="$1"
  require_clean_worktree
  set_versions "$version"
  node build/scripts/release/refresh-source-inventories.mjs "$REPO_ROOT"
  verify_expected_version_changes
  verify_release_contract "$version"
}

main() {
  local command="${1:-release}"
  local version="${2:-}"
  if [[ "$command" = -h || "$command" = --help ]]; then
    usage
    return
  fi
  if [[ "$command" = [0-9]* ]] && test "$#" -eq 1; then
    version="$command"
    command=release
  fi
  test "$#" -le 2 && { test "$command" = release || test "$command" = prepare || test -n "$version"; } || {
    usage
    exit 2
  }

  if test -n "$version"; then validate_version "$version"; fi
  validate_registry_host
  [[ "$POLL_INTERVAL" =~ ^[1-9][0-9]*$ ]] ||
    fail "MYOXUS_RELEASE_POLL_SECONDS must be a positive integer"
  [[ "$WAIT_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
    fail "MYOXUS_RELEASE_TIMEOUT_SECONDS must be a positive integer"
  require_command git
  require_command node
  require_command curl
  require_repo_context
  if test -n "$version" && test "$command" != verify && test "$command" != check && test "$command" != prepare; then
    node build/scripts/release/check-archived-version.mjs containers "$version"
  fi

  case "$command" in
    release)
      require_release_branch
      require_clean_worktree
      sync_release_branch
      version="$(resolve_release_version "$version")"
      section "Selected container release $version"
      prepare_release "$version"
      git add -- package.json server/Cargo.toml server/Cargo.lock SECURITY.md \
        client/REUSE.toml client/provenance/components.json \
        virgultum/provenance/sources.json virgultum/provenance/licenses.json
      if ! git diff --cached --quiet; then
        git commit -m "chore(release): bump server and frontend to $version"
      fi
      require_clean_worktree
      publish_release_refs "$version"
      verify_registry_release "$version"
      ;;
    prepare)
      require_release_branch
      local current
      current="$(current_release_version)"
      test -z "$version" || test "$version" = "$current" ||
        fail "preparation keeps version $current; version allocation belongs to publication"
      verify_release_contract "$current"
      ;;
    publish)
      require_release_branch
      require_clean_worktree
      sync_release_branch
      verify_release_contract "$version"
      publish_release_refs "$version"
      verify_registry_release "$version"
      ;;
    check)
      verify_release_contract "$version"
      ;;
    verify)
      verify_registry_release "$version"
      ;;
    status)
      if test -z "${MYOXUS_FORGEJO_TOKEN:-}"; then
        "$REPO_ROOT/.agents/skills/myoxus-forgejo-temporary-token/scripts/with-temporary-token.sh" \
          --timeout-seconds 120 --scopes read:repository -- \
          bash "$REPO_ROOT/build/scripts/release/release-containers.sh" status "$version"
      else
        component_operation server "$version" status
        component_operation frontends "$version" status
      fi
      ;;
    retry-server|retry-frontends|publish-server|publish-frontends)
      local operation="${command%%-*}"
      local component="${command#*-}"
      # Recovery belongs to the tagged commit, not today's version declarations.
      component_operation "$component" "$version" "$operation"
      verify_registry_release "$version"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  main "$@"
fi
