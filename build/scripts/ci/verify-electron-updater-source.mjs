// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(join(root, "client/apps/electron/package.json"));
const snapshot = join(root, ".yarn/vendor/electron-updater");
const provenance = JSON.parse(
  readFileSync(join(root, "build/dependencies/electron-updater-source.json")),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fileInventory(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${entry.name}`);
    const path = prefix + entry.name;
    return entry.isDirectory()
      ? fileInventory(join(directory, entry.name), path + "/")
      : [path];
  });
}

assert.deepEqual(provenance.upstream, {
  name: "electron-updater",
  version: "6.8.9",
  url: "https://registry.npmjs.org/electron-updater/-/electron-updater-6.8.9.tgz",
  integrity:
    "sha512-ZhVxM9iGONUpZGI1FxdMRgJjUFXi7AYGVa5PwKlO1tV1/4zDxQmfKpXOHVztKrd6L9rLcFjERvi1Mf2vxyTkig==",
});
assert.deepEqual(
  Object.keys(provenance.files).filter(
    (path) => provenance.files[path] !== provenance.upstreamFiles[path],
  ),
  ["out/DownloadedUpdateHelper.js", "package.json"],
  "Only the metadata comparator and dependency manifest may differ",
);
assert.deepEqual(
  Object.keys(provenance.upstreamFiles).filter(
    (path) => !Object.hasOwn(provenance.files, path),
  ),
  ["out/DownloadedUpdateHelper.js.map"],
);
assert.deepEqual(fileInventory(snapshot).sort(), Object.keys(provenance.files));
const installed = dirname(require.resolve("electron-updater/package.json"));
for (const [path, expected] of Object.entries(provenance.files)) {
  assert.equal(sha256(readFileSync(join(snapshot, path))), expected, path);
  assert.equal(
    sha256(readFileSync(join(installed, path))),
    expected,
    `Installed updater source drift: ${path}`,
  );
}
const rootManifest = JSON.parse(readFileSync(join(root, "package.json")));
assert.equal(
  rootManifest.resolutions["electron-updater@npm:6.8.9"],
  "file:./.yarn/vendor/electron-updater",
);
const manifest = JSON.parse(readFileSync(join(installed, "package.json")));
assert.equal(manifest.private, true);
assert(!Object.hasOwn(manifest.dependencies, "lodash.isequal"));
assert(!Object.hasOwn(manifest.devDependencies, "@types/lodash.isequal"));

console.log(
  "Reviewed Electron updater source and installed bytes match provenance",
);
