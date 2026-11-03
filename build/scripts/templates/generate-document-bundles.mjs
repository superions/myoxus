// SPDX-License-Identifier: AGPL-3.0-or-later
// Prepare committed native payloads; never author or rewrite document bodies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeArchive, readNativeBundle } from "./native-payload.mjs";
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
  const decoded = await readNativeBundle(bytes, checksum);
  const { manifest } = decoded;
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
    ...decoded,
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
async function emit(asset, bytes) {
  const filename = path.join(destination, asset);
  const existing = await readFile(filename).catch((error) => {
    if (error.code !== "ENOENT") throw error;
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
  return { asset, sha256: checksum(bytes) };
}

async function prepare(content) {
  const signature = content.subarray(0, 4);
  if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    assert(
      content[0] !== 0x50 || content[1] !== 0x4b,
      "Invalid native package signature",
    );
    return {
      kind: "yjs",
      ...(await emit(`payloads/${checksum(content)}.yjs`, content)),
    };
  }
  const files = await readNativeArchive(content);
  const documents = [...files.keys()].filter((name) =>
    name.endsWith(".snapshot.json"),
  );
  assert.equal(
    documents.length,
    1,
    "A native template snapshot requires exactly one page",
  );
  let bytes = files.get(documents[0]);
  const snapshot = JSON.parse(bytes.toString("utf8"));
  assert(
    Array.isArray(snapshot.blocks)
      ? snapshot.blocks.filter((block) => block.flavour === "myoxus:page")
          .length === 1
      : snapshot.blocks?.flavour === "myoxus:page",
    "Native snapshot requires one page",
  );
  if (Array.isArray(snapshot.blocks)) {
    // Registry portable snapshots may be flat. Lower only their containers to
    // the existing native Transformer tree; authored props/deltas stay exact.
    const blocks = new Map(snapshot.blocks.map((block) => [block.id, block]));
    assert.equal(
      blocks.size,
      snapshot.blocks.length,
      "Duplicate native block identity",
    );
    const root = snapshot.blocks.find(
      (block) => block.flavour === "myoxus:page",
    );
    const visited = new Set();
    const tree = (id, depth = 0) => {
      assert(
        depth <= 256 && !visited.has(id) && blocks.has(id),
        "Invalid native snapshot child graph",
      );
      visited.add(id);
      const block = blocks.get(id);
      return {
        ...block,
        type: "block",
        children: (block.children ?? []).map((child) => tree(child, depth + 1)),
      };
    };
    snapshot.blocks = tree(root.id);
    assert.equal(
      visited.size,
      blocks.size,
      "Unreachable native snapshot blocks",
    );
    snapshot.type = "page";
    snapshot.meta = { createDate: 0, tags: [], ...snapshot.meta };
    bytes = Buffer.from(JSON.stringify(snapshot));
  }
  const assets = [];
  for (const [source, data] of files) {
    if (!source.startsWith("assets/")) continue;
    const extension = path.extname(source).slice(1).toLowerCase();
    const mime =
      {
        webp: "image/webp",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        svg: "image/svg+xml",
      }[extension] ?? "application/octet-stream";
    assets.push({
      source,
      mime,
      ...(await emit(`assets/${checksum(data)}.${extension || "bin"}`, data)),
    });
  }
  return {
    kind: "snapshot",
    ...(await emit(`payloads/${checksum(bytes)}.snapshot.json`, bytes)),
    assets,
  };
}

const entries = [];
for (const [, { manifest, content, variants }] of [...bundles].sort(
  ([a], [b]) => a.localeCompare(b, "en"),
)) {
  const { localized_contents: _localizedContents, ...metadata } = manifest;
  const defaultLocale = (manifest.locale ?? "und")
    .replaceAll("_", "-")
    .toLowerCase();
  const contents = {
    [defaultLocale]: {
      ...(await prepare(content)),
      title: manifest.title,
      description: manifest.description,
    },
  };
  for (const [locale, variant] of variants)
    contents[locale] = {
      ...(await prepare(variant.content)),
      title: variant.title,
      description: variant.description,
    };
  entries.push({ ...metadata, defaultLocale, contents });
}
// ZIPs remain immutable Registry sources, not offline runtime deliveries.
// Remove only byte-identical generated copies; an unknown override fails closed.
for await (const relative of glob("**/*.zip", { cwd: destination })) {
  assert(!check, `Obsolete generated offline ZIP: ${relative}`);
  assert.equal(
    checksum(await readFile(path.join(destination, relative))),
    checksum(await readFile(path.join(source, relative))),
    "Generated ZIP differs from its retained source",
  );
  await unlink(path.join(destination, relative));
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
