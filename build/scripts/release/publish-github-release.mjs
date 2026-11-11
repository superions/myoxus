#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { readSourceProvenance } from "./source-correspondence.mjs";

const REPOSITORY = "superions/myoxus";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// USTAR regular files only: fixed ownership/time keeps preparation deterministic.
// Original legal/SBOM bytes are members, never parsed and rewritten by bundling.
export function createMetadataBundle(entries, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Metadata bundle requires a complete version");
  const names = new Set();
  for (const entry of entries) {
    if (
      !NAME.test(entry.name) ||
      entry.name.length > 100 ||
      entry.name === "CONTENTS.txt" ||
      names.has(entry.name)
    )
      throw new Error("Invalid/duplicate metadata bundle entry");
    names.add(entry.name);
  }
  const contents = Buffer.from(
    "Metadata files; original build files retain their bytes and identities.\n" +
      entries.map((e) => `${hash(e.bytes)}  ${e.name}\n`).join(""),
  );
  const parts = [];
  for (const entry of [
    ...entries,
    { name: "CONTENTS.txt", bytes: contents },
  ].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const header = Buffer.alloc(512);
    const octal = (value, offset, width) =>
      header.write(
        value.toString(8).padStart(width - 1, "0") + "\0",
        offset,
        width,
        "ascii",
      );
    header.write(entry.name, 0, 100, "ascii");
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    parts.push(
      header,
      entry.bytes,
      Buffer.alloc((512 - (entry.bytes.length % 512)) % 512),
    );
  }
  parts.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(parts));
  return {
    name: `myoxus-${version}-legal-provenance.tar.gz`,
    bytes,
    size: bytes.length,
    sha256: hash(bytes),
  };
}

function localFile(root, relative) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === "..")
  )
    throw new Error(
      "Release path must stay inside its explicit input directory",
    );
  const file = path.resolve(root, relative);
  const real = fs.realpathSync(file);
  if (
    !real.startsWith(`${fs.realpathSync(root)}${path.sep}`) ||
    !fs.statSync(real).isFile() ||
    fs.lstatSync(file).isSymbolicLink()
  )
    throw new Error("Release input is not a contained regular file");
  return real;
}

async function request(
  fetchImpl,
  url,
  { method = "GET", token, body, raw = false, missing = false } = {},
) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Release requests require credential-free HTTPS URLs");
  const headers = {
    Accept:
      raw && method === "GET"
        ? "application/octet-stream"
        : "application/vnd.github+json",
    "User-Agent": "Myoxus-release-publisher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined)
    headers["Content-Type"] = raw
      ? "application/octet-stream"
      : "application/json";
  // Node 26's HTTP/2 upload reset the large source asset. Keep real asset
  // uploads on HTTP/1.1 without changing their bytes or the reviewed plan.
  if (raw && method === "POST" && fetchImpl === fetch) {
    return new Promise((resolve, reject) => {
      const upload = httpsRequest(
        parsed,
        {
          method,
          headers: { ...headers, "Content-Length": body.length },
          signal: AbortSignal.timeout(900000),
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new Error(`Release asset upload HTTP ${response.statusCode}`),
              );
            } else {
              resolve(Buffer.concat(chunks));
            }
          });
        },
      );
      upload.on("error", reject);
      upload.end(body);
    });
  }
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(raw ? 900000 : 30000),
    redirect: "follow",
  });
  if (missing && response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `Release request failed: ${method} ${parsed.origin}${parsed.pathname} HTTP ${response.status}`,
    );
  if (!raw) return response.status === 204 ? undefined : response.json();
  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateInput(input) {
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version ?? "") ||
    !NAME.test(input.tag ?? "") ||
    typeof input.prerelease !== "boolean"
  )
    throw new Error(
      "A complete version, tag and explicit prerelease status are required",
    );
  if (
    !Array.isArray(input.assets) ||
    !input.assets.length ||
    input.assets.length > 100
  )
    throw new Error("An explicit asset allowlist is required");
  const names = new Set(["GITHUB-SHA256SUMS"]);
  for (const asset of input.assets) {
    if (
      !NAME.test(asset.name ?? "") ||
      names.has(asset.name) ||
      !SHA256.test(asset.sha256 ?? "")
    )
      throw new Error("Invalid or duplicate asset name/SHA-256");
    names.add(asset.name);
    if (asset.kind === "source-archive")
      throw new Error(
        "Source is published through Git; duplicate source archives are not accepted",
      );
    if (!asset.url || new URL(asset.url).origin !== "https://git.blume29.de")
      throw new Error("Release payloads must come from Forgejo");
    const serverPackage =
      asset.kind === "server-package" && /\.(?:deb|rpm)$/i.test(asset.name);
    if (
      input.scope === "selfhost" &&
      ((/\.(?:deb|rpm|flatpak|dmg|exe|nupkg)$/i.test(asset.name) &&
        !serverPackage) ||
        /^(?:latest.*\.ya?ml|RELEASES)$/i.test(asset.name))
    )
      throw new Error(
        "The self-hosting beta must not contain desktop binaries or update metadata",
      );
  }
  for (const kind of ["provenance"])
    if (input.assets.filter((a) => a.kind === kind).length !== 1)
      throw new Error(`Exactly one ${kind} asset is required`);
  if (input.scope === "selfhost" && !input.prerelease)
    throw new Error("The first self-hosting beta must be a prerelease");
}

