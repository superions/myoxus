#!/usr/bin/env bash
# Fast fixture tests for the small CI helper scripts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmpdir="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmpdir"' EXIT

cd "$REPO_ROOT"

node --test build/scripts/ci/scan-server-dependencies.test.mjs
node --test build/scripts/ci/test-dev-stop-ownership.mjs
node --test build/scripts/ci/test-clean-roots.mjs build/scripts/ci/test-prepare-development-checkout.mjs build/scripts/ci/test-runtime-profile.mjs build/scripts/ci/test-distribution-version-reservations.mjs
bash build/scripts/release/test-publish-github-mirror.sh

section() {
  echo "==> Testing $*"
}

expect_failure() {
  local label="$1"
  shift
  local stdout="$tmpdir/${label}.out"
  local stderr="$tmpdir/${label}.log"

  set +e
  (
    set -e
    "$@"
  ) >"$stdout" 2>"$stderr"
  local exit_code=$?
  set -e
  expect_failure_exit_code="$exit_code"

  if [ "$exit_code" -eq 0 ]; then
    echo "Expected failure succeeded unexpectedly: $label" >&2
    cat "$stdout" >&2
    cat "$stderr" >&2
    exit 1
  fi
}

section "public source correspondence preserves the build identity"
node --input-type=module - "$tmpdir" <<'NODE'
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readSourceProvenance, applySourceToSbom } from "./build/scripts/release/source-correspondence.mjs";
const revision = "1".repeat(40), commit = "2".repeat(40), sha256 = "3".repeat(64);
const file = `${process.argv[2]}/release-provenance.json`;
const report = { schemaVersion: 1, revision, sourceArchive: { sha256 }, publicSource: {
  repository: "https://github.com/superions/myoxus", commit,
  archive: { url: "https://github.com/superions/myoxus/releases/download/v1.0.0/source.tar", sha256 },
}};
writeFileSync(file, JSON.stringify(report));
const source = readSourceProvenance(file, revision);
const bom = applySourceToSbom({ metadata: { component: {} } }, revision, source);
assert.equal(bom.metadata.component.properties[0].value, revision);
assert.equal(bom.metadata.component.externalReferences[0].url, `${source.repository}/tree/${commit}`);
assert.throws(() => readSourceProvenance(file, commit), /build revision/);
report.sourceArchive.sha256 = "4".repeat(64);
writeFileSync(file, JSON.stringify(report));
assert.throws(() => readSourceProvenance(file, revision), /archive digest/);
report.sourceArchive.sha256 = sha256;
delete report.publicSource.archive;
report.publicSource.tree = "5".repeat(40);
writeFileSync(file, JSON.stringify(report));
const gitSource = readSourceProvenance(file, revision);
assert.equal(gitSource.tree, "5".repeat(40));
const gitBom = applySourceToSbom({ metadata: { component: {} } }, revision, gitSource);
assert.equal(gitBom.metadata.component.externalReferences[1].url, `${gitSource.repository}/archive/${commit}.tar.gz`);
assert.equal(gitBom.metadata.component.externalReferences[1].hashes, undefined);
report.publicSource.commit = revision;
writeFileSync(file, JSON.stringify(report));
assert.throws(() => readSourceProvenance(file, revision), /distinct public commit/);
NODE

section "automatic container patch selection"
version_fixture="$tmpdir/container-versions"
version_remote="$tmpdir/container-versions.git"
mkdir -p "$version_fixture/server"
printf '{"version":"1.2.3"}\n' >"$version_fixture/package.json"
printf '[workspace.package]\nversion = "1.2.4"\n' >"$version_fixture/server/Cargo.toml"
git init --quiet "$version_fixture"
git -C "$version_fixture" add .
git -C "$version_fixture" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit --quiet -m fixture
git clone --quiet --bare "$version_fixture" "$version_remote"
git -C "$version_fixture" tag server-v1.2.8
git -C "$version_fixture" tag clients-v99.0.0
git --git-dir="$version_remote" -c user.name=Fixture -c user.email=fixture@example.invalid \
  tag -a frontends-v1.2.10 -m fixture
select_container_version() {
  bash -c 'source "$1"; cd "$2"; REMOTE="$3"; resolve_release_version "${4:-}"' \
    bash "$REPO_ROOT/build/scripts/release/release-containers.sh" \
    "$version_fixture" "$version_remote" "${1:-}"
}
test "$(select_container_version)" = 1.2.11
test "$(select_container_version 1.2.12)" = 1.2.12
expect_failure archived-container-version select_container_version 0.41.18
expect_failure archived-client-version node build/scripts/release/check-archived-version.mjs clients 0.41.19
expect_failure reserved-remote-container-version select_container_version 1.2.10
expect_failure reserved-local-container-version select_container_version 1.2.8
grep -q 'already reserved' "$tmpdir/reserved-remote-container-version.log"
grep -q 'already reserved' "$tmpdir/reserved-local-container-version.log"
test -z "$(git -C "$version_fixture" status --porcelain)"
printf '{"version":"1.3.0"}\n' >"$version_fixture/package.json"
test "$(select_container_version)" = 1.3.1
printf '{"version":"1.2.10"}\n' >"$version_fixture/package.json"
printf '[workspace.package]\nversion = "1.2.10"\n' >"$version_fixture/server/Cargo.toml"
test "$(select_container_version 1.2.10)" = 1.2.10
expect_failure unavailable-container-remote \
  bash -c 'source "$1"; cd "$2"; REMOTE="$2/missing.git"; resolve_release_version' \
  bash "$REPO_ROOT/build/scripts/release/release-containers.sh" "$version_fixture"

mkdir -p "$version_fixture/build/scripts/release"
cp build/scripts/release/release.sh "$version_fixture/build/scripts/release/"
printf '#!/usr/bin/env bash\nprintf "<%%s>\\n" "$@"\n' \
  >"$version_fixture/build/scripts/release/release-containers.sh"
chmod +x "$version_fixture/build/scripts/release/release-containers.sh"
test "$(bash "$version_fixture/build/scripts/release/release.sh" containers)" = $'<release>\n<>'
test "$(bash "$version_fixture/build/scripts/release/release.sh" containers 1.2.12)" = $'<release>\n<1.2.12>'
cp "$version_fixture/build/scripts/release/release-containers.sh" "$version_fixture/build/scripts/release/release-clients.sh"
test "$(bash "$version_fixture/build/scripts/release/release.sh" clients)" = $'<release>\n<>\n<clients>'
expect_failure extra-container-version \
  bash "$version_fixture/build/scripts/release/release.sh" containers 1.2.12 1.2.13
expect_failure missing-verification-version \
  bash "$version_fixture/build/scripts/release/release.sh" verify-containers

section "frontend release gate ownership"
release_gate="build/scripts/server/release-gate-frontend.sh"
if grep -q 'run-frontend-journey-tests' "$release_gate"; then
  echo "Frontend release gate restored the removed legacy journey runner." >&2
  exit 1
fi
if grep -Eq '(phase2_complete_test|admin_endpoints|graphql_admin_compat|graphql_admin_db_backing|graphql_workspace|workspace_docs_rest_compat|graphql_comments)' "$release_gate"; then
  echo "Frontend release gate restored obsolete per-file API test targets." >&2
  exit 1
fi

section "policy documentation workflow bootstrap"
policy_docs_workflow=".forgejo/workflows/policy-docs.yml"
grep -Fq 'node build/scripts/ci/generate-security-policy.mjs --check' \
  "$policy_docs_workflow"
if grep -Fq 'yarn security:policy:check' "$policy_docs_workflow"; then
  echo "Policy documentation workflow requires an unavailable Yarn install state." >&2
  exit 1
fi

section "security policy in the automatic release commit"
# The generator owns the exact bytes; pre-commit formatting must not rewrite it.
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { getFileInfo } from "prettier";
assert.equal((await getFileInfo("SECURITY.md", { ignorePath: ".prettierignore" })).ignored, true);
NODE
policy_fixture="$tmpdir/policy-release"
mkdir -p "$policy_fixture/build/scripts/ci" "$policy_fixture/docs" \
  "$policy_fixture/server/crates/api/src"
mkdir -p "$policy_fixture/build/scripts/release"
cp build/scripts/release/check-archived-version.mjs build/scripts/release/archived-release-reservations.json "$policy_fixture/build/scripts/release/"
cat >"$policy_fixture/build/scripts/release/refresh-source-inventories.mjs" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
for (const file of ['client/REUSE.toml', 'client/provenance/components.json', 'virgultum/provenance/sources.json', 'virgultum/provenance/licenses.json']) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, '{}\n');
}
JS
cp build/scripts/ci/generate-security-policy.mjs "$policy_fixture/build/scripts/ci/"
cp docs/security-policy.json "$policy_fixture/docs/"
cp SECURITY.md "$policy_fixture/"
printf '{"version":"1.2.3"}\n' >"$policy_fixture/package.json"
printf '[workspace]\nmembers = ["crates/api"]\nresolver = "3"\n[workspace.package]\nversion = "1.2.3"\n' \
  >"$policy_fixture/server/Cargo.toml"
printf '[package]\nname = "myoxus-api"\nversion.workspace = true\nedition = "2024"\n' \
  >"$policy_fixture/server/crates/api/Cargo.toml"
touch "$policy_fixture/server/crates/api/src/lib.rs"
printf 'version = 4\n\n[[package]]\nname = "myoxus-api"\nversion = "1.2.3"\n' \
  >"$policy_fixture/server/Cargo.lock"
node "$policy_fixture/build/scripts/ci/generate-security-policy.mjs"
git init --quiet --initial-branch=wip "$policy_fixture"
git -C "$policy_fixture" config user.name Fixture
git -C "$policy_fixture" config user.email fixture@example.invalid
git -C "$policy_fixture" add .
git -C "$policy_fixture" commit --quiet -m fixture
# Preparation must be read-only even when a different version is requested.
bash -c '
  source "$1"
  REPO_ROOT="$2"
  verify_release_contract() { node build/scripts/ci/generate-security-policy.mjs --check; }
  main prepare
  git diff --exit-code
' bash "$REPO_ROOT/build/scripts/release/release-containers.sh" "$policy_fixture"
expect_failure preparation-version-bump \
  bash -c 'source "$1"; REPO_ROOT="$2"; main prepare 1.3.0' \
  bash "$REPO_ROOT/build/scripts/release/release-containers.sh" "$policy_fixture"
test -z "$(git -C "$policy_fixture" status --porcelain)"

mkdir -p "$policy_fixture/client/apps/electron"
printf '{"version":"1.2.3"}\n' > "$policy_fixture/client/apps/electron/package.json"
bash -c '
  source "$1"
  REPO_ROOT="$2"
  cd "$REPO_ROOT"
  verify_contract() { test "$1" = 1.2.3; }
  main prepare
' bash "$REPO_ROOT/build/scripts/release/release-clients.sh" "$policy_fixture"
expect_failure desktop-preparation-version-bump \
  bash -c 'source "$1"; REPO_ROOT="$2"; cd "$REPO_ROOT"; main prepare 1.3.0' \
  bash "$REPO_ROOT/build/scripts/release/release-clients.sh" "$policy_fixture"
grep -Fq '"1.2.3"' "$policy_fixture/client/apps/electron/package.json"
test "$(bash -c 'source "$1"; REPO_ROOT="$2"; REMOTE="$3"; cd "$2"; resolve_release_version' \
  bash "$REPO_ROOT/build/scripts/release/release-clients.sh" "$policy_fixture" "$version_remote")" = 1.2.4
git -C "$policy_fixture" add client/apps/electron/package.json
git -C "$policy_fixture" commit --quiet -m desktop-fixture

# Run the real automatic publication/version/staging path; only external services and the
# unrelated package-declaration checks are replaced in this tiny workspace.
bash -c '
  source "$1"
  REPO_ROOT="$2"
  REMOTE="$3"
  sync_release_branch() { :; }
  verify_release_contract() { node build/scripts/ci/generate-security-policy.mjs --check; }
  publish_release_refs() { git show HEAD:SECURITY.md | cmp - SECURITY.md; }
  verify_registry_release() { :; }
  main release
' bash "$REPO_ROOT/build/scripts/release/release-containers.sh" \
  "$policy_fixture" "$version_remote"
grep -Fq 'release is **1.2.11**.' "$policy_fixture/SECURITY.md"
grep -Fq '| 1.2.x | Yes |' "$policy_fixture/SECURITY.md"
test -z "$(git -C "$policy_fixture" status --porcelain)"
printf 'stale policy\n' >"$policy_fixture/SECURITY.md"
expect_failure stale-prepared-release-policy \
  bash -c 'source "$1"; cd "$2"; verify_release_contract 1.2.11' \
  bash "$REPO_ROOT/build/scripts/release/release-containers.sh" "$policy_fixture"
grep -Fq 'SECURITY.md is stale' "$tmpdir/stale-prepared-release-policy.log"

