#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check") || args.has("--final-check");
const jsonMode = args.has("--json");
const verboseMode = args.has("--verbose");

const scannedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".lock",
  ".mjs",
  ".ts",
  ".tsx",
]);

const scanRoots = [
  "client/admin/workspaces/admin/package.json",
  "client/admin/workspaces/admin/src",
  "tests/client/adminfrontend/e2e",
  "client/libs/ui-facade/package.json",
  "client/libs/ui-facade/src",
  "client/libs/dialogs/package.json",
  "client/libs/dialogs/src",
  "client/libs/core/package.json",
  "client/libs/core/src",
  "client/libs/theme/package.json",
  "client/libs/theme/src",
  "client/admin/workspaces/admin/dist",
  "client/frontends/static/admin",
];

const ignoredPathParts = new Set([
  ".git",
  ".turbo",
  ".yarn",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const relevantPrefixes = [
  "@mantine/",
  "@radix-ui/",
  "@emotion/",
  "@myoxus/component",
  "sonner",
  "next-themes",
  "clsx",
  "cmdk",
];

function rel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function extensionOf(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}

function pathParts(path) {
  return rel(path).split("/").filter(Boolean);
}

function isIgnored(path) {
  return pathParts(path).some((part) => ignoredPathParts.has(part));
}

function* walk(path) {
  if (!existsSync(path) || isIgnored(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      yield* walk(resolve(path, entry));
    }
    return;
  }
  if (stat.isFile() && scannedExtensions.has(extensionOf(path))) {
    yield path;
  }
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

function isSpecPath(path) {
  const relativePath = rel(path);
  return (
    relativePath.includes("/__tests__/") ||
    relativePath.includes("/tests/") ||
    /\.spec\.[tj]sx?$/.test(relativePath) ||
    /\.test\.[tj]sx?$/.test(relativePath)
  );
}

function classifyPath(path, specifier = "") {
  const relativePath = rel(path);
  if (relativePath.includes("/dist/") || relativePath.includes("/static/")) {
    return "build-only";
  }
  if (
    relativePath.endsWith("package.json") ||
    relativePath.includes("/build/scripts/")
  ) {
    return "build-only";
  }
  if (relativePath.includes("client/libs/ui-facade/src/")) {
    return specifier.startsWith("@mantine/")
      ? "allowed-adapter"
      : "shared-product-path";
  }
  if (relativePath.includes("client/admin/workspaces/admin/src/")) {
    return isSpecPath(path) ? "admin-test-only" : "admin-product-path";
  }
  if (relativePath.includes("tests/client/adminfrontend/")) {
    return "admin-test-only";
  }
  if (relativePath.includes("client/libs/")) {
    return isSpecPath(path) ? "admin-test-only" : "shared-product-path";
  }
  return "unknown";
}

function isRelevantSpecifier(specifier) {
  return relevantPrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(prefix),
  );
}

function importedNamesFor(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [];
  const importRegexp = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${escaped}["']`,
    "g",
  );
  for (const match of source.matchAll(importRegexp)) {
    names.push(
      ...(match[1] ?? "")
        .split(",")
        .map((part) =>
          part
            .trim()
            .split(/\s+as\s+/i)[0]
            ?.trim(),
        )
        .filter(Boolean),
    );
  }
  return [...new Set(names)].sort();
}

function extractImports(source) {
  const matches = [];
  const importRegexp =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|\bvi\.mock\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importRegexp)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !isRelevantSpecifier(specifier)) continue;
    matches.push({
      specifier,
      index: match.index ?? 0,
    });
  }
  return matches;
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  return specifier.split("/")[0] ?? specifier;
}

function severityFor({ group, specifier, path }) {
  const pkg = packageName(specifier);
  if (group === "unknown") return "fatal";
  if (pkg.startsWith("@mantine/")) {
    return group === "allowed-adapter" ? "allowed" : "fatal";
  }
  if (
    group === "admin-product-path" &&
    (pkg.startsWith("@radix-ui/") ||
      pkg.startsWith("@emotion/") ||
      pkg === "@myoxus/component" ||
      pkg === "sonner" ||
      pkg === "next-themes" ||
      pkg === "clsx" ||
      pkg === "cmdk")
  ) {
    return "fatal";
  }
  if (
    group === "admin-product-path" &&
    specifier.startsWith("@myoxus/component/") &&
    !specifier.includes("/theme/fonts.css")
  ) {
    return "fatal";
  }
  if (group === "build-only" && rel(path).endsWith("package.json")) {
    return "inventory";
  }
  return "inventory";
}

