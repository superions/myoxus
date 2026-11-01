#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "Usage: $0 <image> <git-revision> <output-dir> [--require-registry-digest]" >&2
  exit 2
fi

image="$1"
revision="$2"
output_dir="$3"
require_registry_digest=false
if [ "${4:-}" = "--require-registry-digest" ]; then
  require_registry_digest=true
elif [ $# -eq 4 ]; then
  echo "Unknown option: $4" >&2
  exit 2
fi

work_dir="$(mktemp -d)"
container_id=""
cleanup() {
  [ -z "$container_id" ] || docker rm -f "$container_id" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$output_dir"
docker image inspect "$image" > "$work_dir/image-inspect.json"
container_id="$(docker create "$image" /__myoxus_legal_inspection__)"
docker cp "$container_id:/usr/share/doc/myoxus-server" "$work_dir/legal"
docker rm "$container_id" >/dev/null
container_id=""

for relative_path in LICENSE THIRD_PARTY_NOTICES.md SOURCE.md provenance/components.json sbom/server.cdx.json os-packages.tsv; do
  test -s "$work_dir/legal/$relative_path"
done
cmp -s LICENSE "$work_dir/legal/LICENSE"
cmp -s server/provenance/components.json "$work_dir/legal/provenance/components.json"
cmp -s build/dependencies/paste-consumers-source.json "$work_dir/legal/provenance/paste-consumers-source.json"
for package in biblatex hayagriva; do
  cmp -s "vendor/cargo/$package/LICENSE-MIT" "$work_dir/legal/licenses/$package/LICENSE-MIT"
  cmp -s "vendor/cargo/$package/LICENSE-APACHE" "$work_dir/legal/licenses/$package/LICENSE-APACHE"
done
cmp -s vendor/cargo/hayagriva/NOTICE "$work_dir/legal/licenses/hayagriva/NOTICE"
cmp -s vendor/cargo/simba/LICENSE "$work_dir/legal/licenses/simba/LICENSE"
cmp -s build/dependencies/safer-bytes-license.txt "$work_dir/legal/licenses/safer-bytes/DECLARED-MIT.txt"
grep -Fq "Git revision: \`$revision\`" "$work_dir/legal/SOURCE.md"
# A retained image must carry the requested mapping too; adding references only
# to a new outer SBOM cannot repair an older image's embedded legal bundle.
node --input-type=module - "$work_dir/legal" "$revision" <<'NODE'
import { readFileSync } from "node:fs";
import { readSourceProvenance, publicSourceReferences } from "./build/scripts/release/source-correspondence.mjs";
const [legal, revision] = process.argv.slice(2);
const source = readSourceProvenance(process.env.MYOXUS_SOURCE_PROVENANCE, revision);
if (source) {
  const text = readFileSync(`${legal}/SOURCE.md`, "utf8");
  for (const value of [source.archive?.url, source.archive?.sha256, source.tree, `${source.repository}/tree/${source.commit}`].filter(Boolean)) {
    if (!text.includes(value)) throw new Error("Image legal bundle has different public source correspondence");
  }
  const bom = JSON.parse(readFileSync(`${legal}/sbom/server.cdx.json`, "utf8"));
  for (const expected of publicSourceReferences(source)) {
    if (!(bom.metadata?.component?.externalReferences ?? []).some((r) => JSON.stringify(r) === JSON.stringify(expected))) {
      throw new Error("Image Cargo SBOM has different public source correspondence");
    }
  }
}
NODE
bash build/scripts/release/validate-sbom.sh "$work_dir/legal/sbom/server.cdx.json" >/dev/null

node build/scripts/release/generate-server-oci-sbom.mjs \
  --cargo-sbom "$work_dir/legal/sbom/server.cdx.json" \
  --os-packages "$work_dir/legal/os-packages.tsv" \
  --image-inspect "$work_dir/image-inspect.json" \
  --output "$output_dir/server-oci.cdx.json" \
  --revision "$revision" \
  --require-registry-digest "$require_registry_digest"
bash build/scripts/release/validate-sbom.sh "$output_dir/server-oci.cdx.json" >/dev/null
cp "$work_dir/image-inspect.json" "$output_dir/server-image-inspect.json"
cp "$work_dir/legal/os-packages.tsv" "$output_dir/server-os-packages.tsv"

jq -e --arg revision "$revision" '
  .metadata.component.type == "container" and
  any(.metadata.component.properties[]; .name == "myoxus:git-revision" and .value == $revision) and
  any(.metadata.component.properties[]; .name == "myoxus:sbom-scope" and .value == "final-oci-filesystem") and
  ([.components[] | select(any(.properties[]?; .name == "myoxus:package-layer" and .value == "debian-runtime"))] | length) > 0
' "$output_dir/server-oci.cdx.json" >/dev/null

echo "Server container legal and OCI SBOM verification passed."