section "container env resolution"
fixture_release="1.2.3"
env_file="$tmpdir/github-env"
GITHUB_ENV="$env_file" \
  VERSION_INPUT="Feature/PDF V2+Release" \
  PUBLISH_CONTAINERS_REQUESTED=false \
  PUBLISH_CONTAINERS_EXPLICIT=false \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q '^RELEASE_REF=feature-pdf-v2-release$' "$env_file"
grep -q '^TAG_PREFIX=local/myoxus$' "$env_file"
grep -q '^PUBLISH_CONTAINERS=false$' "$env_file"
PUBLISH_CONTAINERS=false bash build/scripts/ci/login-container-registry.sh >/dev/null
env_file="$tmpdir/wip-publish-env"
GITHUB_ENV="$env_file" \
  VERSION_INPUT=publish-wip \
  GITHUB_REF_NAME=publish-wip \
  REGISTRY=registry.example.invalid \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q '^RELEASE_REF=wip$' "$env_file"
grep -q '^TAG_PREFIX=registry.example.invalid/myoxus$' "$env_file"
grep -q '^REGISTRY_OWNER=myoxus$' "$env_file"
grep -q '^PUBLISH_CONTAINERS=true$' "$env_file"
for invalid_registry in \
  'https://registry.example.invalid' \
  'registry.example.invalid/myoxus' \
  'registry.example.invalid/roekvar-lab/affine-fork' \
  'user@registry.example.invalid'; do
  label="invalid-registry-$(printf '%s' "$invalid_registry" | tr -c 'A-Za-z0-9' '-')"
  expect_failure "$label" \
    env GITHUB_ENV="$tmpdir/${label}.env" \
    VERSION_INPUT=publish-wip \
    REGISTRY="$invalid_registry" \
    PUBLISH_CONTAINERS_REQUESTED=true \
    bash build/scripts/ci/resolve-container-image-env.sh
  grep -q 'only a registry host and optional port' "$tmpdir/${label}.log"
done
expect_failure release-script-nested-registry \
  env MYOXUS_REGISTRY=registry.example.invalid/owner \
  bash build/scripts/release/release-containers.sh check 1.2.3
grep -q 'only a registry host and optional port' "$tmpdir/release-script-nested-registry.log"
env_file="$tmpdir/server-release-env"
GITHUB_ENV="$env_file" \
  VERSION_INPUT="server-v${fixture_release}" \
  RELEASE_COMPONENT=server \
  REGISTRY=registry.example.invalid \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q "^RELEASE_REF=${fixture_release}$" "$env_file"
env_file="$tmpdir/frontends-release-env"
GITHUB_ENV="$env_file" \
  VERSION_INPUT="frontends-v${fixture_release}" \
  RELEASE_COMPONENT=frontends \
  REGISTRY=registry.example.invalid \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q "^RELEASE_REF=${fixture_release}$" "$env_file"
expect_failure mismatched-release-component \
  env GITHUB_ENV="$tmpdir/mismatched-release-env" \
  VERSION_INPUT="server-v${fixture_release}" \
  RELEASE_COMPONENT=frontends \
  REGISTRY=registry.example.invalid \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q 'RELEASE_COMPONENT=server' "$tmpdir/mismatched-release-component.log"
expect_failure tag-publish-without-registry \
  env GITHUB_ENV="$tmpdir/tag-publish-env" \
  VERSION_INPUT=wip \
  GITHUB_REF_NAME=publish-wip \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q 'MYOXUS_REGISTRY secret' "$tmpdir/tag-publish-without-registry.log"
expect_failure publish-env \
  env GITHUB_ENV="$tmpdir/publish-env" \
  VERSION_INPUT="" \
  GITHUB_REF_NAME="" \
  REGISTRY=registry.example.invalid \
  PUBLISH_CONTAINERS_REQUESTED=true \
  bash build/scripts/ci/resolve-container-image-env.sh
grep -q 'Manual container publishing requires a version input' "$tmpdir/publish-env.log"
expect_failure publish-registry \
  env PUBLISH_CONTAINERS=true \
  bash build/scripts/ci/login-container-registry.sh
grep -q 'MYOXUS_REGISTRY secret' "$tmpdir/publish-registry.log"
expect_failure publish-user \
  env PUBLISH_CONTAINERS=true \
  REGISTRY=registry.example.invalid \
  bash build/scripts/ci/login-container-registry.sh
grep -q 'MYOXUS_REGISTRY_USER secret' "$tmpdir/publish-user.log"
expect_failure publish-password \
  env PUBLISH_CONTAINERS=true \
  REGISTRY=registry.example.invalid \
  REGISTRY_USER=myoxus-ci \
  bash build/scripts/ci/login-container-registry.sh
grep -q 'MYOXUS_REGISTRY_PASSWORD secret' "$tmpdir/publish-password.log"

section "container development export preflight"
expect_failure publishing-development-export env \
  DOCKERFILE=build/server/Dockerfile IMAGE=myoxus ARTIFACT=server \
  TAG_PREFIX=local GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
  PUBLISH_CONTAINERS=true EXPORT_DEVELOPMENT_IMAGE=true \
  bash build/scripts/ci/build-container-image.sh
test "$expect_failure_exit_code" -eq 2
grep -q 'Development image export requires non-publishing mode' "$tmpdir/publishing-development-export.log"
expect_failure malformed-development-export env \
  DOCKERFILE=build/server/Dockerfile IMAGE=myoxus ARTIFACT=server \
  TAG_PREFIX=local GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 \
  PUBLISH_CONTAINERS=false EXPORT_DEVELOPMENT_IMAGE=maybe \
  bash build/scripts/ci/build-container-image.sh
test "$expect_failure_exit_code" -eq 2
grep -q 'EXPORT_DEVELOPMENT_IMAGE must be true or false' "$tmpdir/malformed-development-export.log"

section "container build evidence"
fixture_evidence_version="1.2.3"
fixture_evidence_revision="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fixture_stale_revision="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fixture_local_digest="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
fixture_registry_digest="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

write_container_evidence_fixture() {
  local directory="$1"
  local role="$2"
  local revision="$3"
  local publish_mode="$4"
  node - \
    "$directory" \
    "$role" \
    "$revision" \
    "$fixture_evidence_version" \
    "$publish_mode" \
    "$fixture_local_digest" \
    "$fixture_registry_digest" <<'NODE'
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const [directory, role, revision, version, publishMode, localDigest, registryDigest] =
  process.argv.slice(2);
const titles = {
  server: "Myoxus Server",
  web: "Myoxus Web static artifact",
  admin: "Myoxus Admin static artifact",
};
mkdirSync(directory, { recursive: true });
const image = {
  Id: localDigest,
  RepoDigests:
    publishMode === "true"
      ? [`registry.example.invalid/myoxus/${role}@${registryDigest}`]
      : [],
  Config: {
    Labels: {
      "org.opencontainers.image.title": titles[role],
      "org.opencontainers.image.version": version,
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.source": "https://github.com/superions/myoxus",
    },
  },
};
writeFileSync(
  join(directory, `${role}-image-inspect.json`),
  `${JSON.stringify([image], null, 2)}\n`,
);
if (role === "server") {
  writeFileSync(
    join(directory, "server-os-packages.tsv"),
    "base-files\t1.0\tamd64\n",
  );
  const digest = publishMode === "true" ? registryDigest : localDigest;
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: {
        type: "container",
        version,
        properties: [
          { name: "myoxus:git-revision", value: revision },
          {
            name: "myoxus:oci-digest-kind",
            value:
              publishMode === "true" ? "registry-manifest" : "local-image",
          },
          { name: "myoxus:oci-digest", value: digest },
        ],
      },
    },
  };
  writeFileSync(
    join(directory, "server-oci.cdx.json"),
    `${JSON.stringify(sbom, null, 2)}\n`,
  );
} else {
  const identity = {
    schemaVersion: 1,
    role,
    clientVersion: version,
    editorVersion: version,
    revision,
  };
  writeFileSync(
    join(directory, `${role}-release.json`),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
}
NODE
}

for role in server web admin; do
  evidence_dir="$tmpdir/container-evidence-${role}"
  write_container_evidence_fixture \
    "$evidence_dir" "$role" "$fixture_evidence_revision" false
  node build/scripts/ci/verify-container-build-evidence.mjs \
    --evidence-dir "$evidence_dir" \
    --role "$role" \
    --revision "$fixture_evidence_revision" \
    --version "$fixture_evidence_version" \
    --publish-mode false >/dev/null
  bash build/scripts/ci/write-artifact-manifest.sh "$evidence_dir"
  bash build/scripts/ci/write-sha256sums.sh "$evidence_dir"
  node build/scripts/ci/verify-container-build-evidence.mjs \
    --evidence-dir "$evidence_dir" \
    --role "$role" \
    --revision "$fixture_evidence_revision" \
    --version "$fixture_evidence_version" \
    --publish-mode false >/dev/null
  bash build/scripts/ci/verify-artifact-manifest.sh "$evidence_dir" >/dev/null
  bash build/scripts/ci/verify-sha256sums.sh "$evidence_dir" >/dev/null
done

for role in server web admin; do
  evidence_dir="$tmpdir/container-evidence-publish-${role}"
  write_container_evidence_fixture \
    "$evidence_dir" "$role" "$fixture_evidence_revision" true
  node build/scripts/ci/verify-container-build-evidence.mjs \
    --evidence-dir "$evidence_dir" \
    --role "$role" \
    --revision "$fixture_evidence_revision" \
    --version "$fixture_evidence_version" \
    --publish-mode true >/dev/null
done

evidence_dir="$tmpdir/container-evidence-digest-leak"
write_container_evidence_fixture \
  "$evidence_dir" web "$fixture_evidence_revision" true
expect_failure container-evidence-no-publish-digest \
  node build/scripts/ci/verify-container-build-evidence.mjs \
  --evidence-dir "$evidence_dir" \
  --role web \
  --revision "$fixture_evidence_revision" \
  --version "$fixture_evidence_version" \
  --publish-mode false
grep -q 'no-publish evidence claims a registry digest' \
  "$tmpdir/container-evidence-no-publish-digest.log"

evidence_dir="$tmpdir/container-evidence-stale"
write_container_evidence_fixture \
  "$evidence_dir" admin "$fixture_stale_revision" false
expect_failure container-evidence-stale-revision \
  node build/scripts/ci/verify-container-build-evidence.mjs \
  --evidence-dir "$evidence_dir" \
  --role admin \
  --revision "$fixture_evidence_revision" \
  --version "$fixture_evidence_version" \
  --publish-mode false
grep -q 'revision' "$tmpdir/container-evidence-stale-revision.log"

evidence_dir="$tmpdir/container-evidence-extra"
write_container_evidence_fixture \
  "$evidence_dir" web "$fixture_evidence_revision" false
printf '{"fixture":true}\n' >"$evidence_dir/release-provenance.json"
node build/scripts/ci/verify-container-build-evidence.mjs \
  --evidence-dir "$evidence_dir" \
  --role web \
  --revision "$fixture_evidence_revision" \
  --version "$fixture_evidence_version" \
  --publish-mode false >/dev/null

fake_docker_bin="$tmpdir/container-build-bin"
fake_docker_log="$tmpdir/container-build-docker.log"
mkdir -p "$fake_docker_bin"
cat >"$fake_docker_bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ "$1 ${2:-}" = "buildx build" ]; then
  for argument in "$@"; do
    case "$argument" in
      type=local,dest=*)
        cache_destination="${argument#type=local,dest=}"
        cache_destination="${cache_destination%%,*}"
        mkdir -p "$cache_destination"
        ;;
    esac
  done
elif [ "$1 ${2:-}" = "image inspect" ]; then
  if [ "${3:-}" = --format ]; then
    case "$4" in
      '{{.Id}}') printf 'sha256:%064d\n' 0 | tr 0 e ;;
      *) printf 'registry.example.invalid/myoxus/myoxus-web-frontend@sha256:%064d\n' 0 ;;
    esac
    exit 0
  fi
  node - "$GITHUB_SHA" "$FAKE_PRODUCT_VERSION" <<'NODE'
const [revision, version] = process.argv.slice(2);
process.stdout.write(`${JSON.stringify([{
  Id: `sha256:${"e".repeat(64)}`,
  RepoDigests: [],
  Config: { Labels: {
    "org.opencontainers.image.title": "Myoxus Web static artifact",
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.source": "https://github.com/superions/myoxus",
  } },
}], null, 2)}\n`);
NODE
elif [ "$1" = "create" ]; then
  printf 'fixture-container\n'
elif [ "$1" = "cp" ]; then
  destination="${@: -1}"
  node - "$destination" "$FAKE_PRODUCT_VERSION" <<'NODE'
