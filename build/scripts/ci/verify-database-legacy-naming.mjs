#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const jsonMode = args.has("--json");
const updateBaseline = args.has("--update-baseline");

const baselinePath = "build/scripts/ci/database-legacy-naming-baseline.json";
const selfPath = "build/scripts/ci/verify-database-legacy-naming.mjs";
const operationalGuardPath =
  "build/scripts/ci/verify-database-operational-naming.mjs";

const scanRoots = [
  "server/crates/domain/src",
  "server/crates/application/src",
  "server/crates/api/src",
  "server/crates/infrastructure/src",
  "server/crates/infrastructure/migrations",
  "server/crates/mcp/src",
  "server/crates/worker/src",
  "server/crates/cli/src",
  "client/libs/graphql/src/graphql",
  "client/libs/core/src",
  "client/web/src",
  "client/admin/workspaces/admin/src",
  "build/scripts",
  "build/test-matrix",
  "docs/dev",
  "docs/ops",
];

const scannedExtensions = new Set([
  ".gql",
  ".graphql",
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
  "__generated__",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "output",
  "target",
]);

const rules = [
  {
    id: "pascal-symbol",
    pattern: /\bWorkspaceDatabase[A-Za-z0-9_]*/g,
  },
  {
    id: "product-phrase",
    pattern: /\bWorkspace Databases?\b/g,
  },
  {
    id: "camel-symbol",
    pattern: /\bworkspaceDatabase[A-Za-z0-9_]*/g,
  },
  {
    id: "snake-symbol",
    pattern: /\bworkspace_database[A-Za-z0-9_]*/g,
  },
  {
    id: "kebab-symbol",
    pattern: /\bworkspace-database[A-Za-z0-9_-]*/g,
  },
  {
    id: "lower-product-phrase",
    pattern: /\bworkspace databases?\b/g,
  },
];

