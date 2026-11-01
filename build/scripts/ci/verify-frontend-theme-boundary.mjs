#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");
const reportMode = args.has("--report") || !checkMode;
const optionArgs = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => {
      const [key, ...valueParts] = arg.slice(2).split("=");
      return [key, valueParts.join("=")];
    }),
);
const maxFindings = optionArgs.has("max-findings")
  ? Number(optionArgs.get("max-findings"))
  : null;
const maxRuleCounts = new Map(
  [...optionArgs.entries()]
    .filter(([key]) => key.startsWith("max-rule:"))
    .map(([key, value]) => [key.slice("max-rule:".length), Number(value)]),
);

const scanRoots = [
  "client/admin/workspaces/admin/src",
  "client/web/workspaces/web/src",
  "client/libs/core/src",
  "client/apps/electron/src",
  "client/apps/electron-renderer/src",
];

const scannedExtensions = new Set([".css", ".scss", ".ts", ".tsx"]);
const ignoredPathParts = new Set([
  ".git",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const allowedPathFragments = [
  "/__fixtures__/",
  "/__mocks__/",
  "/__tests__/",
  "/assets/",
  "/icons/",
  "/art/",
  "/artwork/",
  "/branding/",
  "/theme/",
  "/themes/",
  "/ui-facade/",
];

const allowedFileSuffixes = [
  ".spec.ts",
  ".spec.tsx",
  ".test.ts",
  ".test.tsx",
  ".stories.tsx",
  "/assets.ts",
  "-svg.ts",
  ".inline.svg",
  ".svg.tsx",
];

const standaloneColorKeyword = String.raw`(?<![-\w])(?:black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|cyan|teal|lime|violet|indigo)(?![-\w])`;
const colorLiteral = String.raw`(?:#[0-9a-fA-F]{3,8}\b|rgba?\s*\(|hsla?\s*\(|${standaloneColorKeyword})`;
const cssColorDeclaration = new RegExp(
  String.raw`\b(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|outline(?:-color)?|box-shadow|text-shadow|fill|stroke)\s*:\s*[^;{}]*${colorLiteral}`,
  "gi",
);
const tsStyleColorLiteral = new RegExp(
  String.raw`\b(?:color|background(?:Color)?|borderColor|outlineColor|boxShadow|textShadow|fill|stroke)\s*:\s*(["'\`])[^"'\`]*${colorLiteral}[^"'\`]*\1`,
  "gi",
);
const jsxColorPropLiteral = new RegExp(
  String.raw`\b(?:color|fill|stroke)\s*=\s*(["'])\s*${colorLiteral}[^"']*\1`,
  "gi",
);
const retiredAdminTone =
  /(?:\b(?:tone|accent)\s*[:=]\s*["'`{]?\s*["']?(?:mint|sky|ink|amber|peach|rose)\b|data-admin-tone|--org-(?:mint|sky|ink|amber|peach|rose)\b|admin-ui-text-(?:ink|sky|rose)\b)/g;

function extensionOf(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function normalizedRel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function isIgnored(path) {
  const rel = normalizedRel(path);
  const parts = rel.split("/");
  if (parts.some((part) => ignoredPathParts.has(part))) return true;
  if (allowedFileSuffixes.some((suffix) => rel.endsWith(suffix))) return true;
  return allowedPathFragments.some((fragment) => rel.includes(fragment));
}

function* walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      yield* walk(resolve(path, entry));
    }
    return;
  }
  if (!stat.isFile()) return;
  if (isIgnored(path)) return;
  if (!scannedExtensions.has(extensionOf(path))) return;
  yield path;
}

function lineFor(source, index) {
  return source.slice(0, index).split("\n").length;
}

function addMatches(findings, file, source, rule, regexp) {
  for (const match of source.matchAll(regexp)) {
    const index = match.index ?? 0;
    findings.push({
      path: normalizedRel(file),
      line: lineFor(source, index),
      rule,
      snippet: source
        .slice(index, index + 140)
        .split("\n")[0]
        .trim(),
    });
  }
}

const findings = [];

for (const root of scanRoots) {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) continue;
  for (const file of walk(absoluteRoot)) {
    const source = readFileSync(file, "utf8");
    const ext = extensionOf(file);
    if (ext === ".css" || ext === ".scss") {
      addMatches(
        findings,
        file,
        source,
        "raw-css-color-literal",
        cssColorDeclaration,
      );
    } else {
      addMatches(
        findings,
        file,
        source,
        "raw-style-color-literal",
        tsStyleColorLiteral,
      );
      addMatches(
        findings,
        file,
        source,
        "raw-jsx-color-prop",
        jsxColorPropLiteral,
      );
    }
    addMatches(
      findings,
      file,
      source,
      "retired-admin-tone-boundary",
      retiredAdminTone,
    );
  }
}

findings.sort((a, b) =>
  `${a.path}:${a.line}:${a.rule}`.localeCompare(
    `${b.path}:${b.line}:${b.rule}`,
  ),
);

const counts = new Map();
for (const finding of findings) {
  counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1);
}

if (reportMode) {
  console.log("frontend theme boundary inventory");
  console.log(`mode=${checkMode ? "check" : "report"}`);
  console.log(`findings=${findings.length}`);
  for (const [rule, count] of [...counts.entries()].sort()) {
    console.log(`${rule}: ${count}`);
  }
  for (const finding of findings) {
    console.log(
      `${finding.rule}\t${finding.path}:${finding.line}\t${finding.snippet}`,
    );
  }
}

const guardFailures = [];
if (maxFindings !== null && findings.length > maxFindings) {
  guardFailures.push(
    `findings ${findings.length} exceeds max-findings ${maxFindings}`,
  );
}
for (const [rule, maxRuleCount] of maxRuleCounts) {
  const count = counts.get(rule) ?? 0;
  if (count > maxRuleCount) {
    guardFailures.push(
      `${rule} ${count} exceeds max-rule:${rule} ${maxRuleCount}`,
    );
  }
}

if (guardFailures.length > 0) {
  console.error("frontend theme boundary guard failed:");
  for (const failure of guardFailures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

if (checkMode && findings.length > 0) {
  console.error(
    `frontend theme boundary check failed: ${findings.length} raw color/tone findings outside theme/facade/asset/test boundaries`,
  );
  process.exit(1);
}