const { writeFileSync } = require("node:fs");
const [destination, version] = process.argv.slice(2);
writeFileSync(destination, `${JSON.stringify({
  schemaVersion: 1,
  role: "web",
  clientVersion: version,
  editorVersion: version,
  revision: process.env.FAKE_VALID_REVISION ?? "ffffffffffffffffffffffffffffffffffffffff",
}, null, 2)}\n`);
NODE
elif [ "$1" = push ]; then
  [ "${FAKE_UPLOAD_FAIL:-false}" != true ] || exit 42
elif [ "$1" = pull ]; then
  exit 1
elif [ "$1" = "rm" ] || [ "$1 ${2:-}" = "image rm" ]; then
  :
else
  echo "unexpected fake docker invocation: $*" >&2
  exit 2
fi
SH
chmod +x "$fake_docker_bin/docker"
cleanup_fixture_evidence="dist/ci-fixture-container-cleanup-$$"
mkdir -p "$cleanup_fixture_evidence"
printf 'stale\n' >"$cleanup_fixture_evidence/stale.txt"
fixture_build_revision="$(git rev-parse HEAD)"
fixture_product_version="$(node -p "require('./package.json').version")"
expect_failure container-build-cleanup-safe-failure \
  env \
  PATH="$fake_docker_bin:$PATH" \
  DOCKERFILE=build/web/Dockerfile \
  IMAGE=myoxus-web-frontend \
  ARTIFACT=web-frontend \
  TAG_PREFIX=local/myoxus \
  GITHUB_SHA="$fixture_build_revision" \
  PUBLISH_CONTAINERS=false \
  CONTAINER_EVIDENCE_DIR="$cleanup_fixture_evidence" \
  CI_RUNNER_CACHE="$tmpdir/container-build-cache" \
  CI_BUILDKIT_CACHE_MIN_FREE_GIB=0 \
  FAKE_DOCKER_LOG="$fake_docker_log" \
  FAKE_PRODUCT_VERSION="$fixture_product_version" \
  bash build/scripts/ci/build-container-image.sh
if ! grep -q 'release.json revision mismatch' \
  "$tmpdir/container-build-cleanup-safe-failure.log"; then
  cat "$tmpdir/container-build-cleanup-safe-failure.log" >&2
  exit 1
fi
test ! -e "$cleanup_fixture_evidence/stale.txt"
grep -q '^buildx build --pull ' "$fake_docker_log"
grep -q '^image rm ' "$fake_docker_log"
grep -q '^rm fixture-container$' "$fake_docker_log"
test ! -e "$tmpdir/container-build-cache/buildkit/web-frontend-new"
rm -rf -- "$cleanup_fixture_evidence"

section "resume retained image after an upload failure without building"
recovery_fixture_cache="$tmpdir/upload-recovery-cache"
recovery_fixture_evidence="dist/ci-fixture-upload-recovery-$$"
recovery_fixture_summary="$tmpdir/upload-recovery-summary.md"
recovery_environment=(
  env PATH="$fake_docker_bin:$PATH"
  DOCKERFILE=build/web/Dockerfile IMAGE=myoxus-web-frontend ARTIFACT=web-frontend
  TAG_PREFIX=local/myoxus GITHUB_SHA="$fixture_build_revision"
  PUBLISH_CONTAINERS=true CONTAINER_EVIDENCE_DIR="$recovery_fixture_evidence"
  CI_RUNNER_CACHE="$recovery_fixture_cache" CI_BUILDKIT_CACHE_MIN_FREE_GIB=0
  GITHUB_STEP_SUMMARY="$recovery_fixture_summary"
  FAKE_DOCKER_LOG="$tmpdir/upload-recovery-docker.log"
  FAKE_PRODUCT_VERSION="$fixture_product_version" FAKE_VALID_REVISION="$fixture_build_revision"
)
expect_failure container-upload-failure "${recovery_environment[@]}" FAKE_UPLOAD_FAIL=true \
  bash build/scripts/ci/build-container-image.sh
test "$expect_failure_exit_code" -eq 42
receipt="$recovery_fixture_cache/container-recovery/web-frontend/$fixture_build_revision/image-id"
test -s "$receipt"
! grep -q '^image rm ' "$tmpdir/upload-recovery-docker.log"
"${recovery_environment[@]}" CONTAINER_BUILD_MODE=publish-only \
  bash build/scripts/ci/build-container-image.sh
test ! -f "$receipt"
test "$(grep -c '^buildx build ' "$tmpdir/upload-recovery-docker.log")" -eq 1
grep -q 'Existing image reused: `true`' "$recovery_fixture_summary"
expect_failure container-publish-only-missing "${recovery_environment[@]}" CONTAINER_BUILD_MODE=publish-only \
  bash build/scripts/ci/build-container-image.sh
grep -q 'publish-only will not build' "$tmpdir/container-publish-only-missing.log"
test "$(grep -c '^buildx build ' "$tmpdir/upload-recovery-docker.log")" -eq 1
rm -rf -- "$recovery_fixture_evidence"

section "native OCI job retry preserves successful sibling jobs and tags"
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { runContainerOperation } from "./build/scripts/release/forgejo-container-release.mjs";
const revision = "a".repeat(40);
const calls = [];
await runContainerOperation(["retry", "frontends", "1.2.3", revision], async (path, body) => {
  calls.push([path, body]);
  if (path.includes("/actions/runs?")) return { workflow_runs: [{
    id: 123, workflow_id: "release-linux.yml", commit_sha: revision,
    prettyref: "frontends-v1.2.3", status: "failure", html_url: "fixture",
  }] };
  if (path.endsWith("/jobs")) return [
    { id: 1, name: "Frontend images-1", status: "failure", attempt: 1 },
    { id: 2, name: "Frontend images", status: "success", attempt: 1 },
    { id: 3, name: "Accept and promote container images", status: "skipped", attempt: 1 },
  ];
  assert.equal(path, "/api/v1/repos/myoxus/myoxus/actions/jobs/1/rerun");
  return null;
});
assert.deepEqual(calls.filter(([, body]) => body !== undefined).map(([path]) => path),
  ["/api/v1/repos/myoxus/myoxus/actions/jobs/1/rerun"]);
NODE

section "container registry contract"
cat >"$tmpdir/registry-valid.json" <<'JSON'
[
  {"type":"container","name":"myoxus","version":"1.2.3"},
  {"type":"container","name":"myoxus-web-frontend","version":"1.2.3"},
  {"type":"container","name":"myoxus-admin-frontend","version":"1.2.3"}
]
JSON
node build/scripts/ci/verify-container-registry-contract.mjs \
  --registry-host registry.example.invalid \
  --owner myoxus \
  --stage inventory \
  --inventory-file "$tmpdir/registry-valid.json" \
  --evidence "$tmpdir/registry-evidence.json" >/dev/null
test -s "$tmpdir/registry-evidence.json"
cat >"$tmpdir/registry-nested.json" <<'JSON'
[
  {"type":"container","name":"affine-fork/myoxus","version":"1.2.3"},
  {"type":"container","name":"myoxus-web-frontend","version":"1.2.3"},
  {"type":"container","name":"myoxus-admin-frontend","version":"1.2.3"}
]
JSON
expect_failure registry-nested-package \
  node build/scripts/ci/verify-container-registry-contract.mjs \
  --registry-host registry.example.invalid \
  --owner myoxus \
  --stage inventory \
  --inventory-file "$tmpdir/registry-nested.json" \
  --evidence "$tmpdir/registry-nested-evidence.json"
grep -q 'Nested container package names are forbidden' "$tmpdir/registry-nested-package.log"
expect_failure registry-repair-without-confirmation \
  env REGISTRY_USER=fixture REGISTRY_PASSWORD=fixture \
  node build/scripts/ci/repair-container-registry.mjs \
  --registry-host registry.example.invalid \
  --owner myoxus \
  --evidence "$tmpdir/registry-repair.json"
grep -q 'exact CONFIRM_REGISTRY_REPAIR value' "$tmpdir/registry-repair-without-confirmation.log"
node --input-type=module - <<'NODE'
import { selectRepairCandidates } from "./build/scripts/ci/repair-container-registry.mjs";

const pseudoVersion = `sha256:${"d".repeat(64)}`;
const inventory = [
  { type: "container", name: "myoxus", version: "0.39.0" },
  { type: "container", name: "myoxus", version: "wip" },
  { type: "container", name: "myoxus", version: "a".repeat(40) },
  { type: "container", name: "myoxus", version: pseudoVersion },
  { type: "container", name: "myoxus-web-frontend", version: "0.39.0" },
  { type: "container", name: "myoxus-admin-frontend", version: "0.39.0" },
];
const candidates = selectRepairCandidates(inventory);
if (candidates.length !== 1 || candidates[0]?.version !== pseudoVersion) {
  throw new Error(`repair allowlist selected unexpected entries: ${JSON.stringify(candidates)}`);
}
let rejectedUnexpectedPackage = false;
try {
  selectRepairCandidates([
    ...inventory,
    { type: "container", name: "nested/myoxus", version: pseudoVersion },
  ]);
} catch (error) {
  rejectedUnexpectedPackage = String(error).includes("unexpected packages");
}
if (!rejectedUnexpectedPackage) {
  throw new Error("repair allowlist accepted an unexpected package");
}
NODE

section "container digest promotion"
mkdir -p "$tmpdir/bin"
cat >"$tmpdir/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1 ${2:-} ${3:-}" = "buildx imagetools inspect" ]; then
  reference="${*: -1}"
  if [[ "$reference" == *":${FAKE_COMMIT}" ]]; then
    printf '"%s"\n' "$FAKE_SOURCE_DIGEST"
  elif [ -f "$FAKE_DOCKER_STATE" ]; then
    printf '"%s"\n' "$FAKE_SOURCE_DIGEST"
  elif [ -n "${FAKE_PREVIOUS_DIGEST:-}" ]; then
    printf '"%s"\n' "$FAKE_PREVIOUS_DIGEST"
  else
    exit 1
  fi
elif [ "$1" = "pull" ] || [ "$1" = "tag" ]; then
  :
elif [ "$1" = "push" ]; then
  : >"$FAKE_DOCKER_STATE"
elif [ "$1 ${2:-}" = "image rm" ]; then
  :
else
  echo "unexpected fake docker invocation: $*" >&2
  exit 2
fi
SH
chmod +x "$tmpdir/bin/docker"
fixture_commit="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
fixture_source_digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
fixture_previous_digest="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
promotion_env=(
  PATH="$tmpdir/bin:$PATH"
  IMAGE=myoxus
  TAG_PREFIX=registry.example.invalid/myoxus
  RELEASE_REF=1.2.3
  GITHUB_SHA="$fixture_commit"
  FAKE_COMMIT="$fixture_commit"
  FAKE_SOURCE_DIGEST="$fixture_source_digest"
  FAKE_DOCKER_STATE="$tmpdir/promotion-state"
)
expect_failure semantic-tag-collision \
  env "${promotion_env[@]}" FAKE_PREVIOUS_DIGEST="$fixture_previous_digest" \
  bash build/scripts/ci/promote-container-image.sh
grep -q 'Refusing to replace semantic tag' "$tmpdir/semantic-tag-collision.log"
test ! -e "$tmpdir/promotion-state"
expect_failure semantic-tag-wrong-repair-proof \
  env "${promotion_env[@]}" \
  FAKE_PREVIOUS_DIGEST="$fixture_previous_digest" \
  ALLOW_RELEASE_TAG_REPAIR=1.2.3 \
  REPAIR_EXPECTED_PREVIOUS_DIGEST="$fixture_source_digest" \
  bash build/scripts/ci/promote-container-image.sh
grep -q 'Refusing to replace semantic tag' "$tmpdir/semantic-tag-wrong-repair-proof.log"
test ! -e "$tmpdir/promotion-state"
env "${promotion_env[@]}" \
  FAKE_PREVIOUS_DIGEST="$fixture_previous_digest" \
  ALLOW_RELEASE_TAG_REPAIR=1.2.3 \
  REPAIR_EXPECTED_PREVIOUS_DIGEST="$fixture_previous_digest" \
  bash build/scripts/ci/promote-container-image.sh >/dev/null
test -e "$tmpdir/promotion-state"

section "desktop release ownership"
grep -q 'docker push "$commit_image"' build/scripts/ci/build-container-image.sh
! grep -q 'docker push "$release_image"' build/scripts/ci/build-container-image.sh
! grep -q 'verify-server-source-provenance' build/scripts/ci/build-container-image.sh
! grep -q 'verify-server-source-provenance' build/scripts/release/release-containers.sh
! grep -q 'build/scripts/test/run.sh' build/scripts/release/release-containers.sh
grep -q 'release-containers.sh' build/scripts/release/release.sh
grep -q 'release-clients.sh' build/scripts/release/release.sh
grep -q 'MYOXUS_FORGEJO_TOKEN' build/scripts/release/forgejo-client-release.mjs
grep -q 'release-desktop.yml' build/scripts/release/forgejo-client-release.mjs
test -f build/scripts/ci/publish-distribution-overview.mjs
grep -q 'publish-distribution-overview.mjs' \
  .forgejo/workflows/release-linux.yml \
  build/scripts/ci/publish-electron-release.mjs
