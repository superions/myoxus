#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");
const reportMode = args.has("--report") || !checkMode;

const activeRoots = [
  "package.json",
  "vitest.config.mts",
  "yarn.lock",
  "tools",
  "client/admin",
  "client/web",
  "client/libs",
  "client/apps",
  "virgultum",
];

const ignoredPathParts = new Set([
  ".git",
  ".yarn",
  "node_modules",
  "dist",
  "lib",
  "static",
  "web-static",
  "coverage",
  ".turbo",
]);

const scannedExtensions = new Set([
  ".css",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const textPatterns = [
  "@vanilla-extract/",
  "assignInlineVars",
  "vanillaExtractPlugin",
  "VanillaExtractPlugin",
  "vanillaextract-stub",
];

function pathParts(path) {
  return relative(repoRoot, path).split(/[\\/]/).filter(Boolean);
}

function isIgnored(path) {
  return pathParts(path).some((part) => ignoredPathParts.has(part));
}

function extensionOf(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (name.endsWith(".css.ts")) return ".css.ts";
  if (name.endsWith(".css.tsx")) return ".css.tsx";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function domainFor(relPath) {
  if (relPath === "package.json" || relPath === "yarn.lock") return "root";
  if (relPath.startsWith("client/libs/")) return "client/libs";
  if (relPath.startsWith("client/web/")) return "client/web";
  if (relPath.startsWith("client/admin/")) return "client/admin";
  if (relPath.startsWith("client/apps/")) return "client/apps";
  if (relPath.startsWith("virgultum/")) return "virgultum";
  if (relPath.startsWith("tools/")) return "tools";
  return "other";
}

function* walk(path) {
  if (isIgnored(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      yield* walk(resolve(path, entry));
    }
    return;
  }
  if (!stat.isFile()) return;
  const ext = extensionOf(path);
  if (!scannedExtensions.has(ext) && ext !== ".css.ts" && ext !== ".css.tsx") {
    return;
  }
  yield path;
}

const findings = [];
const domainCounts = new Map();

function addFinding(path, kind, detail) {
  const relPath = relative(repoRoot, path);
  const domain = domainFor(relPath);
  findings.push({ path: relPath, domain, kind, detail });
  domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
}

for (const root of activeRoots) {
  const absoluteRoot = resolve(repoRoot, root);
  let stat;
  try {
    stat = statSync(absoluteRoot);
  } catch {
    continue;
  }
  const paths = stat.isDirectory() ? walk(absoluteRoot) : [absoluteRoot];
  for (const path of paths) {
    const ext = extensionOf(path);
    if (ext === ".css.ts" || ext === ".css.tsx") {
      addFinding(path, "css-ts-file", ext);
    }
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const pattern of textPatterns) {
      if (text.includes(pattern)) {
        addFinding(path, "pattern", pattern);
      }
    }
  }
}

const sortedFindings = findings.sort((a, b) =>
  `${a.domain}:${a.path}:${a.kind}:${a.detail}`.localeCompare(
    `${b.domain}:${b.path}:${b.kind}:${b.detail}`,
  ),
);

if (reportMode) {
  console.log("vanilla-extract active-source inventory");
  console.log(`mode=${checkMode ? "check" : "report"}`);
  console.log(`findings=${sortedFindings.length}`);
  for (const [domain, count] of [...domainCounts.entries()].sort()) {
    console.log(`${domain}: ${count}`);
  }
  for (const finding of sortedFindings) {
    console.log(
      `${finding.domain}\t${finding.kind}\t${finding.detail}\t${finding.path}`,
    );
  }
}

if (checkMode && sortedFindings.length > 0) {
  console.error(
    `vanilla-extract guard failed: ${sortedFindings.length} active findings`,
  );
  process.exit(1);
}

if (checkMode) {
  console.log("vanilla-extract guard ok: no active findings");
}
