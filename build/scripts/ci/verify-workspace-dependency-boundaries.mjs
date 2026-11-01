// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectModuleReferences } from "./source-imports.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ownerRoots = [
  "client/admin/workspaces/admin",
  "client/libs/core",
  "tools",
];
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set([
  ".git",
  ".yarn",
  "dist",
  "lib",
  "node_modules",
  "out",
  "output",
  "target",
  "test-results",
]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        sourceExtensions.has(extname(path)) &&
        !/\.d\.[cm]?ts$/.test(path)
      ) {
        files.push(path);
      }
    }
  }
  visit(resolve(repoRoot, root));
  return files.sort();
}

function moduleName(specifier) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    builtins.has(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function nearestManifest(file) {
  let directory = dirname(file);
  while (directory.startsWith(repoRoot)) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (directory === repoRoot) break;
    directory = dirname(directory);
  }
  throw new Error(
    `No package.json owner found for ${relative(repoRoot, file)}`,
  );
}

function declaredDependencies(manifest) {
  return new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

export function findUndeclaredReferences(manifest, references) {
  const declared = declaredDependencies(manifest);
  return references.filter(({ specifier }) => {
    const name = moduleName(specifier);
    return name && !declared.has(name);
  });
}

function verifyBoundaries() {
  const manifestCache = new Map();
  const findings = [];
  for (const file of ownerRoots.flatMap(walkFiles)) {
    const manifestPath = nearestManifest(file);
    let manifest = manifestCache.get(manifestPath);
    if (!manifest) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifestCache.set(manifestPath, manifest);
    }
    const source = readFileSync(file, "utf8");
    for (const reference of findUndeclaredReferences(
      manifest,
      collectModuleReferences(file, source),
    )) {
      findings.push(
        `${relative(repoRoot, file)}:${reference.line} imports undeclared runtime dependency ${moduleName(reference.specifier)} through ${reference.specifier}`,
      );
    }
  }
  return findings.sort();
}

export function runWorkspaceDependencyBoundarySelfTest() {
  const manifest = {
    name: "@myoxus/fixture",
    dependencies: { declared: "1.0.0" },
    devDependencies: { "@scope/test-kit": "1.0.0" },
  };
  const references = collectModuleReferences(
    "fixture.ts",
    [
      'import type { Ignored } from "type-only";',
      'import { value } from "declared/subpath";',
      'import { helper } from "@scope/test-kit";',
      'import { own } from "@myoxus/fixture/internal";',
      'import { readFile } from "node:fs";',
      'import { local } from "./local";',
      'void import("undeclared/runtime");',
    ].join("\n"),
  );
  assert.deepEqual(
    findUndeclaredReferences(manifest, references).map(
      ({ line, specifier }) => ({
        line,
        specifier,
      }),
    ),
    [{ line: 7, specifier: "undeclared/runtime" }],
  );
  return [
    "declared",
    "dev-declared",
    "self-import",
    "builtin",
    "relative",
    "type-only",
    "undeclared",
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selfTests = runWorkspaceDependencyBoundarySelfTest();
  if (process.argv.includes("--self-test")) {
    console.log(
      `Workspace dependency boundary self-tests: ${selfTests.join(", ")}`,
    );
    process.exit(0);
  }

  const findings = verifyBoundaries();
  if (findings.length) {
    for (const finding of findings)
      console.error(`workspace-dependency-boundary: ${finding}`);
    process.exit(1);
  }
  console.log(
    `Workspace dependency boundaries verified across ${ownerRoots.join(", ")}.`,
  );
}