grep -q 'const PLATFORMS = \["linux", "windows", "macos"\]' \
  build/scripts/release/forgejo-client-release.mjs
grep -q '\["clients"\]' build/scripts/release/forgejo-client-release.mjs
! grep -q 'release)' build/scripts/release/release.sh
! grep -Eq 'yarn (install|build)|docker (build|compose)|cargo (build|test|check)' \
  build/scripts/release/release.sh \
  build/scripts/release/release-clients.sh \
  build/scripts/release/forgejo-client-release.mjs \
  build/scripts/release/release-containers.sh
grep -q 'Accept and promote container images' .forgejo/workflows/release-linux.yml
! grep -Eq 'docker (build|buildx build)' \
  build/scripts/ci/accept-and-promote-container-images.sh \
  build/scripts/ci/promote-container-image.sh
! grep -q 'build_linux_packages' .forgejo/workflows/release-linux.yml
! grep -q 'release\.linux\.packages' .forgejo/workflows/release-linux.yml
! grep -q 'yarn install' .forgejo/workflows/release-linux.yml
! grep -q 'electron\.desktop-sbom' .forgejo/workflows/release-desktop.yml
grep -q 'Linux x64 package set on Debian CI' \
  .forgejo/workflows/release-desktop.yml
grep -q '"native:ensure"' client/apps/electron/scripts/stage-package.ts
grep -q 'unset GH_TOKEN GITHUB_TOKEN GITLAB_TOKEN' \
  build/scripts/ci/run-release-linux-packages.sh
grep -q 'reconcile-registry' .forgejo/workflows/release-linux.yml
grep -q 'reconcile-registry-\*)' build/scripts/ci/accept-and-promote-container-images.sh
grep -q 'github_sha="${GITHUB_REF_NAME#reconcile-registry-}"' \
  build/scripts/ci/accept-and-promote-container-images.sh

node - <<'NODE'
const { readFileSync } = require("node:fs");
const { parse } = require("yaml");

const suites = JSON.parse(
  readFileSync("build/test-matrix/suites.json", "utf8"),
);
const electronBaseline = suites.find(
  suite => suite.id === "electron.build.baseline",
);
const manifestGuardInvocations =
  electronBaseline?.command.match(
    /verify-electron-manifest-ownership\.mjs/g,
  ) ?? [];
if (manifestGuardInvocations.length !== 1) {
  throw new Error(
    `electron.build.baseline must invoke the manifest ownership guard exactly once; got ${manifestGuardInvocations.length}`,
  );
}
const dependencyHealth = suites.find(
  suite => suite.id === "dependency.health",
);
if (
  dependencyHealth?.blocking_mode !== "blocking" ||
  dependencyHealth.command !==
    "bash build/scripts/ci/run-dependency-health-report.sh" ||
  !dependencyHealth.changed_path_selectors.includes(".yarnrc.yml")
) {
  throw new Error(
    "dependency.health must propagate hard release-closure policies while the wrapper absorbs unrelated report-only repository debt",
  );
}
const dependencyHealthRunner = readFileSync(
  "build/scripts/ci/run-dependency-health-report.sh",
  "utf8",
);
if (
  !dependencyHealthRunner.includes("AUDIT_MIN_SEVERITY=moderate") ||
  !dependencyHealthRunner.includes(
    'run_policy_step "General release dependency policy"',
  ) ||
  !dependencyHealthRunner.includes(
    'run_policy_step "Electron dependency policy"',
  )
) {
  throw new Error(
    "dependency health must retain Moderate+ Yarn findings while release-closure policies remain blocking",
  );
}
const dependencyWorkflowSource = readFileSync(
  ".forgejo/workflows/dependency-health.yml",
  "utf8",
);
const dependencyWorkflow = parse(dependencyWorkflowSource);
if (Object.keys(dependencyWorkflow.on).join() !== "workflow_dispatch") {
  throw new Error("Dependency builds/reports must be explicit, not repeated on source or timer events");
}
const pathRules = JSON.parse(
  readFileSync("build/test-matrix/path-rules.json", "utf8"),
);
const dependencyRule = pathRules.find(
  rule => rule.id === "electron-desktop-sbom",
);
if (
  !dependencyRule?.paths.includes(".yarnrc.yml") ||
  !dependencyRule?.select_suites.includes("electron.build.baseline") ||
  !dependencyRule.select_suites.includes("electron.desktop-sbom")
) {
  throw new Error(
    "root manifest and lockfile changes must select both Electron baseline and desktop SBOM contracts",
  );
}

