#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BUILD_ONLY_SCHEMA = "myoxus.macos-build-only.v1";
const digest = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function validateBuildOnlyEvidence(evidence, cell, packagesDirectory) {
  assert.equal(evidence.schema, BUILD_ONLY_SCHEMA);
  assert.deepEqual(
    Object.keys(evidence).sort(),
    [
      "arch",
      "buildHost",
      "channel",
      "format",
      "package",
      "platform",
      "runtime",
      "schema",
      "sourceCommit",
      "version",
    ].sort(),
  );
  assert.equal(cell.platform, "macos");
  assert.equal(cell.arch, "arm64");
  for (const key of [
    "arch",
    "channel",
    "platform",
    "sourceCommit",
    "version",
  ]) {
    assert.equal(
      evidence[key],
      cell[key],
      `build-only ${key} differs from release cell`,
    );
  }
  assert.ok(["dmg", "zip"].includes(evidence.format));
  assert.ok(cell.formats.includes(evidence.format));
  assert.deepEqual(evidence.buildHost, { platform: "darwin", arch: "x64" });
  assert.deepEqual(evidence.runtime, {
    status: "not_run",
    reason: "cross_compiled_arm64_on_x64",
  });
  assert.deepEqual(Object.keys(evidence.package).sort(), ["name", "sha256"]);
  assert.equal(
    evidence.package.name,
    `myoxus-${cell.version}-${cell.channel}-macos-arm64.${evidence.format}`,
  );
  const packageFile = path.join(packagesDirectory, evidence.package.name);
  assert.ok(!fs.lstatSync(packagesDirectory).isSymbolicLink());
  assert.ok(
    fs.lstatSync(packageFile).isFile() &&
      !fs.lstatSync(packageFile).isSymbolicLink(),
  );
  assert.equal(
    path.dirname(fs.realpathSync(packageFile)),
    fs.realpathSync(packagesDirectory),
  );
  assert.equal(evidence.package.sha256, digest(packageFile));
}

export function recordBuildOnlyEvidence(
  packagesDirectory,
  output,
  environment = process.env,
) {
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "x64");
  assert.match(environment.GITHUB_SHA ?? "", /^[a-f0-9]{40,64}$/);
  assert.match(
    environment.MYOXUS_RELEASE_VERSION ?? "",
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  );
  assert.ok(["stable", "beta", "internal"].includes(environment.BUILD_TYPE));
  for (const format of ["dmg", "zip"]) {
    const name = `myoxus-${environment.MYOXUS_RELEASE_VERSION}-${environment.BUILD_TYPE}-macos-arm64.${format}`;
    const evidence = {
      schema: BUILD_ONLY_SCHEMA,
      platform: "macos",
      arch: "arm64",
      format,
      version: environment.MYOXUS_RELEASE_VERSION,
      channel: environment.BUILD_TYPE,
      sourceCommit: environment.GITHUB_SHA,
      buildHost: { platform: process.platform, arch: process.arch },
      runtime: { status: "not_run", reason: "cross_compiled_arm64_on_x64" },
      package: { name, sha256: digest(path.join(packagesDirectory, name)) },
    };
    validateBuildOnlyEvidence(
      evidence,
      { ...evidence, formats: [format] },
      packagesDirectory,
    );
    fs.mkdirSync(path.join(output, format), { recursive: true });
    fs.writeFileSync(
      path.join(output, format, "build-only.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
  }
  console.log(
    "ARM64 packages built and structurally checked; native runtime/update tests NOT RUN (x64 build host).",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [packagesDirectory, output] = process.argv.slice(2);
  assert.ok(
    packagesDirectory && output,
    "usage: macos-build-only-evidence.mjs <packages> <evidence-dir>",
  );
  recordBuildOnlyEvidence(packagesDirectory, output);
}
