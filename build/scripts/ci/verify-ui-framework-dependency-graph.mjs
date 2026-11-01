#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check") || args.has("--final-check");
const finalCheckMode = args.has("--final-check");
const jsonMode = args.has("--json");
const verboseMode = args.has("--verbose") || finalCheckMode;

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
  "package.json",
  "yarn.lock",
  "client/libs/ui-facade/package.json",
  "client/libs/ui-facade/src",
  "client/libs/dialogs/package.json",
  "client/libs/dialogs/src",
  "client/libs/core/package.json",
  "client/libs/core/src",
  "client/libs/theme/package.json",
  "client/libs/theme/src",
  "client/web/workspaces/web/package.json",
  "client/web/workspaces/web/src",
  "client/admin/workspaces/admin/package.json",
  "client/admin/workspaces/admin/src",
  "client/apps/electron-renderer/package.json",
  "client/apps/electron-renderer/src",
  "client/apps/electron/package.json",
  "client/apps/electron/src",
  "virgultum",
  "client/frontends/static",
];

const ignoredPathParts = new Set([
  ".git",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const relevantPrefixes = [
  "@mantine/",
  "@radix-ui/",
  "@emotion/",
  "@vanilla-extract/",
  "@myoxus/component",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "next-themes",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "vaul",
];

const buildOutputMarkers = [
  {
    marker: "mx-client-libs-component-src-styles-web-ui",
    specifier: "@myoxus/component",
    package: "@myoxus/component",
    description: "legacy component generated class",
  },
  {
    marker: "@myoxus/component",
    specifier: "@myoxus/component",
    package: "@myoxus/component",
    description: "legacy component package marker",
  },
  {
    marker: "client/libs/component",
    specifier: "client/libs/component",
    package: "@myoxus/component",
    description: "deleted component package path",
  },
];

const trackedPackageDebt = new Map([
  ["@emotion/cache", "P-ENV-UI-MANTINE-01"],
  ["@emotion/react", "P-ENV-UI-MANTINE-01"],
  ["@emotion/styled", "P-ENV-UI-MANTINE-01"],
  ["clsx", "P-ENV-UI-MANTINE-01"],
  ["cmdk", "P-ENV-UI-MANTINE-01"],
  ["next-themes", "P-WEB-UI-MANTINE-02"],
  ["sonner", "P-WEB-UI-MANTINE-02"],
  ["tailwindcss", "P-ENV-UI-MANTINE-01"],
  ["vaul", "P-ENV-UI-MANTINE-01"],
]);

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

function isBuildOutput(path) {
  const relativePath = rel(path);
  return (
    relativePath.includes("/dist/") ||
    relativePath.includes("/static/") ||
    relativePath.includes("/resources/web-static/")
  );
}

function isPackageOnly(path) {
  const relativePath = rel(path);
  return (
    relativePath === "package.json" ||
    relativePath === "yarn.lock" ||
    relativePath.endsWith("/package.json")
  );
}

function classifyPath(path, specifier = "") {
  const relativePath = rel(path);
  if (isBuildOutput(path)) return "build-output";
  if (isPackageOnly(path)) return "package-only";
  if (relativePath.includes("client/libs/ui-facade/src/")) {
    return specifier.startsWith("@mantine/")
      ? "allowed-mantine-adapter"
      : "shared-ui-primitive-target";
  }
  if (isSpecPath(path)) return "test-only";
  if (relativePath.includes("client/admin/workspaces/admin/src/")) {
    return "admin-product-path";
  }
  if (
    relativePath.includes("client/web/workspaces/web/src/") ||
    relativePath.includes("client/libs/core/src/")
  ) {
    return "web-product-path";
  }
  if (
    relativePath.includes("client/apps/electron-renderer/src/") ||
    relativePath.includes("client/apps/electron/src/")
  ) {
    return "electron-product-path";
  }
  if (relativePath.includes("client/libs/theme/src/")) {
    return "shared-ui-primitive-target";
  }
  if (relativePath.startsWith("virgultum/")) {
    return "editor-renderer-exception";
  }
  return "unknown";
}

function isRelevantSpecifier(specifier) {
  return relevantPrefixes.some(
    (prefix) => specifier === prefix || specifier.startsWith(prefix),
  );
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
      kind: "import",
    });
  }
  return matches;
}

