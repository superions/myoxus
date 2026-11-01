// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRetiredTemplateAssets } from "./verify-retired-template-assets.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const removedPathPatterns = [
  /(?:^|[^\w-])packages\/(?:backend|frontend|common)(?:\/|\b)/,
  /["']packages["']\s*,\s*["'](?:backend|frontend|common)["']/,
  /(?:^|[^\w-])blocksuite\//,
  /(?:^|[^\w-])virgultum\/packages(?:\/|(?=[\s"'`,;)]|$))/,
  /(?:^|[^\w-])client\/libs\/component(?:\/|\b)/,
  /(?:^|[^\w-])@myoxus\/component(?:\/|\b)/,
  /(?:^|[^\w-])client\/common(?:\/|\b)/,
  /(?:^|[^\w-])servers\/common\/frontend(?:\/|\b)/,
];

const scannedRoots = [
  ".forgejo/",
  "client/",
  "server/",
  "virgultum/",
  "build/",
  "tools/",
  "todo/",
  "docs/api/",
  "docs/dev/",
  "docs/ops/",
  "docs/test/",
];

const scannedRootContractFiles = new Set([
  ".gitignore",
  ".prettierignore",
  ".yarnrc.yml",
  "Cargo.toml",
  "package.json",
  "tsconfig.json",
  "tsconfig.eslint.json",
  "tsconfig.web.json",
]);

const historicalOrProvenanceRoots = [
  "client/provenance/",
  "virgultum/provenance/",
  "docs/dev/branding/css/historical-",
  "docs/dev/legacy-server/",
  "docs/provenance-inventory.md",
  "docs/dev/virgultum/closeouts/",
  "server/crates/contracts/inventory/",
  "server/crates/infrastructure/migrations/",
  "todo/archive/",
];

const negativeContractFiles = new Set([
  "build/scripts/ci/verify-active-path-contracts.mjs",
  "build/scripts/ci/verify-admin-ui-dependency-graph.mjs",
  "build/scripts/ci/verify-client-source-provenance.mjs",
  "build/scripts/ci/verify-virgultum-source-provenance.mjs",
  "build/scripts/ci/verify-server-source-provenance.mjs",
  "build/scripts/ci/verify-ui-framework-dependency-graph.mjs",
  "build/scripts/frontends/verify-prebuilt-static.sh",
  "client/libs/lit-react/src/lit-react-package-contract.spec.ts",
]);

const generatedContractFiles = new Set([
  "client/libs/graphql/src/graphql/index.ts",
  "client/libs/graphql/src/operations.ts",
  "client/libs/graphql/src/schema.ts",
]);

const requiredIdentityContracts = new Map([
  [
    "server/crates/api/src/auth/base.rs",
    [
      '"affine_session"',
      '"affine_sid"',
      '"affine_user_id"',
      '"myoxus_csrf_token"',
    ],
  ],
  ["server/crates/api/src/client_context.rs", ['"x-affine-version"']],
  ["client/libs/graphql/src/schema.ts", ['AFFINE_LEGACY = "AFFINE_LEGACY"']],
  [
    "server/crates/infrastructure/migrations/1000_myoxus_schema_baseline.sql",
    ["'affine_legacy'"],
  ],
  [
    "client/libs/core/src/desktop/dialogs/import-workspace/index.tsx",
    [".affine,.affine.zip"],
  ],
  [
    "server/crates/application/src/template_registry/bundle.rs",
    ["content.affine.zip", 'trim_end_matches(".affine")'],
  ],
  [
    "virgultum/framework/store/src/schema/flavour-alias.ts",
    [
      '["affine:page", "myoxus:page"]',
      '["affine:surface", "myoxus:surface"]',
      '["affine:surface:text", "myoxus:surface:text"]',
    ],
  ],
  [
    "virgultum/framework/store/src/consts.ts",
    [
      'TEXT_UNIQ_IDENTIFIER = "$virgultum:internal:text$"',
      'NATIVE_UNIQ_IDENTIFIER = "$virgultum:internal:native$"',
      'LEGACY_TEXT_UNIQ_IDENTIFIER = "$blocksuite:internal:text$"',
      'LEGACY_NATIVE_UNIQ_IDENTIFIER = "$blocksuite:internal:native$"',
    ],
  ],
  [
    "virgultum/editor/blocks/embed/src/embed-iframe-block/configs/providers/generic.ts",
    ["toeverything.app", "apple.getaffineapp.com"],
  ],
  [
    "client/apps/android/src/plugins/myoxus-theme/index.ts",
    ['registerPlugin<MyoxusThemePlugin>("AffineTheme")'],
  ],
  [
    "client/apps/android/App/app/build.gradle",
    ['applicationId "app.affine.pro"'],
  ],
  [
    "client/apps/ios/App/App.xcodeproj/project.pbxproj",
    ["PRODUCT_BUNDLE_IDENTIFIER = app.affine.pro;"],
  ],
]);

const clientSourceExtensionPattern = /\.[cm]?[jt]sx?$/;
const obsoleteClientIdentifierPattern = /affine/i;
const obsoleteRuntimeUrlPattern =
  /https?:\/\/[^\s"'`<>]*(?:affine|toeverything|getaffineapp)[^\s"'`<>]*/gi;

function isActiveClientSource(path) {
  return (
    (path.startsWith("client/") || path.startsWith("virgultum/")) &&
    clientSourceExtensionPattern.test(path) &&
    !path.includes("/__tests__/") &&
    !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) &&
    !path.includes("/generated/") &&
    !generatedContractFiles.has(path)
  );
}

/**
 * Extract JavaScript/TypeScript identifiers without treating compatibility
 * strings or comments as product symbols. Template expressions are scanned as
 * code so an obsolete identifier cannot hide inside `${...}` interpolation.
 */
function sourceIdentifiers(source) {
  const identifiers = [];
  let cursor = 0;

  const skipQuoted = (quote) => {
    cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor] === quote) {
        cursor++;
        return;
      } else {
        cursor++;
      }
    }
  };

  const scanTemplate = () => {
    cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") {
        cursor += 2;
      } else if (source[cursor] === "`") {
        cursor++;
        return;
      } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
        cursor += 2;
        scanCode(true);
      } else {
        cursor++;
      }
    }
  };

  const scanCode = (stopAtTemplateBrace = false) => {
    let nestedBraces = 0;
    while (cursor < source.length) {
      const character = source[cursor];
      const next = source[cursor + 1];
      if (character === "/" && next === "/") {
        cursor += 2;
        while (cursor < source.length && source[cursor] !== "\n") cursor++;
      } else if (character === "/" && next === "*") {
        cursor += 2;
        while (
          cursor < source.length &&
          !(source[cursor] === "*" && source[cursor + 1] === "/")
        ) {
          cursor++;
        }
        cursor += 2;
      } else if (character === '"' || character === "'") {
        skipQuoted(character);
      } else if (character === "`") {
        scanTemplate();
      } else if (/[A-Za-z_$]/.test(character)) {
        const start = cursor++;
        while (/[A-Za-z0-9_$]/.test(source[cursor] ?? "")) cursor++;
        identifiers.push(source.slice(start, cursor));
      } else if (character === "{") {
        nestedBraces++;
        cursor++;
      } else if (character === "}" && stopAtTemplateBrace) {
        if (nestedBraces === 0) {
          cursor++;
          return;
        }
        nestedBraces--;
        cursor++;
      } else {
        cursor++;
      }
    }
  };

  scanCode();
  return identifiers;
}

