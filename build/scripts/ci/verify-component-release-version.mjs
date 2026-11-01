#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const component = args.get("--component");
const releaseRef = args.get("--release-ref");

if (
  !component ||
  !releaseRef ||
  !["server", "frontends", "desktop"].includes(component)
) {
  console.error(
    "Usage: verify-component-release-version.mjs --component server|frontends|desktop --release-ref <tag>",
  );
  process.exit(2);
}

function packageVersion(path) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`${path} does not declare a package version`);
  }
  return manifest.version;
}

function serverVersion() {
  const manifest = readFileSync("server/Cargo.toml", "utf8");
  const workspacePackage = manifest.split("[workspace.package]", 2)[1] ?? "";
  const match = workspacePackage.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      "server/Cargo.toml does not declare workspace.package.version",
    );
  }
  return match[1];
}

let versions;
if (component === "server") {
  versions = [["server/Cargo.toml", serverVersion()]];
} else if (component === "desktop") {
  versions = [
    [
      "client/apps/electron/package.json",
      packageVersion("client/apps/electron/package.json"),
    ],
  ];
} else {
  versions = [["package.json", packageVersion("package.json")]];
}

const declaredVersions = new Set(versions.map(([, version]) => version));
if (declaredVersions.size !== 1) {
  console.error(`${component} release version drift:`);
  for (const [path, version] of versions) {
    console.error(`  ${version}\t${path}`);
  }
  process.exit(1);
}

const [declaredVersion] = declaredVersions;
if (!["manual", "wip"].includes(releaseRef) && releaseRef !== declaredVersion) {
  console.error(
    `${component} release tag ${releaseRef} does not match declared version ${declaredVersion}`,
  );
  process.exit(1);
}

console.log(`${component} release version: ${declaredVersion}`);
