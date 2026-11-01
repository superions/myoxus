// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { publishDesktopDistributionOverview } from "./publish-distribution-overview.mjs";
import { verifyReleaseMetadata } from "./verify-desktop-release-metadata.mjs";

const API_ORIGIN = "https://git.blume29.de";
const OWNER = "myoxus";
const REPOSITORY = "packages";
const RELEASE_API = `/api/v1/repos/${OWNER}/${REPOSITORY}/releases`;
const RELEASE_TARGET = "main";
const SUPPORT_FILES = [
  "ARTIFACTS.md",
  "RELEASE.md",
  "SHA256SUMS",
  "desktop-provenance.json",
  "desktop-release.json",
];

function releaseIdentity(bundle) {
  if (bundle.manifest.scope === "linux") {
    return {
      name: `Myoxus Linux Client ${bundle.manifest.version}`,
      tag: `linux-client-v${bundle.manifest.version}`,
    };
  }
  if (bundle.manifest.scope === "windows") {
    return {
      name: `Myoxus Windows Client ${bundle.manifest.version}`,
      tag: `windows-client-v${bundle.manifest.version}`,
    };
  }
  if (bundle.manifest.scope === "macos") {
    return {
      name: `Myoxus macOS Client ${bundle.manifest.version}`,
      tag: `macos-client-v${bundle.manifest.version}`,
    };
  }
  return {
    name: `Myoxus Desktop ${bundle.manifest.version}`,
    tag: `desktop-v${bundle.manifest.version}`,
  };
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function canonicalRelative(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Release file escapes its root: ${file}`);
  }
  return relative;
}

function walkFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Release directory contains a symbolic link: ${absolute}`,
        );
      }
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) files.push(absolute);
      else
        throw new Error(
          `Release directory contains a special file: ${absolute}`,
        );
    }
  }
  return files.sort();
}

