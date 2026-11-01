#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createReleaseIdentity } from "../release/write-release-identity.mjs";

const OCI_SOURCE = "https://github.com/superions/myoxus";
const OCI_TITLES = {
  admin: "Myoxus Admin static artifact",
  server: "Myoxus Server",
  web: "Myoxus Web static artifact",
};

function readVersion(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`${manifestPath} does not declare a version`);
  }
  return manifest.version;
}

function readServerVersion(manifestPath) {
  const manifest = readFileSync(manifestPath, "utf8");
  const workspacePackage = manifest.split("[workspace.package]", 2)[1] ?? "";
  const match = workspacePackage.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      `${manifestPath} does not declare workspace.package.version`,
    );
  }
  return match[1];
}

function collectFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? collectFiles(path.join(directory, entry.name), relativePath)
      : [relativePath];
  });
}

function resolveArtifactPath(buildDirectory, relativePath) {
  if (typeof relativePath !== "string" || !relativePath) {
    throw new Error("Built frontend assets manifest contains an invalid path");
  }
  const buildRoot = path.resolve(buildDirectory);
  const artifactPath = path.resolve(buildRoot, relativePath);
  if (!artifactPath.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error(
      `Built frontend assets manifest escapes its artifact root: ${relativePath}`,
    );
  }
  return artifactPath;
}

function embeddedVersions(source, key) {
  const values = new Set();
  const expression = new RegExp(
    `["']?${key}["']?\\s*:\\s*["'](\\d+\\.\\d+\\.\\d+(?:[-+][^"']+)*)["']`,
    "g",
  );
  for (const match of source.matchAll(expression)) {
    values.add(match[1]);
  }
  return values;
}

function assertExactObject(actual, expected, description) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw new Error(`${description} is not a JSON object`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `${description} keys mismatch: expected ${expectedKeys.join(", ")}, found ${actualKeys.join(", ") || "none"}`,
    );
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key] !== expectedValue) {
      throw new Error(
        `${description} ${key} mismatch: expected ${expectedValue}, found ${String(actual[key])}`,
      );
    }
  }
}

export function verifyStaticReleaseIdentity({
  identity,
  role,
  version,
  revision,
}) {
  if (!revision) {
    throw new Error("A Git revision is required to verify release.json");
  }
  const expected = createReleaseIdentity({ role, version, revision });
  assertExactObject(identity, expected, `${role} release.json`);
  return expected;
}

export function verifyOciReleaseIdentity({ labels, role, version, revision }) {
  if (!Object.hasOwn(OCI_TITLES, role)) {
    throw new Error(`Unsupported OCI release role: ${role}`);
  }
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error(`${role} OCI image has no labels`);
  }
  const expected = {
    "org.opencontainers.image.title": OCI_TITLES[role],
    "org.opencontainers.image.version": version,
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.source": OCI_SOURCE,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (labels[key] !== expectedValue) {
      throw new Error(
        `${role} OCI label ${key} mismatch: expected ${expectedValue}, found ${String(labels[key])}`,
      );
    }
  }
  if (Object.hasOwn(labels, "org.opencontainers.image.licenses")) {
    throw new Error(
      `${role} OCI image must not declare org.opencontainers.image.licenses`,
    );
  }
  return expected;
}

