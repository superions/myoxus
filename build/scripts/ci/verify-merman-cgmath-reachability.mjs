#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hard reachability guard for RUSTSEC-2026-0197.
 *
 * cgmath's equal-index `swap_columns` implementation is unsound. The current
 * Mermaid renderer resolves cgmath only through the package family below and
 * does not call that API. Until an upstream parent removes the advisory, this
 * guard scans every Rust source file in the actually reachable family and
 * fails as soon as any `swap_columns(...)` call appears.
 */

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const closurePackages = new Set([
  "merman",
  "merman-core",
  "merman-render",
  "roughr-merman",
  "svg_path_ops",
]);
const forbiddenCall = /\bswap_columns\s*\(/u;

function rustFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...rustFiles(path));
    else if (entry.endsWith(".rs")) files.push(path);
  }
  return files;
}

function scanRoots(roots) {
  const violations = [];
  for (const root of roots) {
    for (const path of rustFiles(root)) {
      const lines = readFileSync(path, "utf8").split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (forbiddenCall.test(line))
          violations.push(`${path}:${index + 1}:${line.trim()}`);
      });
    }
  }
  return violations;
}

function metadata() {
  return JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "server/Cargo.toml",
        "--format-version",
        "1",
        "--locked",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  );
}

function reachableTree() {
  return execFileSync(
    "cargo",
    [
      "tree",
      "--manifest-path",
      "server/Cargo.toml",
      "-p",
      "myoxus-mermaid-render",
      "--prefix",
      "none",
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
}

function selfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "myoxus-merman-sourceguard-"));
  try {
    writeFileSync(
      join(fixture, "negative.rs"),
      "fn bad(mut matrix: Matrix2<f32>) { matrix.swap_columns(0, 0); }\n",
    );
    if (scanRoots([fixture]).length !== 1) {
      throw new Error(
        "RUSTSEC-2026-0197 negative fixture did not fail causally",
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

selfTest();
const tree = reachableTree();
const packages = metadata().packages.filter(
  (pkg) =>
    closurePackages.has(pkg.name) &&
    tree.includes(`${pkg.name} v${pkg.version}`),
);
if (packages.length === 0) {
  process.stdout.write(
    "RUSTSEC-2026-0197 guard: merman/cgmath closure is not reachable.\n",
  );
  process.exit(0);
}

const foundNames = new Set(packages.map((pkg) => pkg.name));
const expectedReachable = [...closurePackages].filter((name) =>
  tree.includes(`${name} v`),
);
const missing = expectedReachable.filter((name) => !foundNames.has(name));
if (missing.length > 0) {
  throw new Error(
    `could not materialise reachable merman source roots: ${missing.join(", ")}`,
  );
}

const roots = packages.map((pkg) => dirname(pkg.manifest_path));
const violations = scanRoots(roots);
if (violations.length > 0) {
  process.stderr.write(
    `RUSTSEC-2026-0197 guard failed: reachable source calls cgmath::swap_columns:\n${violations.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RUSTSEC-2026-0197 guard passed: ${packages.length} reachable merman/roughr package roots contain no swap_columns call; negative fixture passed.\n`,
);
