#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
cd "$repo_root"

# The unconfigured-build case must not inherit an operator publication URL.
unset MYOXUS_SOURCE_ARCHIVE_URL MYOXUS_SOURCE_ARCHIVE_SHA256 MYOXUS_SOURCE_PROVENANCE

revision="${GITHUB_SHA:-$(git rev-parse HEAD)}"
epoch="${SOURCE_DATE_EPOCH:-$(git show -s --format=%ct "$revision")}"
cargo metadata --manifest-path server/Cargo.toml --format-version=1 --locked > "$work_dir/cargo-metadata.json"
version="$(python3 -c 'import json,sys; print(next(p["version"] for p in json.load(open(sys.argv[1]))["packages"] if p["name"] == "myoxus-api"))' "$work_dir/cargo-metadata.json")"

SKIP_SBOM_VALIDATION=true bash build/scripts/release/assemble-server-legal.sh \
  "$work_dir/first" "$revision" "$version" "$epoch" >/dev/null
SKIP_SBOM_VALIDATION=true bash build/scripts/release/assemble-server-legal.sh \
  "$work_dir/second" "$revision" "$version" "$epoch" >/dev/null
diff -qr "$work_dir/first" "$work_dir/second" >/dev/null
grep -Fq 'Copyright (c) 2026 Daniel Scharf (Myoxus modifications)' "$work_dir/first/licenses/myoxus-yrs/LICENSE"
grep -Fq 'Kevin Jahns' "$work_dir/first/licenses/myoxus-yrs/LICENSE"
grep -Fq 'Bartosz Sypytkowski' "$work_dir/first/licenses/myoxus-yrs/LICENSE"
for package in biblatex hayagriva; do
  cmp "vendor/cargo/$package/LICENSE-MIT" "$work_dir/first/licenses/$package/LICENSE-MIT"
  cmp "vendor/cargo/$package/LICENSE-APACHE" "$work_dir/first/licenses/$package/LICENSE-APACHE"
done
cmp vendor/cargo/hayagriva/NOTICE "$work_dir/first/licenses/hayagriva/NOTICE"
cmp vendor/cargo/simba/LICENSE "$work_dir/first/licenses/simba/LICENSE"
cmp build/dependencies/safer-bytes-license.txt "$work_dir/first/licenses/safer-bytes/DECLARED-MIT.txt"
cmp build/dependencies/paste-consumers-source.json "$work_dir/first/provenance/paste-consumers-source.json"
grep -Fq '| myoxus-yrs | 0.28.0-myoxus.1 | MIT |' "$work_dir/first/THIRD_PARTY_NOTICES.md"
for package in biblatex hayagriva safer-bytes simba; do
  grep -Fq "| $package |" "$work_dir/first/THIRD_PARTY_NOTICES.md"
done
# Resolve the actual engine packages rather than a parallel legal inventory.
node - "$work_dir/cargo-metadata.json" "$work_dir/first" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const [metadataFile, output] = process.argv.slice(2);
const packages = JSON.parse(fs.readFileSync(metadataFile, "utf8")).packages;
const engines = packages.filter((pkg) => pkg.name.startsWith("glirulus-"));
assert(engines.length > 0, "No resolved Glirulus package legal material was checked");
const inventory = fs.readFileSync(path.join(output, "THIRD_PARTY_NOTICES.md"), "utf8");
const sbom = JSON.parse(fs.readFileSync(path.join(output, "sbom/server.cdx.json"), "utf8"));
for (const pkg of engines) {
  const directory = path.dirname(pkg.manifest_path);
  for (const file of ["LICENSE", "NOTICE"]) {
    const published = fs.readFileSync(path.join(directory, file));
    const bundled = fs.readFileSync(path.join(output, "licenses", pkg.name, file));
    assert.deepEqual(bundled, published, `${pkg.name}/${file} differs from resolved package`);
    const text = bundled.toString("utf8");
    assert(text.includes("Copyright (c) 2026 Sayiir"), `${pkg.name}/${file} lost upstream attribution`);
    assert(text.includes("Copyright (c) 2026 Daniel Scharf"), `${pkg.name}/${file} lost fork attribution`);
    assert(text.includes("MIT"), `${pkg.name}/${file} lost MIT attribution`);
  }
  assert(inventory.includes(`| ${pkg.name} | ${pkg.version} | MIT |`));
  assert(sbom.components.some((component) => component.name === pkg.name && component.version === pkg.version), `${pkg.name} is missing from the resolved SBOM`);
}
NODE

grep -Fq '| touying-presentation-framework |' "$work_dir/first/THIRD_PARTY_NOTICES.md"
grep -Fq '| uniwarn-typst-module |' "$work_dir/first/THIRD_PARTY_NOTICES.md"
bash build/scripts/release/validate-sbom.sh "$work_dir/first/sbom/server.cdx.json" >/dev/null

if grep -R -E 'path\+file://|download_url=file://|/Users/|/home/|/builds/' "$work_dir/first"; then
  echo "Generated server Legal tree contains a host-local path." >&2
  exit 1
fi

node - "$work_dir/first/SOURCE.md" "$revision" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [file, revision] = process.argv.slice(2);
const source = fs.readFileSync(file, "utf8");
assert(source.includes(`Git revision: \`${revision}\``));
assert(source.includes("No public source archive is configured"));
assert(!source.includes("github.com"));
assert(!source.includes("git archive"));
NODE

