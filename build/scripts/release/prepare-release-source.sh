#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

# One qualified source projection per immutable build, shared by both OCI jobs.
# This lock covers metadata publication only, never compilation or packaging.
revision="${SOURCE_REVISION:-${GITHUB_SHA:?}}"
if [ -n "${SOURCE_TAG:-}" ]; then
  git fetch origin "refs/tags/$SOURCE_TAG:refs/tags/$SOURCE_TAG"
  revision="$(git rev-list -n 1 "$SOURCE_TAG")"
fi
version="${SOURCE_VERSION:-$(node -p 'require("./package.json").version')}"
[[ "$revision" =~ ^[0-9a-f]{40}$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
root="${CI_RUNNER_CACHE:-/var/cache/ci-runner}/artifacts/${GITHUB_REPOSITORY:?}/public-source"
mkdir -p "$root"
exec 9>"$root/.lock"
flock 9
candidate="$root/$revision"
report="$candidate/source-correspondence.json"
if [ -n "${SOURCE_TAG:-}" ] && [ ! -f "$report" ]; then
  # Recovery must never roll public main back to an older source snapshot.
  mkdir -p "$candidate"
  curl --fail --silent --show-error --max-time 30 \
    "https://git.blume29.de/api/packages/myoxus/generic/myoxus-source/$version-$revision/source-correspondence.json" -o "$report"
  node --input-type=module - "$report" "$revision" <<'JS'
import {readSourceProvenance} from './build/scripts/release/source-correspondence.mjs';
readSourceProvenance(process.argv[2], process.argv[3]);
JS
fi
if [ ! -f "$report" ]; then
  parent="$(git ls-remote https://github.com/superions/myoxus.git refs/heads/main | cut -f1)"
  if [ ! -f "$candidate/candidate-identities.txt" ]; then
    if [ -d "$candidate" ]; then
      mv "$candidate" "$(mktemp -d "$root/.incomplete-$revision.XXXXXX")/preparation"
    fi
    build/scripts/release/publish-github-mirror.sh prepare \
      --revision "$revision" --expected-parent "$parent" --workdir "$candidate"
  fi
  # Values are produced by the existing helper and validated again by publish.
  source "$candidate/candidate-identities.txt"
  if [ "$(git ls-remote https://github.com/superions/myoxus.git refs/heads/main | cut -f1)" != "$candidate_commit" ]; then
    build/scripts/release/publish-github-mirror.sh publish --workdir "$candidate" \
    --expected-source "$source_revision" --expected-parent "$public_parent" \
    --expected-commit "$candidate_commit" --expected-tree "$candidate_tree" \
    --expected-archive-sha256 "$archive_sha256" --expected-manifest-sha256 "$manifest_sha256" \
    --expected-settings-sha256 "$settings_sha256"
  fi
  node --input-type=module - "$candidate" "$revision" <<'JS'
import fs from 'node:fs';
import {validatePublicSource} from './build/scripts/release/source-correspondence.mjs';
const [dir, revision] = process.argv.slice(2);
const ids = Object.fromEntries(fs.readFileSync(`${dir}/candidate-identities.txt`, 'utf8').trim().split('\n').map(l => l.split('=')));
const publicSource = validatePublicSource(revision, {repository:'https://github.com/superions/myoxus', commit:ids.candidate_commit, tree:ids.candidate_tree});
const inventoryPolicyRevision = process.env.MYOXUS_SOURCE_INVENTORY_POLICY_REVISION;
fs.writeFileSync(`${dir}/source-correspondence.json`, JSON.stringify({schemaVersion:1,revision,publicSource,...(inventoryPolicyRevision ? {inventoryPolicyRevision} : {})},null,2)+'\n');
JS
fi
url="https://git.blume29.de/api/packages/myoxus/generic/myoxus-source/$version-$revision/source-correspondence.json"
sha="$(sha256sum "$report" | cut -d' ' -f1)"
if ! curl --fail --silent --show-error --max-time 30 "$url" -o "$candidate/published-correspondence.json"; then
  node -e 'const e=process.env; const auth=e.FORGEJO_PACKAGE_USER && e.FORGEJO_PACKAGE_PASSWORD ? "Basic "+Buffer.from(e.FORGEJO_PACKAGE_USER+":"+e.FORGEJO_PACKAGE_PASSWORD).toString("base64") : "token "+e.FORGEJO_PACKAGE_TOKEN; process.stdout.write("header = \"Authorization: "+auth+"\"\n")' |
    curl --config - --fail --silent --show-error --max-time 60 --upload-file "$report" "$url"
  curl --fail --silent --show-error --max-time 30 "$url" -o "$candidate/published-correspondence.json"
fi
test "$(sha256sum "$candidate/published-correspondence.json" | cut -d' ' -f1)" = "$sha"
{
  echo "source_url=$url"
  echo "source_sha256=$sha"
} >>"${GITHUB_OUTPUT:?}"
