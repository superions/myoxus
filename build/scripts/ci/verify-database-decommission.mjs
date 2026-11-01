#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const baselinePath = path.join(
  repoRoot,
  "build/scripts/ci/database-decommission-baseline.json",
);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const jsonOutput = process.argv.includes("--json");
const runSelfTest = process.argv.includes("--self-test");
const generatedDirectoryNames = new Set(["coverage", "dist", "node_modules"]);

function sourceFiles(roots) {
  const files = [];
  const visit = (absolutePath) => {
    if (!existsSync(absolutePath)) return;
    const statEntries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of statEntries) {
      const child = path.join(absolutePath, entry.name);
      // Guards own authored source. Generated declarations can be stale after
      // a deletion and must never redefine the active runtime inventory.
      if (entry.isDirectory() && !generatedDirectoryNames.has(entry.name)) {
        visit(child);
      } else if (/\.(?:rs|ts|tsx)$/.test(entry.name)) files.push(child);
    }
  };

  for (const root of roots) {
    const absolute = path.join(repoRoot, root);
    if (!existsSync(absolute)) continue;
    if (/\.(?:rs|ts|tsx)$/.test(absolute)) files.push(absolute);
    else visit(absolute);
  }
  return [...new Set(files)].sort();
}

function findHits(policy) {
  const hits = [];
  for (const forbiddenPath of policy.forbiddenPaths ?? []) {
    const absolutePath = path.join(repoRoot, forbiddenPath);
    if (existsSync(absolutePath)) {
      hits.push({ file: forbiddenPath, line: 1 });
    }
  }
  for (const absolutePath of sourceFiles(policy.roots)) {
    const relativePath = path.relative(repoRoot, absolutePath);
    if (policy.exclude?.some((pattern) => pattern.test(relativePath))) continue;
    const lines = readFileSync(absolutePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (policy.patterns.some((pattern) => pattern.test(line))) {
        hits.push({ file: relativePath, line: index + 1 });
      }
    });
  }
  return hits;
}

function unexpectedFiles(hits, allowedFiles) {
  const allowed = new Set(allowedFiles);
  return [...new Set(hits.map((hit) => hit.file))].filter(
    (file) => !allowed.has(file),
  );
}

