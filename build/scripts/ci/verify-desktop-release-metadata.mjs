// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { loadSourceTool, verifySourceTools } from "./source-tools.mjs";

// Publication runs in a fresh checkout without installing build dependencies.
// Reuse the provisioned YAML runtime, with the same lock check as source gates.
verifySourceTools(undefined, ["yaml"]);
const { parse: parseYaml } = loadSourceTool("yaml");

const exactManifestKeys = [
  "artifacts",
  "channel",
  "publishable",
  "provenance",
  "schema",
  "scope",
  "sourceCommit",
  "target",
  "updateMetadata",
  "version",
];
const exactArtifactKeys = [
  "arch",
  "format",
  "name",
  "path",
  "platform",
  "sbom",
  "sha256",
  "sha512",
  "signature",
  "size",
];
const artifactPattern =
  /^myoxus-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(stable|beta|internal)-(linux|macos|windows)-(arm64|x64)\.(deb|dmg|exe|flatpak|rpm|zip)$/;
const expectedMatrix = {
  full: [
    ["linux", "x64", "deb"],
    ["linux", "x64", "flatpak"],
    ["linux", "x64", "rpm"],
    ["macos", "arm64", "dmg"],
    ["macos", "arm64", "zip"],
    ["macos", "x64", "dmg"],
    ["macos", "x64", "zip"],
    ["windows", "x64", "exe"],
    ["windows", "x64", "zip"],
  ],
  linux: [
    ["linux", "x64", "deb"],
    ["linux", "x64", "flatpak"],
    ["linux", "x64", "rpm"],
  ],
  windows: [
    ["windows", "x64", "exe"],
    ["windows", "x64", "zip"],
  ],
  macos: [
    ["macos", "arm64", "dmg"],
    ["macos", "arm64", "zip"],
    ["macos", "x64", "dmg"],
    ["macos", "x64", "zip"],
  ],
};

function digest(contents, algorithm, encoding = "hex") {
  return crypto.createHash(algorithm).update(contents).digest(encoding);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has invalid fields: ${actual.join(", ")}`);
  }
}

function resolveContained(root, relative, label) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a canonical relative path`);
  }
  const absolute = path.join(root, relative);
  const relation = path.relative(root, absolute);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`${label} escapes the release directory`);
  }
  return absolute;
}

function expectedArtifactNames(manifest) {
  return expectedMatrix[manifest.scope]
    .map(
      ([platform, arch, format]) =>
        `myoxus-${manifest.version}-${manifest.channel}-${platform}-${arch}.${format}`,
    )
    .sort();
}

function assertManifestIdentity(manifest) {
  if (!Object.hasOwn(expectedMatrix, manifest.scope)) {
    throw new Error(
      "Desktop release scope must be linux, windows, macos, or full",
    );
  }
  if (!/^(?:stable|beta|internal)$/.test(manifest.channel)) {
    throw new Error("Desktop release channel is invalid");
  }
  const versionMatch = String(manifest.version).match(
    /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/,
  );
  const prereleaseChannel = versionMatch?.[2]?.split(".", 1)[0] ?? null;
  if (
    !versionMatch ||
    (manifest.channel === "stable"
      ? prereleaseChannel !== null
      : prereleaseChannel !== manifest.channel)
  ) {
    throw new Error("Desktop release version and channel disagree");
  }
  if (typeof manifest.publishable !== "boolean") {
    throw new Error("Desktop release publishable state must be boolean");
  }
}

