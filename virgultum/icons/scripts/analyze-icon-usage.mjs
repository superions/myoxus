#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSource,
  walkAst,
} from "../../../build/scripts/ci/source-imports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");

const sourceRoots = [
  "client/admin",
  "client/web",
  "client/libs",
  "client/apps",
  "virgultum/editor",
];

const iconModules = new Set(["@myoxus/icons/react", "@myoxus/icons/lit"]);

const ignoredDirectoryNames = new Set([
  ".git",
  ".yarn",
  "__tests__",
  "dist",
  "fixtures",
  "node_modules",
  "out",
  "output",
  "storybook-static",
  "test",
  "tests",
]);

const ignoredFilePattern = /(?:^|\.)(?:d|spec|test|stories)\.[cm]?[jt]sx?$/;
const sourceFilePattern = /\.[cm]?[jt]sx?$/;

function walk(entry) {
  const absolute = path.join(repoRoot, entry);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return sourceFilePattern.test(absolute) ? [absolute] : [];

  const files = [];
  for (const child of fs.readdirSync(absolute)) {
    if (ignoredDirectoryNames.has(child)) continue;
    const childAbsolute = path.join(absolute, child);
    const childStat = fs.statSync(childAbsolute);
    if (childStat.isDirectory()) {
      files.push(...walk(path.relative(repoRoot, childAbsolute)));
    } else if (
      sourceFilePattern.test(child) &&
      !ignoredFilePattern.test(child)
    ) {
      files.push(childAbsolute);
    }
  }
  return files;
}

function isImportBinding(parent) {
  return [
    "ImportDefaultSpecifier",
    "ImportNamespaceSpecifier",
    "ImportSpecifier",
  ].includes(parent?.type);
}

function analyzeSource(file, sourceText) {
  const sourceFile = parseSource(file, sourceText);
  const namedImports = new Map();
  const namespaceImports = new Set();

  for (const statement of sourceFile.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (!iconModules.has(statement.source.value) || statement.typeOnly)
      continue;
    for (const element of statement.specifiers) {
      if (element.type === "ImportSpecifier" && !element.isTypeOnly) {
        namedImports.set(
          element.local.value,
          element.imported?.value ?? element.local.value,
        );
      } else if (element.type === "ImportNamespaceSpecifier") {
        namespaceImports.add(element.local.value);
      }
    }
  }

  if (!namedImports.size && !namespaceImports.size) return new Map();
  const counts = new Map();
  const count = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);

  walkAst(sourceFile, (node, parent) => {
    if (
      ["JSXMemberExpression", "MemberExpression"].includes(node.type) &&
      node.object?.type === "Identifier" &&
      node.property?.type === "Identifier" &&
      namespaceImports.has(node.object.value)
    ) {
      count(node.property.value);
      return false;
    }
    if (
      node.type === "Identifier" &&
      namedImports.has(node.value) &&
      !isImportBinding(parent)
    ) {
      count(namedImports.get(node.value));
    }
    return true;
  });
  return counts;
}

function analyzeFile(file) {
  return analyzeSource(file, fs.readFileSync(file, "utf8"));
}

export function runIconUsageSelfTest() {
  const counts = analyzeSource(
    "fixture.tsx",
    [
      'import { IconA as A, type IconType } from "@myoxus/icons/react";',
      'import * as Icons from "@myoxus/icons/lit";',
      "const first = <A />;",
      "const second = A;",
      "const third = <Icons.IconB />;",
      "const fourth = Icons.IconB;",
      "type Ignored = IconType;",
    ].join("\n"),
  );
  assert.deepEqual(Object.fromEntries(counts), { IconA: 2, IconB: 2 });
  return ["named-alias", "namespace", "jsx", "type-only"];
}

export function analyzeIconUsage({ limit } = {}) {
  const files = sourceRoots.flatMap(walk).sort();
  const iconUsage = new Map();
  let filesWithIconReferences = 0;

  for (const file of files) {
    const fileCounts = analyzeFile(file);
    if (!fileCounts.size) continue;
    filesWithIconReferences += 1;
    const relativeFile = path.relative(repoRoot, file);
    for (const [name, references] of fileCounts) {
      const usage = iconUsage.get(name) ?? {
        name,
        references: 0,
        files: [],
      };
      usage.references += references;
      usage.files.push({ path: relativeFile, references });
      iconUsage.set(name, usage);
    }
  }

  const icons = [...iconUsage.values()]
    .map((usage) => ({
      ...usage,
      files: usage.files.sort(
        (left, right) =>
          right.references - left.references ||
          left.path.localeCompare(right.path),
      ),
      fileCount: usage.files.length,
    }))
    .sort(
      (left, right) =>
        right.references - left.references ||
        right.fileCount - left.fileCount ||
        left.name.localeCompare(right.name),
    );

  const selectedIcons = Number.isInteger(limit) ? icons.slice(0, limit) : icons;
  return {
    methodology: {
      description:
        "Static TypeScript/JavaScript identifier references to named or namespace imports from @myoxus/icons/react and @myoxus/icons/lit.",
      sourceRoots,
      excluded:
        "Generated output, dist/out/output, node_modules, fixtures, tests, specs, stories and test directories.",
      ranking:
        "Descending by source references, then file count and exported name.",
    },
    scannedFileCount: files.length,
    filesWithIconReferences,
    distinctIconCount: icons.length,
    totalReferences: icons.reduce((sum, icon) => sum + icon.references, 0),
    icons: selectedIcons,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) {
    process.stdout.write(
      `Icon usage self-tests: ${runIconUsageSelfTest().join(", ")}\n`,
    );
    process.exit(0);
  }
  const limitIndex = process.argv.indexOf("--limit");
  const requestedLimit =
    limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : undefined;
  const analysis = analyzeIconUsage({
    limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
  });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
  } else {
    for (const [index, icon] of analysis.icons.entries()) {
      process.stdout.write(
        `${String(index + 1).padStart(2)}  ${String(icon.references).padStart(4)} refs  ${String(icon.fileCount).padStart(3)} files  ${icon.name}\n`,
      );
    }
  }
}