async function verifyPublicCommit(source, fetchImpl, token) {
  const commit = await request(
    fetchImpl,
    `${API}/git/commits/${source.commit}`,
    { token },
  );
  if (
    commit.sha !== source.commit ||
    (source.tree && commit.tree?.sha !== source.tree)
  )
    throw new Error("Public commit/tree differs from the reviewed source");
}

function verifyPreparedFiles(plan, directory) {
  for (const asset of plan.assets) {
    const bytes = fs.readFileSync(localFile(directory, `assets/${asset.name}`));
    if (bytes.length !== asset.size || hash(bytes) !== asset.sha256)
      throw new Error(`Prepared bytes changed: ${asset.name}`);
  }
}

function nativeServerAssets(root, revision, version) {
  // Only the final Server Build job writes server-release, after DEB and RPM
  // installation pass. Bind to the release source, never to a 'latest' build.
  const runs = fs
    .readdirSync(root)
    .filter((name) => new RegExp(`^\\d+-${revision}$`).test(name))
    .sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]));
  if (!runs.length)
    throw new Error(
      `No accepted native server packages for ${revision}; wait for Server Build`,
    );
  const directory = path.join(root, runs[0]);
  const sums = fs.readFileSync(localFile(directory, "SHA256SUMS"), "utf8");
  const packageFile = (format, prefix, suffix) => {
    const relative = `packages/${format}`;
    const names = fs
      .readdirSync(path.join(directory, relative))
      .filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
    if (names.length !== 1)
      throw new Error(
        `Expected one accepted native ${format} package for ${version}`,
      );
    return `${relative}/${names[0]}`;
  };
  // The producer can accept an unchanged earlier build/repack. Keep its original
  // filenames and SBOM revision; the qualified cache binds acceptance to source.
  const files = [
    [packageFile("deb", `myoxus-server_${version}+git.`, "_amd64.deb")],
    [packageFile("rpm", `myoxus-server-${version}+git.`, "-1.x86_64.rpm")],
    [
      "bundle/myoxus-server-linux-x64/legal/sbom/server.cdx.json",
      `myoxus-${version}-native-server.cdx.json`,
    ],
  ];
  return files.map(([relative, name = path.basename(relative)]) => {
    const bytes = fs.readFileSync(localFile(directory, relative));
    const sha256 = hash(bytes);
    if (!sums.split(/\r?\n/).some((line) => line === `${sha256}  ${relative}`))
      throw new Error(`Native server checksum differs: ${relative}`);
    if (name.endsWith(".json")) {
      const component = JSON.parse(bytes).metadata?.component;
      if (
        component?.version !== version ||
        !component.properties?.some(
          (p) => p.name === "myoxus:git-revision" && COMMIT.test(p.value),
        )
      )
        throw new Error(
          "Native server SBOM lacks the accepted version/build identity",
        );
    }
    return { name, size: bytes.length, sha256, bytes };
  });
}

