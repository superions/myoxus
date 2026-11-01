#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION = /^(?:localdev|[0-9a-f]{40}|[0-9a-f]{64})$/;
const CLIENT_ROLES = new Set(["web", "admin"]);

function readPackageVersion(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest.version !== "string" ||
    !SEMANTIC_VERSION.test(manifest.version)
  ) {
    throw new Error(
      `${manifestPath} does not declare a complete semantic version`,
    );
  }
  return manifest.version;
}

function readServerVersion(manifestPath) {
  const manifest = readFileSync(manifestPath, "utf8");
  const workspacePackage = manifest.split("[workspace.package]", 2)[1] ?? "";
  const match = workspacePackage.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match || !SEMANTIC_VERSION.test(match[1])) {
    throw new Error(
      `${manifestPath} does not declare workspace.package.version`,
    );
  }
  return match[1];
}

export function resolveDeclaredReleaseVersion({ repoRoot, role }) {
  if (CLIENT_ROLES.has(role)) {
    return readPackageVersion(path.join(repoRoot, "package.json"));
  }
  if (role === "server") {
    return readServerVersion(path.join(repoRoot, "server/Cargo.toml"));
  }
  throw new Error(`Unsupported release role: ${role}`);
}

export function createReleaseIdentity({ role, version, revision }) {
  if (!CLIENT_ROLES.has(role) && role !== "server") {
    throw new Error(`Unsupported release role: ${role}`);
  }
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error(
      `Invalid release version for ${role}: ${version || "<empty>"}`,
    );
  }
  if (!REVISION.test(revision)) {
    throw new Error(
      `Invalid Git revision for ${role}: expected a full commit SHA or localdev`,
    );
  }

  if (CLIENT_ROLES.has(role)) {
    return {
      schemaVersion: 1,
      role,
      clientVersion: version,
      editorVersion: version,
      revision,
    };
  }

  return {
    schemaVersion: 1,
    role,
    serverVersion: version,
    revision,
  };
}

export function resolveReleaseIdentity({
  repoRoot,
  role,
  revision,
  expectedVersion,
}) {
  const version = resolveDeclaredReleaseVersion({ repoRoot, role });
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(
      `${role} build version ${expectedVersion || "<empty>"} does not match its authoritative source ${version}`,
    );
  }
  return createReleaseIdentity({ role, version, revision });
}

export function writeReleaseIdentity({ outputPath, identity }) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, {
      mode: 0o644,
    });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--print-version") {
      values.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Usage: write-release-identity.mjs --role web|admin|server --revision <full-sha|localdev> [--expected-version <version>] [--output <path>] [--print-version]",
      );
    }
    values.set(key, value);
    index += 1;
  }
  return values;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const role = args.get("--role");
    const revision = args.get("--revision");
    if (typeof role !== "string" || typeof revision !== "string") {
      throw new Error("--role and --revision are required");
    }

    const repoRoot = path.resolve(args.get("--repo") ?? ".");
    const expectedVersion = args.get("--expected-version");
    const identity = resolveReleaseIdentity({
      repoRoot,
      role,
      revision,
      expectedVersion,
    });
    const version =
      role === "server" ? identity.serverVersion : identity.clientVersion;
    const output = args.get("--output");
    if (typeof output === "string") {
      writeReleaseIdentity({
        outputPath: path.resolve(output),
        identity,
      });
    }

    if (args.has("--print-version")) {
      console.log(version);
    } else if (typeof output !== "string") {
      console.log(JSON.stringify(identity, null, 2));
    }
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