function parseChecksumFile(contents) {
  const entries = new Map();
  for (const line of contents.trimEnd().split("\n")) {
    // GNU checksum files use a space for text mode and `*` for binary mode.
    const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/);
    if (!match || entries.has(match[2])) {
      throw new Error("SHA256SUMS is malformed or contains duplicate paths");
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function readPublishableBundle(releaseDirectory) {
  const releaseDir = path.resolve(releaseDirectory);
  const manifest = verifyReleaseMetadata(releaseDir, true);
  const expectedPaths = new Set([
    ...SUPPORT_FILES,
    manifest.provenance.path,
    manifest.updateMetadata.path,
    ...manifest.artifacts.map((artifact) => artifact.path),
    ...manifest.artifacts.map((artifact) => artifact.sbom.path),
  ]);
  const actualPaths = walkFiles(releaseDir).map((file) =>
    canonicalRelative(releaseDir, file),
  );
  const unexpected = actualPaths.filter(
    (relative) => relative !== "SHA256SUMS" && !expectedPaths.has(relative),
  );
  const missing = [...expectedPaths].filter(
    (relative) => !actualPaths.includes(relative),
  );
  if (unexpected.length || missing.length) {
    throw new Error(
      `Release publish allowlist differs; unexpected=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`,
    );
  }

  const checksumPath = path.join(releaseDir, "SHA256SUMS");
  const checksums = parseChecksumFile(fs.readFileSync(checksumPath, "utf8"));
  const checksumExpected = actualPaths.filter(
    (relative) => relative !== "SHA256SUMS",
  );
  if (
    checksums.size !== checksumExpected.length ||
    checksumExpected.some((relative) => {
      const contents = fs.readFileSync(path.join(releaseDir, relative));
      return checksums.get(relative) !== sha256(contents);
    })
  ) {
    throw new Error("SHA256SUMS does not bind the exact publishable bundle");
  }

  const assets = actualPaths.map((relative) => {
    const file = path.join(releaseDir, relative);
    const contents = fs.readFileSync(file);
    return {
      name: path.basename(relative),
      relative,
      contents,
      size: contents.length,
      sha256: sha256(contents),
    };
  });
  const duplicateNames = assets.filter(
    (asset, index) =>
      assets.findIndex((entry) => entry.name === asset.name) !== index,
  );
  if (duplicateNames.length) {
    throw new Error(
      `Forgejo release asset names collide: ${duplicateNames.map((asset) => asset.name).join(", ")}`,
    );
  }
  const forbidden = assets.filter((asset) =>
    /(?:^RELEASES$|Update\.exe|squirrel|\.nupkg$|unsigned[-_.]?test|fixture|intermediate)/i.test(
      asset.name,
    ),
  );
  if (forbidden.length) {
    throw new Error(
      `Forbidden release assets: ${forbidden.map((asset) => asset.name).join(", ")}`,
    );
  }

  const identity = releaseIdentity({ manifest });
  return {
    assets: assets.sort((left, right) => left.name.localeCompare(right.name)),
    manifest,
    manifestSha256: sha256(
      fs.readFileSync(path.join(releaseDir, "desktop-release.json")),
    ),
    releaseDir,
    name: identity.name,
    tag: identity.tag,
  };
}

function releaseBody(bundle) {
  const evidence = {
    schema: "myoxus.desktop-release-publication.v1",
    sourceCommit: bundle.manifest.sourceCommit,
    manifestSha256: bundle.manifestSha256,
    assets: bundle.assets.map(({ name, sha256: digest, size }) => ({
      name,
      sha256: digest,
      size,
    })),
  };
  return [
    bundle.name,
    "",
    "This release was promoted from the digest-bound Myoxus release gate.",
    "",
    ...(bundle.manifest.scope === "macos"
      ? [
          "macOS x64 and ARM64: DMG and ZIP, ad-hoc signed; no Apple Developer ID or notarization.",
          "ARM64 is cross-built on the Intel Mac: archive, architecture and dependency checks passed; native ARM64 runtime tests were not run.",
          "",
        ]
      : []),
    "<!-- myoxus-desktop-publication",
    JSON.stringify(evidence),
    "-->",
  ].join("\n");
}

async function request(
  fetchImpl,
  url,
  options,
  expectedStatuses,
  timeoutMs = 30_000,
) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: "manual",
    signal: options?.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (!expectedStatuses.includes(response.status)) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(
      `Forgejo ${options?.method ?? "GET"} ${new URL(url).pathname} failed with HTTP ${response.status}: ${detail}`,
    );
  }
  return response;
}

function authHeaders(token, json = false) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function assertReleaseShape(
  release,
  bundle,
  { allowLegacyDraftTarget = false } = {},
) {
  const targetMatches =
    release?.target_commitish === RELEASE_TARGET ||
    (allowLegacyDraftTarget &&
      release?.draft &&
      release?.target_commitish === bundle.manifest.sourceCommit);
  if (
    !release ||
    !Number.isSafeInteger(release.id) ||
    release.tag_name !== bundle.tag ||
    !targetMatches ||
    release.name !== bundle.name ||
    release.body !== releaseBody(bundle) ||
    release.prerelease !== (bundle.manifest.channel !== "stable") ||
    !Array.isArray(release.assets)
  ) {
    throw new Error(
      "Existing Forgejo release differs from local release identity",
    );
  }
}

function expectedDownloadPath(bundle, name) {
  return `/${OWNER}/${REPOSITORY}/releases/download/${bundle.tag}/${encodeURIComponent(name)}`;
}

function expectedDownloadPathForTag(tag, name) {
  return `/${OWNER}/${REPOSITORY}/releases/download/${tag}/${encodeURIComponent(name)}`;
}

