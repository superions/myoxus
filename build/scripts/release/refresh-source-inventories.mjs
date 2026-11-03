// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { generateVirgultumProvenance } from "../ci/generate-virgultum-source-provenance.mjs";
import {
  collectScopedFiles,
  deterministicAssetHash,
  loadReuseAnnotations,
  parseFileSpdx,
  pathMatches,
  validateProvenance,
} from "../ci/verify-client-source-provenance.mjs";

/** Refresh derived inventories, never guess a retained/third-party license. */
export function refreshClientInventories(root) {
  const file = path.join(root, "client/provenance/components.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const files = collectScopedFiles(root, manifest.policy.scopedFiles.roots);
  const present = new Set(files.map((p) => p.slice(7)));
  const annotations = loadReuseAnnotations(root);
  for (const annotation of annotations) {
    const paths = Array.isArray(annotation.path)
      ? annotation.path
      : [annotation.path];
    annotation.path = paths.filter((p) => present.has(p));
  }
  const annotated = new Set(annotations.flatMap((a) => a.path));
  const notice = manifest.policy.canonicalMyoxusCopyright;
  const added = [];
  for (const file of files) {
    if (annotated.has(file.slice(7))) continue;
    const header = parseFileSpdx(root, file);
    const components = manifest.components.filter((c) =>
      c.paths.some((p) => pathMatches(file, p)),
    );
    const generated = (manifest.policy.generatedSourceRoots ?? []).find(
      (r) =>
        file.startsWith(r.path) &&
        r.origin === "M0" &&
        r.licenseExpression === "AGPL-3.0-or-later",
    );
    // Only an explicit Myoxus SPDX header or an approved generated-content
    // owner admits new files. Unknown assets and third-party grants still stop.
    if (
      !(
        header.licenses.length === 1 &&
        header.licenses[0] === "AGPL-3.0-or-later"
      ) &&
      !generated &&
      !(manifest.policy.reviewedMyoxusFiles ?? []).includes(file)
    )
      throw new Error(`Explicit origin/license review required: ${file}`);
    if (header.copyright.some((n) => n !== notice))
      throw new Error(`Retained attribution needs explicit review: ${file}`);
    if (!components.some((c) => c.origin.split("/").includes("M0")))
      throw new Error(`No approved Myoxus component for ${file}`);
    added.push(file.slice(7));
  }
  if (added.length)
    annotations.push({
      "SPDX-FileCopyrightText": notice,
      "SPDX-License-Identifier": "AGPL-3.0-or-later",
      "X-Myoxus-Origin": "M0",
      path: added.sort(),
    });
  manifest.policy.scopedFiles.pathCount = files.length;
  manifest.policy.scopedFiles.pathSha256 = createHash("sha256")
    .update(files.join("\n") + "\n")
    .digest("hex");
  const extensions = new Set(
    manifest.policy.bundledAssets.extensions.map((e) => "." + e),
  );
  const assets = files.filter((f) =>
    extensions.has(path.extname(f).toLowerCase()),
  );
  const hash = deterministicAssetHash(root, assets);
  manifest.policy.bundledAssets.pathCount = assets.length;
  manifest.policy.bundledAssets.contentSha256 = hash;
  if (assets.length)
    Object.assign(
      manifest.components.find((c) => c.id === "client-bundled-assets"),
      { paths: assets, contentSha256: hash },
    );
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  const reuse = path.join(root, "client/REUSE.toml");
  const prefix = fs.readFileSync(reuse, "utf8").split("[[annotations]]")[0];
  const render = (value) =>
    Array.isArray(value)
      ? "[\n" +
        value.map((v) => "  " + JSON.stringify(v) + ",").join("\n") +
        "\n]"
      : JSON.stringify(value);
  fs.writeFileSync(
    reuse,
    prefix +
      annotations
        .filter((a) => a.path.length)
        .map(
          (a) =>
            "[[annotations]]\n" +
            Object.entries(a)
              .map(([k, v]) => `${k} = ${render(v)}`)
              .join("\n"),
        )
        .join("\n\n") +
      "\n",
  );
  const findings = validateProvenance(root);
  if (findings.length) throw new Error(findings.join("\n"));
  console.log(
    `Client inventories refreshed: ${files.length} files, ${assets.length} assets; ${added.length} newly classified files.`,
  );
}

export async function refreshSourceInventories(root) {
  refreshClientInventories(root);
  const sourcesPath = path.join(root, "virgultum/provenance/sources.json");
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  // Current-byte fingerprints are derived. Original blob identities, origins,
  // license expressions and notices remain the reviewed licensing authority.
  for (const annotation of sources.annotations) {
    annotation.files = annotation.files.filter((entry) =>
      fs.existsSync(path.join(root, entry.path)),
    );
    for (const entry of annotation.files) {
      const absolute = path.join(root, entry.path);
      const header = parseFileSpdx(root, entry.path);
      if (
        header.licenses.some(
          (l) => !annotation.licenseExpression.split(" AND ").includes(l),
        )
      )
        throw new Error(
          `License changed; explicit review required: ${entry.path}`,
        );
      entry.sha256 = createHash("sha256")
        .update(fs.readFileSync(absolute))
        .digest("hex");
    }
  }
  fs.writeFileSync(
    sourcesPath,
    await format(JSON.stringify(sources), {
      ...(await resolveConfig(sourcesPath)),
      parser: "json",
    }),
  );
  fs.writeFileSync(
    path.join(root, "virgultum/provenance/licenses.json"),
    JSON.stringify(generateVirgultumProvenance(root), null, 2) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await refreshSourceInventories(path.resolve(process.argv[2] ?? "."));
