// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { stringify as stringifyYaml } from "yaml";
import { readSourceProvenance } from "../release/source-correspondence.mjs";

const artifactPattern =
  /^myoxus-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(stable|beta|internal)-(linux|macos|windows)-(arm64|x64)\.(deb|dmg|exe|flatpak|rpm|zip)$/;
const forbiddenNamePattern =
  /(?:^RELEASES$|Update\.exe|squirrel|\.nupkg$|unsigned[-_.]?test|fixture|intermediate)/i;
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
const scopeMatrices = {
  full: fullMatrix,
  linux: linuxMatrix,
  windows: windowsMatrix,
  macos: fullMatrix.filter(([platform]) => platform === "macos"),
};

function digest(contents, algorithm, encoding = "hex") {
  return crypto.createHash(algorithm).update(contents).digest(encoding);
}

function canonicalPath(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Artifact escapes release directory: ${file}`);
  }
  return relative;
}

function walk(root) {
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
      else files.push(absolute);
    }
  }
  return files.sort();
}

function expectedArtifactNames(version, channel, scope) {
  const matrix = scopeMatrices[scope];
  if (!matrix) throw new Error(`Unsupported release scope: ${scope}`);
  return matrix.map(
    ([platform, arch, format]) =>
      `myoxus-${version}-${channel}-${platform}-${arch}.${format}`,
  );
}

function channelMatchesVersion(version, channel) {
  const prerelease = version.split("-", 2)[1]?.split(".", 1)[0] ?? null;
  return channel === "stable" ? prerelease === null : prerelease === channel;
}

function readSbom(file, version) {
  const sbom = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    sbom.bomFormat !== "CycloneDX" ||
    sbom.specVersion !== "1.5" ||
    !Array.isArray(sbom.components) ||
    sbom.components.length === 0
  ) {
    throw new Error("Desktop SBOM is not a non-empty CycloneDX 1.5 document");
  }
  const componentNames = new Set(
    sbom.components.map((component) => String(component.name ?? "")),
  );
  for (const dependency of ["electron", "mediabunny"]) {
    if (!componentNames.has(dependency)) {
      throw new Error(`Desktop SBOM is missing ${dependency}`);
    }
  }
  const rootVersion = String(sbom.metadata?.component?.version ?? "");
  if (rootVersion && rootVersion !== version) {
    throw new Error(
      `Desktop SBOM root version ${rootVersion} differs from release ${version}`,
    );
  }
  return sbom;
}

function readSignatureEvidence(file) {
  if (!file) return new Map();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some((name) => forbiddenNamePattern.test(name))
  ) {
    throw new Error("Signature evidence must be an artifact-name object");
  }
  return new Map(Object.entries(parsed));
}

function signatureFor(artifact, evidence, allowUnsignedTest, scope) {
  if (artifact.platform === "linux") {
    return { status: "not-applicable", verifier: "package-digest" };
  }
  if (
    artifact.platform === "windows" &&
    scope === "windows" &&
    !allowUnsignedTest
  ) {
    if (evidence.has(artifact.name)) {
      throw new Error(
        `Normal Windows scope must not claim signing evidence: ${artifact.name}`,
      );
    }
    return { status: "unsigned", verifier: "none" };
  }
  const entry = evidence.get(artifact.name);
  if (
    artifact.platform === "macos" &&
    scope === "macos" &&
    !allowUnsignedTest
  ) {
    if (
      entry?.status !== "ad-hoc" ||
      entry.verifier !== "codesign" ||
      entry.sha256 !==
        digest(fs.readFileSync(artifact.absolutePath), "sha256") ||
      Object.keys(entry).sort().join(",") !== "sha256,status,verifier"
    ) {
      throw new Error(
        `macOS client lacks digest-bound ad-hoc evidence: ${artifact.name}`,
      );
    }
    return { status: "ad-hoc", verifier: "codesign" };
  }
  if (entry?.status === "signed") {
    const expectedVerifier =
      artifact.platform === "macos" ? "codesign" : "authenticode";
    if (
      entry.verifier !== expectedVerifier ||
      typeof entry.certificateFingerprint !== "string" ||
      !/^[A-Fa-f0-9:]{32,}$/.test(entry.certificateFingerprint) ||
      typeof entry.timestamp !== "string" ||
      !Number.isFinite(Date.parse(entry.timestamp))
    ) {
      throw new Error(`Invalid signature evidence for ${artifact.name}`);
    }
    return {
      status: "signed",
      verifier: expectedVerifier,
      certificateFingerprint: entry.certificateFingerprint,
      timestamp: new Date(entry.timestamp).toISOString(),
    };
  }
  if (allowUnsignedTest) {
    return { status: "unsigned-test", verifier: "none" };
  }
  throw new Error(`Signed target artifact lacks evidence: ${artifact.name}`);
}

function collectArtifacts({ releaseDir, version, channel, scope }) {
  const releaseFiles = walk(releaseDir);
  const invalidPackages = releaseFiles.filter(
    (file) =>
      /\.(?:deb|dmg|exe|flatpak|nupkg|rpm|zip)$/i.test(file) &&
      !artifactPattern.test(path.basename(file)),
  );
  if (invalidPackages.length) {
    throw new Error(
      `Release contains package files outside the naming contract: ${invalidPackages.map((file) => canonicalPath(releaseDir, file)).join(", ")}`,
    );
  }
  const candidates = releaseFiles
    .filter((file) => artifactPattern.test(path.basename(file)))
    .map((file) => {
      const name = path.basename(file);
      const match = name.match(artifactPattern);
      return {
        absolutePath: file,
        name,
        version: match[1],
        channel: match[2],
        platform: match[3],
        arch: match[4],
        format: match[5],
      };
    });
  const names = candidates.map((artifact) => artifact.name).sort();
  const expected = expectedArtifactNames(version, channel, scope).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `Desktop artifact inventory differs. Expected ${expected.join(", ")}; got ${names.join(", ")}`,
    );
  }
  for (const artifact of candidates) {
    if (artifact.version !== version || artifact.channel !== channel) {
      throw new Error(
        `Artifact identity differs from release: ${artifact.name}`,
      );
    }
  }
  const forbidden = walk(releaseDir)
    .map((file) => path.basename(file))
    .filter((name) => forbiddenNamePattern.test(name));
  if (forbidden.length) {
    throw new Error(`Forbidden release artifacts: ${forbidden.join(", ")}`);
  }
  return candidates.sort((left, right) => left.name.localeCompare(right.name));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeReleaseMetadata(options) {
  const releaseDir = path.resolve(options.releaseDir);
  const sbomPath = path.resolve(options.sbom);
  if (!fs.statSync(releaseDir).isDirectory()) {
    throw new Error(`Release directory is missing: ${releaseDir}`);
  }
  if (!channelMatchesVersion(options.version, options.channel)) {
    throw new Error(
      `Version ${options.version} does not belong to ${options.channel}`,
    );
  }
  const publicSource = readSourceProvenance(
    options.sourceProvenance ?? process.env.MYOXUS_SOURCE_PROVENANCE,
    options.sourceCommit,
  );
  readSbom(sbomPath, options.version);
  const sbomRelativePath = canonicalPath(releaseDir, sbomPath);
  const sbomSha256 = digest(fs.readFileSync(sbomPath), "sha256");
  const signatureEvidence = readSignatureEvidence(options.signatureEvidence);
  const artifacts = collectArtifacts(options).map((artifact) => {
    const contents = fs.readFileSync(artifact.absolutePath);
    return {
      name: artifact.name,
      path: canonicalPath(releaseDir, artifact.absolutePath),
      platform: artifact.platform,
      arch: artifact.arch,
      format: artifact.format,
      size: contents.length,
      sha256: digest(contents, "sha256"),
      sha512: digest(contents, "sha512", "base64"),
      sbom: { path: sbomRelativePath, sha256: sbomSha256 },
      signature: signatureFor(
        artifact,
        signatureEvidence,
        options.allowUnsignedTest,
        options.scope,
      ),
    };
  });

  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH ?? "";
  if (!/^(?:0|[1-9]\d*)$/.test(sourceDateEpoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  const releaseDate = new Date(Number(sourceDateEpoch) * 1000);
  if (!Number.isFinite(releaseDate.getTime())) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported date range");
  }
  const sourceRepository = options.sourceRepository ?? "local/repository";
  const builderId = options.builderId ?? "local";
  const runId = options.runId ?? "manual";
  const provenance = {
    schema: "myoxus.desktop-provenance.v1",
    source: {
      repository: sourceRepository,
      commit: options.sourceCommit,
      ...(publicSource ? { publicSource } : {}),
    },
    build: {
      builderId,
      runId,
      generatedAt: releaseDate.toISOString(),
    },
    release: {
      version: options.version,
      channel: options.channel,
    },
    materials: [
      {
        path: sbomRelativePath,
        sha256: sbomSha256,
        type: "cyclonedx-1.5",
      },
    ],
    subjects: artifacts.map(({ name, path: artifactPath, sha256, size }) => ({
      name,
      path: artifactPath,
      sha256,
      size,
    })),
  };
  const provenancePath = path.join(releaseDir, "desktop-provenance.json");
  writeJson(provenancePath, provenance);
  const provenanceContents = fs.readFileSync(provenancePath);

  const updateFiles = artifacts
    .filter(
      (artifact) =>
        artifact.format === "deb" ||
        artifact.format === "rpm" ||
        artifact.format === "exe" ||
        (artifact.platform === "macos" && artifact.format === "zip"),
    )
    .map((artifact) => ({
      url: artifact.name,
      sha512: artifact.sha512,
      size: artifact.size,
    }));
  const latest = {
    version: options.version,
    files: updateFiles,
    releaseDate: releaseDate.toISOString(),
  };
  const latestPath = path.join(releaseDir, "latest.yml");
  fs.writeFileSync(latestPath, stringifyYaml(latest, { lineWidth: 0 }));
  const latestContents = fs.readFileSync(latestPath);

  const publishable =
    Object.hasOwn(scopeMatrices, options.scope) &&
    sourceRepository === "myoxus/myoxus" &&
    /^(?:[1-9]\d*)$/.test(runId) &&
    builderId ===
      `https://git.blume29.de/myoxus/myoxus/actions/runs/${runId}` &&
    artifacts.every(
      (artifact) => artifact.signature.status !== "unsigned-test",
    );
  const manifest = {
    schema: "myoxus.desktop-release.v1",
    version: options.version,
    channel: options.channel,
    sourceCommit: options.sourceCommit,
    scope: options.scope,
    publishable,
    provenance: {
      path: "desktop-provenance.json",
      sha256: digest(provenanceContents, "sha256"),
    },
    target: { owner: "myoxus", repository: "packages" },
    updateMetadata: {
      path: "latest.yml",
      sha256: digest(latestContents, "sha256"),
    },
    artifacts,
  };
  writeJson(path.join(releaseDir, "desktop-release.json"), manifest);
  return manifest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      "allow-unsigned-test": { type: "boolean", default: false },
      "builder-id": { type: "string" },
      channel: { type: "string" },
      "release-dir": { type: "string" },
      sbom: { type: "string" },
      scope: { type: "string", default: "full" },
      "signature-evidence": { type: "string" },
      "source-commit": { type: "string" },
      "source-repository": { type: "string" },
      "source-provenance": { type: "string" },
      "run-id": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });

  for (const key of [
    "channel",
    "release-dir",
    "sbom",
    "source-commit",
    "version",
  ]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  if (!["stable", "beta", "internal"].includes(values.channel)) {
    throw new Error(`Unsupported release channel: ${values.channel}`);
  }
  if (!["linux", "windows", "macos", "full"].includes(values.scope)) {
    throw new Error(`Unsupported release scope: ${values.scope}`);
  }
  if (!/^[a-f0-9]{40}$/.test(values["source-commit"])) {
    throw new Error("--source-commit must be the full 40-character Git commit");
  }

  const manifest = writeReleaseMetadata({
    allowUnsignedTest: values["allow-unsigned-test"],
    builderId: values["builder-id"],
    channel: values.channel,
    releaseDir: values["release-dir"],
    sbom: values.sbom,
    scope: values.scope,
    signatureEvidence: values["signature-evidence"],
    sourceCommit: values["source-commit"],
    sourceRepository: values["source-repository"],
    sourceProvenance: values["source-provenance"],
    runId: values["run-id"],
    version: values.version,
  });
  process.stdout.write(
    `Wrote ${manifest.scope} desktop release metadata for ${manifest.artifacts.length} artifacts.\n`,
  );
}
