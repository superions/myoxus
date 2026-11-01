// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceTool } from "./source-tools.mjs";

const { parseSync } = loadSourceTool("@swc/core");

const supportedExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function parserOptions(path) {
  const extension = extname(path);
  if (!supportedExtensions.has(extension)) {
    throw new Error(
      `Unsupported JavaScript/TypeScript source extension: ${path}`,
    );
  }
  const typescript = [".cts", ".mts", ".ts", ".tsx"].includes(extension);
  return typescript
    ? { syntax: "typescript", tsx: extension === ".tsx", decorators: true }
    : { syntax: "ecmascript", jsx: extension === ".jsx", decorators: true };
}

export function parseSource(path, source) {
  try {
    return parseSync(source, parserOptions(path));
  } catch (error) {
    throw new Error(`Unable to parse ${path} with SWC`, { cause: error });
  }
}

export function walkAst(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string" && visitor(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "span" || key === "ctxt") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visitor, node);
    } else if (value && typeof value === "object") {
      walkAst(value, visitor, node);
    }
  }
}

function lineForSpan(source, span) {
  const byteOffset = Math.max(0, (span?.start ?? 1) - 1);
  return Buffer.from(source)
    .subarray(0, byteOffset)
    .toString("utf8")
    .split("\n").length;
}

function importedName(specifier) {
  if (specifier.imported?.type === "Identifier")
    return specifier.imported.value;
  if (specifier.imported?.type === "StringLiteral")
    return specifier.imported.value;
  return specifier.local?.value ?? null;
}

function runtimeImport(node) {
  if (node.typeOnly) return false;
  if (!node.specifiers?.length) return true;
  return node.specifiers.some(
    (specifier) =>
      specifier.type !== "ImportSpecifier" || specifier.isTypeOnly !== true,
  );
}

function runtimeExport(node) {
  if (node.typeOnly) return false;
  if (!node.specifiers?.length) return true;
  return node.specifiers.some((specifier) => specifier.isTypeOnly !== true);
}

export function collectModuleReferences(
  path,
  source,
  { includeExportNames = false } = {},
) {
  const ast = parseSource(path, source);
  const references = [];
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration" && runtimeImport(node)) {
      references.push({
        importedNames: node.specifiers
          .filter(
            (specifier) =>
              (specifier.type === "ImportSpecifier" && !specifier.isTypeOnly) ||
              (includeExportNames &&
                specifier.type === "ImportDefaultSpecifier"),
          )
          .map((specifier) =>
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : importedName(specifier),
          )
          .filter(Boolean),
        kind: "import",
        line: lineForSpan(source, node.span),
        specifier: node.source.value,
      });
      return;
    }
    if (
      ["ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) &&
      node.source &&
      runtimeExport(node)
    ) {
      references.push({
        importedNames: includeExportNames
          ? (node.specifiers ?? [])
              .filter((item) => !item.isTypeOnly)
              .map((item) => item.orig?.value)
              .filter(Boolean)
          : [],
        kind: "export",
        line: lineForSpan(source, node.span),
        specifier: node.source.value,
      });
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.arguments?.length === 1 &&
      node.arguments[0]?.expression?.type === "StringLiteral" &&
      (node.callee?.type === "Import" ||
        (node.callee?.type === "Identifier" && node.callee.value === "require"))
    ) {
      references.push({
        importedNames: [],
        kind: "dynamic",
        line: lineForSpan(source, node.span),
        specifier: node.arguments[0].expression.value,
      });
    }
  });
  return references;
}

export function runSourceImportSelfTest() {
  const references = collectModuleReferences(
    "fixture.tsx",
    [
      'import type { TypeOnly } from "types-only";',
      'import { type MixedType, Runtime as Alias } from "mixed";',
      'export type { ExportedType } from "export-types";',
      'export { runtimeValue } from "runtime-export";',
      'const lazy = import("lazy-module");',
      'const common = require("common-module");',
      "void <Alias />;",
    ].join("\n"),
  );
  assert.deepEqual(
    references.map(({ importedNames, kind, line, specifier }) => ({
      importedNames,
      kind,
      line,
      specifier,
    })),
    [
      {
        importedNames: ["Runtime"],
        kind: "import",
        line: 2,
        specifier: "mixed",
      },
      {
        importedNames: [],
        kind: "export",
        line: 4,
        specifier: "runtime-export",
      },
      { importedNames: [], kind: "dynamic", line: 5, specifier: "lazy-module" },
      {
        importedNames: [],
        kind: "dynamic",
        line: 6,
        specifier: "common-module",
      },
    ],
  );
  return ["type-only", "named-import", "runtime-export", "dynamic", "require"];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--self-test")) {
    throw new Error("source-imports.mjs only exposes the --self-test command");
  }
  console.log(
    `Source import self-tests: ${runSourceImportSelfTest().join(", ")}`,
  );
}