const specPattern = /\.(?:spec|test)\.tsx?$/;
const policies = [
  {
    id: "document_import_notion",
    roots: ["client/libs/core/src/desktop/dialogs/import/index.tsx"],
    patterns: [
      /NotionHtmlTransformer/,
      /editor-option-menu-import-notion/,
      /com\.myoxus\.import\.notion/,
      /["']notion["']/,
    ],
    allowed: [],
  },
  {
    id: "linked_doc_notion",
    roots: ["virgultum/editor/widgets/linked-doc/src"],
    patterns: [/NotionHtmlTransformer/, /_importNotion/, /importNotionZip/],
    allowed: baseline.policies.linked_doc_notion,
  },
  {
    id: "editor_local_database_creation",
    roots: ["client", "virgultum"],
    patterns: [
      /blockType\s*:\s*["']myoxus:database["']/,
      /\[\{\s*flavour\s*:\s*["']myoxus:database["']/,
    ],
    exclude: [specPattern],
    allowed: baseline.policies.editor_local_database_creation,
  },
  {
    id: "core_editor_database_runtime",
    roots: ["client/libs/core/src/editor"],
    patterns: [
      /@virgultum\/editor\/blocks\/database/,
      /DatabaseViewExtension/,
      /DatabaseBlockDataSource/,
      /propertiesPresets/,
      /groupByConfigList/,
    ],
    exclude: [specPattern],
    allowed: baseline.policies.core_editor_database_runtime,
  },
  {
    id: "virgultum_projection",
    roots: ["client/libs/core/src/modules/database"],
    patterns: [/toVirgultum/],
    exclude: [specPattern],
    allowed: baseline.policies.virgultum_projection,
  },
  {
    id: "editor_local_database_runtime",
    roots: ["client", "virgultum"],
    patterns: [
      /from ["']@virgultum\/block-database["']/,
      /DatabaseBlockDataSource/,
      /DatabaseViewExtension/,
      /propertiesPresets/,
      /groupByConfigList/,
      /convertToDatabase/,
      /DATABASE_CONVERT_WHITE_LIST/,
    ],
    exclude: [specPattern],
    allowed: baseline.policies.editor_local_database_runtime,
  },
  {
    id: "removed_editor_database_files",
    roots: [],
    patterns: [],
    forbiddenPaths: [
      "client/libs/core/src/modules/database/database-block-adapter/projection.ts",
      "virgultum/editor/blocks/database/src/adapters",
      "virgultum/editor/blocks/database/src/context",
      "virgultum/editor/blocks/database/src/data-source.ts",
      "virgultum/editor/blocks/database/src/database-block.ts",
      "virgultum/editor/blocks/database/src/detail-panel",
      "virgultum/editor/blocks/database/src/properties",
      "virgultum/editor/blocks/database/src/service",
      "virgultum/editor/blocks/database/src/store.ts",
      "virgultum/editor/blocks/database/src/view.ts",
    ],
    allowed: baseline.policies.removed_editor_database_files,
  },
  {
    id: "active_database_ui_private_virgultum",
    roots: ["client/libs/core/src/modules/database"],
    patterns: [
      /virgultum\/editor\/blocks\/database\/src/,
      /DatabaseTablePreset/,
      /virgultum-adapter/,
    ],
    exclude: [specPattern],
    allowed: [],
  },
  {
    id: "legacy_workspace_local_import",
    roots: [
      "client/libs/core/src/desktop/dialogs/import",
      "client/libs/core/src/desktop/dialogs/import-workspace",
    ],
    patterns: [/dotaffinefile/, /loadDBFile/, /_addLocalWorkspace/],
    exclude: [specPattern],
    allowed: baseline.policies.legacy_workspace_local_import,
  },
  {
    id: "electron_legacy_backup_fallback",
    roots: ["client/apps/electron/src/helper/dialog/dialog.ts"],
    patterns: [/cpV1DBFile/, /SqliteConnection\.validate/],
    exclude: [specPattern],
    allowed: baseline.policies.electron_legacy_backup_fallback,
  },
  {
    id: "browser_local_workspace_import",
    roots: ["client/web"],
    patterns: [
      /dotaffinefile/,
      /loadDBFile/,
      /_addLocalWorkspace/,
      /createLocalWorkspace/,
    ],
    exclude: [specPattern],
    allowed: [],
  },
  {
    id: "snapshot_archive_parser",
    roots: ["server/crates"],
    patterns: [
      /fn is_snapshot_json_path/,
      /fn validate_snapshot_archive/,
      /fn inspect_zip_archive/,
      /fn detect_portable_archive_kind/,
    ],
    exclude: [/(?:^|\/)target\//],
    allowed: baseline.policies.snapshot_archive_parser,
  },
];

if (runSelfTest) {
  const sampleHits = [
    { file: "allowed.ts", line: 1 },
    { file: "new-regression.ts", line: 2 },
  ];
  const violations = unexpectedFiles(sampleHits, ["allowed.ts"]);
  if (violations.length !== 1 || violations[0] !== "new-regression.ts") {
    throw new Error(
      "decommission guard negative self-test did not fail closed",
    );
  }
}

const report = policies.map((policy) => {
  const hits = findHits(policy);
  return {
    id: policy.id,
    files: [...new Set(hits.map((hit) => hit.file))],
    hit_count: hits.length,
    violations: unexpectedFiles(hits, policy.allowed),
  };
});
const violations = report.flatMap((entry) =>
  entry.violations.map((file) => ({ policy: entry.id, file })),
);

if (jsonOutput) {
  console.log(JSON.stringify({ report, violations }, null, 2));
} else {
  for (const entry of report) {
    console.log(
      `${entry.id}: ${entry.hit_count} hit(s) in ${entry.files.length} file(s)`,
    );
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.policy}: unexpected source ${violation.file}`);
  }
  process.exit(1);
}