# Exercise the real assembler with an explicitly supplied public archive.
source_url="https://downloads.example.org/myoxus-server-source.tar.gz"
source_sha="$(printf '1%.0s' {1..64})"
node - "$work_dir/release-provenance.json" "$revision" "$source_url" "$source_sha" <<'NODE'
const fs = require("node:fs");
const [file, revision, url, sha256] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision,
  sourceArchive: { sha256 }, publicSource: {
    repository: "https://github.com/superions/myoxus", commit: "2".repeat(40),
    archive: { url, sha256 },
  },
}));
NODE
node build/scripts/release/assemble-server-legal.mjs \
  --repo-root "$repo_root" --output "$work_dir/linked" \
  --revision "$revision" --version "$version" --epoch "$epoch" \
  --source-archive-url "$source_url" --source-archive-sha256 "$source_sha" \
  --source-provenance "$work_dir/release-provenance.json"
node - "$work_dir/linked/SOURCE.md" "$source_url" "$source_sha" "$revision" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [file, url, sha, revision] = process.argv.slice(2);
const source = fs.readFileSync(file, "utf8");
assert(source.includes(`Git revision: \`${revision}\``));
assert(source.includes(`/tree/${"2".repeat(40)}`));
assert(source.includes(`Source archive: <${url}>`));
assert(source.includes(`Source archive SHA-256: \`${sha}\``));
assert(!source.includes("No public source archive is configured"));
assert(!source.includes("/commit/"));
assert(!source.includes("git archive"));
NODE

# Invalid metadata must fail before any output is written or Cargo is invoked.
node - "$repo_root" "$work_dir" "$revision" "$version" "$epoch" <<'NODE'
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const [root, work, revision, version, epoch] = process.argv.slice(2);
const sha = "1".repeat(64);
for (const [index, [url, checksum]] of [
  ["not-a-url", sha],
  ["https://example.org/source.tar.gz", ""],
  ["", sha],
  ["https://example.org/source.tar.gz", "bad-digest"],
  ["http://example.org/source.tar.gz", sha],
  ["https://user:password@example.org/source.tar.gz", sha],
  ["https://example.org/source.tar.gz?token=placeholder", sha],
  ["https://example.org/source.tar.gz#fragment", sha],
  [`https://github.com/superions/myoxus/commit/${revision}`, sha],
  ["https://example.org/source.tar.gz>\nInjected", sha],
].entries()) {
  const output = `${work}/invalid-${index}`;
  const result = spawnSync(process.execPath, [
    `${root}/build/scripts/release/assemble-server-legal.mjs`,
    "--repo-root", `${work}/absent-source`, "--output", output,
    "--revision", revision, "--version", version, "--epoch", epoch,
    "--source-archive-url", url, "--source-archive-sha256", checksum,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Source archive/);
  assert.equal(existsSync(output), false);
}
NODE

node - "$work_dir" "$revision" "$version" <<'NODE'
const fs = require("node:fs");
const [directory, revision, version] = process.argv.slice(2);
fs.writeFileSync(
  `${directory}/image-inspect.json`,
  `${JSON.stringify([{
    Id: `sha256:${"1".repeat(64)}`,
    RepoDigests: [],
    Config: { Labels: {
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.version": version,
    } },
  }], null, 2)}\n`,
);
fs.writeFileSync(
  `${directory}/os-packages.tsv`,
  "ca-certificates\t20250419\tamd64\nlibc6\t2.41-12\tamd64\n",
);
NODE

node build/scripts/release/generate-server-oci-sbom.mjs \
  --cargo-sbom "$work_dir/first/sbom/server.cdx.json" \
  --os-packages "$work_dir/os-packages.tsv" \
  --image-inspect "$work_dir/image-inspect.json" \
  --output "$work_dir/server-oci.cdx.json" \
  --revision "$revision" \
  --require-registry-digest false
bash build/scripts/release/validate-sbom.sh "$work_dir/server-oci.cdx.json" >/dev/null

if node build/scripts/release/generate-server-oci-sbom.mjs \
  --cargo-sbom "$work_dir/first/sbom/server.cdx.json" \
  --os-packages "$work_dir/os-packages.tsv" \
  --image-inspect "$work_dir/image-inspect.json" \
  --output "$work_dir/should-not-exist.cdx.json" \
  --revision "$revision" \
  --require-registry-digest true >/dev/null 2>&1; then
  echo "OCI SBOM accepted a local image ID where a registry digest was required." >&2
  exit 1
fi

if node build/scripts/release/generate-server-oci-sbom.mjs \
  --cargo-sbom "$work_dir/first/sbom/server.cdx.json" \
  --os-packages "$work_dir/os-packages.tsv" \
  --image-inspect "$work_dir/image-inspect.json" \
  --output "$work_dir/should-not-exist.cdx.json" \
  --revision 2222222222222222222222222222222222222222 \
  --require-registry-digest false >/dev/null 2>&1; then
  echo "OCI SBOM accepted a mismatched Git revision." >&2
  exit 1
fi

echo "Server Legal/SBOM determinism and negative checks passed."