export async function prepareRelease({
  inputFile,
  outputDir,
  fetchImpl = fetch,
  forgejoToken,
  nativeServerRoot,
  sourceProvenanceFile,
}) {
  const input = json(inputFile);
  validateInput(input);
  const output = path.resolve(outputDir);
  if (fs.existsSync(output) && fs.readdirSync(output).length)
    throw new Error("Preparation output must be new or empty");
  fs.mkdirSync(path.join(output, "assets"), { recursive: true });
  const assets = [];
  for (const asset of input.assets) {
    const bytes = await request(fetchImpl, asset.url, {
      raw: true,
      token: forgejoToken,
    });
    if (
      hash(bytes) !== asset.sha256 ||
      (asset.size !== undefined && bytes.length !== asset.size)
    )
      throw new Error(`Reviewed bytes differ: ${asset.name}`);
    fs.writeFileSync(path.join(output, "assets", asset.name), bytes, {
      flag: "wx",
    });
    assets.push({
      name: asset.name,
      size: bytes.length,
      sha256: asset.sha256,
      ...(asset.url ? { origin: asset.url } : {}),
    });
  }
  // Source qualification belongs to GH-04/GH-06 and artifact qualification to
  // the existing producers. Copying only binds their accepted evidence/bytes.
  const provenance = input.assets.find((a) => a.kind === "provenance");
  const provenanceFile = path.join(output, "assets", provenance.name);
  const report = json(provenanceFile);
  let revision = report.revision;
  let source;
  let homebrew;
  let desktopName;
  if (input.scope === "desktop") {
    const [{ verifyReleaseMetadata }, { renderHomebrewCask }] =
      await Promise.all([
        import("../ci/verify-desktop-release-metadata.mjs"),
        import("../ci/write-homebrew-cask.mjs"),
      ]);
    if (report.schema !== "myoxus.desktop-provenance.v1")
      throw new Error("Desktop provenance schema is invalid");
    revision = report.source?.commit;
    source = readSourceProvenance(sourceProvenanceFile, revision);
    if (!source)
      throw new Error("Desktop copy requires separate source provenance");
    const manifest = json(path.join(output, "assets/desktop-release.json"));
    const validation = fs.mkdtempSync(path.join(output, ".desktop-"));
    try {
      // Reconstruct the producer's paths using the already digest-checked bytes.
      // The original metadata remains untouched in the publication bundle.
      const files = [
        ["desktop-release.json", "desktop-release.json"],
        [manifest.provenance.path, provenance.name],
        [manifest.updateMetadata.path, "latest.yml"],
        ...manifest.artifacts.flatMap((a) => [
          [a.path, a.name],
          [a.sbom.path, path.basename(a.sbom.path)],
        ]),
      ];
      for (const [relative, name] of files) {
        if (
          typeof relative !== "string" ||
          path.isAbsolute(relative) ||
          relative.split(/[\\/]/).includes("..")
        )
          throw new Error("Desktop producer path escapes its inventory");
        const target = path.join(validation, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (!fs.existsSync(target))
          fs.linkSync(localFile(output, `assets/${name}`), target);
      }
      const checked = verifyReleaseMetadata(validation, true);
      const expectedTag = `${checked.scope === "full" ? "desktop" : `${checked.scope}-client`}-v${checked.version}`;
      const packages = input.assets
        .filter((a) => /\.(dmg|zip|exe|deb|rpm|flatpak)$/.test(a.name))
        .map((a) => a.name)
        .sort();
      if (
        checked.sourceCommit !== revision ||
        checked.version !== input.version ||
        input.tag !== expectedTag ||
        input.prerelease !== (checked.channel !== "stable") ||
        JSON.stringify(packages) !==
          JSON.stringify(checked.artifacts.map((a) => a.name).sort())
      )
        throw new Error(
          "Desktop copy differs from its qualified source/channel/inventory",
        );
      if (["macos", "full"].includes(checked.scope))
        homebrew = renderHomebrewCask(checked, { github: true });
      const label = {
        macos: "macOS Client",
        linux: "Linux Client",
        windows: "Windows Client",
        full: "Desktop",
      }[checked.scope];
      desktopName = `Myoxus ${label} ${input.version}`;
    } finally {
      fs.rmSync(validation, { recursive: true, force: true });
    }
    const bytes = fs.readFileSync(sourceProvenanceFile);
    fs.writeFileSync(
      path.join(output, "assets/source-correspondence.json"),
      bytes,
      { flag: "wx" },
    );
    assets.push({
      name: "source-correspondence.json",
      size: bytes.length,
      sha256: hash(bytes),
    });
  } else {
    source = readSourceProvenance(provenanceFile, revision);
    if (report.summary?.inReleaseBlocked?.length !== 0)
      throw new Error("Release provenance is not qualified");
  }
  if (!source.tree)
    throw new Error(
      "New publications require a qualified public Git tree; historical archive reports remain readable",
    );
  const identity = {
    revision,
    commit: source.commit,
    ...(source.tree ? { tree: source.tree } : {}),
  };
  const includeNative =
    nativeServerRoot &&
    (input.scope === "selfhost" ||
      input.containers?.some((c) => c.role === "server"));
  if (includeNative) {
    for (const { bytes, ...asset } of nativeServerAssets(
      nativeServerRoot,
      revision,
      input.version,
    )) {
      if (assets.some((a) => a.name === asset.name))
        throw new Error(`Native server asset is supplied twice: ${asset.name}`);
      fs.writeFileSync(path.join(output, "assets", asset.name), bytes, {
        flag: "wx",
      });
      assets.push(asset);
    }
  }
  // The source snapshot and release can be prepared for one joint approval.
  // Publication checks public source reachability before its first GitHub write.
  const notes = input.notes;
  if (
    typeof notes !== "string" ||
    !notes.trim() ||
    Buffer.byteLength(notes) > 65536
  )
    throw new Error("Explicit release notes are required");
  const containers = input.containers ?? [];
  if (
    containers.some(
      (c) =>
        !/^git\.blume29\.de\/myoxus\/[a-z-]+@sha256:[0-9a-f]{64}$/.test(
          c.coordinate,
        ),
    )
  )
    throw new Error("Container references require exact Forgejo OCI digests");
  const nativeNotes = includeNative
    ? `\n\nNative server packages (Linux x86_64):\n${assets
        .filter((a) => /\.(deb|rpm)$/.test(a.name))
        .map(
          (a) =>
            `- [${a.name}](https://github.com/${REPOSITORY}/releases/download/${input.tag}/${encodeURIComponent(a.name)})`,
        )
        .join("\n")}`
    : "";
  const sourceNotes = `Source tree: \`${source.tree}\`\nSource download: ${source.repository}/archive/${source.commit}.tar.gz`;
  const body = `${notes.trim()}${nativeNotes}\n\nSource: ${source.repository}/tree/${source.commit}\n${sourceNotes}\n${containers.map((c) => `\n- ${c.role}: \`${c.coordinate}\``).join("")}\n`;
  if (body.includes(`github.com/${REPOSITORY}/commit/${revision}`))
    throw new Error("Private build revisions are not GitHub commit URLs");
  const metadataNames = new Set(
    input.assets
      .filter((a) =>
        [
          "legal",
          "sbom",
          "provenance",
          "notice",
          "checksums",
          "source-manifest",
        ].includes(a.kind),
      )
      .map((a) => a.name),
  );
  if (input.scope === "desktop")
    metadataNames.add("source-correspondence.json");
  if (includeNative)
    metadataNames.add(`myoxus-${input.version}-native-server.cdx.json`);
  const originals = assets.filter((a) => metadataNames.has(a.name));
  const bundle = createMetadataBundle(
    originals.map((a) => ({
      name: a.name,
      bytes: fs.readFileSync(path.join(output, "assets", a.name)),
    })),
    input.version,
  );
  fs.writeFileSync(path.join(output, "assets", bundle.name), bundle.bytes, {
    flag: "wx",
  });
  for (const a of originals) fs.unlinkSync(path.join(output, "assets", a.name));
  assets.splice(
    0,
    assets.length,
    ...assets.filter((a) => !metadataNames.has(a.name)),
    { name: bundle.name, size: bundle.size, sha256: bundle.sha256 },
  );
  const sums = Buffer.from(
    assets.map((a) => `${a.sha256}  ${a.name}\n`).join(""),
  );
  fs.writeFileSync(path.join(output, "assets/GITHUB-SHA256SUMS"), sums, {
    flag: "wx",
  });
  assets.push({
    name: "GITHUB-SHA256SUMS",
    size: sums.length,
    sha256: hash(sums),
  });
  const plan = {
    repository: REPOSITORY,
    tag: input.tag,
    version: input.version,
    prerelease: input.prerelease,
    source: identity,
    body:
      body +
      `\nLegal, SBOM and provenance: https://github.com/${REPOSITORY}/releases/download/${input.tag}/${bundle.name}\n`,
    assets,
    ...(homebrew ? { homebrew } : {}),
    ...(desktopName ? { name: desktopName } : {}),
  };
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "github-release-plan.json"), bytes, {
    flag: "wx",
  });
  fs.writeFileSync(
    path.join(output, "github-release-plan.json.sha256"),
    `${hash(bytes)}\n`,
  );
  return { plan, sha256: hash(bytes), output };
}

