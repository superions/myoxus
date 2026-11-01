// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const provenance = JSON.parse(
  readFileSync(
    path.join(root, "build/dependencies/paste-consumers-source.json"),
  ),
);
const versions = {
  biblatex: "0.12.0",
  hayagriva: "0.10.1",
  "safer-bytes": "0.2.0",
  simba: "0.9.1",
};
assert.deepEqual(Object.keys(provenance), Object.keys(versions));
assert.equal(
  createHash("sha256")
    .update(
      readFileSync(
        path.join(root, "build/dependencies/safer-bytes-license.txt"),
      ),
    )
    .digest("hex"),
  "7ec9745de5874fbff4529d2f2ce807edb6de634f96e1b9455a5fd10a957bfb4d",
  "Retain Safer-bytes' declared MIT license and standard terms",
);
function inventory(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${entry.name}`);
    return entry.isDirectory()
      ? inventory(path.join(directory, entry.name), prefix + entry.name + "/")
      : [prefix + entry.name];
  });
}
for (const [name, version] of Object.entries(versions)) {
  const record = provenance[name];
  const directory = path.join(root, "vendor/cargo", name);
  assert.equal(record.version, version);
  assert.deepEqual(
    Object.keys(record.files).filter((file) => file !== "Cargo.lock.orig"),
    Object.keys(record.upstreamFiles).filter((file) => file !== "Cargo.lock"),
  );
  if (Object.hasOwn(record.upstreamFiles, "Cargo.lock")) {
    assert.equal(
      record.files["Cargo.lock.orig"],
      record.upstreamFiles["Cargo.lock"],
    );
  }
  assert.deepEqual(
    Object.keys(record.files).filter(
      (file) =>
        file !== "Cargo.lock.orig" &&
        record.files[file] !== record.upstreamFiles[file],
    ),
    ["Cargo.toml"],
    `${name}: only the normalized manifest may differ from upstream`,
  );
  assert.deepEqual(inventory(directory).sort(), Object.keys(record.files));
  for (const [file, checksum] of Object.entries(record.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(path.join(directory, file)))
        .digest("hex"),
      checksum,
      `${name}/${file}`,
    );
  }
}
console.log(
  "Four reviewed vendored sources match their provenance and licenses",
);