function assertSignature(artifact, manifest) {
  if (!artifact.signature || typeof artifact.signature !== "object") {
    throw new Error(`${artifact.name} has no signature evidence`);
  }
  if (artifact.platform === "linux") {
    assertExactKeys(
      artifact.signature,
      ["status", "verifier"],
      `${artifact.name} signature`,
    );
    if (
      artifact.signature.status !== "not-applicable" ||
      artifact.signature.verifier !== "package-digest"
    ) {
      throw new Error(`${artifact.name} has invalid Linux signature evidence`);
    }
    return;
  }
  if (artifact.signature.status === "unsigned-test") {
    assertExactKeys(
      artifact.signature,
      ["status", "verifier"],
      `${artifact.name} signature`,
    );
    if (artifact.signature.verifier !== "none" || manifest.publishable) {
      throw new Error(`${artifact.name} has invalid unsigned-test evidence`);
    }
    return;
  }
  if (artifact.signature.status === "ad-hoc") {
    assertExactKeys(
      artifact.signature,
      ["status", "verifier"],
      `${artifact.name} signature`,
    );
    if (
      artifact.platform !== "macos" ||
      manifest.scope !== "macos" ||
      artifact.signature.verifier !== "codesign" ||
      !manifest.publishable
    ) {
      throw new Error(`${artifact.name} has invalid ad-hoc evidence`);
    }
    return;
  }
  if (artifact.signature.status === "unsigned") {
    assertExactKeys(
      artifact.signature,
      ["status", "verifier"],
      `${artifact.name} signature`,
    );
    if (
      artifact.platform !== "windows" ||
      manifest.scope !== "windows" ||
      artifact.signature.verifier !== "none" ||
      !manifest.publishable
    ) {
      throw new Error(`${artifact.name} has invalid unsigned evidence`);
    }
    return;
  }
  assertExactKeys(
    artifact.signature,
    ["certificateFingerprint", "status", "timestamp", "verifier"],
    `${artifact.name} signature`,
  );
  const expectedVerifier =
    artifact.platform === "macos" ? "codesign" : "authenticode";
  if (
    ["windows", "macos"].includes(manifest.scope) ||
    artifact.signature.status !== "signed" ||
    artifact.signature.verifier !== expectedVerifier ||
    !/^[A-Fa-f0-9:]{32,}$/.test(artifact.signature.certificateFingerprint) ||
    !Number.isFinite(Date.parse(artifact.signature.timestamp))
  ) {
    throw new Error(`${artifact.name} has invalid signed evidence`);
  }
}