async function verifyTag(plan, fetchImpl, token) {
  const ref = await request(
    fetchImpl,
    `${API}/git/ref/tags/${encodeURIComponent(plan.tag)}`,
    { token, missing: true },
  );
  if (!ref) return;
  let object = ref.object;
  for (let i = 0; object?.type === "tag" && i < 8; i++)
    object = (
      await request(fetchImpl, `${API}/git/tags/${object.sha}`, { token })
    ).object;
  if (object?.type !== "commit" || object.sha !== plan.source.commit)
    throw new Error("Existing immutable tag points at different public source");
}

async function releaseAssets(releaseId, fetchImpl, token) {
  const assets = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await request(
      fetchImpl,
      `${API}/releases/${releaseId}/assets?per_page=100&page=${page}`,
      { token },
    );
    assets.push(...rows);
    if (rows.length < 100) return assets;
  }
  throw new Error("Release asset listing exceeds its bounded inventory");
}

async function verifyRemoteAssets(plan, releaseId, fetchImpl, token, complete) {
  const actual = await releaseAssets(releaseId, fetchImpl, token);
  const names = new Set();
  for (const asset of actual) {
    const expected = plan.assets.find((a) => a.name === asset.name);
    if (!expected || names.has(asset.name))
      throw new Error(
        "Existing release has unexpected, duplicate or different immutable assets",
      );
    // GitHub may retain a zero-byte starter after a failed upload. Only a
    // matching draft placeholder is removable; uploaded/public bytes never are.
    if (
      !complete &&
      asset.state === "starter" &&
      asset.size === 0 &&
      !asset.digest
    ) {
      await request(fetchImpl, `${API}/releases/assets/${asset.id}`, {
        method: "DELETE",
        token,
      });
      continue;
    }
    if (asset.size !== expected.size)
      throw new Error("Existing release has different immutable asset size");
    names.add(asset.name);
    if (asset.state !== "uploaded")
      throw new Error(`Release asset is not uploaded: ${asset.name}`);
    if (asset.digest) {
      if (asset.digest !== `sha256:${expected.sha256}`)
        throw new Error(
          `Existing immutable asset has different bytes: ${asset.name}`,
        );
      continue;
    }
    const bytes = await request(
      fetchImpl,
      `${API}/releases/assets/${asset.id}`,
      { token, raw: true },
    );
    if (hash(bytes) !== expected.sha256)
      throw new Error(
        `Existing immutable asset has different bytes: ${asset.name}`,
      );
  }
  if (complete && actual.length !== plan.assets.length)
    throw new Error("Release draft is incomplete");
  return names;
}

