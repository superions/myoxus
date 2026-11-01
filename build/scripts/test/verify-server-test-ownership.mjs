#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cheap contract for the server test ownership inventory. The matrix uses this
// as a structural guard: every Rust test-owned file must be represented by the
// inventory, while crates without Rust tests may remain absent.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const args = new Set(process.argv.slice(2));
const json = args.has("--json");

const allowedTiers = new Set([
  "service-free-inline",
  "service-free-or-contract",
  "postgres-backed",
  "redis-backed",
  "minio-backed",
  "nightly-or-manual",
]);

function gitFiles(patterns) {
  return execFileSync("git", ["ls-files", ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

function crateFor(file) {
  return /^server\/crates\/([^/]+)\//.exec(file)?.[1] ?? "server-root";
}

function isRustTestOwned(file, source) {
  return (
    file.includes("/tests/") ||
    file.endsWith("_test.rs") ||
    file.endsWith("tests.rs") ||
    file.includes("/test_") ||
    source.includes("#[cfg(test)]")
  );
}

function runInventory() {
  return JSON.parse(
    execFileSync(
      "node",
      [
        "build/scripts/test/inventory.mjs",
        "--json",
        "--server-test-ownership-only",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
}

const crateManifests = gitFiles(["server/crates/*/Cargo.toml"]);
const allCrates = crateManifests
  .map((file) => crateFor(file))
  .sort((a, b) => a.localeCompare(b));
const rustFiles = gitFiles(["server/**/*.rs"]);
const testOwnedByCrate = new Map();

for (const file of rustFiles) {
  const absolutePath = path.join(repoRoot, file);
  // `git ls-files` includes tracked paths deleted in an unstaged worktree.
  // Ownership describes executable source, so pending deletions must not keep
  // obsolete test owners alive or make this guard fail before staging.
  if (!existsSync(absolutePath)) continue;
  const source = readFileSync(absolutePath, "utf8");
  if (!isRustTestOwned(file, source)) continue;
  const crate = crateFor(file);
  testOwnedByCrate.set(crate, (testOwnedByCrate.get(crate) ?? 0) + 1);
}

const inventory = runInventory();
const ownership = inventory.serverTestOwnership ?? {};
const findings = [];

for (const [crate, fileCount] of [...testOwnedByCrate.entries()].sort()) {
  const entry = ownership[crate];
  if (!entry) {
    findings.push({
      level: "error",
      crate,
      message: `crate has ${fileCount} Rust test-owned file(s) but no inventory ownership entry`,
    });
    continue;
  }
  if (entry.files !== fileCount) {
    findings.push({
      level: "error",
      crate,
      message: `inventory file count ${entry.files} does not match source count ${fileCount}`,
    });
  }
  for (const tier of Object.keys(entry.tiers ?? {})) {
    if (!allowedTiers.has(tier)) {
      findings.push({
        level: "error",
        crate,
        message: `unknown server service tier ${tier}`,
      });
    }
  }
}

for (const crate of Object.keys(ownership)) {
  if (!testOwnedByCrate.has(crate)) {
    findings.push({
      level: "error",
      crate,
      message: "inventory contains a crate with no Rust test-owned files",
    });
  }
}

const emptyCrates = allCrates.filter((crate) => !testOwnedByCrate.has(crate));
const workspaceCratesWithTests = allCrates.filter((crate) =>
  testOwnedByCrate.has(crate),
);
const payload = {
  generatedAt: new Date().toISOString(),
  workspaceCrates: {
    total: allCrates.length,
    withRustTests: workspaceCratesWithTests.length,
    withoutRustTests: emptyCrates,
  },
  ownedTestScopes: {
    total: testOwnedByCrate.size,
    includesServerRoot: testOwnedByCrate.has("server-root"),
  },
  ownedCrates: Object.fromEntries([...testOwnedByCrate.entries()].sort()),
  findings,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("Server test ownership");
  console.log(`Workspace crates: ${payload.workspaceCrates.total}`);
  console.log(
    `Workspace crates with Rust tests: ${payload.workspaceCrates.withRustTests}`,
  );
  console.log(`Owned test scopes: ${payload.ownedTestScopes.total}`);
  console.log(
    `Workspace crates without Rust tests: ${payload.workspaceCrates.withoutRustTests.join(", ") || "none"}`,
  );
  if (findings.length > 0) {
    console.log("");
    for (const finding of findings) {
      console.log(`- ${finding.level}: ${finding.crate}: ${finding.message}`);
    }
  }
}

if (findings.some((finding) => finding.level === "error")) {
  process.exit(1);
}