function verifyProvenance(releaseDir, manifest) {
  assertExactKeys(
    manifest.provenance,
    ["path", "sha256"],
    "desktop release provenance",
  );
  if (!/^[a-f0-9]{64}$/.test(manifest.provenance.sha256)) {
    throw new Error("Desktop release provenance digest is invalid");
  }
  if (manifest.provenance.path !== "desktop-provenance.json") {
    throw new Error("Desktop release provenance path is non-canonical");
  }
  const provenancePath = resolveContained(
    releaseDir,
    manifest.provenance.path,
    "desktop release provenance",
  );
  const contents = fs.readFileSync(provenancePath);
  if (digest(contents, "sha256") !== manifest.provenance.sha256) {
    throw new Error("Desktop release provenance digest differs");
  }
  const provenance = JSON.parse(contents.toString("utf8"));
  assertExactKeys(
    provenance,
    ["build", "materials", "release", "schema", "source", "subjects"],
    "desktop provenance",
  );
  assertExactKeys(
    provenance.source,
    ["commit", "repository"],
    "provenance source",
  );
  assertExactKeys(
    provenance.build,
    ["builderId", "generatedAt", "runId"],
    "provenance build",
  );
  assertExactKeys(
    provenance.release,
    ["channel", "version"],
    "provenance release",
  );
  if (
    provenance.schema !== "myoxus.desktop-provenance.v1" ||
    provenance.source.commit !== manifest.sourceCommit ||
    provenance.release.version !== manifest.version ||
    provenance.release.channel !== manifest.channel ||
    !Number.isFinite(Date.parse(provenance.build.generatedAt))
  ) {
    throw new Error(
      "Desktop provenance identity differs from release metadata",
    );
  }
  if (
    manifest.publishable &&
    (!["myoxus/myoxus", "Roekvar-Lab/affine-fork"].includes(
      provenance.source.repository,
    ) ||
      !/^(?:[1-9]\d*)$/.test(provenance.build.runId) ||
      provenance.build.builderId !==
        `https://git.blume29.de/${provenance.source.repository}/actions/runs/${provenance.build.runId}`)
  ) {
    throw new Error(
      "Publishable provenance lacks canonical Forgejo build identity",
    );
  }
  if (
    !Array.isArray(provenance.materials) ||
    provenance.materials.length !== 1
  ) {
    throw new Error(
      "Desktop provenance must contain exactly one SBOM material",
    );
  }
  const material = provenance.materials[0];
  assertExactKeys(material, ["path", "sha256", "type"], "provenance material");
  const sbom = manifest.artifacts[0]?.sbom;
  if (
    material.type !== "cyclonedx-1.5" ||
    material.path !== sbom?.path ||
    material.sha256 !== sbom?.sha256
  ) {
    throw new Error("Desktop provenance SBOM material differs");
  }
  if (!Array.isArray(provenance.subjects)) {
    throw new Error("Desktop provenance subjects must be an array");
  }
  const expectedSubjects = manifest.artifacts
    .map(({ name, path: artifactPath, sha256, size }) => ({
      name,
      path: artifactPath,
      sha256,
      size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const [index, subject] of provenance.subjects.entries()) {
    assertExactKeys(
      subject,
      ["name", "path", "sha256", "size"],
      `provenance subjects[${index}]`,
    );
  }
  if (
    JSON.stringify(
      [...provenance.subjects].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ) !== JSON.stringify(expectedSubjects)
  ) {
    throw new Error(
      "Desktop provenance subjects differ from release artifacts",
    );
  }
}

export function verifyReleaseMetadata(releaseDir, requirePublishable = false) {
  const manifestPath = path.join(releaseDir, "desktop-release.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assertExactKeys(manifest, exactManifestKeys, "desktop release manifest");
  if (manifest.schema !== "myoxus.desktop-release.v1") {
    throw new Error("Desktop release schema is invalid");
  }
  if (
    manifest.target?.owner !== "myoxus" ||
    manifest.target?.repository !== "packages" ||
    Object.keys(manifest.target ?? {}).length !== 2
  ) {
    throw new Error("Desktop release target must be exactly myoxus/packages");
  }
  assertExactKeys(
    manifest.updateMetadata,
    ["path", "sha256"],
    "desktop release update metadata",
  );
  if (!/^[a-f0-9]{64}$/.test(manifest.updateMetadata.sha256)) {
    throw new Error("Desktop release update metadata digest is invalid");
  }
  if (manifest.updateMetadata.path !== "latest.yml") {
    throw new Error("Desktop release update metadata path is non-canonical");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) {
    throw new Error("Desktop release source commit is invalid");
  }
  assertManifestIdentity(manifest);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("Desktop release contains no artifacts");
  }
  verifyProvenance(releaseDir, manifest);
  if (requirePublishable && manifest.publishable !== true) {
    throw new Error("Desktop release is not publishable");
  }
  const inventory = manifest.artifacts.map((artifact) => artifact.name).sort();
  if (
    JSON.stringify(inventory) !==
    JSON.stringify(expectedArtifactNames(manifest))
  ) {
    throw new Error(
      "Desktop release artifact inventory is incomplete or unexpected",
    );
  }

  const names = new Set();
  const sbomPaths = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    assertExactKeys(artifact, exactArtifactKeys, `artifacts[${index}]`);
    if (names.has(artifact.name)) {
      throw new Error(`Duplicate desktop artifact ${artifact.name}`);
    }
    names.add(artifact.name);
    if (path.basename(artifact.path) !== artifact.name) {
      throw new Error(`${artifact.name} path and name differ`);
    }
    const identity = artifact.name.match(artifactPattern);
    if (
      !identity ||
      identity[1] !== manifest.version ||
      identity[2] !== manifest.channel ||
      identity[3] !== artifact.platform ||
      identity[4] !== artifact.arch ||
      identity[5] !== artifact.format
    ) {
      throw new Error(`${artifact.name} identity fields disagree`);
    }
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512)
    ) {
      throw new Error(`${artifact.name} has invalid digest metadata`);
    }
    const file = resolveContained(releaseDir, artifact.path, artifact.name);
    const contents = fs.readFileSync(file);
    if (
      contents.length !== artifact.size ||
      digest(contents, "sha256") !== artifact.sha256 ||
      digest(contents, "sha512", "base64") !== artifact.sha512
    ) {
      throw new Error(`${artifact.name} metadata differs from artifact bytes`);
    }
    assertSignature(artifact, manifest);
    assertExactKeys(artifact.sbom, ["path", "sha256"], `${artifact.name} SBOM`);
    if (!/^[a-f0-9]{64}$/.test(artifact.sbom.sha256)) {
      throw new Error(`${artifact.name} has an invalid SBOM digest`);
    }
    const sbom = resolveContained(
      releaseDir,
      artifact.sbom?.path,
      `${artifact.name} SBOM`,
    );
    const sbomContents = fs.readFileSync(sbom);
    if (digest(sbomContents, "sha256") !== artifact.sbom?.sha256) {
      throw new Error(`${artifact.name} SBOM digest differs`);
    }
    sbomPaths.add(artifact.sbom.path);
  }

  const latestPath = resolveContained(
    releaseDir,
    manifest.updateMetadata?.path,
    "update metadata",
  );
  const latestContents = fs.readFileSync(latestPath);
  if (digest(latestContents, "sha256") !== manifest.updateMetadata?.sha256) {
    throw new Error("latest.yml digest differs from desktop release manifest");
  }
  const latest = parseYaml(latestContents.toString("utf8"));
  if (
    latest?.version !== manifest.version ||
    !Array.isArray(latest.files) ||
    latest.files.length === 0 ||
    !Number.isFinite(Date.parse(latest.releaseDate))
  ) {
    throw new Error("latest.yml does not match the desktop release version");
  }
  const updateNames = new Set();
  for (const file of latest.files) {
    const artifact = manifest.artifacts.find((item) => item.name === file.url);
    if (
      !artifact ||
      updateNames.has(file.url) ||
      file.sha512 !== artifact.sha512 ||
      file.size !== artifact.size ||
      !["deb", "rpm", "exe", "zip"].includes(artifact.format) ||
      (artifact.format === "zip" && artifact.platform !== "macos")
    ) {
      throw new Error(`latest.yml has invalid artifact ${file.url}`);
    }
    updateNames.add(file.url);
  }
  const expectedUpdateNames = manifest.artifacts
    .filter(
      (artifact) =>
        ["deb", "rpm", "exe"].includes(artifact.format) ||
        (artifact.format === "zip" && artifact.platform === "macos"),
    )
    .map((artifact) => artifact.name)
    .sort();
  if (
    JSON.stringify([...updateNames].sort()) !==
    JSON.stringify(expectedUpdateNames)
  ) {
    throw new Error(
      "latest.yml does not contain the exact updater artifact set",
    );
  }

  for (const sbomPath of sbomPaths) {
    const sbom = JSON.parse(
      fs.readFileSync(path.join(releaseDir, sbomPath), "utf8"),
    );
    if (
      sbom.bomFormat !== "CycloneDX" ||
      sbom.specVersion !== "1.5" ||
      !Array.isArray(sbom.components) ||
      sbom.components.length === 0
    ) {
      throw new Error(`${sbomPath} is not a non-empty CycloneDX 1.5 SBOM`);
    }
  }
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      "release-dir": { type: "string" },
      "require-publishable": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values["release-dir"]) throw new Error("--release-dir is required");
  const releaseDir = path.resolve(values["release-dir"]);
  const manifest = verifyReleaseMetadata(
    releaseDir,
    values["require-publishable"],
  );
  process.stdout.write(
    `Verified ${manifest.scope} desktop release metadata for ${manifest.artifacts.length} artifacts.\n`,
  );
}