async function findRelease(tag, fetchImpl, token) {
  const direct = await request(
    fetchImpl,
    `${API}/releases/tags/${encodeURIComponent(tag)}`,
    { token, missing: true },
  );
  if (direct) return direct;
  // A draft may not have a tag yet, so the tag lookup alone cannot recover it.
  for (let page = 1; page <= 5; page++) {
    const releases = await request(
      fetchImpl,
      `${API}/releases?per_page=100&page=${page}`,
      { token },
    );
    const matches = releases.filter((release) => release.tag_name === tag);
    if (matches.length > 1)
      throw new Error("Multiple release drafts claim the same immutable tag");
    if (matches.length) return matches[0];
    if (releases.length < 100) return undefined;
  }
  throw new Error("Release draft discovery exceeds its bounded inventory");
}

async function verifyAnonymousDownloads(plan, fetchImpl) {
  for (const asset of plan.assets) {
    const url = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(plan.tag)}/${encodeURIComponent(asset.name)}`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(900000),
      redirect: "follow",
    });
    if (!response.ok)
      throw new Error(
        `Anonymous download failed: ${asset.name} HTTP ${response.status}`,
      );
    const sha = createHash("sha256");
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > asset.size)
        throw new Error(
          `Anonymous download exceeds reviewed size: ${asset.name}`,
        );
      sha.update(bytes);
    }
    if (size !== asset.size || sha.digest("hex") !== asset.sha256)
      throw new Error(
        `Anonymous download differs from reviewed bytes: ${asset.name}`,
      );
  }
}

async function publishHomebrewCask(plan, fetchImpl, token) {
  if (!plan.homebrew) return;
  const lockFile = process.env.GITHUB_PUBLICATION_LOCK;
  if (lockFile) fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const descriptor = lockFile ? fs.openSync(lockFile, "a", 0o600) : undefined;
  try {
    // flock's inherited open-file description remains locked through the parent
    // descriptor. Only the public-main mutation waits; asset transfers stay independent.
    if (descriptor !== undefined)
      execFileSync("flock", ["-x", "3"], {
        stdio: ["ignore", "ignore", "inherit", descriptor],
        timeout: 900000,
      });
    await writePublicHomebrewCask(plan, fetchImpl, token);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

async function writePublicHomebrewCask(plan, fetchImpl, token) {
  const { compareCaskVersions } =
    await import("../ci/publish-electron-release.mjs");
  const cask = plan.homebrew;
  if (
    !/^myoxus(?:-beta|-internal)?$/.test(cask.token) ||
    cask.path !== `Casks/${cask.token}.rb` ||
    cask.version !== plan.version ||
    !cask.source.includes(
      `https://github.com/${REPOSITORY}/releases/download/${plan.tag}/`,
    )
  )
    throw new Error("Invalid reviewed Homebrew destination");
  const url = `${API}/contents/${cask.path}`;
  const current = await request(fetchImpl, `${url}?ref=main`, {
    token,
    missing: true,
  });
  if (current) {
    const source = Buffer.from(current.content, "base64").toString("utf8");
    if (source === cask.source) return;
    const previous = source.match(/\bversion "([^"]+)"/)?.[1];
    if (!previous) throw new Error("Existing Homebrew cask has no version");
    const order = compareCaskVersions(previous, cask.version);
    if (order === 0)
      throw new Error(
        "Existing immutable Homebrew version has different bytes",
      );
    if (order > 0) return;
  }
  // Only advertise the Cask after every public release asset has been verified.
  // Contents API SHA provides compare-and-swap protection against concurrent updates.
  await request(fetchImpl, url, {
    method: "PUT",
    token,
    body: {
      message: `Update ${cask.token} Homebrew cask to ${cask.version}`,
      branch: "main",
      content: Buffer.from(cask.source).toString("base64"),
      ...(current ? { sha: current.sha } : {}),
    },
  });
  const checked = await request(fetchImpl, `${url}?ref=main`, { token });
  if (Buffer.from(checked.content, "base64").toString("utf8") !== cask.source)
    throw new Error(
      "Published Homebrew cask differs from the verified candidate",
    );
}

