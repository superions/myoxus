#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  verifyOciReleaseIdentity,
  verifyStaticReleaseIdentity,
} from "./verify-built-release-identity.mjs";

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(
        "Usage: verify-container-build-evidence.mjs --evidence-dir <dir> --role server|web|admin --revision <full-sha> --version <semver> --publish-mode true|false",
      );
    }
    if (values.has(key)) fail(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  return values;
}

function requiredArgument(values, name) {
  const value = values.get(name);
  if (!value) fail(`Missing ${name}`);
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(
      `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readImage(file) {
  const inspection = readJson(file);
  const image = Array.isArray(inspection) ? inspection[0] : inspection;
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    fail(`${file} does not contain one Docker image inspection`);
  }
  return image;
}

function assertRequiredEvidence(directory, requiredFiles) {
  const sealFiles = ["ARTIFACTS.md", "SHA256SUMS"];
  // Producers may attach additional reports. Their presence does not change
  // the required image identity or source/license checks.
  const sealed = sealFiles.every((file) =>
    statSync(path.join(directory, file), { throwIfNoEntry: false })?.isFile(),
  );
  for (const file of requiredFiles) {
    const target = path.join(directory, file);
    const info = statSync(target, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size === 0) {
      fail(`Container evidence file is absent or empty: ${file}`);
    }
  }
  return sealed;
}

function repoDigests(image) {
  if (image.RepoDigests === undefined || image.RepoDigests === null) return [];
  if (!Array.isArray(image.RepoDigests)) {
    fail("Docker image inspection RepoDigests is not an array");
  }
  return image.RepoDigests;
}

function assertDigestMode({ image, publishMode, role }) {
  const digests = repoDigests(image);
  if (!publishMode && digests.length > 0) {
    fail(`${role} no-publish evidence claims a registry digest`);
  }
  for (const digest of digests) {
    if (!/@sha256:[0-9a-f]{64}$/.test(digest)) {
      fail(`${role} image inspection contains an invalid registry digest`);
    }
  }
  return digests;
}

function propertyValue(properties, name) {
  if (!Array.isArray(properties)) return undefined;
  return properties.find((property) => property?.name === name)?.value;
}

function verifyServerEvidence({ directory, revision, version, publishMode }) {
  const requiredFiles = [
    "server-image-inspect.json",
    "server-oci.cdx.json",
    "server-os-packages.tsv",
  ];
  const sealed = assertRequiredEvidence(directory, requiredFiles);
  const image = readImage(path.join(directory, "server-image-inspect.json"));
  const digests = assertDigestMode({ image, publishMode, role: "server" });
  verifyOciReleaseIdentity({
    labels: image.Config?.Labels,
    role: "server",
    version,
    revision,
  });

  const sbom = readJson(path.join(directory, "server-oci.cdx.json"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.5") {
    fail("Server OCI evidence is not CycloneDX 1.5");
  }
  const component = sbom.metadata?.component;
  if (component?.type !== "container" || component.version !== version) {
    fail("Server OCI SBOM root does not match the expected container version");
  }
  const properties = component.properties;
  if (propertyValue(properties, "myoxus:git-revision") !== revision) {
    fail("Server OCI SBOM revision does not match the candidate revision");
  }
  const expectedKind = publishMode ? "registry-manifest" : "local-image";
  if (propertyValue(properties, "myoxus:oci-digest-kind") !== expectedKind) {
    fail(`Server OCI SBOM digest kind must be ${expectedKind}`);
  }
  const digest = propertyValue(properties, "myoxus:oci-digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    fail("Server OCI SBOM has no immutable SHA-256 identity");
  }
  if (publishMode) {
    if (digests.length === 0) {
      fail("Published server evidence has no registry manifest digest");
    }
    if (!digests.some((value) => value.endsWith(`@${digest}`))) {
      fail("Server OCI SBOM digest does not match the image registry digest");
    }
  } else if (image.Id !== digest) {
    fail("Server OCI SBOM local-image digest does not match the image ID");
  }
  return { sealed, files: requiredFiles };
}

function verifyFrontendEvidence({
  directory,
  revision,
  version,
  publishMode,
  role,
}) {
  const requiredFiles = [`${role}-image-inspect.json`, `${role}-release.json`];
  const sealed = assertRequiredEvidence(directory, requiredFiles);
  const image = readImage(path.join(directory, `${role}-image-inspect.json`));
  assertDigestMode({ image, publishMode, role });
  verifyOciReleaseIdentity({
    labels: image.Config?.Labels,
    role,
    version,
    revision,
  });
  verifyStaticReleaseIdentity({
    identity: readJson(path.join(directory, `${role}-release.json`)),
    role,
    version,
    revision,
  });
  return { sealed, files: requiredFiles };
}

try {
  const args = parseArguments(process.argv.slice(2));
  const directory = path.resolve(requiredArgument(args, "--evidence-dir"));
  const role = requiredArgument(args, "--role");
  const revision = requiredArgument(args, "--revision");
  const version = requiredArgument(args, "--version");
  const publishModeValue = requiredArgument(args, "--publish-mode");

  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail("Container evidence requires a full lowercase 40-character Git SHA");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Container evidence requires a complete semantic version: ${version}`);
  }
  if (publishModeValue !== "true" && publishModeValue !== "false") {
    fail("--publish-mode must be true or false");
  }
  if (!["server", "web", "admin"].includes(role)) {
    fail(`Unsupported container evidence role: ${role}`);
  }
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`Container evidence directory does not exist: ${directory}`);
  }

  const input = {
    directory,
    role,
    revision,
    version,
    publishMode: publishModeValue === "true",
  };
  const result =
    role === "server"
      ? verifyServerEvidence(input)
      : verifyFrontendEvidence(input);
  console.log(
    JSON.stringify(
      { role, version, revision, publishMode: input.publishMode, ...result },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`[FAIL] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