function packageName(specifier) {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return `${scope}/${name}`;
  }
  if (specifier === "*.css.ts") return "@vanilla-extract/css";
  if (specifier === "assignInlineVars") return "@vanilla-extract/dynamic";
  return specifier.split("/")[0] ?? specifier;
}

function trackedOwnerFor(finding) {
  if (finding.group === "test-only") return "P-ENV-UI-MANTINE-03";
  if (finding.group === "build-output") return "P-ENV-UI-MANTINE-02";
  if (finding.group === "package-only") {
    if (finding.package.startsWith("@mantine/")) return null;
    return trackedPackageDebt.get(finding.package) ?? "P-ENV-UI-MANTINE-01";
  }
  if (finding.group === "editor-renderer-exception") {
    return "todo/virgultum.md";
  }
  if (finding.group === "web-product-path") {
    if (
      finding.package === "sonner" ||
      finding.package === "next-themes" ||
      finding.specifier.includes("/notification")
    ) {
      return "P-WEB-UI-MANTINE-02";
    }
    return "P-WEB-UI-MANTINE-03";
  }
  if (finding.group === "electron-product-path") {
    return "P-WEB-UI-MANTINE-03";
  }
  if (finding.group === "shared-ui-primitive-target") {
    if (finding.path.includes("client/libs/ui-facade/src/")) {
      return finding.specifier === "@myoxus/component"
        ? null
        : "P-WEB-UI-MANTINE-01";
    }
    return "P-WEB-UI-MANTINE-04";
  }
  return null;
}

function severityFor(finding) {
  if (finding.group === "unknown") return "fatal";
  if (finding.group === "allowed-mantine-adapter") return "allowed";

  if (finding.package.startsWith("@mantine/")) {
    if (finding.group === "package-only") {
      return finding.path === "client/libs/ui-facade/package.json"
        ? "allowed"
        : "fatal";
    }
    return "fatal";
  }

  if (
    finding.group === "shared-ui-primitive-target" &&
    finding.path.includes("client/libs/ui-facade/src/") &&
    finding.specifier === "@myoxus/component"
  ) {
    return "fatal";
  }

  if (
    finding.group === "admin-product-path" &&
    (finding.package.startsWith("@radix-ui/") ||
      finding.package.startsWith("@emotion/") ||
      finding.package.startsWith("@vanilla-extract/") ||
      finding.package === "@myoxus/component" ||
      finding.package === "class-variance-authority" ||
      finding.package === "clsx" ||
      finding.package === "next-themes" ||
      finding.package === "sonner" ||
      finding.package === "tailwind-merge" ||
      finding.package === "tailwindcss" ||
      finding.package === "vaul")
  ) {
    return "fatal";
  }

  const owner = trackedOwnerFor(finding);
  return owner ? "tracked-debt" : "fatal";
}