export async function publishPreparedRelease({
  planFile,
  expectedSha256,
  token,
  fetchImpl = fetch,
}) {
  if (
    !SHA256.test(expectedSha256 ?? "") ||
    hash(fs.readFileSync(planFile)) !== expectedSha256
  )
    throw new Error("Prepared release plan differs from the reviewed SHA-256");
  if (typeof token !== "string" || token.length < 16 || /\s/.test(token))
    throw new Error("A repository-scoped GITHUB_RELEASE_TOKEN is required");
  const plan = json(planFile);
  if (
    plan.repository !== REPOSITORY ||
    !COMMIT.test(plan.source?.commit ?? "") ||
    !NAME.test(plan.tag ?? "")
  )
    throw new Error("Invalid reviewed publication plan");
  const directory = path.dirname(path.resolve(planFile));
  verifyPreparedFiles(plan, directory);
  await verifyPublicCommit(plan.source, fetchImpl, token);
  await verifyTag(plan, fetchImpl, token);
  let release = await findRelease(plan.tag, fetchImpl, token);
  if (
    release &&
    (release.target_commitish !== plan.source.commit ||
      (plan.name && release.name !== plan.name) ||
      release.body !== plan.body ||
      release.prerelease !== plan.prerelease)
  )
    throw new Error(
      "Existing release metadata differs from the reviewed candidate",
    );
  if (!release)
    release = await request(fetchImpl, `${API}/releases`, {
      method: "POST",
      token,
      body: {
        tag_name: plan.tag,
        target_commitish: plan.source.commit,
        name: plan.name ?? `Myoxus ${plan.version}`,
        body: plan.body,
        prerelease: plan.prerelease,
        draft: true,
      },
    });
  const existing = await verifyRemoteAssets(
    plan,
    release.id,
    fetchImpl,
    token,
    !release.draft,
  );
  if (!release.draft) {
    await verifyAnonymousDownloads(plan, fetchImpl);
    await publishHomebrewCask(plan, fetchImpl, token);
    return { id: release.id, alreadyPublished: true };
  }
  const missing = plan.assets.filter((a) => !existing.has(a.name));
  for (let index = 0; index < missing.length; index += 3) {
    await Promise.all(
      missing.slice(index, index + 3).map(async (asset) => {
        await request(
          fetchImpl,
          `https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
          {
            method: "POST",
            token,
            raw: true,
            body: fs.readFileSync(localFile(directory, `assets/${asset.name}`)),
          },
        );
      }),
    );
  }
  // GitHub's stored digests bind uploaded bytes without downloading every file
  // twice. Older assets lacking a digest retain the individual readback fallback.
  await verifyRemoteAssets(plan, release.id, fetchImpl, token, true);
  await verifyTag(plan, fetchImpl, token);
  release = await request(fetchImpl, `${API}/releases/${release.id}`, {
    method: "PATCH",
    token,
    body: { draft: false, make_latest: "false" },
  });
  if (release.draft)
    throw new Error("GitHub kept the reviewed release as a draft");
  await verifyTag(plan, fetchImpl, token);
  await verifyRemoteAssets(plan, release.id, fetchImpl, token, true);
  await verifyAnonymousDownloads(plan, fetchImpl);
  await publishHomebrewCask(plan, fetchImpl, token);
  return { id: release.id, alreadyPublished: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      "expected-plan-sha256": { type: "string" },
      "source-provenance": { type: "string" },
    },
  });
  if (mode === "prepare" && values.input && values.output) {
    const result = await prepareRelease({
      inputFile: values.input,
      outputDir: values.output,
      forgejoToken: process.env.FORGEJO_RELEASE_READ_TOKEN,
      nativeServerRoot: process.env.NATIVE_SERVER_RELEASE_ROOT,
      sourceProvenanceFile: values["source-provenance"],
    });
    console.log(
      `Prepared ${result.plan.assets.length} exact assets; plan SHA-256 ${result.sha256}. No GitHub write was made.`,
    );
  } else if (mode === "publish" && values.plan) {
    console.log(
      JSON.stringify(
        await publishPreparedRelease({
          planFile: values.plan,
          expectedSha256: values["expected-plan-sha256"],
          token: process.env.GITHUB_RELEASE_TOKEN,
        }),
      ),
    );
  } else
    throw new Error(
      "Use prepare --input <allowlist.json> --output <new-directory>, or publish --plan <prepared-plan.json> --expected-plan-sha256 <reviewed-digest>",
    );
}