export function verifyBuiltReleaseIdentity({
  buildDirectory,
  rootVersion,
  distributionVersion,
  role = "web",
  revision,
  releaseIdentity,
  imageLabels,
  workerSource,
}) {
  if (role !== "web" && role !== "admin") {
    throw new Error(`Unsupported frontend release role: ${role}`);
  }
  if (!existsSync(buildDirectory) || !statSync(buildDirectory).isDirectory()) {
    throw new Error(
      `Built frontend directory does not exist: ${buildDirectory}`,
    );
  }

  const manifestPath = path.join(buildDirectory, "assets-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Built frontend assets manifest is missing: ${manifestPath}`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.js) || manifest.js.length === 0) {
    throw new Error("Built frontend assets manifest has no JavaScript entries");
  }

  const entrySources = manifest.js.map((relativePath) => {
    const artifactPath = resolveArtifactPath(buildDirectory, relativePath);
    if (!existsSync(artifactPath)) {
      throw new Error(
        `Manifest JavaScript artifact is missing: ${relativePath}`,
      );
    }
    return readFileSync(artifactPath, "utf8");
  });
  const emittedJavaScript = entrySources.join("\n");

  for (const key of ["appVersion", "editorVersion"]) {
    const values = embeddedVersions(emittedJavaScript, key);
    if (
      !values.has(rootVersion) ||
      [...values].some((value) => value !== rootVersion)
    ) {
      throw new Error(
        `Built ${key} identity mismatch: expected only ${rootVersion}, found ${
          [...values].join(", ") || "no emitted value"
        }`,
      );
    }
  }

  const workerPattern = /-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.worker\.js$/;
  const workers = collectFiles(buildDirectory).filter((file) =>
    workerPattern.test(file),
  );
  const mismatchedWorkers = workers.filter((file) => {
    const match = file.match(workerPattern);
    return match?.[1] !== rootVersion;
  });
  if (mismatchedWorkers.length > 0) {
    throw new Error(
      `Built worker version mismatch: ${mismatchedWorkers.join(", ")}`,
    );
  }

  const storageWorker = `js/storage-${rootVersion}.worker.js`;
  if (role === "web" && !workers.includes(storageWorker)) {
    throw new Error(`Expected built worker is missing: ${storageWorker}`);
  }

  // Distribution versions remain useful in direct negative fixtures, but
  // private application workspaces deliberately do not own product versions.
  if (
    distributionVersion !== undefined &&
    distributionVersion !== rootVersion &&
    workers.some((file) => file.includes(`-${distributionVersion}.worker.js`))
  ) {
    throw new Error(
      `Internal package version leaked into a built worker: ${distributionVersion}`,
    );
  }

  if (workerSource && role === "web") {
    const resolver = readFileSync(workerSource, "utf8");
    if (!resolver.includes("`${name}-${BUILD_CONFIG.appVersion}.worker.js`")) {
      throw new Error(
        `Worker URL resolver does not derive its filename from BUILD_CONFIG.appVersion: ${workerSource}`,
      );
    }
  }

  if (releaseIdentity !== undefined) {
    verifyStaticReleaseIdentity({
      identity: releaseIdentity,
      role,
      version: rootVersion,
      revision,
    });
  }
  if (imageLabels !== undefined) {
    verifyOciReleaseIdentity({
      labels: imageLabels,
      role,
      version: rootVersion,
      revision,
    });
  }

  return {
    role,
    rootVersion,
    distributionVersion,
    revision,
    storageWorker: role === "web" ? storageWorker : null,
    workers,
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: verify-built-release-identity.mjs --role web|admin|server --revision <sha|localdev> --image-inspect <json> [--build-dir <dir> --root-manifest <package.json> --release-json <json>]",
      );
    }
    values.set(key, value);
  }
  return values;
}

function readImageLabels(inspectPath) {
  const inspection = JSON.parse(readFileSync(inspectPath, "utf8"));
  const image = Array.isArray(inspection) ? inspection[0] : inspection;
  return image?.Config?.Labels;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const role = args.get("--role") ?? "web";
    const revision = args.get("--revision");
    const imageInspect = args.get("--image-inspect");

    if (role === "server") {
      if (!revision || !imageInspect) {
        throw new Error(
          "Server verification requires --revision and --image-inspect",
        );
      }
      const version = readServerVersion(
        path.resolve(args.get("--server-manifest") ?? "server/Cargo.toml"),
      );
      const result = verifyOciReleaseIdentity({
        labels: readImageLabels(path.resolve(imageInspect)),
        role,
        version,
        revision,
      });
      console.log(
        JSON.stringify({ role, version, revision, labels: result }, null, 2),
      );
    } else {
      const rootManifest = path.resolve(
        args.get("--root-manifest") ?? "package.json",
      );
      const rootVersion = readVersion(rootManifest);
      const releaseJson = args.get("--release-json");
      if (!args.has("--build-dir")) {
        if (!revision || !imageInspect || !releaseJson) {
          throw new Error(
            "Frontend OCI verification requires --revision, --image-inspect and --release-json",
          );
        }
        const releaseIdentity = JSON.parse(
          readFileSync(path.resolve(releaseJson), "utf8"),
        );
        const labels = readImageLabels(path.resolve(imageInspect));
        verifyStaticReleaseIdentity({
          identity: releaseIdentity,
          role,
          version: rootVersion,
          revision,
        });
        verifyOciReleaseIdentity({
          labels,
          role,
          version: rootVersion,
          revision,
        });
        console.log(
          JSON.stringify(
            { role, version: rootVersion, revision, labels },
            null,
            2,
          ),
        );
      } else {
        const buildDirectory = path.resolve(args.get("--build-dir"));
        const distributionManifest = args.get("--distribution-manifest");
        const workerSource = path.resolve(
          args.get("--worker-source") ?? "client/libs/env/src/worker.ts",
        );
        const result = verifyBuiltReleaseIdentity({
          buildDirectory,
          rootVersion,
          distributionVersion: distributionManifest
            ? readVersion(path.resolve(distributionManifest))
            : undefined,
          role,
          revision,
          releaseIdentity: releaseJson
            ? JSON.parse(readFileSync(path.resolve(releaseJson), "utf8"))
            : undefined,
          imageLabels: imageInspect
            ? readImageLabels(path.resolve(imageInspect))
            : undefined,
          workerSource,
        });
        console.log(JSON.stringify(result, null, 2));
      }
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