function scanSource(path, source) {
  const findings = [];
  for (const match of extractImports(source)) {
    const group = classifyPath(path, match.specifier);
    const importedNames =
      match.specifier === "@myoxus/component"
        ? importedNamesFor(source, match.specifier)
        : [];
    const finding = {
      group,
      path: rel(path),
      line: lineNumberForIndex(source, match.index),
      specifier: match.specifier,
      package: packageName(match.specifier),
      importedNames,
    };
    findings.push({
      ...finding,
      severity: severityFor({ ...finding, path }),
    });
  }
  return findings;
}

function scanPackageJson(path, source) {
  const findings = [];
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return findings;
  }
  const sections = ["dependencies", "devDependencies", "peerDependencies"];
  for (const section of sections) {
    for (const [name, version] of Object.entries(parsed[section] ?? {})) {
      if (!isRelevantSpecifier(name)) continue;
      const group = classifyPath(path, name);
      const finding = {
        group,
        path: rel(path),
        line: 1,
        specifier: name,
        package: packageName(name),
        importedNames: [],
        dependencySection: section,
        version: String(version),
      };
      const isAdminPackage =
        rel(path) === "client/admin/workspaces/admin/package.json";
      findings.push({
        ...finding,
        severity: isAdminPackage ? "fatal" : "inventory",
      });
    }
  }
  return findings;
}

function validateDefectInjection() {
  const adminFeature = resolve(
    repoRoot,
    "client/admin/workspaces/admin/src/modules/__guard__/BadFeature.tsx",
  );
  const facadeAdapter = resolve(
    repoRoot,
    "client/libs/ui-facade/src/__guard__/Adapter.tsx",
  );
  const injected = scanSource(
    adminFeature,
    [
      'import { Dialog } from "@radix-ui/react-dialog";',
      'import { toast } from "sonner";',
      'import { Command } from "cmdk";',
      'import { Button } from "@mantine/core";',
    ].join("\n"),
  );
  const fatalSpecifiers = injected
    .filter((finding) => finding.severity === "fatal")
    .map((finding) => finding.specifier)
    .sort();
  const expected = [
    "@mantine/core",
    "@radix-ui/react-dialog",
    "cmdk",
    "sonner",
  ];
  if (JSON.stringify(fatalSpecifiers) !== JSON.stringify(expected)) {
    throw new Error(
      `dependency graph defect injection failed: ${JSON.stringify(fatalSpecifiers)}`,
    );
  }

  const allowed = scanSource(
    facadeAdapter,
    'import { Button } from "@mantine/core";',
  );
  if (
    allowed.length !== 1 ||
    allowed[0]?.group !== "allowed-adapter" ||
    allowed[0]?.severity !== "allowed"
  ) {
    throw new Error(
      `dependency graph adapter allowlist failed: ${JSON.stringify(allowed)}`,
    );
  }
}

function collectFindings() {
  const findings = [];
  for (const root of scanRoots) {
    const absoluteRoot = resolve(repoRoot, root);
    for (const path of walk(absoluteRoot)) {
      const source = readFileSync(path, "utf8");
      findings.push(
        ...(rel(path).endsWith("package.json")
          ? scanPackageJson(path, source)
          : scanSource(path, source)),
      );
    }
  }
  return findings.sort((a, b) =>
    `${a.severity}:${a.group}:${a.path}:${a.line}:${a.specifier}`.localeCompare(
      `${b.severity}:${b.group}:${b.path}:${b.line}:${b.specifier}`,
    ),
  );
}

function groupedCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = `${finding.severity}/${finding.group}/${finding.package}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort();
}

validateDefectInjection();
const findings = collectFindings();
const fatalFindings = findings.filter(
  (finding) => finding.severity === "fatal",
);

if (jsonMode) {
  console.log(JSON.stringify({ findings, fatalFindings }, null, 2));
} else {
  console.log("admin-ui-dependency-graph guard");
  console.log(`mode=${checkMode ? "check" : "report"}`);
  console.log(`findings=${findings.length}`);
  console.log(`fatal=${fatalFindings.length}`);
  for (const [key, count] of groupedCounts(findings)) {
    console.log(`${key}: ${count}`);
  }
  const printable = verboseMode ? findings : findings.slice(0, 200);
  for (const finding of printable) {
    const names =
      finding.importedNames?.length > 0
        ? ` imports={${finding.importedNames.join(",")}}`
        : "";
    const dependency = finding.dependencySection
      ? ` ${finding.dependencySection}@${finding.version}`
      : "";
    console.log(
      `${finding.severity}\t${finding.group}\t${finding.path}:${finding.line}\t${finding.specifier}${dependency}${names}`,
    );
  }
  if (!verboseMode && findings.length > printable.length) {
    console.log(
      `... ${findings.length - printable.length} additional findings hidden`,
    );
  }
}

if (checkMode && fatalFindings.length > 0) {
  console.error(
    `admin-ui-dependency-graph failed: ${fatalFindings.length} fatal finding(s)`,
  );
  process.exit(1);
}