function scanSource(path, source) {
  const findings = [];
  for (const match of extractImports(source)) {
    const finding = {
      group: classifyPath(path, match.specifier),
      kind: match.kind,
      path: rel(path),
      line: lineNumberForIndex(source, match.index),
      specifier: match.specifier,
      package: packageName(match.specifier),
    };
    findings.push({
      ...finding,
      owner: trackedOwnerFor(finding),
      severity: severityFor(finding),
    });
  }

  if (rel(path).endsWith(".css.ts")) {
    const finding = {
      group: classifyPath(path, "*.css.ts"),
      kind: "vanilla-css-ts-file",
      path: rel(path),
      line: 1,
      specifier: "*.css.ts",
      package: "@vanilla-extract/css",
    };
    findings.push({
      ...finding,
      owner: trackedOwnerFor(finding),
      severity: severityFor(finding),
    });
  }

  for (const match of source.matchAll(/\bassignInlineVars\b/g)) {
    const finding = {
      group: classifyPath(path, "assignInlineVars"),
      kind: "vanilla-dynamic",
      path: rel(path),
      line: lineNumberForIndex(source, match.index ?? 0),
      specifier: "assignInlineVars",
      package: "@vanilla-extract/dynamic",
    };
    findings.push({
      ...finding,
      owner: trackedOwnerFor(finding),
      severity: severityFor(finding),
    });
  }

  if (isBuildOutput(path)) {
    for (const marker of buildOutputMarkers) {
      for (const match of source.matchAll(
        new RegExp(marker.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      )) {
        const finding = {
          group: classifyPath(path, marker.specifier),
          kind: "build-output-marker",
          path: rel(path),
          line: lineNumberForIndex(source, match.index ?? 0),
          specifier: marker.specifier,
          package: marker.package,
          marker: marker.description,
        };
        findings.push({
          ...finding,
          owner: trackedOwnerFor(finding),
          severity: severityFor(finding),
        });
      }
    }
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
      const finding = {
        group: classifyPath(path, name),
        kind: "package-dependency",
        path: rel(path),
        line: 1,
        specifier: name,
        package: packageName(name),
        dependencySection: section,
        version: String(version),
      };
      findings.push({
        ...finding,
        owner: trackedOwnerFor(finding),
        severity: severityFor(finding),
      });
    }
  }
  return findings;
}

function scanYarnLock(path, source) {
  const findings = [];
  for (const prefix of relevantPrefixes) {
    if (prefix === "@mantine/" || prefix === "clsx") continue;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexp = new RegExp(`(?:^|\\n)"?${escaped}`, "g");
    for (const match of source.matchAll(regexp)) {
      const specifier = prefix.endsWith("/") ? `${prefix}*` : prefix;
      const finding = {
        group: classifyPath(path, specifier),
        kind: "lockfile-entry",
        path: rel(path),
        line: lineNumberForIndex(source, match.index ?? 0),
        specifier,
        package: packageName(specifier),
      };
      findings.push({
        ...finding,
        owner: trackedOwnerFor(finding),
        severity: severityFor(finding),
      });
    }
  }
  return findings;
}

