#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");

const scanRoots = [
  "server/crates/api/src",
  "server/crates/application/src",
  "server/crates/worker/src",
  "server/crates/cli/src",
  "client/admin/workspaces/admin/src",
  "build/scripts",
  "build/test-matrix",
  ".forgejo",
  "docs/ops",
  "package.json",
];

const scannedExtensions = new Set([
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);
const ignoredPathParts = new Set([
  ".git",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "output",
  "target",
]);

const deprecatedAliasFiles = new Set([
  "server/crates/api/src/config.rs",
  "server/crates/api/src/graphql/config.rs",
]);
// These exact references prove or document alias rejection. Keeping them narrow
// prevents the guard from treating negative evidence as active operational use.
const deprecatedAliasEvidence = new Map([
  [
    "docs/ops/data/databases/README.md",
    [
      /queue alias `workspace-database`, emits a startup warning, and always projects/,
    ],
  ],
  [
    "server/crates/api/src/handlers/metrics.rs",
    [/assert!\(!KNOWN_QUEUE_NAMES\.contains\(&"workspace-database"\)\);/],
  ],
]);
const selfPath = "build/scripts/ci/verify-database-operational-naming.mjs";
const dateTimeConfigTargets = [
  "build/scripts/test/seed-test-users.sh",
  "server/crates/infrastructure/src/workspace_database/definition/managed_schema.rs",
  "server/crates/infrastructure/src/workspace_database/definition/mod.rs",
  "server/crates/infrastructure/src/workspace_database/editing/batches.rs",
  "server/crates/infrastructure/src/workspace_database/editing/capture.rs",
  "server/crates/infrastructure/src/workspace_database/editing/changes.rs",
  "server/crates/infrastructure/src/workspace_database/editing/links.rs",
  "server/crates/infrastructure/src/workspace_database/editing/mod.rs",
  "server/crates/infrastructure/src/workspace_database/editing/movement.rs",
  "server/crates/infrastructure/src/workspace_database/editing/relations.rs",
  "server/crates/infrastructure/src/workspace_database/editing/task_events.rs",
  "server/crates/infrastructure/src/workspace_database/editing/templates.rs",
  "server/crates/infrastructure/src/workspace_automation/task_events.rs",
  "server/crates/infrastructure/src/workspace_database/import_export/mod.rs",
  "server/crates/infrastructure/src/workspace_database/import_export/workspace_content.rs",
  "server/crates/infrastructure/src/workspace_database/mod.rs",
  "server/crates/infrastructure/src/workspace_database/projections/mod.rs",
  "server/crates/infrastructure/src/workspace_database/projections/hooks.rs",
  "server/crates/infrastructure/src/workspace_database/projections/references.rs",
  "server/crates/infrastructure/src/workspace_database/projections/values.rs",
  "server/crates/infrastructure/src/workspace_database/projects.rs",
  "server/crates/infrastructure/src/workspace_database/reminders/hooks.rs",
  "server/crates/infrastructure/src/workspace_database/reminders.rs",
  "server/crates/infrastructure/src/workspace_database/views/definitions.rs",
  "server/crates/infrastructure/src/workspace_database/views/mod.rs",
  "server/crates/infrastructure/src/workspace_database/views/query.rs",
  "server/crates/infrastructure/src/workspace_database/views/state.rs",
  "server/crates/infrastructure/src/workspace_database/views/tasks.rs",
  "server/crates/infrastructure/tests/database_row_reminders_test.rs",
  "server/crates/api/tests/db/workspaces/graphql_database_test.rs",
];

const rules = [
  {
    id: "legacy-database-queue-key",
    pattern:
      /\b(?:job\.queues\.|queues\.)workspace-database(?:\.concurrency)?\b/g,
  },
  {
    id: "legacy-database-queue-literal",
    pattern: /["'`]workspace-database["'`]/g,
  },
  {
    id: "legacy-database-worker-polling-key",
    pattern:
      /\b(?:worker\.polling\.)?workspace_database_projection_interval_ms\b/g,
  },
  {
    id: "legacy-database-admin-config-key",
    pattern: /\bworkerWorkspaceDatabaseProjectionIntervalMs\b/g,
  },
  {
    id: "legacy-database-job-name",
    pattern:
      /\bworkspaceDatabase\.recompute(?:Rollups|Formulas|StaleProjections)\b/g,
  },
  {
    id: "legacy-database-operational-copy",
    pattern:
      /\b(?:workspace-database|workspace database|Workspace Database)\s+(?:queue|worker|job|jobs|projection|projections)\b/g,
  },
];

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
  return rel.split("/").some((part) => ignoredPathParts.has(part));
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

function lineSnippet(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const nextLine = source.indexOf("\n", index);
  const lineEnd = nextLine === -1 ? source.length : nextLine;
  return source.slice(lineStart, lineEnd).trim();
}

function isAllowedDeprecatedAlias(rel, ruleId) {
  if (!deprecatedAliasFiles.has(rel)) return false;
  return [
    "legacy-database-queue-key",
    "legacy-database-queue-literal",
    "legacy-database-worker-polling-key",
    "legacy-database-admin-config-key",
  ].includes(ruleId);
}

function isDeprecatedAliasEvidence(rel, snippet) {
  return (deprecatedAliasEvidence.get(rel) ?? []).some((pattern) =>
    pattern.test(snippet),
  );
}

const findings = [];

for (const root of scanRoots) {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) continue;
  for (const file of walk(absoluteRoot)) {
    const rel = normalizedRel(file);
    if (rel === selfPath) continue;
    const source = readFileSync(file, "utf8");
    for (const rule of rules) {
      for (const match of source.matchAll(rule.pattern)) {
        const index = match.index ?? 0;
        if (isAllowedDeprecatedAlias(rel, rule.id)) continue;
        if (isDeprecatedAliasEvidence(rel, lineSnippet(source, index)))
          continue;
        findings.push({
          path: rel,
          line: lineFor(source, index),
          rule: rule.id,
          snippet: lineSnippet(source, index),
        });
      }
    }
  }
}

for (const rel of dateTimeConfigTargets) {
  const file = resolve(repoRoot, rel);
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  const reminderConfigPatterns = [
    /config_json\s*->>\s*['"](?:allow_reminders|default_time_zone)['"]/g,
    /(?:\\?["'])(?:allow_reminders|default_time_zone)(?:\\?["'])\s*:/g,
  ];
  for (const pattern of reminderConfigPatterns) {
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      findings.push({
        path: rel,
        line: lineFor(source, index),
        rule: "legacy-datetime-config-json-member",
        snippet: lineSnippet(source, index),
      });
    }
  }
}

findings.sort((a, b) =>
  `${a.path}:${a.line}:${a.rule}`.localeCompare(
    `${b.path}:${b.line}:${b.rule}`,
  ),
);

if (jsonMode) {
  console.log(JSON.stringify({ findings }, null, 2));
} else {
  console.log("database operational naming guard");
  console.log(`findings=${findings.length}`);
  for (const finding of findings) {
    console.log(
      `${finding.rule}\t${finding.path}:${finding.line}\t${finding.snippet}`,
    );
  }
}

if (findings.length > 0) {
  console.error(
    "Deprecated Database operational names or DateTime config JSON members were found outside their canonical boundaries.",
  );
  process.exit(1);
}