const allowedStorageSnakeSymbols = new Map([
  [
    "server/crates/infrastructure/src/recurrence/advance.rs",
    new Set(["workspace_databases", "workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/recurrence/mod.rs",
    new Set(["workspace_databases", "workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/recurrence/lifecycle.rs",
    new Set(["workspace_databases", "workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/scheduling/mod.rs",
    new Set(["workspace_databases", "workspace_database_fields"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_automation/task_events.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/projections/hooks.rs",
    new Set([
      "workspace_database",
      "workspace_database_fields",
      "workspace_database_formula_dependencies",
      "workspace_database_formula_values",
      "workspace_database_relation_edges",
      "workspace_database_rollup_values",
      "workspace_database_rows",
    ]),
  ],
  [
    "server/crates/infrastructure/src/doc/mod.rs",
    new Set(["workspace_database", "workspace_database_rows"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/maintenance.rs",
    new Set([
      "workspace_database",
      "workspace_databases",
      "workspace_database_rows",
      "workspace_database_cell_values",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/projections/mod.rs",
    new Set([
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_formula_dependencies",
      "workspace_database_formula_values",
      "workspace_database_relation_edges",
      "workspace_database_rollup_values",
      "workspace_database_row_search",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/projections/references.rs",
    new Set([
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/projections/values.rs",
    new Set([
      "workspace_database",
      "workspace_database_fields",
      "workspace_database_formula_values",
      "workspace_database_rollup_values",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workflow_runtime/effects.rs",
    new Set([
      "workspace_database",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_automation.rs",
    new Set([
      "workspace_database",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workflow_runtime/waits.rs",
    new Set(["workspace_database", "workspace_databases"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/handover.rs",
    new Set([
      "workspace_database",
      "workspace_database_rows",
      "workspace_database_fields",
      "workspace_database_cell_values",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/automation_events.rs",
    new Set([
      "workspace_database",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/review.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_rows",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace/starter_documents.rs",
    new Set(["workspace_database_rows", "workspace_databases"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/definition/managed_schema.rs",
    new Set([
      "workspace_database",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/definition/select_updates.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/definition/mod.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/batches.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_search",
      "workspace_database_rows",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/capture.rs",
    new Set(["workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/changes.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_relation_edges",
      "workspace_database_row_search",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/links.rs",
    new Set([
      "workspace_database",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/mod.rs",
    new Set(["workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/movement.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_formula_values",
      "workspace_database_relation_edges",
      "workspace_database_rollup_values",
      "workspace_database_row_search",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/relations.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_relation_edges",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/task_events.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/editing/templates.rs",
    new Set([
      "workspace_database",
      "workspace_database_row_templates",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/import_export/workspace_content.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/import_export/mod.rs",
    new Set([
      "workspace_database_csv_mapping_templates",
      "workspace_database_row_search",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/mod.rs",
    new Set([
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/projects.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/reminders/hooks.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/reminders.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/views/definitions.rs",
    new Set(["workspace_database", "workspace_database_views"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/views/mod.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_page_inventory_revision",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/views/state.rs",
    new Set(["workspace_database", "workspace_database_views"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_database/views/tasks.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],

  // Managed schema and movement reuse the deployed tables and repository
  // module. Keep this boundary explicit without admitting new product names.
  ["server/crates/api/src/bin/server.rs", new Set(["workspace_database"])],
  [
    "server/crates/infrastructure/src/workspace/mod.rs",
    new Set(["workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/database_activity.rs",
    new Set(["workspace_databases", "workspace_database_rows"]),
  ],
  [
    "server/crates/infrastructure/src/workspace/starter.rs",
    new Set(["workspace_database", "workspace_databases"]),
  ],
  [
    "server/crates/infrastructure/src/auth/mod.rs",
    new Set(["workspace_databases"]),
  ],
  // Definition extraction keeps the deployed physical SQL names and module.
  ["build/test-matrix/path-rules.json", new Set(["workspace_database"])],
  ["build/test-matrix/suites.json", new Set(["workspace_database"])],
  [
    "build/scripts/server/test-packaged-template-loaders.mjs",
    new Set([
      "workspace_databases",
      "workspace_database_fields",
      "workspace_database_views",
      "workspace_database_rows",
      "workspace_database_cell_values",
      "workspace_database_row_templates",
    ]),
  ],
  // Physical SQL table names still use the historical storage prefix until a
  // dedicated migration renames persisted tables. These are not active product,
  // queue, config, API, GraphQL or UI names and must not force unrelated
  // Database work to inflate the legacy baseline.
  [
    "server/crates/api/src/database_task_notification.rs",
    // Composition reuses the existing physical Rust module; product/domain
    // names still use Database, and no prefixed SQL/API symbols are exempt.
    new Set(["workspace_database"]),
  ],
  [
    "server/crates/infrastructure/src/workspace_tags.rs",
    new Set([
      // The lifecycle transaction calls the canonical repository type through
      // its still-unmigrated physical Rust module. This is the same bounded
      // storage boundary as the SQL table identifiers below, not a new public
      // or domain-level Database name.
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_search",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/application/src/workspace_content_operation/authorization.rs",
    new Set(["workspace_databases"]),
  ],
  [
    "server/crates/application/src/workspace_content_operation/dependencies.rs",
    new Set([
      "workspace_database_cell_values",
      "workspace_database_csv_mapping_templates",
      "workspace_database_fields",
      "workspace_database_formula_dependencies",
      "workspace_database_formula_values",
      "workspace_database_page_inventory_revision",
      "workspace_database_relation_edges",
      "workspace_database_rollup_values",
      "workspace_database_row_search",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/migrations.rs",
    new Set(["workspace_database_page_inventory_revision"]),
  ],
  [
    "server/crates/application/src/workspace_content_operation/preflight.rs",
    new Set([
      "workspace_database_relation_edges",
      "workspace_database_rows",
      "workspace_databases",
    ]),
  ],
  [
    "server/crates/infrastructure/src/workspace_content_operation.rs",
    new Set([
      "workspace_database",
      "workspace_database_cell_values",
      "workspace_database_fields",
      "workspace_database_row_search",
      "workspace_database_row_templates",
      "workspace_database_rows",
      "workspace_database_views",
      "workspace_databases",
    ]),
  ],
]);

const physicalStorageDocumentationPaths = new Set([
  // These documents intentionally expose applied SQL identifiers to developers
  // and operators. Only Markdown code references are exempt; prose and product
  // contracts remain subject to the naming ratchet.
  "docs/dev/server/databases-data-model.md",
  "docs/ops/data/databases/README.md",
]);

function lineAt(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const nextNewline = source.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  return source.slice(lineStart, lineEnd);
}

function isMarkdownCodeReference(source, match) {
  if (match.index == null) return false;
  const line = lineAt(source, match.index);
  const offset = match.index - (source.lastIndexOf("\n", match.index) + 1);
  const before = line.slice(0, offset);
  const after = line.slice(offset + match[0].length);
  const inlineCode =
    before.lastIndexOf("`") > before.lastIndexOf("```") && after.includes("`");
  const fencedCode =
    (source.slice(0, match.index).match(/```/g)?.length ?? 0) % 2 === 1;
  return inlineCode || fencedCode;
}

function isAllowedStorageSnakeSymbol(path, match) {
  if (!allowedStorageSnakeSymbols.has(path)) return false;
  const symbols = allowedStorageSnakeSymbols.get(path);
  return symbols === null || symbols.has(match[0]);
}

function isDocumentedDeprecatedConfigAlias(rel, source, match) {
  if (rel !== "docs/ops/data/databases/README.md" || match.index == null)
    return false;
  const paragraphStart = source.lastIndexOf("\n\n", match.index) + 2;
  const nextParagraph = source.indexOf("\n\n", match.index);
  const paragraphEnd = nextParagraph === -1 ? source.length : nextParagraph;
  const paragraph = source.slice(paragraphStart, paragraphEnd);
  return (
    isMarkdownCodeReference(source, match) &&
    paragraph.includes("dated serde aliases") &&
    paragraph.includes("emits a startup warning")
  );
}

function isNegativeNamingAssertion(rel, source, match) {
  if (
    rel !== "server/crates/api/src/handlers/metrics.rs" ||
    match.index == null
  ) {
    return false;
  }
  const line = lineAt(source, match.index);
  return (
    line.includes("assert!(!KNOWN_QUEUE_NAMES.contains(") &&
    line.includes(match[0])
  );
}

function extensionOf(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function normalizedRel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function isAllowedStoragePathReference(rel, source, match) {
  if (rel !== "build/test-matrix/suites.json" || match.index == null)
    return false;
  const lineStart = source.lastIndexOf("\n", match.index) + 1;
  const nextNewline = source.indexOf("\n", match.index);
  const lineEnd = nextNewline === -1 ? source.length : nextNewline;
  return (
    source.slice(lineStart, lineEnd).trim().replace(/,$/, "") ===
    '"server/crates/infrastructure/src/workspace_database/**"'
  );
}

function isIgnored(path) {
  const rel = normalizedRel(path);
  // Naming guards necessarily contain the forbidden spellings as detection
  // patterns. They are policy sources, not active product naming debt.
  if (rel === selfPath || rel === operationalGuardPath || rel === baselinePath)
    return true;
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

function scan() {
  const files = {};
  for (const root of scanRoots) {
    const absoluteRoot = resolve(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const file of walk(absoluteRoot)) {
      const rel = normalizedRel(file);
      const source = readFileSync(file, "utf8");
      const counts = {};
      for (const rule of rules) {
        const count = [...source.matchAll(rule.pattern)].filter((match) => {
          if (isNegativeNamingAssertion(rel, source, match)) return false;
          if (isDocumentedDeprecatedConfigAlias(rel, source, match)) {
            return false;
          }
          if (rule.id !== "snake-symbol") return true;
          return !(
            isAllowedStorageSnakeSymbol(rel, match) ||
            // Matrix ownership may name the one permitted physical SQLx
            // storage file without introducing an active symbol.
            isAllowedStoragePathReference(rel, source, match) ||
            (physicalStorageDocumentationPaths.has(rel) &&
              isMarkdownCodeReference(source, match))
          );
        }).length;
        if (count > 0) counts[rule.id] = count;
      }
      if (Object.keys(counts).length > 0) {
        files[rel] = counts;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function readBaseline() {
  const absoluteBaseline = resolve(repoRoot, baselinePath);
  if (!existsSync(absoluteBaseline)) {
    throw new Error(
      `Missing ${baselinePath}. Run this script with --update-baseline in an intentional P-DB-01 naming-ratchet commit.`,
    );
  }
  return JSON.parse(readFileSync(absoluteBaseline, "utf8")).files ?? {};
}

function compare(current, baseline) {
  const findings = [];
  for (const [path, counts] of Object.entries(current)) {
    const baselineCounts = baseline[path] ?? {};
    for (const rule of rules) {
      const currentCount = counts[rule.id] ?? 0;
      const allowedCount = baselineCounts[rule.id] ?? 0;
      if (currentCount > allowedCount) {
        findings.push({
          path,
          rule: rule.id,
          allowed: allowedCount,
          current: currentCount,
          added: currentCount - allowedCount,
        });
      }
    }
  }
  findings.sort((a, b) =>
    `${a.path}:${a.rule}`.localeCompare(`${b.path}:${b.rule}`),
  );
  return findings;
}

const current = scan();

if (updateBaseline) {
  const payload = {
    generatedAt: new Date().toISOString(),
    purpose:
      "P-DB-01 migration ratchet. Counts are legacy Database naming debt, not approved target names; reductions are always allowed, additions fail the guard.",
    scanRoots,
    rules: rules.map(({ id }) => id),
    files: current,
  };
  const absoluteBaseline = resolve(repoRoot, baselinePath);
  mkdirSync(dirname(absoluteBaseline), { recursive: true });
  writeFileSync(absoluteBaseline, `${JSON.stringify(payload, null, 2)}\n`);
  if (!jsonMode) {
    console.log(`database legacy naming baseline updated: ${baselinePath}`);
    console.log(`files=${Object.keys(current).length}`);
  } else {
    console.log(
      JSON.stringify(
        { baselinePath, files: Object.keys(current).length },
        null,
        2,
      ),
    );
  }
  process.exit(0);
}

const baseline = readBaseline();
const findings = compare(current, baseline);

if (jsonMode) {
  console.log(JSON.stringify({ findings }, null, 2));
} else {
  console.log("database legacy naming ratchet");
  console.log(`findings=${findings.length}`);
  for (const finding of findings) {
    console.log(
      `${finding.rule}\t${finding.path}\tallowed=${finding.allowed}\tcurrent=${finding.current}\tadded=${finding.added}`,
    );
  }
}

if (findings.length > 0) {
  console.error(
    "New legacy Database naming is blocked by P-DB-01. Rename to Database* or reduce the existing baseline in the same intentional migration slice.",
  );
  process.exit(1);
}