function collectFindings() {
  const findings = [];
  for (const root of scanRoots) {
    const absoluteRoot = resolve(repoRoot, root);
    for (const path of walk(absoluteRoot)) {
      const source = readFileSync(path, "utf8");
      if (rel(path) === "yarn.lock") {
        findings.push(...scanYarnLock(path, source));
      } else if (rel(path).endsWith("package.json")) {
        findings.push(...scanPackageJson(path, source));
      } else {
        findings.push(...scanSource(path, source));
      }
    }
  }
  return findings.sort((a, b) =>
    `${a.severity}:${a.group}:${a.package}:${a.path}:${a.line}:${a.specifier}`.localeCompare(
      `${b.severity}:${b.group}:${b.package}:${b.path}:${b.line}:${b.specifier}`,
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

function ownerCounts(findings) {
  const counts = new Map();
  for (const finding of findings) {
    if (!finding.owner) continue;
    counts.set(finding.owner, (counts.get(finding.owner) ?? 0) + 1);
  }
  return [...counts.entries()].sort();
}

function validateDefectInjection() {
  const adminFeature = resolve(
    repoRoot,
    "client/admin/workspaces/admin/src/modules/__guard__/BadFeature.tsx",
  );
  const facadeBad = resolve(
    repoRoot,
    "client/libs/ui-facade/src/__guard__/BadFacade.tsx",
  );
  const facadeAdapter = resolve(
    repoRoot,
    "client/libs/ui-facade/src/__guard__/Adapter.tsx",
  );
  const adminFindings = scanSource(
    adminFeature,
    [
      'import { Dialog } from "@radix-ui/react-dialog";',
      'import { styled } from "@emotion/styled";',
      'import { assignInlineVars } from "@vanilla-extract/dynamic";',
      'import { toast } from "sonner";',
      'import { Command } from "cmdk";',
      'import { useTheme } from "next-themes";',
      'import { Button } from "@mantine/core";',
      'import { cn } from "tailwind-merge";',
      'import { Drawer } from "vaul";',
      'import { Button as LegacyButton } from "@myoxus/component";',
    ].join("\n"),
  );
  const fatalSpecifiers = adminFindings
    .filter((finding) => finding.severity === "fatal")
    .map((finding) => finding.specifier)
    .sort();
  const expectedAdmin = [
    "@emotion/styled",
    "@mantine/core",
    "@myoxus/component",
    "@radix-ui/react-dialog",
    "@vanilla-extract/dynamic",
    "assignInlineVars",
    "cmdk",
    "next-themes",
    "sonner",
    "tailwind-merge",
    "vaul",
  ];
  if (JSON.stringify(fatalSpecifiers) !== JSON.stringify(expectedAdmin)) {
    throw new Error(
      `dependency graph product defect injection failed: ${JSON.stringify(fatalSpecifiers)}`,
    );
  }

  const broadFacade = scanSource(
    facadeBad,
    'import { Button } from "@myoxus/component";',
  );
  if (
    broadFacade.length !== 1 ||
    broadFacade[0]?.specifier !== "@myoxus/component" ||
    broadFacade[0]?.severity !== "fatal"
  ) {
    throw new Error(
      `dependency graph facade-barrel injection failed: ${JSON.stringify(broadFacade)}`,
    );
  }

  const allowed = scanSource(
    facadeAdapter,
    'import { Button } from "@mantine/core";',
  );
  if (
    allowed.length !== 1 ||
    allowed[0]?.group !== "allowed-mantine-adapter" ||
    allowed[0]?.severity !== "allowed"
  ) {
    throw new Error(
      `dependency graph adapter allowlist failed: ${JSON.stringify(allowed)}`,
    );
  }
}

validateDefectInjection();
const findings = collectFindings();
const finalFindings = finalCheckMode
  ? findings.filter((finding) => finding.severity !== "allowed")
  : findings.filter((finding) => finding.severity === "fatal");
const summary = {
  mode: finalCheckMode ? "final-check" : checkMode ? "check" : "report",
  findings: findings.length,
  fatal: findings.filter((finding) => finding.severity === "fatal").length,
  trackedDebt: findings.filter((finding) => finding.severity === "tracked-debt")
    .length,
  allowed: findings.filter((finding) => finding.severity === "allowed").length,
  finalBlocking: finalFindings.length,
};

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        summary,
        groupedCounts: groupedCounts(findings),
        ownerCounts: ownerCounts(findings),
        findings,
        blockingFindings: finalFindings,
      },
      null,
      2,
    ),
  );
} else {
  console.log("ui-framework-dependency-graph guard");
  console.log(`mode=${summary.mode}`);
  console.log(`findings=${summary.findings}`);
  console.log(`fatal=${summary.fatal}`);
  console.log(`trackedDebt=${summary.trackedDebt}`);
  console.log(`allowed=${summary.allowed}`);
  console.log(`finalBlocking=${summary.finalBlocking}`);
  for (const [key, count] of groupedCounts(findings)) {
    console.log(`${key}: ${count}`);
  }
  for (const [owner, count] of ownerCounts(findings)) {
    console.log(`owner/${owner}: ${count}`);
  }
  const printable = verboseMode ? findings : findings.slice(0, 240);
  for (const finding of printable) {
    const dependency = finding.dependencySection
      ? ` ${finding.dependencySection}@${finding.version}`
      : "";
    const owner = finding.owner ? ` owner=${finding.owner}` : "";
    console.log(
      `${finding.severity}\t${finding.group}\t${finding.path}:${finding.line}\t${finding.specifier}${dependency}${owner}`,
    );
  }
  if (!verboseMode && findings.length > printable.length) {
    console.log(
      `... ${findings.length - printable.length} additional findings hidden`,
    );
  }
}

if (checkMode && finalFindings.length > 0) {
  console.error(
    `ui-framework-dependency-graph failed: ${finalFindings.length} blocking finding(s)`,
  );
  process.exit(1);
}
