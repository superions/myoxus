// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import {
  publishBundle,
  readPublishableBundle,
  recoverDraftBundle,
} from "./publish-electron-release.mjs";
import { verifyReleaseMetadata } from "./verify-desktop-release-metadata.mjs";
import { writeReleaseMetadata } from "./write-desktop-release-metadata.mjs";

const origin = "https://forgejo.test.invalid";
const token = "fixture-release-token";
const sourceCommit = "a".repeat(40);
const releaseTarget = "main";
const version = "0.40.0";
const fullMatrix = [
  ["linux", "x64", "deb"],
  ["linux", "x64", "flatpak"],
  ["linux", "x64", "rpm"],
  ["macos", "arm64", "dmg"],
  ["macos", "arm64", "zip"],
  ["macos", "x64", "dmg"],
  ["macos", "x64", "zip"],
  ["windows", "x64", "exe"],
  ["windows", "x64", "zip"],
];
const linuxMatrix = fullMatrix.filter(([platform]) => platform === "linux");
const windowsMatrix = fullMatrix.filter(([platform]) => platform === "windows");

function digest(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function createBundleFixture(
  root,
  scope = "full",
  checksumMarker = " ",
  archived = false,
  identity = {},
) {
  const version = identity.version ?? "0.40.0";
  const channel = identity.channel ?? "stable";
  if (![" ", "*"].includes(checksumMarker)) {
    throw new Error("Fixture checksum marker must be text or binary");
  }
  const matrix =
    scope === "linux"
      ? linuxMatrix
      : scope === "windows"
        ? windowsMatrix
        : scope === "macos"
          ? fullMatrix.filter(([platform]) => platform === "macos")
          : fullMatrix;
  fs.mkdirSync(path.join(root, "packages"), { recursive: true });
  fs.mkdirSync(path.join(root, "sbom"), { recursive: true });
  const signatures = {};
  for (const [platform, arch, format] of matrix) {
    const name = `myoxus-${version}-${channel}-${platform}-${arch}.${format}`;
    fs.writeFileSync(path.join(root, "packages", name), `bytes:${name}\n`);
    if (scope === "macos") {
      signatures[name] = {
        status: "ad-hoc",
        verifier: "codesign",
        sha256: digest(fs.readFileSync(path.join(root, "packages", name))),
      };
    } else if (platform !== "linux" && scope !== "windows") {
      signatures[name] = {
        status: "signed",
        verifier: platform === "macos" ? "codesign" : "authenticode",
        certificateFingerprint: "AA:".repeat(31) + "AA",
        timestamp: "2026-07-23T00:00:00.000Z",
      };
    }
  }
  const sbom = path.join(root, "sbom", `myoxus-desktop-${version}.cdx.json`);
  fs.writeFileSync(
    sbom,
    `${JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        component: { type: "application", name: "myoxus-desktop", version },
      },
      components: [
        { type: "framework", name: "electron", version: "44.4.5" },
        { type: "library", name: "mediabunny", version: "1.50.9" },
      ],
    })}\n`,
  );
  const signaturesPath = path.join(root, "signatures.json");
  fs.writeFileSync(signaturesPath, `${JSON.stringify(signatures)}\n`);
  process.env.SOURCE_DATE_EPOCH = "0";
  writeReleaseMetadata({
    allowUnsignedTest: false,
    builderId: "https://git.blume29.de/myoxus/myoxus/actions/runs/41",
    channel,
    releaseDir: root,
    sbom,
    scope,
    signatureEvidence: signaturesPath,
    sourceCommit,
    sourceRepository: "myoxus/myoxus",
    runId: "41",
    version,
  });
  if (archived) {
    // Simulate retained pre-cut artifact metadata; the current writer never emits it.
    const filename = path.join(root, "desktop-provenance.json");
    const provenance = JSON.parse(fs.readFileSync(filename, "utf8"));
    provenance.source.repository = "Roekvar-Lab/affine-fork";
    provenance.build.builderId =
      "https://git.blume29.de/Roekvar-Lab/affine-fork/actions/runs/41";
    fs.writeFileSync(filename, JSON.stringify(provenance));
    const manifestPath = path.join(root, "desktop-release.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.provenance.sha256 = digest(fs.readFileSync(filename));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  fs.rmSync(signaturesPath);
  fs.writeFileSync(path.join(root, "ARTIFACTS.md"), "# Artifacts\n");
  fs.writeFileSync(path.join(root, "RELEASE.md"), "# Release\n");
  const files = [];
  for (const entry of fs.readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    files.push(
      `${digest(fs.readFileSync(absolute))} ${checksumMarker}${relative}`,
    );
  }
  fs.writeFileSync(
    path.join(root, "SHA256SUMS"),
    `${files.sort().join("\n")}\n`,
  );
  return readPublishableBundle(root);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createForgejoFixture({
  failPublishOnce = false,
  failUploadOnce = false,
  failCaskOnce = false,
  tag,
}) {
  if (!tag) throw new Error("Forgejo fixture tag is required");
  let release = null;
  const bytes = new Map();
  let publishFailed = false;
  let uploadFailed = false;
  let uploadCount = 0;
  let caskFailed = false;
  const casks = new Map();
  let caskWrites = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const authenticated = init.headers?.Authorization === `Bearer ${token}`;
    const releaseRoot = "/api/v1/repos/myoxus/packages/releases";
    const caskPrefix = "/api/v1/repos/myoxus/packages/contents/Casks/";
    if (url.pathname.startsWith(caskPrefix)) {
      const file = url.pathname.slice(caskPrefix.length);
      const source = casks.get(file);
      if (method === "GET")
        return source === undefined
          ? new Response("missing", { status: 404 })
          : json({
              sha: digest(source),
              encoding: "base64",
              content: Buffer.from(source).toString("base64"),
            });
      if (!authenticated || !release || release.draft)
        throw new Error("Casks cannot precede verified publication");
      if (failCaskOnce && !caskFailed) {
        caskFailed = true;
        return new Response("injected Cask failure", { status: 500 });
      }
      const body = JSON.parse(init.body);
      if (
        method !== (source === undefined ? "POST" : "PUT") ||
        (source !== undefined && body.sha !== digest(source))
      )
        return new Response("conflict", { status: 409 });
      casks.set(file, Buffer.from(body.content, "base64").toString("utf8"));
      caskWrites++;
      return json(
        { content: { sha: digest(casks.get(file)) } },
        source === undefined ? 201 : 200,
      );
    }
    if (url.pathname.startsWith(releaseRoot) && !authenticated) {
      if (url.pathname !== releaseRoot || url.search !== "?page=1&limit=50") {
        return new Response("unauthorized", { status: 401 });
      }
      return json(release && !release.draft ? [release] : []);
    }
    if (url.pathname === `${releaseRoot}/tags/${tag}`) {
      return release ? json(release) : new Response("missing", { status: 404 });
    }
    if (url.pathname === releaseRoot && method === "POST") {
      const body = JSON.parse(init.body);
      if (body.target_commitish !== releaseTarget) {
        return json({ message: "invalid package release target" }, 422);
      }
      release = { id: 41, ...body, assets: [] };
      return json(release, 201);
    }
    if (url.pathname === `${releaseRoot}/41/assets` && method === "POST") {
      if (failUploadOnce && !uploadFailed && uploadCount === 1) {
        uploadFailed = true;
        return new Response("injected upload failure", { status: 500 });
      }
      const name = url.searchParams.get("name");
      const attachment = init.body.get("attachment");
      const contents = Buffer.from(await attachment.arrayBuffer());
      bytes.set(name, contents);
      release.assets.push({
        name,
        size: contents.length,
        browser_download_url: `${origin}/myoxus/packages/releases/download/${tag}/${name}`,
      });
      uploadCount += 1;
      return json(release.assets.at(-1), 201);
    }
    if (url.pathname === `${releaseRoot}/41` && method === "PATCH") {
      const body = JSON.parse(init.body);
      const expected = {
        tag_name: release.tag_name,
        target_commitish: releaseTarget,
        name: release.name,
        body: release.body,
        draft: false,
        prerelease: release.prerelease,
      };
      if (JSON.stringify(body) !== JSON.stringify(expected)) {
        return json({ message: "incomplete release edit" }, 500);
      }
      if (failPublishOnce && !publishFailed) {
        publishFailed = true;
        return json({ message: "injected publication failure" }, 500);
      }
      Object.assign(release, body);
      release.published_at = "2026-07-23T00:00:00.000Z";
      return json(release);
    }
    const downloadPrefix = `/myoxus/packages/releases/download/${tag}/`;
    if (url.pathname.startsWith(downloadPrefix)) {
      const contents = bytes.get(
        decodeURIComponent(url.pathname.slice(downloadPrefix.length)),
      );
      return contents
        ? new Response(contents, { status: 200 })
        : new Response("missing", { status: 404 });
    }
    return new Response("unexpected fixture request", { status: 500 });
  };
  return {
    fetchImpl,
    casks,
    get caskWrites() {
      return caskWrites;
    },
    corruptReleaseBody() {
      release.body = "foreign release";
    },
    get uploadCount() {
      return uploadCount;
    },
    useLegacyDraftTarget() {
      if (!release?.draft) {
        throw new Error("Legacy target fixture requires an existing draft");
      }
      release.target_commitish = sourceCommit;
    },
  };
}

async function expectFailure(label, action, pattern) {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error))) return;
    throw new Error(`${label} failed for the wrong reason: ${error}`);
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-publisher-"));
try {
  const bundle = createBundleFixture(root);
  const forgejo = createForgejoFixture({
    failUploadOnce: true,
    tag: bundle.tag,
  });
  await expectFailure(
    "interrupted upload",
    () =>
      publishBundle({ bundle, fetchImpl: forgejo.fetchImpl, origin, token }),
    /injected upload failure/,
  );
  const uploadCountBeforeRetry = forgejo.uploadCount;
  const result = await publishBundle({
    bundle,
    fetchImpl: forgejo.fetchImpl,
    origin,
    token,
  });
  if (result.reused || forgejo.uploadCount !== bundle.assets.length) {
    throw new Error("Draft retry did not resume the exact missing asset set");
  }
  const afterPublicationUploads = forgejo.uploadCount;
  const retry = await publishBundle({
    bundle,
    fetchImpl: forgejo.fetchImpl,
    origin,
    token,
  });
  if (
    !retry.reused ||
    forgejo.uploadCount !== afterPublicationUploads ||
    forgejo.caskWrites !== 1
  ) {
    throw new Error("Published retry was not an idempotent verification");
  }
  // The existing publisher fixture owns repeated-release safety. Include Cask
  // failures here so public channel pins cannot drift or force a package rebuild.
  for (const caskChannel of ["beta", "internal"]) {
    const caskVersion = `0.40.0-${caskChannel}.2`;
    const caskRoot = path.join(root, `cask-${caskChannel}`);
    try {
      const caskBundle = createBundleFixture(caskRoot, "macos", " ", false, {
        channel: caskChannel,
        version: caskVersion,
      });
      const remote = createForgejoFixture({
        tag: caskBundle.tag,
        failCaskOnce: true,
      });
      const publish = () =>
        publishBundle({
          bundle: caskBundle,
          fetchImpl: remote.fetchImpl,
          origin,
          token,
        });
      await expectFailure(
        "retryable Cask write",
        publish,
        /injected Cask failure/,
      );
      const retainedUploads = remote.uploadCount;
      const recovered = await publish();
      const caskName = `myoxus-${caskChannel}.rb`;
      const source = remote.casks.get(caskName);
      if (
        !recovered.reused ||
        !source ||
        remote.uploadCount !== retainedUploads ||
        remote.caskWrites !== 1
      )
        throw new Error("Cask retry rebuilt or reuploaded release assets");
      await publish();
      if (remote.caskWrites !== 1 || remote.casks.size !== 1)
        throw new Error("Cask retry is not channel-isolated/idempotent");
      remote.casks.set(
        caskName,
        source.replaceAll(caskVersion, `0.40.0-${caskChannel}.10`),
      );
      await publish();
      if (remote.caskWrites !== 1)
        throw new Error("Publisher downgraded a newer Cask");
      const dmgHash = caskBundle.manifest.artifacts.find(
        (a) => a.format === "dmg",
      ).sha256;
      remote.casks.set(caskName, source.replace(dmgHash, "0".repeat(64)));
      await expectFailure(
        "immutable same-version Cask",
        publish,
        /same-version content\/digest conflict/,
      );
    } finally {
      fs.rmSync(caskRoot, { recursive: true, force: true });
    }
  }
  if (uploadCountBeforeRetry !== 1) {
    throw new Error("Interrupted fixture did not retain one verified asset");
  }
  const recoveryForgejo = createForgejoFixture({
    failPublishOnce: true,
    tag: bundle.tag,
  });
  await expectFailure(
    "interrupted publication",
    () =>
      publishBundle({
        bundle,
        fetchImpl: recoveryForgejo.fetchImpl,
        origin,
        token,
      }),
    /injected publication failure/,
  );
  recoveryForgejo.useLegacyDraftTarget();
  const recoveryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-publisher-recovery-"),
  );
  try {
    const recoveredBundle = await recoverDraftBundle({
      expectedSourceCommit: sourceCommit,
      fetchImpl: recoveryForgejo.fetchImpl,
      origin,
      releaseDirectory: recoveryRoot,
      tag: bundle.tag,
      token,
    });
    const recoveredResult = await publishBundle({
      bundle: recoveredBundle,
      fetchImpl: recoveryForgejo.fetchImpl,
      origin,
      token,
    });
    if (
      recoveredResult.reused ||
      recoveryForgejo.uploadCount !== bundle.assets.length
    ) {
      throw new Error("Draft publication recovery was not atomic");
    }
  } finally {
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }
  await expectFailure(
    "missing credential",
    () =>
      publishBundle({
        bundle,
        fetchImpl: forgejo.fetchImpl,
        origin,
        token: "",
      }),
    /MYOXUS_RELEASE_TOKEN/,
  );
  forgejo.corruptReleaseBody();
  await expectFailure(
    "release identity collision",
    () =>
      publishBundle({ bundle, fetchImpl: forgejo.fetchImpl, origin, token }),
    /differs from local release identity/,
  );
  const provenancePath = path.join(root, "desktop-provenance.json");
  const provenance = fs.readFileSync(provenancePath);
  fs.appendFileSync(provenancePath, "tamper\n");
  await expectFailure(
    "provenance digest",
    async () => readPublishableBundle(root),
    /provenance digest differs/,
  );
  fs.writeFileSync(provenancePath, provenance);
  fs.writeFileSync(path.join(root, "fixture.nupkg"), "forbidden");
  await expectFailure(
    "publish allowlist",
    async () => readPublishableBundle(root),
    /publish allowlist differs/,
  );
  const linuxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-linux-publisher-"),
  );
  try {
    const linuxBundle = createBundleFixture(linuxRoot, "linux");
    // A build workspace's node_modules must not hide publisher checkout defects.
    const freshCheckout = path.join(linuxRoot, "fresh-checkout");
    const runtime = path.join(linuxRoot, "provisioned-tools");
    const require = createRequire(import.meta.url);
    const yamlPackage = require.resolve("yaml/package.json");
    fs.mkdirSync(path.join(runtime, "node_modules"), { recursive: true });
    fs.cpSync(
      path.dirname(yamlPackage),
      path.join(runtime, "node_modules/yaml"),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(path.join(runtime, "package.json"), "{}\n");
    fs.mkdirSync(path.join(freshCheckout, "build/scripts/ci"), {
      recursive: true,
    });
    for (const name of [
      "package.json",
      "yarn.lock",
      "build/scripts/ci/source-tools.mjs",
      "build/scripts/ci/verify-desktop-release-metadata.mjs",
    ]) {
      fs.copyFileSync(
        new URL(`../../../${name}`, import.meta.url),
        path.join(freshCheckout, name),
      );
    }
    const verifyFresh = () =>
      spawnSync(
        process.execPath,
        [
          "build/scripts/ci/verify-desktop-release-metadata.mjs",
          "--release-dir",
          linuxRoot,
          "--require-publishable",
        ],
        {
          cwd: freshCheckout,
          env: { ...process.env, MYOXUS_CI_SOURCE_TOOLS: runtime },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
    const verified = verifyFresh();
    if (verified.error || verified.status !== 0) {
      throw new Error(
        `Fresh publication checkout failed: ${verified.error ?? verified.stderr}`,
      );
    }
    const yamlMetadataPath = path.join(
      runtime,
      "node_modules/yaml/package.json",
    );
    const yamlMetadata = JSON.parse(fs.readFileSync(yamlMetadataPath, "utf8"));
    fs.writeFileSync(
      yamlMetadataPath,
      JSON.stringify({ ...yamlMetadata, version: "0.0.0" }),
    );
    const stale = verifyFresh();
    if (
      stale.error ||
      stale.status === 0 ||
      !/does not match yarn.lock/.test(stale.stderr)
    ) {
      throw new Error(
        "Fresh publication checkout must reject a stale YAML runtime",
      );
    }
    fs.rmSync(freshCheckout, { recursive: true });
    fs.rmSync(runtime, { recursive: true });
    if (
      linuxBundle.tag !== `linux-client-v${version}` ||
      linuxBundle.name !== `Myoxus Linux Client ${version}` ||
      linuxBundle.manifest.artifacts.length !== 3
    ) {
      throw new Error("Linux client publication identity is invalid");
    }
    const linuxForgejo = createForgejoFixture({ tag: linuxBundle.tag });
    const linuxResult = await publishBundle({
      bundle: linuxBundle,
      fetchImpl: linuxForgejo.fetchImpl,
      origin,
      token,
    });
    if (linuxResult.reused) {
      throw new Error("New Linux client release was unexpectedly reused");
    }
  } finally {
    fs.rmSync(linuxRoot, { force: true, recursive: true });
  }
  const windowsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-windows-publisher-"),
  );
  try {
    const windowsBundle = createBundleFixture(windowsRoot, "windows", "*");
    if (
      windowsBundle.tag !== `windows-client-v${version}` ||
      windowsBundle.name !== `Myoxus Windows Client ${version}` ||
      windowsBundle.manifest.artifacts.length !== 2 ||
      windowsBundle.manifest.artifacts.some(
        (artifact) =>
          artifact.signature.status !== "unsigned" ||
          artifact.signature.verifier !== "none",
      )
    ) {
      throw new Error("Windows client publication identity is invalid");
    }
    const windowsManifestPath = path.join(windowsRoot, "desktop-release.json");
    const windowsManifestSource = fs.readFileSync(windowsManifestPath, "utf8");
    const falselySignedManifest = JSON.parse(windowsManifestSource);
    falselySignedManifest.artifacts[0].signature = {
      certificateFingerprint: "AA:".repeat(31) + "AA",
      status: "signed",
      timestamp: "2026-07-23T00:00:00.000Z",
      verifier: "authenticode",
    };
    fs.writeFileSync(
      windowsManifestPath,
      `${JSON.stringify(falselySignedManifest, null, 2)}\n`,
    );
    await expectFailure(
      "normal Windows scope cannot claim Authenticode",
      async () => verifyReleaseMetadata(windowsRoot, true),
      /invalid signed evidence/,
    );
    fs.writeFileSync(windowsManifestPath, windowsManifestSource);
    const windowsForgejo = createForgejoFixture({ tag: windowsBundle.tag });
    const windowsResult = await publishBundle({
      bundle: windowsBundle,
      fetchImpl: windowsForgejo.fetchImpl,
      origin,
      token,
    });
    if (windowsResult.reused) {
      throw new Error("New Windows client release was unexpectedly reused");
    }
  } finally {
    fs.rmSync(windowsRoot, { force: true, recursive: true });
  }
  const macRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-macos-publisher-"),
  );
  const macRecovery = fs.mkdtempSync(
    path.join(os.tmpdir(), "myoxus-macos-recovery-"),
  );
  try {
    const macBundle = createBundleFixture(macRoot, "macos");
    if (
      macBundle.tag !== `macos-client-v${version}` ||
      macBundle.name !== `Myoxus macOS Client ${version}` ||
      macBundle.manifest.artifacts.length !== 4 ||
      macBundle.manifest.artifacts.some((a) => a.signature.status !== "ad-hoc")
    ) {
      throw new Error(
        "macOS client publication identity or architecture set is invalid",
      );
    }
    const macForgejo = createForgejoFixture({
      tag: macBundle.tag,
      failPublishOnce: true,
    });
    await expectFailure(
      "interrupted macOS publication",
      () =>
        publishBundle({
          bundle: macBundle,
          fetchImpl: macForgejo.fetchImpl,
          origin,
          token,
        }),
      /injected publication failure/,
    );
    const recovered = await recoverDraftBundle({
      expectedSourceCommit: sourceCommit,
      fetchImpl: macForgejo.fetchImpl,
      origin,
      releaseDirectory: macRecovery,
      tag: macBundle.tag,
      token,
    });
    await publishBundle({
      bundle: recovered,
      fetchImpl: macForgejo.fetchImpl,
      origin,
      token,
    });
    const uploads = macForgejo.uploadCount;
    const retried = await publishBundle({
      bundle: macBundle,
      fetchImpl: macForgejo.fetchImpl,
      origin,
      token,
    });
    if (!retried.reused || uploads !== macForgejo.uploadCount) {
      throw new Error("macOS publication retry uploaded duplicate assets");
    }
  } finally {
    fs.rmSync(macRoot, { recursive: true, force: true });
    fs.rmSync(macRecovery, { recursive: true, force: true });
  }
  const archivedRoot = path.join(root, "archived-metadata-fixture");
  createBundleFixture(archivedRoot, "linux", " ", true);
  verifyReleaseMetadata(archivedRoot, true);
  process.stdout.write(
    `Desktop, Linux, Windows and macOS client publisher contracts passed.\n`,
  );
} finally {
  fs.rmSync(root, { force: true, recursive: true });
}
