// SPDX-License-Identifier: AGPL-3.0-or-later
// Copy committed native bundles; this generator never authors document bodies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parse } from "yaml";
import semver from "semver";
import { format, resolveConfig } from "prettier";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = path.join(root, "server/templates/documents");
const destination = path.join(root, "client/libs/core/public/document-bundles");
const indexPath = path.join(
  root,
  "client/libs/core/src/modules/template-doc/generated/document-bundles.json",
);
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = process.argv.includes("--check");
assert(
  process.argv.slice(2).every((argument) => argument === "--check"),
  "Unknown argument",
);
// The mandatory base exports select active native versions; retained components
// remain pin evidence and must not become offline offerings by directory order.
const base = parse(
  await readFile(
    path.join(root, "server/templates/features/base/manifest.yaml"),
    "utf8",
  ),
);
const bundles = new Map();
const retainedSlugs = new Set();
for (const entry of base.exports.filter((item) => item.document)) {
  assert.equal(
    base.components.find((component) => component.id === entry.source.component)
      ?.kind,
    "documentTemplate",
    `Document export references an unknown or non-document component: ${entry.id}`,
  );
}
for (const component of base.components.filter(
  (item) => item.kind === "documentTemplate",
)) {
  const filename = path.resolve(root, "server/templates", component.path);
  assert(
    filename.startsWith(`${source}${path.sep}`),
    "Document component escapes native source root",
  );
  const bytes = await readFile(filename);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert(
    zip.file("manifest.json") && zip.file("content.template.zip"),
    "Incomplete document bundle",
  );
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.template_id),
    "Unsafe bundle identity",
  );
  assert(semver.valid(manifest.version), "Invalid bundle version");
  retainedSlugs.add(manifest.template_id);
  const exports = base.exports.filter(
    (item) => item.source.component === component.id,
  );
  if (!exports.length) continue;
  assert.equal(exports.length, 1, "Ambiguous active document export");
  assert.equal(
    exports[0].source.export,
    `${manifest.template_id}@${manifest.version}`,
    "Document export identity mismatch",
  );
  assert(
    !bundles.has(manifest.template_id),
    "Duplicate active document identity",
  );
  bundles.set(manifest.template_id, {
    manifest,
    bytes,
    component: component.id,
  });
}
const retired = [...retainedSlugs].filter((slug) => !bundles.has(slug)).sort();
// The same configured export selects the release revision, default policy and
// native-client learning order. Adding a guide needs no second delivery list.
const guides = base.exports.flatMap((entry) => {
  if (!entry.document?.newWorkspaceDefault) return [];
  const bundle = [...bundles.values()].find(
    ({ component }) => component === entry.source.component,
  );
  return bundle?.manifest.purpose === "guide"
    ? [bundle.manifest.template_id]
    : [];
});
const entries = [];
for (const [slug, { manifest, bytes }] of [...bundles].sort(([a], [b]) =>
  a.localeCompare(b, "en"),
)) {
  const asset = `${slug}/${manifest.version}.zip`;
  const filename = path.join(destination, asset);
  const existing = await readFile(filename).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing)
    assert.equal(
      checksum(existing),
      checksum(bytes),
      "Immutable generated asset drift",
    );
  else {
    assert(!check, `Missing generated asset: ${asset}`);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
  }
  entries.push({ ...manifest, asset, sha256: checksum(bytes) });
}
// Match the repository formatter so a successful pre-commit hook cannot make
// the next generated-artifact check fail without a content change.
const index = await format(
  JSON.stringify({ retired, onboarding: guides, entries }),
  {
    ...(await resolveConfig(indexPath)),
    filepath: indexPath,
  },
);
if (check)
  assert.equal(
    await readFile(indexPath, "utf8"),
    index,
    "Generated document bundle index drift",
  );
else {
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, index);
}
console.log(
  `${check ? "Verified" : "Generated"} ${entries.length} native bundle assets and a manifest-derived index.`,
);
