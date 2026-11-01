#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Check the actual immutable dependency source, not just an equal version string.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const source = JSON.parse(read("build/dependencies/yrs-source.json"));
if (
  source.package !== "myoxus-yrs" ||
  source.version !== "0.28.0-myoxus.1" ||
  source.repository !== "https://github.com/superions/myoxus-yrs" ||
  !/^[0-9a-f]{40}$/.test(source.revision) ||
  source.registry !== "registry+https://github.com/rust-lang/crates.io-index" ||
  !/^[0-9a-f]{64}$/.test(source.crateSha256) ||
  source.upstreamVersion !== "0.28.0" ||
  source.upstreamSha256 !==
    "52c70dc8beca8666c77612a96889106ca3cd65318609721f464624ff79685da9"
) {
  throw new Error("Unreviewed Myoxus Yrs release source");
}
if (existsSync(path.join(root, "vendor/yrs"))) {
  throw new Error(
    "Local vendor/yrs source must not shadow the external package",
  );
}
const expectedSource = source.registry;
let sharedManifest;
for (const manifest of ["Cargo.toml", "server/Cargo.toml"]) {
  const text = read(manifest);
  const declaration = text.match(/^\s*yrs\s*=\s*\{([^}]+)\}/m)?.[1] ?? "";
  const field = (name) =>
    declaration.match(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*"([^"]+)"`))?.[1];
  if (
    field("package") !== source.package ||
    field("version") !== `=${source.version}` ||
    /\b(?:git|rev|path|registry|branch|tag)\s*=/.test(declaration)
  ) {
    throw new Error(
      `${manifest}: yrs must use the pinned crates.io myoxus-yrs package without local patches`,
    );
  }
  const lockPath =
    manifest === "Cargo.toml" ? "Cargo.lock" : "server/Cargo.lock";
  const lock = read(lockPath);
  if (/^name = "smallstr"$/m.test(lock)) {
    throw new Error(
      `${lockPath}: retired smallstr remains in the package graph`,
    );
  }
  if (/^name = "yrs"$/m.test(lock)) {
    throw new Error(
      `${lockPath}: upstream yrs must not coexist with myoxus-yrs`,
    );
  }
  const locked = lock
    .split("[[package]]")
    .filter((block) => /^\s*name = "myoxus-yrs"$/m.test(block));
  if (
    locked.length !== 1 ||
    !locked[0].includes(`version = "${source.version}"`) ||
    !locked[0].includes(`source = "${expectedSource}"`) ||
    !locked[0].includes(`checksum = "${source.crateSha256}"`)
  ) {
    throw new Error(
      `${lockPath}: myoxus-yrs must lock the reviewed crates.io archive`,
    );
  }
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--manifest-path",
        path.join(root, manifest),
      ],
      {
        encoding: "utf8",
        timeout: 180000,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const candidates = metadata.packages.filter(
    (pkg) => pkg.name === source.package,
  );
  if (
    candidates.length !== 1 ||
    candidates[0].version !== source.version ||
    candidates[0].source !== expectedSource ||
    metadata.packages.some((pkg) => pkg.name === "yrs")
  ) {
    throw new Error(
      `${manifest}: Cargo did not resolve the reviewed external myoxus-yrs source`,
    );
  }
  const resolved = realpathSync(candidates[0].manifest_path);
  if (sharedManifest && sharedManifest !== resolved) {
    throw new Error(
      "Server and native consumers resolved different myoxus-yrs source trees",
    );
  }
  sharedManifest = resolved;
  // Cargo normalizes the registry manifest; Cargo.toml.orig and VCS metadata
  // bind the published archive back to the reviewed, clean release checkout.
  const vcs = JSON.parse(
    readFileSync(
      path.join(path.dirname(resolved), ".cargo_vcs_info.json"),
      "utf8",
    ),
  );
  if (vcs.git?.sha1 !== source.revision || vcs.git?.dirty) {
    throw new Error("Published myoxus-yrs has unexpected Git provenance");
  }
  for (const [file, expected] of Object.entries(source.files)) {
    const actual = createHash("sha256")
      .update(readFileSync(path.join(path.dirname(resolved), file)))
      .digest("hex");
    if (actual !== expected) {
      throw new Error(
        `Resolved myoxus-yrs differs from the unmodified reviewed package: ${file}`,
      );
    }
  }
}
console.log(
  `Both Cargo workspaces use unmodified ${source.package} ${source.version} from crates.io (${source.crateSha256}) at ${source.revision}`,
);
