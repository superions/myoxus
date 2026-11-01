#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const domains = JSON.parse(
  read("build/test-matrix/api-integration-domains.json"),
);
const suites = JSON.parse(read("build/test-matrix/suites.json"));
const declared = [
  ...read("server/crates/api/tests/integration.rs").matchAll(
    /#\[path = "([^"]+)"\]\s+mod (\w+);/g,
  ),
]
  .filter((match) => !match[1].startsWith("support/"))
  .map((match) => ({
    module: match[2],
    path: `server/crates/api/tests/${match[1]}`,
  }));
const assigned = Object.values(domains).flat();
assert.equal(
  new Set(assigned.map((item) => item.module)).size,
  assigned.length,
  "duplicate capability ownership",
);
const normalize = (items) =>
  items.map((item) => `${item.module}:${item.path}`).sort();
assert.deepEqual(
  normalize(assigned),
  normalize(declared),
  "every compiled integration module needs exactly one capability owner",
);

for (const [id, modules] of Object.entries(domains)) {
  const suite = suites.find((item) => item.id === id);
  assert.ok(suite, `missing executable suite ${id}`);
  const generatedCommand = `bash build/scripts/test/api-integration-domain.sh ${id}`;
  if (
    !suite.command
      .split("&&")
      .some((command) => command.trim() === generatedCommand)
  ) {
    // Existing compound suites retain their application/infrastructure cases.
    for (const { module } of modules) {
      assert.ok(
        suite.command.includes(`${module}::`) ||
          (module.startsWith("mcp_document_") &&
            suite.command.includes("integration mcp_document_ ")),
        `${id} does not execute assigned module ${module}`,
      );
    }
  }
}

assert.ok(
  !suites.some((item) => item.id === "api.integration.all"),
  "the full API inventory must not be a matrix suite",
);
for (const suite of suites) {
  assert.ok(
    !/--test\s+integration\s+--(?:\s+--[\w-]+(?:=\S+)*)*\s*(?:$|&&)/.test(
      suite.command,
    ),
    `unfiltered API execution in matrix suite ${suite.id}`,
  );
}
const stackWrapper = read("build/scripts/ci/verify-server-integration.sh");
assert.ok(
  !/cargo test[^\n]*--test integration/.test(stackWrapper),
  "regular stack wrapper must route through a capability suite",
);
assert.ok(stackWrapper.includes('api-integration-domain.sh" api.integration'));

const execute = promisify(execFile);
async function selection(files) {
  const result = await execute(
    process.execPath,
    ["build/scripts/test/run.mjs", "--files", files, "--dry-run", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(result.stdout).selected.map((item) => item.id);
}
const ownerCases = [
  [
    "server/crates/api/tests/copilot/transcription_results_test.rs",
    "api.integration",
  ],
  [
    "server/crates/api/tests/integrations/git_sync/git_sync_rebase_test.rs",
    "server.git-sync.integration",
  ],
  [
    "server/crates/api/tests/pdf/pdf_export_api_test.rs",
    "server.pdf.integration",
  ],
  [
    "server/crates/api/tests/calendar/calendar_native_repo_test.rs",
    "server.calendar.integration",
  ],
  ["server/crates/api/tests/mcp/mcp_calendar_test.rs", "mcp.calendar.e2e"],
  [
    "server/crates/api/tests/pdf/document_version_graphql_test.rs",
    "server.document-history.integration",
  ],
  [
    "server/crates/api/tests/contract/schema/graphql_schema_drift_test.rs",
    "api.integration",
  ],
];
const metadataCases = [
  "build/test-matrix/api-integration-domains.json",
  "build/test-matrix/api-standard-filters.json",
];
const selections = await Promise.all(
  [...ownerCases.map(([file]) => file), ...metadataCases].map(selection),
);
for (const [index, [file, expected]] of ownerCases.entries()) {
  const ids = selections[index];
  assert.deepEqual(
    ids.filter((id) => Object.hasOwn(domains, id)),
    [expected],
    `wrong full owner for ${file}`,
  );
  assert.ok(
    !ids.includes("api.integration.all"),
    `full aggregate leaked for ${file}`,
  );
  assert.ok(
    !ids.includes("server.api.unit"),
    `test-only change selected unrelated library units: ${file}`,
  );
}
// Metadata changes validate assignment without starting the product they route.
for (const index of metadataCases.keys()) {
  const ids = selections[ownerCases.length + index];
  assert.ok(
    !ids.some(
      (id) =>
        id.startsWith("api.integration") || id.endsWith(".integration.quick"),
    ),
  );
}

// Exercise exact runtime-name selection without compiling or starting services.
const sample = domains["server.git-sync.integration"].map(
  ({ module }) => `${module}::fixture: test`,
);
const result = spawnSync(
  process.execPath,
  [
    "build/scripts/test/api-integration-domain.mjs",
    "server.git-sync.integration",
    "--select-tests",
  ],
  {
    cwd: root,
    encoding: "utf8",
    input: [...sample, "unrelated::fixture: test", `prefix_${sample[0]}`].join(
      "\n",
    ),
  },
);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(
  result.stdout.trim().split("\n"),
  sample.map((line) => line.slice(0, -6)),
);
const missing = spawnSync(
  process.execPath,
  [
    "build/scripts/test/api-integration-domain.mjs",
    "server.git-sync.integration",
    "--select-tests",
  ],
  { cwd: root, encoding: "utf8", input: "unrelated::fixture: test\n" },
);
assert.notEqual(missing.status, 0, "missing compiled module must fail closed");
console.log(
  `API integration routing: ${assigned.length} modules assigned exactly once across ${Object.keys(domains).length} executable capabilities; source-only checks passed.`,
);
