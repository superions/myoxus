// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const FULL_REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PUBLIC_REPOSITORY = "https://github.com/superions/myoxus";

export function validateSourceArchive(url, sha256) {
  if (!url && !sha256) return undefined;
  if (!url || !sha256) {
    throw new Error("Source archive URL and SHA-256 must be supplied together");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Source archive URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /[\s<>`]/.test(url) ||
    /\/(?:commit|commits|tree|blob)\//.test(parsed.pathname) ||
    !/\.(?:tar(?:\.(?:gz|xz|zst))?|zip)$/.test(parsed.pathname)
  ) {
    throw new Error(
      "Source archive must be a direct HTTPS archive URL without credentials, query or fragment",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("Source archive requires a full lowercase SHA-256");
  }
  return { url, sha256 };
}

// This is publication metadata attached after the public commit exists. Build
// revision fields remain authoritative and are never replaced by this commit.
export function validatePublicSource(revision, source) {
  if (!FULL_REVISION.test(revision ?? "")) {
    throw new Error("Source correspondence requires a full build revision");
  }
  if (
    source?.repository !== PUBLIC_REPOSITORY ||
    !/^[0-9a-f]{40}$/.test(source.commit ?? "") ||
    source.commit === revision
  ) {
    throw new Error(
      "Public source requires the curated GitHub repository and its distinct public commit",
    );
  }
  const archive = validateSourceArchive(
    source.archive?.url,
    source.archive?.sha256,
  );
  if ((!archive && !/^[0-9a-f]{40}$/.test(source.tree ?? "")) || archive?.url.includes(revision)) {
    throw new Error(
      "Public source requires a qualified Git tree or a verified archive without the private build revision",
    );
  }
  if (source.tree !== undefined && !/^[0-9a-f]{40}$/.test(source.tree))
    throw new Error("Public source tree must be a full Git object ID");
  return { repository: PUBLIC_REPOSITORY, commit: source.commit,
    ...(source.tree ? { tree: source.tree } : {}), ...(archive ? { archive } : {}) };
}

/** Read the existing release provenance report, bound to the caller's build. */
export function readSourceProvenance(file, revision) {
  if (!file) return undefined;
  const report = JSON.parse(readFileSync(file, "utf8"));
  if (report.schemaVersion !== 1 || report.revision !== revision) {
    throw new Error(
      "Public source provenance does not match the build revision",
    );
  }
  const source = validatePublicSource(revision, report.publicSource);
  if (source.archive && report.sourceArchive?.sha256 !== source.archive.sha256) {
    throw new Error(
      "Public source provenance archive digest disagrees with its verified source archive",
    );
  }
  return source;
}

export function publicSourceReferences(source) {
  if (!source) return [];
  return [
    { type: "vcs", url: `${source.repository}/tree/${source.commit}` },
    {
      type: "distribution",
      url: source.archive?.url ?? `${source.repository}/archive/${source.commit}.tar.gz`,
      ...(source.archive ? { hashes: [{ alg: "SHA-256", content: source.archive.sha256 }] } : {}),
    },
  ];
}

export function applySourceToSbom(bom, revision, source) {
  const component = bom.metadata?.component;
  if (!component) throw new Error("SBOM has no root component");
  const existing = component.properties ?? [];
  const build = existing.filter((p) => p.name === "myoxus:git-revision");
  if (build.some((p) => p.value !== revision)) {
    throw new Error("SBOM build revision disagrees with source provenance");
  }
  if (!FULL_REVISION.test(revision ?? ""))
    throw new Error("SBOM requires a full build revision");
  component.properties = [
    ...existing.filter((p) => p.name !== "myoxus:git-revision"),
    { name: "myoxus:git-revision", value: revision },
  ];
  if (source) {
    const expected = publicSourceReferences(
      validatePublicSource(revision, source),
    );
    for (const ref of component.externalReferences ?? []) {
      // Package metadata may already name the repository without claiming a
      // revision. Replace that generic pointer with the reviewed public commit.
      if (ref.type === "vcs" && ref.url === source.repository && !ref.hashes)
        continue;
      if (
        expected.some(
          (r) =>
            r.type === ref.type && JSON.stringify(r) !== JSON.stringify(ref),
        )
      ) {
        throw new Error("SBOM already has a different public source reference");
      }
    }
    component.externalReferences = [
      ...(component.externalReferences ?? []).filter(
        (r) => !expected.some((e) => e.type === r.type),
      ),
      ...expected,
    ];
  }
  return bom;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2)
    args.set(process.argv[i], process.argv[i + 1]);
  if (args.has("--fetch-provenance")) {
    const url = new URL(args.get("--fetch-provenance"));
    const sha256 = args.get("--sha256");
    const output = args.get("--output");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[0-9a-f]{64}$/.test(sha256 ?? "") ||
      !output
    ) {
      throw new Error(
        "Provenance download requires HTTPS, an exact SHA-256 and an output path",
      );
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Provenance download failed: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024)
        throw new Error("Provenance report exceeds 16 MiB");
      chunks.push(chunk);
    }
    const contents = Buffer.concat(chunks);
    if (createHash("sha256").update(contents).digest("hex") !== sha256) {
      throw new Error("Downloaded source provenance SHA-256 differs");
    }
    const report = JSON.parse(contents);
    if (
      report.schemaVersion !== 1 ||
      report.revision !== args.get("--revision")
    ) {
      throw new Error(
        "Downloaded source provenance does not match the build revision",
      );
    }
    const source = validatePublicSource(report.revision, report.publicSource);
    if (source.archive && report.sourceArchive?.sha256 !== source.archive.sha256) {
      throw new Error("Downloaded provenance archive digest disagrees");
    }
    writeFileSync(output, contents, { mode: 0o600 });
  } else {
    const file = args.get("--sbom");
    const revision = args.get("--revision");
    if (!file) throw new Error("--sbom is required");
    const bom = applySourceToSbom(
      JSON.parse(readFileSync(file, "utf8")),
      revision,
      readSourceProvenance(args.get("--source-provenance"), revision),
    );
    writeFileSync(file, `${JSON.stringify(bom, null, 2)}\n`);
  }
}