async function downloadReleaseAsset({ fetchImpl, origin, remote, tag, token }) {
  if (
    !remote ||
    typeof remote.name !== "string" ||
    !Number.isSafeInteger(remote.size) ||
    remote.size < 0
  ) {
    throw new Error("Forgejo draft contains malformed asset metadata");
  }
  const downloadUrl = new URL(remote.browser_download_url);
  if (
    downloadUrl.origin !== origin ||
    downloadUrl.pathname !== expectedDownloadPathForTag(tag, remote.name) ||
    downloadUrl.search ||
    downloadUrl.hash
  ) {
    throw new Error(`Forgejo asset URL is non-canonical: ${remote.name}`);
  }
  const response = await request(
    fetchImpl,
    downloadUrl,
    { headers: authHeaders(token) },
    [200],
    15 * 60_000,
  );
  const contents = Buffer.from(await response.arrayBuffer());
  if (contents.length !== remote.size) {
    throw new Error(`Forgejo asset size differs: ${remote.name}`);
  }
  return contents;
}

async function verifyRemoteAssets({
  assets,
  bundle,
  fetchImpl,
  origin,
  token,
  requireComplete,
}) {
  const expected = new Map(bundle.assets.map((asset) => [asset.name, asset]));
  const names = new Set();
  for (const remote of assets) {
    const local = expected.get(remote.name);
    if (!local || names.has(remote.name) || remote.size !== local.size) {
      throw new Error(`Forgejo asset inventory differs at ${remote.name}`);
    }
    names.add(remote.name);
    const downloadUrl = new URL(remote.browser_download_url);
    if (
      downloadUrl.origin !== origin ||
      downloadUrl.pathname !== expectedDownloadPath(bundle, remote.name) ||
      downloadUrl.search ||
      downloadUrl.hash
    ) {
      throw new Error(`Forgejo asset URL is non-canonical: ${remote.name}`);
    }
    const response = await request(
      fetchImpl,
      downloadUrl,
      token ? { headers: authHeaders(token) } : {},
      [200],
      15 * 60_000,
    );
    const contents = Buffer.from(await response.arrayBuffer());
    if (contents.length !== local.size || sha256(contents) !== local.sha256) {
      throw new Error(`Forgejo asset bytes differ: ${remote.name}`);
    }
  }
  if (requireComplete && names.size !== expected.size) {
    throw new Error("Forgejo release does not contain the complete asset set");
  }
  return names;
}

async function getRelease({ bundle, fetchImpl, origin, token }) {
  const response = await request(
    fetchImpl,
    `${origin}${RELEASE_API}/tags/${bundle.tag}`,
    { headers: authHeaders(token) },
    [200, 404],
  );
  return response.status === 404 ? null : response.json();
}

