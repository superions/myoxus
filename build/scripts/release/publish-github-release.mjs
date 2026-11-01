#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import fs from "node:fs";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readSourceProvenance } from "./source-correspondence.mjs";

const REPOSITORY = "superions/myoxus";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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
    if (asset.url && new URL(asset.url).origin !== "https://git.blume29.de")
      throw new Error("Release payloads must come from Forgejo");
    if (!asset.url && asset.kind !== "source-archive")
      throw new Error(
        "Only the reviewed source archive may be supplied locally",
      );
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
  if (input.assets.filter((a) => a.kind === "source-archive").length > 1)
    throw new Error("At most one historical source archive is allowed");
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
  if (commit.sha !== source.commit || (source.tree && commit.tree?.sha !== source.tree))
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
  const files = [
    [
      `packages/deb/myoxus-server_${version}+git.${revision.slice(0, 12)}_amd64.deb`,
    ],
    [
      `packages/rpm/myoxus-server-${version}+git.${revision.slice(0, 12)}-1.x86_64.rpm`,
    ],
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
          (p) => p.name === "myoxus:git-revision" && p.value === revision,
        )
      )
        throw new Error(
          "Native server SBOM differs from release source/version",
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
}) {
  const input = json(inputFile);
  validateInput(input);
  const root = path.dirname(path.resolve(inputFile));
  const output = path.resolve(outputDir);
  if (fs.existsSync(output) && fs.readdirSync(output).length)
    throw new Error("Preparation output must be new or empty");
  fs.mkdirSync(path.join(output, "assets"), { recursive: true });
  const assets = [];
  for (const asset of input.assets) {
    const bytes = asset.url
      ? await request(fetchImpl, asset.url, { raw: true, token: forgejoToken })
      : fs.readFileSync(localFile(root, asset.path));
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
  const archive = input.assets.find((a) => a.kind === "source-archive");
  const provenance = input.assets.find((a) => a.kind === "provenance");
  const provenanceFile = path.join(output, "assets", provenance.name);
  const report = json(provenanceFile);
  const source = readSourceProvenance(provenanceFile, report.revision);
  if (report.summary?.inReleaseBlocked?.length !== 0)
    throw new Error("Release provenance is not qualified");
  if (source.archive && (
    !archive ||
    source.archive.sha256 !== archive.sha256 ||
    source.archive.url !==
      `https://github.com/${REPOSITORY}/releases/download/${input.tag}/${archive.name}`
  ))
    throw new Error("Source mapping differs from the reviewed release asset");
  if (!source.archive && archive)
    throw new Error("Git-based source must not upload another source archive");
  const identity = { revision: report.revision, commit: source.commit,
    ...(source.tree ? { tree: source.tree } : {}) };
  if (nativeServerRoot) {
    for (const { bytes, ...asset } of nativeServerAssets(
      nativeServerRoot,
      report.revision,
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
  const nativeNotes = nativeServerRoot
    ? `\n\nNative server packages (Linux x86_64):\n${assets
        .filter((a) => /\.(deb|rpm)$/.test(a.name))
        .map(
          (a) =>
            `- [${a.name}](https://github.com/${REPOSITORY}/releases/download/${input.tag}/${encodeURIComponent(a.name)})`,
        )
        .join("\n")}`
    : "";
  const sourceNotes = source.archive
    ? `Source archive: ${source.archive.url}\nSource archive SHA-256: \`${archive.sha256}\``
    : `Source tree: \`${source.tree}\`\nSource download: ${source.repository}/archive/${source.commit}.tar.gz`;
  const body = `${notes.trim()}${nativeNotes}\n\nSource: ${source.repository}/tree/${source.commit}\n${sourceNotes}\n${containers.map((c) => `\n- ${c.role}: \`${c.coordinate}\``).join("")}\n`;
  if (body.includes(`github.com/${REPOSITORY}/commit/${report.revision}`))
    throw new Error("Private build revisions are not GitHub commit URLs");
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
    body,
    assets,
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
    if (!expected || names.has(asset.name) || asset.size !== expected.size)
      throw new Error(
        "Existing release has unexpected, duplicate or different immutable assets",
      );
    names.add(asset.name);
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
        name: `Myoxus ${plan.version}`,
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
  if (!release.draft) return { id: release.id, alreadyPublished: true };
  for (const asset of plan.assets) {
    if (existing.has(asset.name)) continue;
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
  }
  // No release becomes visible until every uploaded byte was read back. A
  // failed attempt leaves its draft available for a same-byte retry.
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
    },
  });
  if (mode === "prepare" && values.input && values.output) {
    const result = await prepareRelease({
      inputFile: values.input,
      outputDir: values.output,
      forgejoToken: process.env.FORGEJO_RELEASE_READ_TOKEN,
      nativeServerRoot: process.env.NATIVE_SERVER_RELEASE_ROOT,
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
