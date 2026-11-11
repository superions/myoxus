#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

# Fail-closed version and behavior contract for the JavaScript Yjs runtime and
# both Rust yrs workspaces. Version ranges are intentionally not accepted here:
# persisted CRDT bytes cross all three runtimes and therefore require one
# reviewed protocol set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
YJS_TARGET="${YJS_TARGET:-13.6.32}"
Y_PROTOCOLS_TARGET="${Y_PROTOCOLS_TARGET:-1.0.7}"
YRS_TARGET="${YRS_TARGET:-0.28.0-myoxus.1}"
DIAGNOSTIC="$REPO_ROOT/build/scripts/test/cargo-diagnostic.sh"

cd "$REPO_ROOT"

node - "$YJS_TARGET" "$Y_PROTOCOLS_TARGET" "$YRS_TARGET" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [yjsTarget, protocolsTarget, yrsTarget] = process.argv.slice(2);
const fail = (message) => {
  throw new Error(message);
};
const read = (file) => fs.readFileSync(file, "utf8");
const packageFiles = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".yarn") continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.name === "package.json") packageFiles.push(target);
  }
}

visit("client");
visit("virgultum");
packageFiles.push("package.json");

const expectedYjsRange = `^${yjsTarget}`;
const expectedProtocolsRange = `^${protocolsTarget}`;
const patchNeedle = `patch:yjs@npm%3A${yjsTarget}#~/.yarn/patches/`;
for (const file of packageFiles) {
  const manifest = JSON.parse(read(file));
  const declarations = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  const yjs = declarations.yjs;
  if (yjs && yjs !== expectedYjsRange && !yjs.startsWith(patchNeedle)) {
    fail(`${file}: yjs must target ${yjsTarget}, got ${yjs}`);
  }
  const protocols = declarations["y-protocols"];
  if (protocols && protocols !== expectedProtocolsRange) {
    fail(
      `${file}: y-protocols must target ${protocolsTarget}, got ${protocols}`,
    );
  }
}

const root = JSON.parse(read("package.json"));
const resolution = root.resolutions?.yjs;
if (!resolution?.startsWith(patchNeedle)) {
  fail(`root yjs resolution must select the ${yjsTarget} patch, got ${resolution}`);
}
const patchPath = resolution.slice(resolution.indexOf("#~/") + 3);
if (!fs.existsSync(patchPath)) fail(`resolved yjs patch is missing: ${patchPath}`);
const patch = read(patchPath);
const removedUint32 = patch.match(/^-.*generateNewClientId.*uint32/gm)?.length ?? 0;
const addedUint53 = patch.match(/^\+.*generateNewClientId.*uint53/gm)?.length ?? 0;
if (removedUint32 !== 3 || addedUint53 !== 3) {
  fail(
    `yjs patch must replace exactly three uint32 client-id sites, got ${removedUint32}/${addedUint53}`,
  );
}

const yarnLock = read("yarn.lock");
if (!yarnLock.includes(`version: ${yjsTarget}`)) {
  fail(`yarn.lock does not materialize yjs ${yjsTarget}`);
}
if (!yarnLock.includes(`version: ${protocolsTarget}`)) {
  fail(`yarn.lock does not materialize y-protocols ${protocolsTarget}`);
}
if (/yjs-npm-13\.6\.(?:21|30|31)/.test(yarnLock)) {
  fail("yarn.lock still references an obsolete Myoxus yjs patch");
}

function yarnVersions(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^"?${escaped}@[^\\n]*"?:\\n  version: ([^\\n]+)$`,
    "gm",
  );
  return new Set([...yarnLock.matchAll(pattern)].map((match) => match[1]));
}

for (const [packageName, expected] of [
  ["lib0", "0.2.119"],
  ["socket.io-client", "4.8.4"],
]) {
  const versions = yarnVersions(packageName);
  if (versions.size !== 1 || !versions.has(expected)) {
    fail(
      `${packageName} must remain exactly ${expected}, got ${[...versions].join(", ") || "missing"}`,
    );
  }
}

function cargoPackageVersion(lockPath, packageName) {
  const blocks = read(lockPath).split("[[package]]");
  const block = blocks.find((candidate) =>
    new RegExp(`\\n?name = "${packageName}"\\n`).test(candidate),
  );
  return block?.match(/\nversion = "([^"]+)"/)?.[1] ?? null;
}

for (const lockPath of ["Cargo.lock", "server/Cargo.lock"]) {
  const version = cargoPackageVersion(lockPath, "myoxus-yrs");
  if (version !== yrsTarget) {
    fail(`${lockPath}: yrs must be ${yrsTarget}, got ${version ?? "missing"}`);
  }
}
// Transport version follows the qualified 2026-11-08 cutover; the CRDT
// byte/runtime checks below remain independent of the transport upgrade.
if (cargoPackageVersion("server/Cargo.lock", "socketioxide") !== "0.18.9") {
  fail("server socketioxide must remain exactly 0.18.9 in the reviewed protocol set");
}

for (const manifestPath of ["Cargo.toml", "server/Cargo.toml"]) {
  const manifest = read(manifestPath);
  const declaration = manifest.match(/^\s*yrs\s*=\s*\{([^}]+)\}/m)?.[1] ?? "";
  if (!declaration.includes('package = "myoxus-yrs"') || !declaration.includes(`version = "=${yrsTarget}"`)) {
    fail(`${manifestPath}: yrs must be pinned exactly to ${yrsTarget}`);
  }
  if (/small-client/.test(manifest)) {
    fail(`${manifestPath}: yrs small-client violates the 53-bit client-id contract`);
  }
}

console.log(
  `CRDT versions: yjs ${yjsTarget}, y-protocols ${protocolsTarget}, yrs ${yrsTarget}; uint53 patch verified`,
);
NODE

node build/scripts/ci/verify-yrs-source.mjs

if [[ "${YJS_COMPAT_VERSION_ONLY:-0}" != "1" ]]; then
  node build/scripts/ci/test-yjs-runtime.mjs
  "$DIAGNOSTIC" --timeout-seconds 900 -- test --locked --manifest-path server/Cargo.toml -p yjs
fi
