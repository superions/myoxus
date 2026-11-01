#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Changed-line ratchet for Rust test-owned files. Existing cleanup debt remains
// inventory-only; newly added bare `.ok()` calls in tests are blocked unless the
// line carries an explicit cleanup exception marker.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const checkBudgets = argv.includes("--check-budgets");

function optionValue(name, fallback = null) {
  const prefixed = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return fallback;
}

const diffBase = optionValue("--base");
const diffFile = optionValue("--diff-file");
const budgetFile = optionValue(
  "--budget-file",
  "build/test-matrix/test-quality-budgets.json",
);
const scanRoot = optionValue("--scan-root", "server");
const allowMarker = "myoxus-allow-cleanup-ok";
const ignoredDirs = new Set([
  ".git",
  ".yarn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
]);

function gitDiff(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function changedDiffs() {
  if (diffFile) return [readFileSync(path.resolve(repoRoot, diffFile), "utf8")];
  if (diffBase) {
    return [
      gitDiff([
        "diff",
        "--unified=0",
        "--no-ext-diff",
        `${diffBase}...HEAD`,
        "--",
        "server",
      ]),
    ];
  }
  return [
    gitDiff([
      "diff",
      "--cached",
      "--unified=0",
      "--no-ext-diff",
      "--",
      "server",
    ]),
    gitDiff(["diff", "--unified=0", "--no-ext-diff", "--", "server"]),
  ];
}

function isRustTestOwned(file) {
  return (
    file.endsWith(".rs") &&
    (file.includes("/tests/") ||
      file.endsWith("_test.rs") ||
      file.endsWith("tests.rs") ||
      file.includes("/test_"))
  );
}

function crateFor(file) {
  return /^server\/crates\/([^/]+)\//.exec(file)?.[1] ?? "server-root";
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function scanRelativePath(root, file) {
  if (path.isAbsolute(root)) {
    return toPosix(path.join(path.basename(root), path.relative(root, file)));
  }
  return toPosix(path.relative(repoRoot, file));
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (stat.isFile() && entry.endsWith(".rs")) yield fullPath;
  }
}

function findingForAddedLine(file, line, text) {
  if (!/\.ok\s*\(\s*\)/.test(text)) return null;
  if (text.includes(allowMarker)) return null;
  return {
    pattern: "rust_cleanup_ok",
    label: ".ok() in Rust test-owned code",
    file,
    line,
    text: text.trim(),
    remediation:
      "Assert the cleanup result, use an idempotent helper, or add a narrow `myoxus-allow-cleanup-ok` comment with the cleanup reason.",
  };
}

function ratchetFindings() {
  const findings = [];
  const seen = new Set();
  for (const diff of changedDiffs()) {
    let currentFile = null;
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
      const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (fileMatch) {
        currentFile = fileMatch[2];
        newLine = 0;
        continue;
      }
      if (!currentFile || !isRustTestOwned(currentFile)) continue;
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunkMatch) {
        newLine = Number(hunkMatch[1]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        const added = line.slice(1);
        const finding = findingForAddedLine(currentFile, newLine, added);
        if (finding) {
          const key = `${finding.file}:${finding.line}:${finding.text}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push(finding);
          }
        }
        newLine += 1;
      } else if (line.startsWith(" ")) {
        newLine += 1;
      }
    }
  }
  return findings;
}

const findings = ratchetFindings();

function cleanupOkCountsByCrate() {
  const counts = {};
  const serverRoot = path.resolve(repoRoot, scanRoot);
  try {
    statSync(serverRoot);
  } catch {
    return counts;
  }
  for (const file of walk(serverRoot)) {
    const relative = scanRelativePath(serverRoot, file);
    if (!isRustTestOwned(relative)) continue;
    const source = readFileSync(file, "utf8");
    const count = source
      .split(/\r?\n/)
      .filter((line) => !line.includes(allowMarker))
      .reduce(
        (total, line) => total + (line.match(/\.ok\s*\(\s*\)/g)?.length ?? 0),
        0,
      );
    if (count === 0) continue;
    const crate = crateFor(relative);
    counts[crate] = (counts[crate] ?? 0) + count;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function loadBudget() {
  const fullPath = path.resolve(repoRoot, budgetFile);
  return {
    path: fullPath,
    data: JSON.parse(readFileSync(fullPath, "utf8")),
  };
}

function budgetFindings(counts, budget) {
  const limits = budget.rust?.crates ?? {};
  const findings = [];
  for (const [crate, actual] of Object.entries(counts)) {
    const max = Number(limits[crate]?.rust_cleanup_ok ?? 0);
    if (actual <= max) continue;
    findings.push({
      crate,
      pattern: "rust_cleanup_ok",
      actual,
      max,
      delta: actual - max,
    });
  }
  return findings;
}

const rustBudgetCounts = checkBudgets ? cleanupOkCountsByCrate() : {};
let rustBudgetFindings = [];
let budgetPayload = undefined;
if (checkBudgets) {
  const budget = loadBudget();
  rustBudgetFindings = budgetFindings(rustBudgetCounts, budget.data);
  budgetPayload = {
    budgetFile: path.relative(repoRoot, budget.path),
    policy: budget.data.policy,
    counts: rustBudgetCounts,
    findings: rustBudgetFindings,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  base: diffBase,
  allowMarker,
  findings,
  budget: budgetPayload,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log("Rust changed-line test quality ratchet");
  console.log("======================================");
  if (findings.length === 0) {
    console.log("No newly added blocked Rust test cleanup patterns found.");
  } else {
    for (const finding of findings) {
      console.log(
        `${finding.file}:${finding.line} [${finding.label}] ${finding.text}`,
      );
      console.log(`  ${finding.remediation}`);
    }
  }
  if (checkBudgets) {
    console.log("");
    console.log("Rust test cleanup budget ratchet");
    console.log("================================");
    if (rustBudgetFindings.length === 0) {
      console.log("No Rust cleanup budget increases found.");
    } else {
      for (const finding of rustBudgetFindings) {
        console.log(
          `${finding.crate} ${finding.pattern}: ${finding.actual} > ${finding.max} (+${finding.delta})`,
        );
      }
    }
  }
}

if (findings.length > 0 || rustBudgetFindings.length > 0) process.exit(1);