export async function recoverDraftBundle({
  expectedSourceCommit,
  fetchImpl = fetch,
  origin = API_ORIGIN,
  releaseDirectory,
  tag,
  token,
}) {
  if (origin !== API_ORIGIN && fetchImpl === fetch) {
    throw new Error(
      "Production recovery origin must be https://git.blume29.de",
    );
  }
  if (typeof token !== "string" || token.length < 16 || /\s/.test(token)) {
    throw new Error("MYOXUS_RELEASE_TOKEN is required for draft recovery");
  }
  if (
    !/^(?:desktop|linux-client|windows-client|macos-client)-v\d+\.\d+\.\d+$/.test(
      tag ?? "",
    )
  ) {
    throw new Error("A canonical desktop release tag is required for recovery");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit ?? "")) {
    throw new Error("A full expected source commit is required for recovery");
  }

  const releaseDir = path.resolve(releaseDirectory);
  fs.mkdirSync(releaseDir, { recursive: true });
  if (fs.readdirSync(releaseDir).length !== 0) {
    throw new Error("Draft recovery directory must be empty");
  }

  const response = await request(
    fetchImpl,
    `${origin}${RELEASE_API}/tags/${encodeURIComponent(tag)}`,
    { headers: authHeaders(token) },
    [200],
  );
  const release = await response.json();
  if (
    !release ||
    !release.draft ||
    release.tag_name !== tag ||
    ![RELEASE_TARGET, expectedSourceCommit].includes(
      release.target_commitish,
    ) ||
    !Array.isArray(release.assets)
  ) {
    throw new Error("Forgejo draft recovery identity differs");
  }

  const remoteAssets = new Map();
  for (const remote of release.assets) {
    if (
      typeof remote?.name !== "string" ||
      remoteAssets.has(remote.name) ||
      remote.name !== path.posix.basename(remote.name)
    ) {
      throw new Error("Forgejo draft asset names are malformed or duplicated");
    }
    remoteAssets.set(remote.name, remote);
  }
  const checksumRemote = remoteAssets.get("SHA256SUMS");
  if (!checksumRemote) {
    throw new Error("Forgejo draft has no SHA256SUMS asset");
  }
  const checksumContents = await downloadReleaseAsset({
    fetchImpl,
    origin,
    remote: checksumRemote,
    tag,
    token,
  });
  const checksums = parseChecksumFile(checksumContents.toString("utf8"));
  const pathsByName = new Map();
  for (const [relative, digest] of checksums) {
    if (
      relative !== path.posix.normalize(relative) ||
      relative.startsWith("/") ||
      relative.startsWith("../") ||
      relative.includes("\\") ||
      !/^[a-f0-9]{64}$/.test(digest)
    ) {
      throw new Error("SHA256SUMS contains an unsafe recovery path");
    }
    const name = path.posix.basename(relative);
    if (name === "SHA256SUMS" || pathsByName.has(name)) {
      throw new Error("SHA256SUMS recovery asset names collide");
    }
    pathsByName.set(name, { digest, relative });
  }
  const expectedNames = new Set(["SHA256SUMS", ...pathsByName.keys()]);
  if (
    remoteAssets.size !== expectedNames.size ||
    [...remoteAssets.keys()].some((name) => !expectedNames.has(name))
  ) {
    throw new Error("Forgejo draft does not match its recovery checksum set");
  }

  fs.writeFileSync(path.join(releaseDir, "SHA256SUMS"), checksumContents);
  for (const [name, { digest, relative }] of pathsByName) {
    const contents = await downloadReleaseAsset({
      fetchImpl,
      origin,
      remote: remoteAssets.get(name),
      tag,
      token,
    });
    if (sha256(contents) !== digest) {
      throw new Error(`Forgejo draft checksum differs: ${name}`);
    }
    const destination = path.join(releaseDir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }

  const bundle = readPublishableBundle(releaseDir);
  if (
    bundle.tag !== tag ||
    bundle.manifest.sourceCommit !== expectedSourceCommit
  ) {
    throw new Error("Recovered Forgejo draft metadata differs");
  }
  assertReleaseShape(release, bundle, { allowLegacyDraftTarget: true });
  return bundle;
}

async function verifyPublicRelease({ bundle, fetchImpl, origin }) {
  const response = await request(
    fetchImpl,
    `${origin}${RELEASE_API}?page=1&limit=50`,
    { headers: { Accept: "application/json" } },
    [200],
  );
  const releases = await response.json();
  const matches = Array.isArray(releases)
    ? releases.filter((release) => release.tag_name === bundle.tag)
    : [];
  if (matches.length !== 1 || matches[0].draft) {
    throw new Error(
      "Published release is absent or ambiguous in the public feed",
    );
  }
  if (!Number.isFinite(Date.parse(matches[0].published_at))) {
    throw new Error("Published release has no valid publication timestamp");
  }
  assertReleaseShape(matches[0], bundle);
  await verifyRemoteAssets({
    assets: matches[0].assets,
    bundle,
    fetchImpl,
    origin,
    token: null,
    requireComplete: true,
  });
}