const releaseLinuxSource = readFileSync(
  ".forgejo/workflows/release-linux.yml",
  "utf8",
);
const workflow = parse(releaseLinuxSource);
const expectedOciJobs = [
  "container-preflight",
  "server-image",
  "frontend-images",
  "container-acceptance",
];
const actualOciJobs = Object.keys(workflow.jobs).sort();
for (const job of ["server-image", "frontend-images"]) {
  if (workflow.jobs[job].needs !== "container-preflight") {
    throw new Error(`${job} must wait for the early dependency security gate`);
  }
}
const earlySecurity = workflow.jobs["container-preflight"].steps.find(
  step => String(step.run).includes("scan-server-dependencies.sh server/Cargo.lock"),
);
if (!earlySecurity || earlySecurity["continue-on-error"] || earlySecurity.if) {
  throw new Error("Every container preflight must block on vulnerable locked dependencies");
}
const preflightSteps = workflow.jobs["container-preflight"].steps;
const releasePolicy = preflightSteps.find(
  step => String(step.run).includes(
    "node build/scripts/ci/generate-security-policy.mjs --check",
  ),
);
if (!releasePolicy || releasePolicy["continue-on-error"] || releasePolicy.if ||
    preflightSteps.indexOf(releasePolicy) > preflightSteps.indexOf(earlySecurity)) {
  throw new Error("Release policy drift must block before the security scan and container builds");
}
if (
  actualOciJobs.length !== expectedOciJobs.length ||
  actualOciJobs.some((job, index) => job !== expectedOciJobs.toSorted()[index])
) {
  throw new Error(
    `release-linux.yml must contain only OCI jobs; got ${actualOciJobs.join(", ")}`,
  );
}
// Frontend SBOM tooling needs the locked dependencies, but OCI jobs must never
// execute the root postinstall or desktop builds on the host.
const installs = releaseLinuxSource.match(/^[ \t]*yarn install[^\n]*/gm) ?? [];
if (/electron|desktop/i.test(releaseLinuxSource) ||
    installs.some((line) => line.trim() !== "yarn install --immutable --mode=skip-build")) {
  throw new Error("release-linux.yml must not orchestrate desktop builds");
}
for (const job of ["container-preflight", "server-image", "frontend-images"]) {
  if (String(workflow.jobs[job].if).includes("reconcile-registry")) {
    throw new Error(`${job} must not run for registry-only reconciliation`);
  }
}
if (!String(workflow.jobs["container-acceptance"].if).includes("reconcile-registry")) {
  throw new Error("container acceptance does not own registry-only reconciliation");
}
const serverSteps = workflow.jobs["server-image"].steps;
const recoveryStep = serverSteps.find(
  step => step.name === "Resolve server source revision",
);
if (!recoveryStep || !String(recoveryStep.run).includes("git checkout --detach")) {
  throw new Error("server release recovery does not materialize the original source commit");
}
// Run the actual source-selection step: recovery retains its old source, while
// an explicit same-version correction must compile the selected current source.
const sourceSelectionFixture = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/myoxus-source-selection-`);
try {
  const fs = require("node:fs");
  fs.writeFileSync(`${sourceSelectionFixture}/git`, '#!/bin/sh\nif [ "$1" = rev-list ]; then printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi\n', { mode: 0o755 });
  for (const repair of ["", "0.41.38"]) {
    const envFile = `${sourceSelectionFixture}/environment`;
    fs.writeFileSync(envFile, "");
    const result = require("node:child_process").spawnSync("bash", ["-c", String(recoveryStep.run).replaceAll("${{ github.event_name }}", "workflow_dispatch")], {
      env: { ...process.env, PATH: `${sourceSelectionFixture}:${process.env.PATH}`, GITHUB_SHA: "b".repeat(40), GITHUB_ENV: envFile, RUNNER_TEMP: sourceSelectionFixture, SERVER_VERSION_INPUT: "0.41.38", PUBLISH_CONTAINERS_REQUESTED: "true", BUILD_FRONTENDS_REQUESTED: "false", REPAIR_RELEASE_VERSION_INPUT: repair },
      encoding: "utf8", timeout: 10000,
    });
    if (result.status !== 0 || !fs.readFileSync(envFile, "utf8").includes(`RELEASE_SOURCE_SHA=${(repair ? "b" : "a").repeat(40)}`)) {
      throw new Error(`Wrong source selected for repair=${repair}: ${result.stderr}`);
    }
  }
} finally {
  require("node:fs").rmSync(sourceSelectionFixture, { recursive: true, force: true });
}
const serverEvidenceStep = serverSteps.find(
  step => step.name === "Verify server provenance evidence",
);
const serverStageStep = serverSteps.find(
  step => step.name === "Stage server provenance evidence",
);
if (
  !String(serverEvidenceStep?.run).includes(
    "verify-container-build-evidence.mjs",
  ) ||
  !String(serverEvidenceStep?.run).includes("dist/container-build/server") ||
  !String(serverStageStep?.run).includes("server-container-provenance")
) {
  throw new Error(
    "Server OCI evidence is not verified and staged from its role directory",
  );
}
const frontendSteps = workflow.jobs["frontend-images"].steps;
const frontendEvidenceSteps = frontendSteps.filter(
  step => step.name === "Verify frontend provenance evidence",
);
const frontendStageSteps = frontendSteps.filter(
  step => step.name === "Stage frontend provenance evidence",
);
if (frontendEvidenceSteps.length !== 1 || frontendStageSteps.length !== 1) {
  throw new Error("Frontend OCI matrix must verify and stage evidence exactly once");
}
const frontendEvidenceRun = String(frontendEvidenceSteps[0].run);
const frontendStageRun = String(frontendStageSteps[0].run);
for (const requiredAnchor of [
  "dist/container-build/$ARTIFACT",
  "verify-container-build-evidence.mjs",
  "verify-artifact-manifest.sh",
  "verify-sha256sums.sh",
]) {
  if (!frontendEvidenceRun.includes(requiredAnchor)) {
    throw new Error(`Frontend OCI evidence step is missing ${requiredAnchor}`);
  }
}
for (const requiredAnchor of [
  "dist/container-build/$ARTIFACT",
  "web-frontend-container-provenance",
  "admin-frontend-container-provenance",
]) {
  if (!frontendStageRun.includes(requiredAnchor)) {
    throw new Error(`Frontend OCI staging step is missing ${requiredAnchor}`);
  }
}
for (const artifactKind of [
  "server-container-provenance",
  "web-frontend-container-provenance",
  "admin-frontend-container-provenance",
]) {
  const occurrences =
    releaseLinuxSource.match(new RegExp(artifactKind, "g"))?.length ?? 0;
  if (occurrences !== 1) {
    throw new Error(
      `release-linux.yml must stage ${artifactKind} exactly once; got ${occurrences}`,
    );
  }
}
const desktopWorkflow = parse(
  readFileSync(".forgejo/workflows/release-desktop.yml", "utf8"),
);
const desktopPreflightRuns = desktopWorkflow.jobs["contract-preflight"].steps
  .map(step => String(step.run ?? ""))
  .join("\n");
const dependencyPolicyInvocations =
  desktopPreflightRuns.match(/verify-electron-dependency-policy\.mjs/g) ?? [];
if (dependencyPolicyInvocations.length !== 1) {
  throw new Error(
    `Desktop preflight must invoke the Electron dependency policy exactly once; got ${dependencyPolicyInvocations.length}`,
  );
}
const linuxJob = desktopWorkflow.jobs["linux-packages"];
if (!linuxJob) {
  throw new Error("release-desktop.yml must own the Linux package build");
}
if (
  JSON.stringify(linuxJob["runs-on"]) !==
    JSON.stringify(["self-hosted", "linux", "x64", "ci-build"])
) {
  throw new Error("Linux packages must run on the generic Debian ci-build runner");
}
const linuxRuns = linuxJob.steps
  .map(step => String(step.run ?? ""))
  .join("\n");
const linuxBuildStep = linuxJob.steps.find(
  step => step.name === "Build the complete Linux package set once",
);
if (
  !linuxRuns.includes("--suite release.linux.packages --strict") ||
  linuxBuildStep?.env?.LINUX_TARGETS !== "deb,rpm,flatpak"
) {
  throw new Error("Debian Linux build does not invoke the complete package suite");
}
if (linuxRuns.includes("yarn install")) {
  throw new Error("Desktop Linux job must not install before its owning wrapper");
}
const linuxWrapperSource = readFileSync(
  "build/scripts/ci/run-release-linux-packages.sh",
  "utf8",
);
const linuxInstallIndex = linuxWrapperSource.indexOf("yarn install --immutable");
const linuxPlaywrightIndex = linuxWrapperSource.indexOf(
  "yarn playwright install chromium",
);
const linuxPreinstallIndex = linuxWrapperSource.indexOf("yarn run preinstall");
if (
  linuxInstallIndex === -1 ||
  linuxPlaywrightIndex === -1 ||
  linuxPreinstallIndex === -1 ||
  linuxInstallIndex > linuxPlaywrightIndex ||
  linuxPlaywrightIndex > linuxPreinstallIndex
) {
  throw new Error(
    "The Linux package owner must materialize Yarn state and pinned Chromium before invoking package scripts",
  );
}
const scopeInput = desktopWorkflow.on?.workflow_dispatch?.inputs?.scope;
if (
  scopeInput?.default !== "full" ||
  JSON.stringify(scopeInput.options) !==
    JSON.stringify(["full", "clients", "linux", "windows", "macos"])
) {
  throw new Error(
    "Desktop release scope must be exactly full, clients, linux, windows, or macos",
  );
}
for (const job of [
  "macos-unsigned-test",
  "macos-update-e2e",
  "macos-packages",
  "windows-unsigned-test",
  "windows-update-e2e",
  "aggregate-release",
]) {
  if (!String(desktopWorkflow.jobs[job]?.if).includes("inputs.scope == 'full'")) {
    throw new Error(`${job} must remain exclusive to the full signed release`);
  }
}
const windowsJob = desktopWorkflow.jobs["windows-packages"];
const windowsCondition = String(windowsJob?.if);
const windowsPowerShellShell =
  "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& ([ScriptBlock]::Create([IO.File]::ReadAllText('{0}')))\"";
const windowsToolchain =
  ". ./build/scripts/ci/verify-windows-electron-toolchain.ps1";
if (
  !windowsCondition.includes("inputs.scope == 'full'") ||
  !windowsCondition.includes("inputs.scope == 'clients'") ||
  !windowsCondition.includes("inputs.scope == 'windows'") ||
  JSON.stringify(windowsJob?.["runs-on"]) !==
    JSON.stringify(["self-hosted", "windows", "x64", "ci-build"])
) {
  throw new Error("The Windows owner must serve full and platform client releases on ci-build");
}
if (
  windowsJob.steps.some(
    step =>
      String(step.shell ?? "") === "pwsh" ||
      (String(step.shell ?? "").startsWith("powershell") &&
        String(step.shell) !== windowsPowerShellShell),
  )
) {
  throw new Error(
    "Windows release steps must use the installed Windows PowerShell with process-scoped execution-policy bypass",
  );
}
const windowsStep = name =>
  windowsJob.steps.find(candidate => candidate.name === name);
for (const signedStep of [
  "Import the workflow-scoped signing certificate",
  "Build and Authenticode-sign NSIS, ZIP, and contained executables",
]) {
  if (String(windowsStep(signedStep)?.if) !== "${{ inputs.scope == 'full' }}") {
    throw new Error(`${signedStep} must remain exclusive to the full signed release`);
  }
}
if (
  String(windowsStep("Build Windows NSIS and ZIP once")?.if) !==
  "${{ inputs.scope == 'clients' || inputs.scope == 'windows' }}"
) {
  throw new Error("Normal Windows publication must reuse the existing unsigned package path");
}
for (const removed of [
  "aggregate-linux-release",
  "publish-linux-release",
  "aggregate-windows-release",
  "publish-windows-release",
]) {
  if (desktopWorkflow.jobs[removed]) {
    throw new Error(`${removed} must not reintroduce a candidate/publication handoff`);
  }
}
const windowsRuns = windowsJob.steps
  .map(step => String(step.run ?? ""))
  .join("\n");
if (
  !windowsRuns.includes(windowsToolchain) ||
  !windowsRuns.includes("yarn playwright install chromium") ||
  !windowsRuns.includes("--scope windows") ||
  !windowsRuns.includes("--require-publishable") ||
  !windowsRuns.includes("publish-electron-release.mjs") ||
  !windowsRuns.includes("Windows NSIS install failed")
) {
  throw new Error("Windows client release lacks its single build, install, metadata, or publisher path");
}
const packagingWorkflow = parse(readFileSync(
  ".forgejo/workflows/electron-packaging.yml",
  "utf8",
));
const macLabels = ["self-hosted", "macos", "x64", "electron-macos-x64"];
if (packagingWorkflow.concurrency?.["cancel-in-progress"] !== false ||
    packagingWorkflow.concurrency?.group !== "${{ github.workflow }}-${{ github.ref }}") {
  throw new Error("Packaging workflows must queue per branch without canceling active native builds");
}
for (const filename of [".forgejo/workflows/electron-packaging.yml", ".forgejo/workflows/release-desktop.yml", ".forgejo/workflows/graphql-codegen.yml", "build/scripts/ci/verify-macos-electron-toolchain.sh"]) {
  const source = readFileSync(filename, "utf8");
  if (/electron-macos-\d|sw_vers[^\n]*(?:=|test|grep)/.test(source)) {
    throw new Error(`${filename} must not impose an exact macOS release`);
  }
}
for (const [name, job] of Object.entries(desktopWorkflow.jobs).filter(([name]) => name.startsWith("macos-"))) {
  if (JSON.stringify(job["runs-on"]) !== JSON.stringify(macLabels)) {
    throw new Error(`${name} must run on the actual x64 macOS host`);
  }
  if (name !== "macos-packages" && JSON.stringify(job.strategy?.matrix ?? {}).includes("arm64")) {
    throw new Error(`${name} must not claim native ARM64 execution on x64`);
  }
}
const macPackage = packagingWorkflow.jobs["macos-package"];
for (const job of [macPackage, desktopWorkflow.jobs["macos-packages"], desktopWorkflow.jobs["macos-unsigned-test"]].filter(Boolean)) {
  if (!job.steps.some(step => String(step.run ?? "").includes("verify-macos-packaging-artifacts.sh"))) {
    throw new Error("macOS packaging must validate the relocated ZIP and DMG, not only the source application");
  }
}
if (JSON.stringify(macPackage["runs-on"]) !== JSON.stringify(macLabels) ||
    JSON.stringify(macPackage.strategy.matrix.arch) !== JSON.stringify(["x64", "arm64"])) {
  throw new Error("macOS packaging must build both targets on x64");
}
const signedMac = desktopWorkflow.jobs["macos-packages"];
const nativeMacTest = macPackage.steps.find(step => step.name === "Run native x64 Electron tests");
if (nativeMacTest?.if !== "${{ matrix.arch == 'x64' }}" ||
    nativeMacTest.env?.CARGO_BUILD_TARGET !== "x86_64-apple-darwin" ||
    nativeMacTest.run !== "build/scripts/test/run.sh --suite electron.vitest --strict") {
  throw new Error("macOS native Electron tests must use the matrix suite only on x64");
}
const nativeStep = signedMac.steps.find(step => step.name === "Install DMG and ZIP independently and run the signed runtime gate");
const crossStep = signedMac.steps.find(step => String(step.run ?? "").includes("macos-build-only-evidence.mjs"));
if (nativeStep.if !== "${{ matrix.arch == 'x64' }}" || crossStep.if !== "${{ matrix.arch == 'arm64' }}") {
  throw new Error("Runtime and ARM64 build-only evidence must have distinct architecture gates");
}
if (
  JSON.stringify(packagingWorkflow.jobs?.["windows-package"]?.["runs-on"]) !==
    JSON.stringify(["self-hosted", "windows", "x64", "ci-build"])
) {
  throw new Error("The existing Windows packaging CI must use the registered ci-build runner");
}
if (
  packagingWorkflow.jobs?.["windows-package"]?.steps?.some(
    step =>
      String(step.shell ?? "") === "pwsh" ||
      (String(step.shell ?? "").startsWith("powershell") &&
        String(step.shell) !== windowsPowerShellShell),
  )
) {
  throw new Error(
    "The existing Windows packaging CI must use the runner-compatible Windows PowerShell invocation",
  );
}
const packagingWindowsRuns = packagingWorkflow.jobs["windows-package"].steps
  .map(step => String(step.run ?? ""))
  .join("\n");
if (
  !packagingWindowsRuns.includes(windowsToolchain) ||
  !packagingWindowsRuns.includes("yarn playwright install chromium")
) {
  throw new Error(
    "The existing Windows packaging CI must materialize native and browser build inputs",
  );
}
const windowsToolchainSource = readFileSync(
  "build/scripts/ci/verify-windows-electron-toolchain.ps1",
  "utf8",
);
for (const required of [
  'Join-Path $env:USERPROFILE ".cargo"',
  "rustup/archive/$rustupVersion/x86_64-pc-windows-msvc/rustup-init.exe",
  "86478e53f769379d7f0ebfa7c9aa97cb76ca92233f79aa2cc0dbee2efaac73c7",
  "--no-modify-path --profile minimal --default-toolchain none",
  "rustup toolchain install stable --profile minimal",
  "--manifest-path client/libs/local-store/Cargo.toml",
]) {
  if (!windowsToolchainSource.includes(required)) {
    throw new Error(`Windows Electron toolchain contract is missing: ${required}`);
  }
}
const linuxInstall = desktopWorkflow.jobs["linux-install"];
const linuxPublish = desktopWorkflow.jobs["linux-publish"];
const linuxPublishRuns = linuxPublish?.steps.map(step => String(step.run ?? "")).join("\n") ?? "";
const installRuns = linuxInstall?.steps.map(step => String(step.run ?? "")).join("\n") ?? "";
const packageArtifact = "linux-client-packages";
if (
  !linuxRuns.includes("--require-publishable") ||
  linuxRuns.includes("publish-electron-release.mjs") ||
  linuxInstall?.needs !== "linux-packages" ||
  JSON.stringify(linuxInstall?.strategy?.matrix?.include) !== JSON.stringify([
    { format: "deb", runner: "electron-ubuntu-24.04-x64" },
    { format: "rpm", runner: "electron-fedora-44-x64" },
  ]) ||
  JSON.stringify(linuxInstall?.["runs-on"]) !== JSON.stringify(["self-hosted", "linux", "x64", "${{ matrix.runner }}"]) ||
  JSON.stringify(linuxPublish?.needs) !== JSON.stringify(["linux-packages", "linux-install"]) ||
  !desktopWorkflow.jobs["aggregate-release"].needs.includes("linux-install") ||
  !installRuns.includes("flock -w 300 /var/lib/forgejo-runner/package-maintenance.lock") ||
  !installRuns.includes("verify-installed-linux-package.mjs") ||
  !linuxPublishRuns.includes("--require-publishable") ||
  !linuxPublishRuns.includes("publish-electron-release.mjs") ||
  /yarn|release\.linux\.packages|run-release-linux-packages/.test(installRuns + linuxPublishRuns)
) throw new Error("Linux release must build once, install on both dedicated runners and gate publication/aggregation");
if (String(linuxInstall.if) !== String(linuxJob.if) ||
    String(linuxPublish.if) !== "${{ inputs.scope == 'clients' || inputs.scope == 'linux' }}")
  throw new Error("Linux installation/publication scope routing regressed");
for (const [job, direction] of [[linuxJob, "upload"], [linuxInstall, "download"], [linuxPublish, "download"]]) {
  if (!job.steps.some(step => String(step.uses ?? "").includes(`${direction}-artifact@`) &&
      step.with?.name === packageArtifact && step.with?.path === (direction === "upload" ? "dist/release-linux/" : "dist/release-linux")))
    throw new Error(`Linux ${direction} must consume the same-run named package set`);
}
for (const stepName of [
  "Require the dedicated desktop product-flow environment",
  "Establish the operator-configured digest-bound shared exchange",
]) {
  const step = desktopWorkflow.jobs["contract-preflight"].steps.find(
    candidate => candidate.name === stepName,
  );
  if (String(step?.if) !== "${{ inputs.scope == 'full' }}") {
    throw new Error(`${stepName} must not block normal client releases`);
  }
}

const linuxWrapper = readFileSync(
  "build/scripts/ci/run-release-linux-packages.sh",
  "utf8",
);
const immutableInstalls = linuxWrapper.match(/yarn install --immutable/g) ?? [];
if (immutableInstalls.length !== 1) {
  throw new Error(
    `Linux package wrapper must install exactly once; got ${immutableInstalls.length}`,
  );
}
NODE

node --test build/scripts/ci/test-installed-linux-package.mjs

section "component release versions"
server_release="$(sed -n '/^  \[workspace.package\]$/,/^  \[/s/^  version = "\([^"]*\)"$/\1/p' server/Cargo.toml)"
frontend_release="$(node -p "require('./package.json').version")"
desktop_release="$(node -p "require('./client/apps/electron/package.json').version")"
node build/scripts/ci/verify-component-release-version.mjs \
  --component server \
  --release-ref "$server_release" >/dev/null
node build/scripts/ci/verify-component-release-version.mjs \
  --component frontends \
  --release-ref "$frontend_release" >/dev/null
node build/scripts/ci/verify-component-release-version.mjs \
  --component desktop \
  --release-ref "$desktop_release" >/dev/null
expect_failure frontend-release-version \
  node build/scripts/ci/verify-component-release-version.mjs \
  --component frontends \
  --release-ref 0.0.0-invalid
grep -q "does not match declared version ${frontend_release}" "$tmpdir/frontend-release-version.log"
expect_failure desktop-release-version \
  node build/scripts/ci/verify-component-release-version.mjs \
  --component desktop \
  --release-ref 0.0.0-invalid
grep -q "does not match declared version ${desktop_release}" "$tmpdir/desktop-release-version.log"

section "artifact staging"
mkdir -p "$tmpdir/source/sub"
printf 'report' >"$tmpdir/source/sub/report.txt"
CI_RUNNER_CACHE="$tmpdir/cache" \
  GITHUB_REPOSITORY=local/repo \
  GITHUB_RUN_NUMBER=7 \
  GITHUB_SHA=abc \
  bash build/scripts/ci/stage-runner-artifacts.sh "$tmpdir/source" dependency-health >/dev/null
test -f "$tmpdir/cache/artifacts/local/repo/dependency-health/7-abc/sub/report.txt"
mkdir -p "$tmpdir/empty-source"
expect_failure empty-stage bash build/scripts/ci/stage-runner-artifacts.sh "$tmpdir/empty-source"
grep -q 'No artifact files found' "$tmpdir/empty-stage.log"

section "artifact list CRLF normalization"
mkdir -p "$tmpdir/artifact-list" "$tmpdir/crlf-bin"
printf 'fixture' >"$tmpdir/artifact-list/report.txt"
cat >"$tmpdir/crlf-bin/sort" <<'EOF'
#!/usr/bin/env bash
while IFS= read -r line; do
  printf '%s\r\n' "$line"
done
EOF
chmod +x "$tmpdir/crlf-bin/sort"
PATH="$tmpdir/crlf-bin:$PATH" \
  bash build/scripts/ci/list-artifact-files.sh "$tmpdir/artifact-list" \
    >"$tmpdir/artifact-list.txt"
if grep -q $'\r' "$tmpdir/artifact-list.txt"; then
  echo "Artifact file listing retained a Windows CR delimiter" >&2
  exit 1
fi
grep -Fqx "$tmpdir/artifact-list/report.txt" "$tmpdir/artifact-list.txt"

section "empty Yarn audit output contract"
node build/scripts/ci/audit-gradle-locks-osv.mjs --self-test
mkdir -p "$tmpdir/audit-bin"
cat >"$tmpdir/audit-bin/yarn" <<'EOF'
#!/usr/bin/env bash
exit "${FAKE_YARN_AUDIT_EXIT:-0}"
EOF
chmod +x "$tmpdir/audit-bin/yarn"
PATH="$tmpdir/audit-bin:$PATH" \
  AUDIT_OUTPUT="$tmpdir/clean-yarn-audit.json" \
  bash build/scripts/ci/yarn-audit-local.sh >/dev/null
grep -q '"type":"audit-summary"' "$tmpdir/clean-yarn-audit.json"
grep -q '"result":"clean"' "$tmpdir/clean-yarn-audit.json"
expect_failure empty-yarn-audit-failure \
  env PATH="$tmpdir/audit-bin:$PATH" \
    FAKE_YARN_AUDIT_EXIT=2 \
    AUDIT_OUTPUT="$tmpdir/failed-yarn-audit.json" \
    bash build/scripts/ci/yarn-audit-local.sh
grep -q '^audit-command-failed-without-advisory-report: exit 2$' \
  "$tmpdir/failed-yarn-audit.json"

section "artifact directory preparation"
mkdir -p dist/ci/test-stale
printf 'stale' >dist/ci/test-stale/old.txt
bash build/scripts/ci/prepare-artifact-dir.sh dist/ci/test-stale
test -d dist/ci/test-stale
test ! -e dist/ci/test-stale/old.txt
rmdir dist/ci/test-stale
expect_failure refuse-clean bash build/scripts/ci/prepare-artifact-dir.sh "$tmpdir/refuse-clean"
grep -q 'Refusing to clean artifact directory outside dist/' "$tmpdir/refuse-clean.log"

section "runner cache env contract"
CI_RUNNER_CACHE=/var/cache/ci-runner \
  COREPACK_HOME=/var/cache/ci-runner/corepack \
  YARN_CACHE_FOLDER=/var/cache/ci-runner/yarn \
  CARGO_HOME=/var/cache/ci-runner/cargo \
  RUSTUP_HOME=/var/cache/ci-runner/rustup \
  ELECTRON_CACHE=/var/cache/ci-runner/electron \
  PLAYWRIGHT_BROWSERS_PATH=/var/cache/ci-runner/playwright \
  RUNNER_CACHE_WRITE_SMOKE=false \
  bash build/scripts/ci/verify-runner-cache-env.sh >/dev/null
expect_failure cache-env \
  env CI_RUNNER_CACHE=/tmp/ci-runner \
  RUNNER_CACHE_WRITE_SMOKE=false \
  bash build/scripts/ci/verify-runner-cache-env.sh

section "test quality ratchet"
cat >"$tmpdir/quality-ratchet-bad.diff" <<'EOF'
diff --git a/client/libs/core/src/example.spec.ts b/client/libs/core/src/example.spec.ts
--- a/client/libs/core/src/example.spec.ts
+++ b/client/libs/core/src/example.spec.ts
@@ -0,0 +1,3 @@
+test.skip('must not land', () => {});
+test.only('focused test must not land', () => {});
+expect(result).ok();
EOF
expect_failure quality-ratchet \
  node build/scripts/ci/audit-test-quality.mjs --ratchet --diff-file "$tmpdir/quality-ratchet-bad.diff"
grep -q 'test.skip' "$tmpdir/quality-ratchet.out"
grep -q 'test.only' "$tmpdir/quality-ratchet.out"
cat >"$tmpdir/quality-ratchet-report-only.diff" <<'EOF'
diff --git a/client/libs/core/src/example.spec.ts b/client/libs/core/src/example.spec.ts
--- a/client/libs/core/src/example.spec.ts
+++ b/client/libs/core/src/example.spec.ts
@@ -0,0 +1 @@
+expect(value).toBeTruthy();
EOF
node build/scripts/ci/audit-test-quality.mjs --ratchet --diff-file "$tmpdir/quality-ratchet-report-only.diff" >/dev/null
mkdir -p "$tmpdir/quality-budget-fixture/client/libs/core/src"
cat >"$tmpdir/quality-budget-fixture/client/libs/core/src/example.spec.ts" <<'EOF'
test('has a weak assertion for the budget fixture', () => {
  expect(value).toBeTruthy();
});
EOF
cat >"$tmpdir/quality-budget-fail.json" <<'EOF'
{
  "schema_version": 1,
  "policy": { "mode": "fixture" },
  "jsTs": {
    "domains": {
      "core-unit": {
        "test_only": 0,
        "test_skip": 0,
        "catch_null": 0,
        "truthy": 0,
        "bare_ok": 0
      }
    }
  }
}
EOF
expect_failure quality-budget \
  node build/scripts/ci/audit-test-quality.mjs \
    --check-budgets \
    --scan-root "$tmpdir/quality-budget-fixture/client" \
    --budget-file "$tmpdir/quality-budget-fail.json"
grep -q 'core-unit toBeTruthy' "$tmpdir/quality-budget.out"
cat >"$tmpdir/quality-budget-pass.json" <<'EOF'
{
  "schema_version": 1,
  "policy": { "mode": "fixture" },
  "jsTs": {
    "domains": {
      "core-unit": {
        "test_only": 0,
        "test_skip": 0,
        "catch_null": 0,
        "truthy": 1,
        "bare_ok": 0
      }
    }
  }
}
EOF
node build/scripts/ci/audit-test-quality.mjs \
  --check-budgets \
  --scan-root "$tmpdir/quality-budget-fixture/client" \
  --budget-file "$tmpdir/quality-budget-pass.json" >/dev/null

section "rust test quality ratchet"
cat >"$tmpdir/rust-quality-ratchet-bad.diff" <<'EOF'
diff --git a/server/crates/api/tests/example_test.rs b/server/crates/api/tests/example_test.rs
--- a/server/crates/api/tests/example_test.rs
+++ b/server/crates/api/tests/example_test.rs
@@ -0,0 +1,2 @@
+cleanup_test_data().await.ok();
+delete_rows().ok();
EOF
expect_failure rust-quality-ratchet \
  node build/scripts/test/rust-quality-ratchet.mjs --diff-file "$tmpdir/rust-quality-ratchet-bad.diff"
grep -q 'cleanup_test_data' "$tmpdir/rust-quality-ratchet.out"
cat >"$tmpdir/rust-quality-ratchet-allowed.diff" <<'EOF'
diff --git a/server/crates/api/tests/example_test.rs b/server/crates/api/tests/example_test.rs
--- a/server/crates/api/tests/example_test.rs
+++ b/server/crates/api/tests/example_test.rs
@@ -0,0 +1 @@
+cleanup_optional_rows().await.ok(); // myoxus-allow-cleanup-ok: optional rows may already be gone
EOF
node build/scripts/test/rust-quality-ratchet.mjs --diff-file "$tmpdir/rust-quality-ratchet-allowed.diff" >/dev/null
mkdir -p "$tmpdir/rust-budget-fixture/server/crates/api/tests"
cat >"$tmpdir/rust-budget-fixture/server/crates/api/tests/example_test.rs" <<'EOF'
#[test]
fn cleanup_fixture() {
    cleanup_rows().ok();
}
EOF
cat >"$tmpdir/rust-budget-fail.json" <<'EOF'
{
  "schema_version": 1,
  "policy": { "mode": "fixture" },
  "rust": {
    "crates": {
      "api": {
        "rust_cleanup_ok": 0
      }
    }
  }
}
EOF
expect_failure rust-quality-budget \
  node build/scripts/test/rust-quality-ratchet.mjs \
    --check-budgets \
    --scan-root "$tmpdir/rust-budget-fixture/server" \
    --budget-file "$tmpdir/rust-budget-fail.json"
grep -q 'api rust_cleanup_ok' "$tmpdir/rust-quality-budget.out"
cat >"$tmpdir/rust-budget-pass.json" <<'EOF'
{
  "schema_version": 1,
  "policy": { "mode": "fixture" },
  "rust": {
    "crates": {
      "api": {
        "rust_cleanup_ok": 1
      }
    }
  }
}
EOF
node build/scripts/test/rust-quality-ratchet.mjs \
  --check-budgets \
  --scan-root "$tmpdir/rust-budget-fixture/server" \
  --budget-file "$tmpdir/rust-budget-pass.json" >/dev/null

section "matrix changed tier filter"
build/scripts/test/run.sh \
  --files server/crates/api/src/graphql/schema.rs \
  --only-tier integration \
  --dry-run \
  --json >"$tmpdir/changed-integration-only.json"
node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const ids = data.selected.map((suite) => suite.id);
if (!ids.includes("api.integration.quick")) throw new Error("missing api.integration.quick");
if (ids.includes("server.rust.check")) throw new Error("server.rust.check leaked into integration-only selection");
if (!data.selected.every((suite) => suite.tier === "integration")) throw new Error("non-integration suite selected");
' "$tmpdir/changed-integration-only.json"
build/scripts/test/run.sh \
  --files server/crates/api/src/websocket/handlers/doc.rs \
  --only-tier integration \
  --dry-run \
  --json >"$tmpdir/sync-integration-only.json"
node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const ids = data.selected.map((suite) => suite.id);
if (!ids.includes("api.integration.quick")) throw new Error("sync change lost api.integration.quick");
if (!ids.includes("api.sync-load.protocol")) throw new Error("sync change lost api.sync-load.protocol");
if (!data.selected.every((suite) => suite.tier === "integration")) throw new Error("non-integration suite selected for sync change");
' "$tmpdir/sync-integration-only.json"
build/scripts/test/run.sh \
  --files server/crates/domain/src/lib.rs \
  --only-tier integration \
  --dry-run \
  --json >"$tmpdir/domain-integration-only.json"
node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expected = [
  "api.integration.quick", "server.auth.integration.quick",
  "server.config.integration.quick", "server.calendar.integration.quick",
  "server.git-sync.integration.quick", "server.organization.integration.quick",
  "server.documents.integration.quick", "server.storage.integration.quick",
];
require("node:assert/strict").deepEqual(data.selected.map(suite => suite.id).sort(), expected.sort());
' "$tmpdir/domain-integration-only.json"

section "release artifact manifest"
mkdir -p "$tmpdir/release/linux" "$tmpdir/release/sbom"
printf 'deb' >"$tmpdir/release/linux/myoxus-0.40.0-stable-linux-x64.deb"
printf 'rpm' >"$tmpdir/release/linux/myoxus-0.40.0-stable-linux-x64.rpm"
printf 'flatpak' >"$tmpdir/release/linux/myoxus-0.40.0-stable-linux-x64.flatpak"
cat >"$tmpdir/release/sbom/myoxus-desktop-0.40.0.cdx.json" <<'EOF'
{
  "bomFormat": "CycloneDX",
  "specVersion": "1.5",
  "version": 1,
  "metadata": { "component": { "type": "application", "name": "myoxus-desktop", "version": "0.40.0" } },
  "components": [
    { "type": "framework", "name": "electron", "version": "44.4.5" },
    { "type": "library", "name": "mediabunny", "version": "1.50.9" }
  ]
}
EOF
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/release"
grep -q 'linux/myoxus-0.40.0-stable-linux-x64.deb' "$tmpdir/release/ARTIFACTS.md"
grep -q 'sbom/myoxus-desktop-0.40.0.cdx.json' "$tmpdir/release/ARTIFACTS.md"
mkdir -p "$tmpdir/empty-artifacts"
expect_failure empty-artifacts bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/empty-artifacts"
grep -q 'No artifact files found' "$tmpdir/empty-artifacts.log"

section "release checksums"
mkdir -p "$tmpdir/release/linux/space dir"
printf 'deb2' >"$tmpdir/release/linux/space dir/app spaced.deb"
GITHUB_REPOSITORY=local/repo \
  GITHUB_RUN_NUMBER=7 \
  GITHUB_SHA=abc \
  GITHUB_REF_NAME=v1.2.3 \
  RELEASE_REF=v1.2.3 \
  bash build/scripts/ci/write-release-summary.sh "$tmpdir/release"
grep -q 'release ref: v1.2.3' "$tmpdir/release/RELEASE.md"
grep -q 'linux/myoxus-0.40.0-stable-linux-x64.deb' "$tmpdir/release/RELEASE.md"
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/release"
grep -q 'RELEASE.md' "$tmpdir/release/ARTIFACTS.md"
bash build/scripts/ci/verify-artifact-manifest.sh "$tmpdir/release" >/dev/null
cp "$tmpdir/release/ARTIFACTS.md" "$tmpdir/release/ARTIFACTS.partial.md"
printf 'missing' >"$tmpdir/release/linux/missing.deb"
expect_failure manifest bash build/scripts/ci/verify-artifact-manifest.sh "$tmpdir/release" ARTIFACTS.partial.md
grep -q 'Artifact manifest does not list' "$tmpdir/manifest.log"
rm "$tmpdir/release/linux/missing.deb" "$tmpdir/release/ARTIFACTS.partial.md"
bash build/scripts/ci/write-sha256sums.sh "$tmpdir/release"
grep -q 'linux/myoxus-0.40.0-stable-linux-x64.deb' "$tmpdir/release/SHA256SUMS"
grep -q 'linux/space dir/app spaced.deb' "$tmpdir/release/SHA256SUMS"
grep -q 'ARTIFACTS.md' "$tmpdir/release/SHA256SUMS"
bash build/scripts/ci/verify-sha256sums.sh "$tmpdir/release" >/dev/null
rm "$tmpdir/release/linux/space dir/app spaced.deb"
expect_failure invalid-release-epoch \
  env SOURCE_DATE_EPOCH=0junk \
  node build/scripts/ci/write-desktop-release-metadata.mjs \
    --release-dir "$tmpdir/release" \
    --version 0.40.0 \
    --channel stable \
    --scope linux \
    --source-commit 0000000000000000000000000000000000000000 \
    --sbom "$tmpdir/release/sbom/myoxus-desktop-0.40.0.cdx.json"
grep -q 'SOURCE_DATE_EPOCH must be a non-negative integer' \
  "$tmpdir/invalid-release-epoch.log"
SOURCE_DATE_EPOCH=0 node build/scripts/ci/write-desktop-release-metadata.mjs \
  --release-dir "$tmpdir/release" \
  --version 0.40.0 \
  --channel stable \
  --scope linux \
  --source-commit 0000000000000000000000000000000000000000 \
  --sbom "$tmpdir/release/sbom/myoxus-desktop-0.40.0.cdx.json"
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/release"
bash build/scripts/ci/write-sha256sums.sh "$tmpdir/release"
bash build/scripts/ci/verify-release-artifacts.sh "$tmpdir/release"
expect_failure linux-not-publishable \
  node build/scripts/ci/verify-desktop-release-metadata.mjs \
    --release-dir "$tmpdir/release" \
    --require-publishable
grep -q 'Desktop release is not publishable' \
  "$tmpdir/linux-not-publishable.log"
SOURCE_DATE_EPOCH=0 node build/scripts/ci/write-desktop-release-metadata.mjs \
  --release-dir "$tmpdir/release" \
  --version 0.40.0 \
  --channel stable \
  --scope linux \
  --source-commit 0000000000000000000000000000000000000000 \
  --source-repository myoxus/myoxus \
  --builder-id https://git.blume29.de/myoxus/myoxus/actions/runs/41 \
  --run-id 41 \
  --sbom "$tmpdir/release/sbom/myoxus-desktop-0.40.0.cdx.json"
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/release"
bash build/scripts/ci/write-sha256sums.sh "$tmpdir/release"
node build/scripts/ci/verify-desktop-release-metadata.mjs \
  --release-dir "$tmpdir/release" \
  --require-publishable
cp "$tmpdir/release/desktop-release.json" \
  "$tmpdir/release/desktop-release.valid.json"
jq '.artifacts[0].platform = "windows"' \
  "$tmpdir/release/desktop-release.valid.json" \
  >"$tmpdir/release/desktop-release.json"
expect_failure release-identity-tamper \
  node build/scripts/ci/verify-desktop-release-metadata.mjs \
    --release-dir "$tmpdir/release"
grep -q 'identity fields disagree' "$tmpdir/release-identity-tamper.log"
mv "$tmpdir/release/desktop-release.valid.json" \
  "$tmpdir/release/desktop-release.json"
printf 'tamper' >>"$tmpdir/release/linux/myoxus-0.40.0-stable-linux-x64.deb"
expect_failure tamper bash build/scripts/ci/verify-sha256sums.sh "$tmpdir/release"

section "Windows release artifact contract without POSIX find"
bash build/scripts/ci/test-windows-release-contract.sh

section "Linux package collection"
mkdir -p "$tmpdir/electron-out"/{deb,rpm,flatpak} "$tmpdir/collected"
printf 'stale' >"$tmpdir/electron-out/stale.deb"
printf 'deb' >"$tmpdir/electron-out/deb/app.deb"
printf 'rpm' >"$tmpdir/electron-out/rpm/app.rpm"
printf 'flatpak' >"$tmpdir/electron-out/flatpak/app.flatpak"
bash build/scripts/ci/collect-linux-packages.sh "$tmpdir/electron-out" "$tmpdir/collected" >/dev/null
test -f "$tmpdir/collected/app.deb"
test -f "$tmpdir/collected/app.rpm"
test -f "$tmpdir/collected/app.flatpak"
test "$(cat "$tmpdir/collected/app.deb")" = 'deb'
mkdir -p "$tmpdir/incomplete-electron-out/deb" "$tmpdir/incomplete-collected"
printf 'deb' >"$tmpdir/incomplete-electron-out/deb/app.deb"
expect_failure incomplete-collect bash build/scripts/ci/collect-linux-packages.sh "$tmpdir/incomplete-electron-out" "$tmpdir/incomplete-collected"
grep -q 'Expected exactly one current rpm artifact' "$tmpdir/incomplete-collect.log"

section "native server build artifacts"
mkdir -p "$tmpdir/server/config" \
  "$tmpdir/server/templates/mail" \
  "$tmpdir/server/templates/features/base" \
  "$tmpdir/server/templates/databases" \
  "$tmpdir/server/templates/assistants" \
  "$tmpdir/server/templates/documents" \
  "$tmpdir/server/static/fonts" \
  "$tmpdir/server/static/icc" \
  "$tmpdir/ops/systemd" \
  "$tmpdir/server-target/release" \
  "$tmpdir/server-build/bundle/myoxus-server-linux-x64/bin"
printf '[workspace]\n' >"$tmpdir/server/Cargo.toml"
printf 'default' >"$tmpdir/server/config/default.yaml"
printf 'local example' >"$tmpdir/server/config/local.yaml.example"
printf 'feature' >"$tmpdir/server/config/features.user.yaml"
printf 'do-not-copy' >"$tmpdir/server/config/local.yaml"
printf 'mail' >"$tmpdir/server/templates/mail/sign-in.html"
printf 'native authoring only' >"$tmpdir/server/templates/databases/catalog.yaml"
printf 'native authoring only' >"$tmpdir/server/templates/assistants/catalog.yaml"
printf 'native authoring only' >"$tmpdir/server/templates/documents/source.zip"
printf '{}\n' >"$tmpdir/server/static/fonts/manifest.json"
printf 'icc' >"$tmpdir/server/static/icc/sRGB-v4.icc"
printf '[Service]\nExecStart=/usr/local/bin/myoxus-server\n' >"$tmpdir/ops/systemd/myoxus-api.service"
printf 'RUN_MODE=production\n' >"$tmpdir/ops/systemd/myoxus.env.example"
printf 'server' >"$tmpdir/server-target/release/server"
printf 'compiler' >"$tmpdir/server-target/release/myoxus-pdf-compiler"
# The compiled CLI is the native admission dependency. This bounded fixture
# emits real pinned ZIP/release files and checks their exact bytes on every read.
printf 'formatVersion: 1\n' >"$tmpdir/server/templates/features/base/manifest.yaml"
cat >"$tmpdir/server-target/release/myoxus-cli" <<'PYCLI'
#!/usr/bin/env python3
import hashlib, io, json, os, pathlib, sys, zipfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

def encoded(value):
    # JSON is a supported YAML subset; production bytes come from the native CLI.
    return (json.dumps(value, indent=2) + "\n").encode()

args = sys.argv[1:]
assert args[:2] == ["templates", "feature-bundle"], args
operation = args[2]
options = {}
i = 3
while i < len(args):
    option = args[i]
    if option == "--release-base":
        options[option] = True
        i += 1
    else:
        options[option] = args[i + 1]
        i += 2
root = pathlib.Path(options["--root"])
if operation == "pack":
    if os.environ.get("MOCK_FEATURE_PACK_FAILURE") == "1":
        sys.exit("explicit native Feature pack failure")
    assert options["--release-base"]
    assert (root / options["--manifest"]).is_file()
    output = pathlib.Path(options["--output"])
    core = b'format_version: 1\nid: myoxus.project.task-core\nversion: 1.0.0\nfields: []\nroles: []\n'
    manifest = {"formatVersion": 1, "id": "myoxus.features.base", "version": "1.0.0",
                "capabilities": {"database": 1},
                "components": [{"id": "core", "kind": "taskCore", "path": "native/core.yaml",
                                "sha256": digest(core), "nativeIdentity": {"id": "myoxus.project.task-core", "version": "1.0.0"}}],
                "files": {"native/core.yaml": digest(core)}, "links": [], "exports": []}
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in sorted({"manifest.yaml": encoded(manifest), "native/core.yaml": core}.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    archive_bytes = stream.getvalue()
    pin = {"id": "myoxus.features.base", "version": "1.0.0", "sha256": digest(archive_bytes)}
    release = encoded({"formatVersion": 1, "base": pin})
    write(output / "templates/features/myoxus.features.base/1.0.0.myoxus.zip", archive_bytes)
    write(output / "templates/features/catalog.yaml", encoded({"formatVersion": 1, "base": pin, "optional": [], "retained": []}))
    write(output / "templates/features/release.yaml", release)
    write(output / "static/features/release.yaml", release)
    # Reproduce the native packer's private output modes, including nested dirs.
    for feature_root in (output / "templates/features", output / "static/features"):
        for entry in feature_root.rglob("*"):
            entry.chmod(0o700 if entry.is_dir() else 0o600)
        feature_root.chmod(0o700)
elif operation == "validate-release":
    release_bytes = pathlib.Path(options["--release-manifest"]).read_bytes()
    assert release_bytes == (root / "features/release.yaml").read_bytes(), "independent release expectation differs"
    release = json.loads(release_bytes)
    catalog = json.loads((root / "features/catalog.yaml").read_bytes())
    assert release["formatVersion"] == catalog["formatVersion"] == 1
    assert release["base"] == catalog["base"], "release/catalog pin differs"
    pin = release["base"]
    archive_bytes = (root / "features" / pin["id"] / (pin["version"] + ".myoxus.zip")).read_bytes()
    assert digest(archive_bytes) == pin["sha256"], "Feature archive SHA mismatch"
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        manifest = json.loads(archive.read("manifest.yaml"))
        assert manifest["id"] == pin["id"] and manifest["version"] == pin["version"]
        assert set(archive.namelist()) == {"manifest.yaml", *manifest["files"]}
        for name, checksum in manifest["files"].items():
            assert digest(archive.read(name)) == checksum, "native file SHA mismatch"
else:
    sys.exit("unexpected native CLI invocation")
PYCLI
chmod +x "$tmpdir/server-target/release/server" "$tmpdir/server-target/release/myoxus-cli" "$tmpdir/server-target/release/myoxus-pdf-compiler"
server_bundle="$tmpdir/server-build/bundle/myoxus-server-linux-x64"
SERVER_BINARY_NAMES="server myoxus-cli myoxus-pdf-compiler" \
  SERVER_BINARY_RENAMES="server:myoxus-server" \
  bash build/scripts/ci/collect-server-binaries.sh \
    "$tmpdir/server" \
    "$tmpdir/server-target/release" \
    "$server_bundle/bin" >/dev/null
bash build/scripts/ci/collect-server-runtime-assets.sh \
  "$tmpdir/server" \
  "$tmpdir/ops" \
  "$server_bundle" \
  "$tmpdir/server-target/release/myoxus-cli" >/dev/null
test -s "$server_bundle/config/default.yaml"
test -s "$server_bundle/config/local.yaml.example"
test -s "$server_bundle/config/features.user.yaml"
test ! -e "$server_bundle/config/local.yaml"
test -s "$server_bundle/templates/mail/sign-in.html"
test -s "$server_bundle/static/fonts/manifest.json"
test -s "$server_bundle/static/icc/sRGB-v4.icc"
test -s "$server_bundle/templates/features/catalog.yaml"
test -s "$server_bundle/templates/features/myoxus.features.base/1.0.0.myoxus.zip"
cmp -s "$server_bundle/templates/features/release.yaml" "$server_bundle/static/features/release.yaml"
python3 - "$server_bundle" <<'PY_FEATURE_MODES'
import pathlib, stat, sys
bundle = pathlib.Path(sys.argv[1])
for root in (bundle / "templates/features", bundle / "static/features"):
    for entry in (root, *root.rglob("*")):
        expected = 0o755 if entry.is_dir() else 0o644
        actual = stat.S_IMODE(entry.stat().st_mode)
        assert actual == expected, f"Packaged asset mode {oct(actual)} != {oct(expected)}: {entry}"
PY_FEATURE_MODES
for native_family in databases assistants documents; do
  test ! -e "$server_bundle/templates/$native_family"
done
expect_failure rejected-native-feature-pack env MOCK_FEATURE_PACK_FAILURE=1 \
  bash build/scripts/ci/collect-server-runtime-assets.sh \
    "$tmpdir/server" "$tmpdir/ops" "$tmpdir/rejected-server-bundle" \
    "$tmpdir/server-target/release/myoxus-cli"
grep -q 'explicit native Feature pack failure' "$tmpdir/rejected-native-feature-pack.log"
test ! -e "$tmpdir/rejected-server-bundle/templates/features/catalog.yaml"
feature_archive="$server_bundle/templates/features/myoxus.features.base/1.0.0.myoxus.zip"
cp "$feature_archive" "$tmpdir/original-feature.zip"
printf tampered >>"$feature_archive"
expect_failure tampered-native-feature-archive \
  bash build/scripts/ci/create-server-bundle-archive.sh \
    "$tmpdir/server-build/bundle" myoxus-server-linux-x64 "$tmpdir/rejected-archives"
grep -q 'Feature archive SHA mismatch' "$tmpdir/tampered-native-feature-archive.log"
cp "$tmpdir/original-feature.zip" "$feature_archive"
cp "$server_bundle/static/features/release.yaml" "$tmpdir/original-feature-release.yaml"
printf 'wrong independent expectation' >"$server_bundle/static/features/release.yaml"
expect_failure wrong-native-feature-expectation \
  bash build/scripts/ci/create-server-bundle-archive.sh \
    "$tmpdir/server-build/bundle" myoxus-server-linux-x64 "$tmpdir/rejected-archives"
grep -q 'independent release expectation differs' "$tmpdir/wrong-native-feature-expectation.log"
cp "$tmpdir/original-feature-release.yaml" "$server_bundle/static/features/release.yaml"
test -x "$server_bundle/bin/myoxus-server"
test -x "$server_bundle/bin/myoxus-cli"
test -x "$server_bundle/bin/myoxus-pdf-compiler"
server_revision="$(git rev-parse HEAD)"
server_epoch="$(git show -s --format=%ct "$server_revision")"
server_version="$(cargo metadata --manifest-path server/Cargo.toml --format-version=1 --no-deps | python3 -c 'import json,sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "myoxus-api"))')"
bash build/scripts/release/assemble-server-legal.sh \
  "$server_bundle/legal" \
  "$server_revision" \
  "$server_version" \
  "$server_epoch" >/dev/null
test -s "$server_bundle/legal/sbom/server.cdx.json"
expect_failure missing-server-binary \
  env SERVER_BINARY_NAMES="missing-server" \
    bash build/scripts/ci/collect-server-binaries.sh \
      "$tmpdir/server" \
      "$tmpdir/server-target/release" \
      "$server_bundle/bin"
grep -q 'Missing server binary' "$tmpdir/missing-server-binary.log"
bash build/scripts/ci/create-server-bundle-archive.sh \
  "$tmpdir/server-build/bundle" \
  myoxus-server-linux-x64 \
  "$tmpdir/server-build/archives" >/dev/null
find "$tmpdir/server-build/archives" -type f \( -name '*.tar.zst' -o -name '*.tar.gz' \) | grep -q .
mkdir -p "$tmpdir/server-build/packages/deb" "$tmpdir/server-build/packages/rpm"
if command -v dpkg-deb >/dev/null 2>&1 && command -v rpmbuild >/dev/null 2>&1; then
  bash build/scripts/ci/package-server-deb.sh \
    "$server_bundle" \
    "$tmpdir/server-build/packages/deb" \
    "0.30.0+test" \
    amd64 >/dev/null
  bash build/scripts/ci/package-server-rpm.sh \
    "$server_bundle" "$tmpdir/server-build/packages/rpm" "0.30.0+test" x86_64 >/dev/null
  verify_native_server_artifacts=true
else
  printf 'fake rpm fixture' >"$tmpdir/server-build/packages/rpm/myoxus-server-0.30.0+test-1.x86_64.rpm"
  printf 'fake deb fixture' >"$tmpdir/server-build/packages/deb/myoxus-server_0.30.0+test_amd64.deb"
  verify_native_server_artifacts=false
fi
GITHUB_REPOSITORY=local/repo \
  GITHUB_RUN_NUMBER=7 \
  GITHUB_SHA=abc \
  GITHUB_REF_NAME=wip \
  bash build/scripts/ci/write-server-build-summary.sh "$tmpdir/server-build"
grep -q 'bundle/myoxus-server-linux-x64/bin/myoxus-server' "$tmpdir/server-build/SERVER_BUILD.md"
grep -Fq -- '- sha: abc' "$tmpdir/server-build/SERVER_BUILD.md"
# The fixture above proves CI metadata precedence. Restore the local Git-derived
# identity before exercising the complete artifact verifier against local legal
# metadata.
bash build/scripts/ci/write-server-build-summary.sh "$tmpdir/server-build"
grep -Fq -- "- sha: $(git rev-parse HEAD)" "$tmpdir/server-build/SERVER_BUILD.md"
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/server-build"
bash build/scripts/ci/write-sha256sums.sh "$tmpdir/server-build"
if $verify_native_server_artifacts; then
  (
    relative_root=$(mktemp -d "$REPO_ROOT/output/native-server-fixture.XXXXXX")
    trap 'rm -rf "$relative_root"' EXIT
    ln -s "$tmpdir/server-build" "$relative_root/server-build"
    bash build/scripts/ci/verify-server-build-artifacts.sh "${relative_root#"$REPO_ROOT"/}/server-build"
  )
fi

section "dependency-health summary"
mkdir -p "$tmpdir/reports"
printf '{}\n' >"$tmpdir/reports/android-gradle-osv.json"
printf '{}\n' >"$tmpdir/reports/yarn-audit.json"
printf '{}\n' >"$tmpdir/reports/cargo-audit.json"
printf '{}\n' >"$tmpdir/reports/electron-cargo-audit.json"
printf '{}\n' >"$tmpdir/reports/electron-dependency-policy.json"
printf '{}\n' >"$tmpdir/reports/release-dependency-policy.json"
printf '# Duplicate dependency report\n' >"$tmpdir/reports/dep-duplicates-report.md"
printf 'Yjs compatibility PASS\n' >"$tmpdir/reports/yjs-compat.log"
cp docs/provenance-inventory.md "$tmpdir/reports/provenance-inventory.md"
bash build/scripts/ci/write-dependency-health-summary.sh "$tmpdir/reports" docs/provenance-inventory.md
bash build/scripts/ci/write-artifact-manifest.sh "$tmpdir/reports"
bash build/scripts/ci/verify-artifact-manifest.sh "$tmpdir/reports" >/dev/null
bash build/scripts/ci/verify-dependency-health-artifacts.sh "$tmpdir/reports"
grep -q 'yarn-audit.json' "$tmpdir/reports/summary.md"
grep -q 'release-blocking markers:' "$tmpdir/reports/summary.md"
grep -Fq -- "- commit: $(git rev-parse HEAD)" "$tmpdir/reports/summary.md"
for lockfile in yarn.lock Cargo.lock server/Cargo.lock; do
  lock_digest="$(sha256sum "$lockfile" | cut -d' ' -f1)"
  grep -Fq "| \`$lockfile\` | \`$lock_digest\` |" "$tmpdir/reports/summary.md"
done

section "cache prune dry-run"
maintenance_workflow=".forgejo/workflows/runner-maintenance.yml"
grep -Fq 'timeout-minutes: 120' "$maintenance_workflow"
grep -Fq 'SCHEDULED_BUILDX_MAX_USED_SPACE: "64gb"' "$maintenance_workflow"
grep -Fq 'SCHEDULED_BUILDX_MIN_FREE_SPACE: "64gb"' "$maintenance_workflow"
grep -Fq -- '--max-used-space "$SCHEDULED_BUILDX_MAX_USED_SPACE"' "$maintenance_workflow"
grep -Fq -- '--min-free-space "$SCHEDULED_BUILDX_MIN_FREE_SPACE"' "$maintenance_workflow"
grep -Fq -- '--keep-storage "$SCHEDULED_BUILDER_KEEP_STORAGE"' "$maintenance_workflow"
grep -Fq 'SCHEDULED_IMAGE_RETENTION_HOURS: "24"' "$maintenance_workflow"
! grep -Fq 'SCHEDULED_DOCKER_RETENTION_HOURS: "168"' "$maintenance_workflow"
mkdir -p \
  "$tmpdir/runner-cache/artifacts/owner/repo/report/old-run" \
  "$tmpdir/runner-cache/buildkit/old" \
  "$tmpdir/runner-cache/buildkit/web-frontend" \
  "$tmpdir/runner-cache/buildkit/current"
touch -t 202001010000 \
  "$tmpdir/runner-cache/artifacts/owner/repo/report/old-run" \
  "$tmpdir/runner-cache/buildkit/web-frontend"
bash build/scripts/ci/prune-ci-runner-cache.sh \
  --cache-root "$tmpdir/runner-cache" \
  --dry-run \
  --days 1 >"$tmpdir/prune.log"
grep -q '/artifacts/owner/repo/report/old-run' "$tmpdir/prune.log"
grep -q '/buildkit/web-frontend' "$tmpdir/prune.log"
! grep -q '/buildkit/old' "$tmpdir/prune.log"
! grep -q '/buildkit/current' "$tmpdir/prune.log"
bash build/scripts/ci/prune-ci-runner-cache.sh \
  --cache-root "$tmpdir/runner-cache" \
  --dry-run \
  --buildkit-all \
  --days 1 >"$tmpdir/prune-all.log"
grep -q '/buildkit/web-frontend' "$tmpdir/prune-all.log"
! grep -q '/buildkit/current' "$tmpdir/prune-all.log"
expect_failure unsafe-cache-root \
  bash build/scripts/ci/prune-ci-runner-cache.sh --cache-root /var/cache --apply

node --test build/scripts/ci/test-macos-build-only.mjs build/scripts/ci/test-macos-bundle-closure.mjs
node --test build/scripts/ci/test-macos-client-release.mjs
echo "CI helper fixture tests passed."