export function findClientIdentityViolations(path, source) {
  if (!isActiveClientSource(path)) return [];

  const findings = [];
  for (const identifier of sourceIdentifiers(source)) {
    if (obsoleteClientIdentifierPattern.test(identifier)) {
      findings.push(`${path}: obsolete client source identifier ${identifier}`);
    }
  }
  for (const match of source.matchAll(obsoleteRuntimeUrlPattern)) {
    findings.push(`${path}: obsolete runtime URL ${match[0]}`);
  }
  return [...new Set(findings)];
}

export function findMissingRequiredLiterals(path, source, requiredLiterals) {
  return requiredLiterals
    .filter((literal) => !source.includes(literal))
    .map((literal) => `${path}: missing compatibility literal ${literal}`);
}

function isClassifiedReference(path, line) {
  if (path.startsWith("todo/") && path.endsWith("-done.md")) return true;
  if (negativeContractFiles.has(path)) return true;
  // Generated GraphQL output can lag only until its mandatory codegen gate;
  // its authoritative Rust and operation sources are scanned independently.
  if (generatedContractFiles.has(path)) return true;
  if (historicalOrProvenanceRoots.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if (/(?:NOTICE|PROVENANCE)\.md$/.test(path)) return true;
  if (/\bnegative-contract\b/i.test(line)) return true;
  if (/https?:\/\//.test(line)) return true;
  return false;
}

export function findObsoletePathReferences(path, source) {
  const findings = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (
      removedPathPatterns.some((pattern) => pattern.test(line)) &&
      !isClassifiedReference(path, line)
    ) {
      findings.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  return findings;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function isScannedContractPath(path) {
  return (
    scannedRootContractFiles.has(path) ||
    scannedRoots.some((prefix) => path.startsWith(prefix))
  );
}

function exportTargetExists(manifestPath, target, trackedFileSet) {
  const packageRoot = dirname(manifestPath);
  const relativeTarget = join(packageRoot, target).replace(/\\/g, "/");
  if (relativeTarget.includes("*")) {
    const escaped = relativeTarget
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".+");
    const targetPattern = new RegExp(`^${escaped}$`);
    return [...trackedFileSet].some((path) => targetPattern.test(path));
  }

  const candidates = [relativeTarget];
  if (relativeTarget.endsWith(".js")) {
    candidates.push(
      relativeTarget.slice(0, -3) + ".ts",
      relativeTarget.slice(0, -3) + ".tsx",
    );
  }
  if (!/\.[cm]?[jt]sx?$/.test(relativeTarget)) {
    candidates.push(
      `${relativeTarget}.ts`,
      `${relativeTarget}.tsx`,
      `${relativeTarget}/index.ts`,
      `${relativeTarget}/index.tsx`,
    );
  }
  return candidates.some((candidate) => trackedFileSet.has(candidate));
}

function verifyPackageExports(files) {
  const findings = [];
  const trackedFileSet = new Set(files);
  for (const path of files.filter((path) => path.endsWith("package.json"))) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
    for (const [specifier, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "string" || !target.startsWith("./")) continue;
      // Compiled package entry points are materialized by their package build
      // and are intentionally absent from a clean source checkout.
      if (target === "./dist" || target.startsWith("./dist/")) continue;
      if (!exportTargetExists(path, target, trackedFileSet)) {
        findings.push(`${path}: export ${specifier} targets missing ${target}`);
      }
    }
  }
  return findings;
}

function verifyActivePaths() {
  const files = trackedFiles();
  const findings = verifyPackageExports(files);
  for (const path of files) {
    if (!isScannedContractPath(path)) continue;
    const absolutePath = join(repoRoot, path);
    let source;
    try {
      source = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (source.includes("\0")) continue;
    findings.push(...findObsoletePathReferences(path, source));
    findings.push(...findClientIdentityViolations(path, source));
  }
  for (const [path, literals] of requiredIdentityContracts) {
    const source = readFileSync(join(repoRoot, path), "utf8");
    findings.push(...findMissingRequiredLiterals(path, source, literals));
  }
  return findings.sort();
}

export function runActivePathContractSelfTest() {
  assert.deepEqual(
    findObsoletePathReferences(
      "build/config.json",
      '{"scope":"packages/backend/server/src"}',
    ),
    ['build/config.json:1: {"scope":"packages/backend/server/src"}'],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "client/current.ts",
      'import "client/common/core/bootstrap"',
    ),
    ['client/current.ts:1: import "client/common/core/bootstrap"'],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "docs/dev/current.md",
      "Use @myoxus/component for buttons",
    ),
    ["docs/dev/current.md:1: Use @myoxus/component for buttons"],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "todo/virgultum.md",
      "Current documentation: docs/dev/virgultum/packages.md",
    ),
    [],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "todo/release.md",
      "negative-contract: packages/backend/server/src must fail",
    ),
    [],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "tools/runner.js",
      'join(root, "packages", "backend", "server")',
    ),
    ['tools/runner.js:1: join(root, "packages", "backend", "server")'],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "docs/provenance-inventory.md",
      "Historical source: packages/backend/server/src",
    ),
    [],
  );
  assert.deepEqual(
    findObsoletePathReferences(
      "build/scripts/ci/verify-client-source-provenance.mjs",
      'const forbidden = "packages/backend";',
    ),
    [],
  );
  assert.equal(
    exportTargetExists(
      "client/libs/example/package.json",
      "./src/missing.ts",
      new Set(["client/libs/example/package.json"]),
    ),
    false,
  );
  assert.equal(
    exportTargetExists(
      "client/libs/example/package.json",
      "./src/*",
      new Set([
        "client/libs/example/package.json",
        "client/libs/example/src/index.ts",
      ]),
    ),
    true,
  );
  assert.equal(isScannedContractPath(".prettierignore"), true);
  assert.equal(isScannedContractPath(".forgejo/workflows/pr-check.yml"), true);
  assert.equal(isScannedContractPath("todo/server.md"), true);
  assert.equal(isScannedContractPath("AGENTS.md"), false);
  assert.deepEqual(
    findClientIdentityViolations(
      "client/current.ts",
      "export class AffineErrorBoundary {}",
    ),
    [
      "client/current.ts: obsolete client source identifier AffineErrorBoundary",
    ],
  );
  assert.deepEqual(
    findClientIdentityViolations(
      "client/current.ts",
      "export function registerAffineCommands() {}",
    ),
    [
      "client/current.ts: obsolete client source identifier registerAffineCommands",
    ],
  );
  assert.deepEqual(
    findClientIdentityViolations(
      "client/current.ts",
      "export const label = `${registerAffineCommands()}`;",
    ),
    [
      "client/current.ts: obsolete client source identifier registerAffineCommands",
    ],
  );
  assert.deepEqual(
    findClientIdentityViolations(
      "client/current.ts",
      'export const endpoint = "https://app.affine.pro/graphql";',
    ),
    ["client/current.ts: obsolete runtime URL https://app.affine.pro/graphql"],
  );
  assert.deepEqual(
    findClientIdentityViolations(
      "client/apps/android/src/plugins/myoxus-theme/index.ts",
      'const MyoxusTheme = registerPlugin("AffineTheme");',
    ),
    [],
  );
  assert.deepEqual(
    findClientIdentityViolations(
      "client/current.ts",
      "export class MyoxusErrorBoundary {}",
    ),
    [],
  );
  assert.deepEqual(
    findMissingRequiredLiterals(
      "client/import.ts",
      'const accepted = ".myoxus";',
      [".affine.zip"],
    ),
    ["client/import.ts: missing compatibility literal .affine.zip"],
  );
  return [
    "phantom-scope",
    "segmented-phantom-scope",
    "provenance-classification",
    "negative-contract",
    "active-todo-scope",
    "semantic-packages-document",
    "retired-package-specifier",
    "retired-client-common-tree",
    "missing-export",
    "wildcard-export",
    "root-contract-scope",
    "obsolete-client-identifier",
    "obsolete-composite-client-identifier",
    "obsolete-template-expression-identifier",
    "obsolete-runtime-url",
    "allowed-wire-identifier",
    "current-client-identifier",
    "required-compatibility-literal",
  ];
}

const selfTests = runActivePathContractSelfTest();
if (process.argv.includes("--self-test")) {
  console.log(`Active path contract self-tests: ${selfTests.join(", ")}`);
  process.exit(0);
}

const findings = verifyActivePaths();
if (findings.length) {
  for (const finding of findings)
    console.error(`active-path-contract: ${finding}`);
  process.exit(1);
}

await verifyRetiredTemplateAssets(repoRoot);

console.log("Active path contracts match the current repository trees.");