export async function publishBundle({
  bundle,
  fetchImpl = fetch,
  origin = API_ORIGIN,
  token,
}) {
  if (origin !== API_ORIGIN && fetchImpl === fetch) {
    throw new Error(
      "Production publication origin must be https://git.blume29.de",
    );
  }
  if (typeof token !== "string" || token.length < 16 || /\s/.test(token)) {
    throw new Error("MYOXUS_RELEASE_TOKEN is required for desktop publication");
  }

  let release = await getRelease({ bundle, fetchImpl, origin, token });
  if (release) {
    assertReleaseShape(release, bundle, { allowLegacyDraftTarget: true });
    const existingNames = await verifyRemoteAssets({
      assets: release.assets,
      bundle,
      fetchImpl,
      origin,
      token,
      requireComplete: !release.draft,
    });
    if (!release.draft) {
      await verifyPublicRelease({ bundle, fetchImpl, origin });
      return { release, reused: true };
    }
    release.existingNames = existingNames;
  } else {
    const response = await request(
      fetchImpl,
      `${origin}${RELEASE_API}`,
      {
        method: "POST",
        headers: authHeaders(token, true),
        body: JSON.stringify({
          tag_name: bundle.tag,
          target_commitish: RELEASE_TARGET,
          name: bundle.name,
          body: releaseBody(bundle),
          draft: true,
          prerelease: bundle.manifest.channel !== "stable",
        }),
      },
      [201],
    );
    release = await response.json();
    assertReleaseShape(release, bundle);
    if (!release.draft || release.assets.length !== 0) {
      throw new Error("New Forgejo release was not created as an empty draft");
    }
    release.existingNames = new Set();
  }

  for (const asset of bundle.assets) {
    if (release.existingNames.has(asset.name)) continue;
    const form = new FormData();
    form.append("attachment", new Blob([asset.contents]), asset.name);
    await request(
      fetchImpl,
      `${origin}${RELEASE_API}/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      { method: "POST", headers: authHeaders(token), body: form },
      [201],
      15 * 60_000,
    );
  }

  release = await getRelease({ bundle, fetchImpl, origin, token });
  assertReleaseShape(release, bundle, { allowLegacyDraftTarget: true });
  await verifyRemoteAssets({
    assets: release.assets,
    bundle,
    fetchImpl,
    origin,
    token,
    requireComplete: true,
  });
  const publishResponse = await request(
    fetchImpl,
    `${origin}${RELEASE_API}/${release.id}`,
    {
      method: "PATCH",
      headers: authHeaders(token, true),
      body: JSON.stringify({
        tag_name: bundle.tag,
        target_commitish: RELEASE_TARGET,
        name: bundle.name,
        body: releaseBody(bundle),
        draft: false,
        prerelease: bundle.manifest.channel !== "stable",
      }),
    },
    [200],
  );
  const published = await publishResponse.json();
  assertReleaseShape(published, bundle);
  if (published.draft) {
    throw new Error("Forgejo release remained a draft after publication");
  }
  await verifyPublicRelease({ bundle, fetchImpl, origin });
  return { release: published, reused: false };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "expected-source-commit": { type: "string" },
      "recover-draft-tag": { type: "string" },
      "release-dir": { type: "string" },
    },
    strict: true,
  });
  const token = process.env.MYOXUS_RELEASE_TOKEN;
  const recoveryTag = values["recover-draft-tag"];
  if (recoveryTag && values["release-dir"]) {
    throw new Error("--recover-draft-tag and --release-dir are exclusive");
  }
  if (!recoveryTag && !values["release-dir"]) {
    throw new Error("--release-dir is required");
  }
  let temporaryDirectory;
  try {
    const bundle = recoveryTag
      ? await recoverDraftBundle({
          expectedSourceCommit: values["expected-source-commit"],
          releaseDirectory: (temporaryDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), "myoxus-release-recovery-"),
          )),
          tag: recoveryTag,
          token,
        })
      : readPublishableBundle(values["release-dir"]);
    const result = await publishBundle({ bundle, token });
    const overview = await publishDesktopDistributionOverview({
      manifest: bundle.manifest,
      token,
    });
    process.stdout.write(
      `${result.reused ? "Verified existing" : "Published"} ${bundle.tag} to ${OWNER}/${REPOSITORY}.\n`,
    );
    process.stdout.write(`Distribution overview: ${overview.reason}.\n`);
  } finally {
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
