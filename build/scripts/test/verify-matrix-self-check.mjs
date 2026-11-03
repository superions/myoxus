#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";

import {
  classifyBlockingResult,
  suiteExitCode,
} from "./matrix-result-policy.mjs";
import { runWithProcessTreeTimeout } from "./process-tree-runner.mjs";
import { evaluateRuntimeBudget } from "./runtime-budget.mjs";
import {
  createVitestDiagnosticContract,
  VitestDiagnosticUsageError,
} from "./vitest-diagnostic-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function verifyRuntimeBudgetTolerance() {
  const runtimeBudgets = JSON.parse(
    readFileSync(
      path.join(repoRoot, "build/test-matrix/runtime-budgets.json"),
      "utf8",
    ),
  );
  const tolerance = Number(
    runtimeBudgets.policy?.fluctuation_tolerance_percent,
  );
  if (tolerance !== 20) {
    throw new Error(
      `runtime fluctuation tolerance must be 20%, got ${tolerance}`,
    );
  }

  const equalThresholdBudget = {
    baseline_ms: 100,
    warn_budget_ms: 100,
    strict_budget_ms: 100,
  };
  const atBudget = evaluateRuntimeBudget(100, equalThresholdBudget, tolerance);
  const atToleranceCeiling = evaluateRuntimeBudget(
    120,
    equalThresholdBudget,
    tolerance,
  );
  const aboveToleranceCeiling = evaluateRuntimeBudget(
    121,
    equalThresholdBudget,
    tolerance,
  );
  if (atBudget?.status !== "within" || atBudget.strictExceeded) {
    throw new Error(
      "a runtime at the declared budget must remain within budget",
    );
  }
  if (
    atToleranceCeiling?.status !== "strict-fluctuation-tolerated" ||
    atToleranceCeiling.strictExceeded ||
    !atToleranceCeiling.toleratedFluctuation
  ) {
    throw new Error("a runtime exactly 20% above budget must be tolerated");
  }
  if (
    aboveToleranceCeiling?.status !== "strict-exceeded" ||
    !aboveToleranceCeiling.strictExceeded
  ) {
    throw new Error("a runtime more than 20% above budget must exceed strict");
  }

  const splitBudget = {
    baseline_ms: 50,
    warn_budget_ms: 100,
    strict_budget_ms: 1000,
  };
  if (
    evaluateRuntimeBudget(120, splitBudget, tolerance)?.status !==
      "warn-fluctuation-tolerated" ||
    evaluateRuntimeBudget(121, splitBudget, tolerance)?.status !==
      "warn-exceeded"
  ) {
    throw new Error(
      "the warning budget must use the same 20% fluctuation band",
    );
  }
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) resolve();
      else
        reject(
          new Error(`${args[0]} failed: status=${status} signal=${signal}`),
        );
    });
  });
}

function runNodeJson(args, env = process.env) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status !== 0) {
        reject(
          new Error(`${args[0]} failed: status=${status} signal=${signal}`),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${args[0]} returned invalid JSON`, { cause: error }));
      }
    });
  });
}

function runNodeStatus(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
}

function runNodeCaptured(args, env = process.env) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function verifyRuntimeSummaryContract() {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "myoxus-runtime-summary-"),
  );
  const summaryScript = "build/scripts/test/summarize-runs.mjs";

  try {
    const missingInput = path.join(fixtureRoot, "missing-input");
    const noWriteReport = path.join(fixtureRoot, "no-write-report");
    const missingPayload = await runNodeJson([
      summaryScript,
      "--input-dir",
      missingInput,
      "--report-dir",
      noWriteReport,
      "--json",
    ]);
    if (
      missingPayload.suites?.length !== 0 ||
      existsSync(missingInput) ||
      existsSync(noWriteReport)
    ) {
      throw new Error(
        "a missing runtime input must be empty without creating input or report directories",
      );
    }

    const writtenReport = path.join(fixtureRoot, "written-report");
    await runNodeJson([
      summaryScript,
      "--input-dir",
      missingInput,
      "--report-dir",
      writtenReport,
      "--write-report",
      "--json",
    ]);
    const writtenJson = JSON.parse(
      readFileSync(
        path.join(writtenReport, "matrix-runtime-summary.json"),
        "utf8",
      ),
    );
    const writtenMarkdown = readFileSync(
      path.join(writtenReport, "matrix-runtime-summary.md"),
      "utf8",
    );
    if (
      writtenJson.suites?.length !== 0 ||
      !writtenMarkdown.includes("# Test Matrix Runtime Summary") ||
      existsSync(missingInput)
    ) {
      throw new Error(
        "--write-report must materialize an empty JSON/Markdown report without creating its missing input",
      );
    }

    const emptyInput = path.join(fixtureRoot, "empty-input");
    mkdirSync(emptyInput);
    const emptyPayload = await runNodeJson([
      summaryScript,
      "--input-dir",
      emptyInput,
      "--json",
    ]);
    if (emptyPayload.suites?.length !== 0) {
      throw new Error("an empty runtime input directory must yield suites: []");
    }

    const validInput = path.join(fixtureRoot, "valid-input");
    mkdirSync(validInput);
    writeFileSync(
      path.join(validInput, "matrix-run-valid.json"),
      `${JSON.stringify({
        generatedAt: "2026-07-22T00:00:00.000Z",
        dryRun: false,
        selected: [{ id: "fixture.suite" }],
        results: [
          {
            id: "fixture.suite",
            status: "passed",
            elapsedMs: 42,
            exitCode: 0,
          },
        ],
      })}\n`,
    );
    const validPayload = await runNodeJson([
      summaryScript,
      "--input-dir",
      validInput,
      "--json",
    ]);
    if (
      validPayload.suites?.length !== 1 ||
      validPayload.suites[0]?.suite !== "fixture.suite" ||
      validPayload.suites[0]?.runs !== 1 ||
      validPayload.suites[0]?.passed !== 1
    ) {
      throw new Error("a valid runtime artifact must remain aggregatable");
    }

    const malformedInput = path.join(fixtureRoot, "malformed-input");
    mkdirSync(malformedInput);
    writeFileSync(
      path.join(malformedInput, "matrix-run-invalid.json"),
      "{invalid-json\n",
    );
    const malformed = await runNodeCaptured([
      summaryScript,
      "--input-dir",
      malformedInput,
      "--json",
    ]);
    if (
      malformed.status === 0 ||
      !malformed.stderr.includes("matrix-run-invalid.json")
    ) {
      throw new Error(
        "a malformed runtime artifact must fail and identify its artifact path",
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function verifySuiteSubsumption() {
  const embedSelection = await runNodeJson([
    "build/scripts/test/run.mjs",
    "--files",
    "client/libs/core/src/editor/view-extensions/editor-view/doc-embed.spec.ts",
    "--dry-run",
    "--json",
  ]);
  const embedIds = new Set(embedSelection.selected.map((suite) => suite.id));
  if (
    !embedIds.has("editor.annotations.vitest") ||
    embedIds.has("core.vitest")
  ) {
    throw new Error(
      "native embed consumers must select their desktop owner without broad Core UI tests",
    );
  }
  const [changedSelection, i18nSelection, explicitSelection] =
    await Promise.all([
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        [
          "client/libs/core/src/modules/database/availability.spec.ts",
          "client/libs/core/src/__tests__/calendar.spec.ts",
        ].join(","),
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "client/libs/core/src/__tests__/i18n-quality.spec.ts",
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--suite",
        "core.vitest,core.database.vitest,core.i18n-quality.vitest",
        "--dry-run",
        "--json",
      ]),
    ]);

  const changedIds = new Set(
    changedSelection.selected.map((suite) => suite.id),
  );
  if (
    !changedIds.has("core.vitest") ||
    changedIds.has("core.database.vitest")
  ) {
    throw new Error(
      "broad changed-path Core selection must subsume the Database Vitest scope",
    );
  }

  const i18nIds = new Set(i18nSelection.selected.map((suite) => suite.id));
  if (!i18nIds.has("core.i18n-quality.vitest") || i18nIds.has("core.vitest")) {
    throw new Error(
      "the Core i18n quality spec must select its focused gate without broad Core Vitest",
    );
  }

  const explicitIds = new Set(
    explicitSelection.selected.map((suite) => suite.id),
  );
  if (
    !explicitIds.has("core.vitest") ||
    !explicitIds.has("core.database.vitest") ||
    !explicitIds.has("core.i18n-quality.vitest")
  ) {
    throw new Error(
      "explicit suite selection must override automatic subsumption",
    );
  }
}

async function verifyRustChangedPathSelection() {
  const ownerCases = [
    ["server/crates/api/src/lib.rs", "server.api.unit"],
    ["server/crates/domain/src/lib.rs", "server.domain.unit"],
    ["server/crates/infrastructure/src/lib.rs", "server.infrastructure.unit"],
    ["server/crates/mcp/src/lib.rs", "server.mcp.unit"],
    ["server/crates/pdf_export/src/lib.rs", "server.rendering.unit"],
    ["server/crates/doc_pipeline/src/lib.rs", "server.document.unit"],
    [
      "server/crates/workspace_import/src/lib.rs",
      "server.workspace-import.unit",
    ],
    ["server/crates/worker/src/lib.rs", "server.worker.redis"],
    ["server/crates/cli/src/main.rs", "server.cli.integration"],
  ];
  const [ownerSelections, manifestSelection] = await Promise.all([
    Promise.all(
      ownerCases.map(([file]) =>
        runNodeJson([
          "build/scripts/test/run.mjs",
          "--files",
          file,
          "--dry-run",
          "--json",
        ]),
      ),
    ),
    runNodeJson([
      "build/scripts/test/run.mjs",
      "--files",
      "server/crates/domain/Cargo.toml",
      "--dry-run",
      "--json",
    ]),
  ]);
  for (let index = 0; index < ownerCases.length; index += 1) {
    const [file, expectedSuite] = ownerCases[index];
    const sourceIds = new Set(
      ownerSelections[index].selected.map((suite) => suite.id),
    );
    if (
      !sourceIds.has(expectedSuite) ||
      sourceIds.has("server.rust.unit") ||
      sourceIds.has("server.rust.check")
    ) {
      throw new Error(
        `${file} must select ${expectedSuite} without whole-workspace Rust gates`,
      );
    }
  }
  const manifestIds = new Set(
    manifestSelection.selected.map((suite) => suite.id),
  );
  if (
    !manifestIds.has("server.rust.unit") ||
    !manifestIds.has("server.rust.check")
  ) {
    throw new Error(
      "Cargo manifest changes must retain both unit-target and workspace/binary compile coverage",
    );
  }
}

function verifyClientNativeRustOwnership() {
  const suites = JSON.parse(
    readFileSync(path.join(repoRoot, "build/test-matrix/suites.json"), "utf8"),
  );
  const rules = JSON.parse(
    readFileSync(
      path.join(repoRoot, "build/test-matrix/path-rules.json"),
      "utf8",
    ),
  );
  const requiredSelectors = [
    "Cargo.toml",
    "Cargo.lock",
    "client/apps/mobile-native/**",
    "client/libs/doc-indexer/**",
    "client/libs/local-store/storage/**",
  ];

  const assertOwner = (candidate, rule) => {
    if (!candidate) {
      throw new Error("client.native.rust suite is required");
    }
    if (!rule || !rule.select_suites?.includes("client.native.rust")) {
      throw new Error("client.native.rust path rule is required");
    }
    const selectors = new Set(candidate.changed_path_selectors ?? []);
    const paths = new Set(rule.paths ?? []);
    for (const selector of requiredSelectors) {
      if (!selectors.has(selector) || !paths.has(selector)) {
        throw new Error(
          `client.native.rust must own native selector ${selector}`,
        );
      }
    }
  };

  const owner = suites.find((suite) => suite.id === "client.native.rust");
  const ownerRule = rules.find((rule) => rule.id === "client-native-rust");
  assertOwner(owner, ownerRule);

  // Prove the ownership assertion is fail-closed instead of merely checking
  // today's positive fixture.
  const missingRootLock = {
    ...owner,
    changed_path_selectors: owner.changed_path_selectors.filter(
      (selector) => selector !== "Cargo.lock",
    ),
  };
  try {
    assertOwner(missingRootLock, ownerRule);
    throw new Error(
      "client.native.rust accepted a missing Cargo.lock selector",
    );
  } catch (error) {
    if (!String(error).includes("native selector Cargo.lock")) throw error;
  }
}

async function verifyGraphqlChangedPathSelection() {
  const [fetcher, codegen, serverSchema, document, generated] =
    await Promise.all([
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "client/libs/graphql/src/fetcher.ts",
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "client/libs/graphql/codegen.mjs",
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "server/crates/api/src/graphql/mod.rs",
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "client/libs/graphql/src/graphql/workspace-role-permissions.gql",
        "--dry-run",
        "--json",
      ]),
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        "client/libs/graphql/src/operations.ts",
        "--dry-run",
        "--json",
      ]),
    ]);
  const fetcherIds = new Set(fetcher.selected.map((suite) => suite.id));
  if (
    !fetcherIds.has("graphql.client.vitest") ||
    !fetcherIds.has("graphql.client.typecheck") ||
    fetcherIds.has("graphql.codegen.stack") ||
    fetcherIds.has("core.typecheck")
  ) {
    throw new Error(
      "GraphQL transport changes must stay package-scoped without codegen/Core",
    );
  }
  const codegenIds = new Set(codegen.selected.map((suite) => suite.id));
  for (const expected of [
    "graphql.client.vitest",
    "graphql.client.typecheck",
    "graphql.codegen.stack",
    "core.typecheck",
  ]) {
    if (!codegenIds.has(expected)) {
      throw new Error(`GraphQL codegen tooling must select ${expected}`);
    }
  }
  const serverIds = new Set(serverSchema.selected.map((suite) => suite.id));
  if (
    !serverIds.has("graphql.codegen.stack") ||
    !serverIds.has("server.api.unit") ||
    serverIds.has("core.typecheck") ||
    serverIds.has("graphql.client.vitest")
  ) {
    throw new Error(
      "server GraphQL source must select API ownership and live codegen without unchanged client consumers",
    );
  }
  for (const [label, selection] of [
    ["GraphQL document", document],
    ["generated GraphQL client", generated],
  ]) {
    const ids = new Set(selection.selected.map((suite) => suite.id));
    for (const expected of [
      "graphql.client.vitest",
      "graphql.client.typecheck",
      "graphql.codegen.stack",
      "core.typecheck",
    ]) {
      if (!ids.has(expected)) {
        throw new Error(`${label} must select ${expected}`);
      }
    }
  }
}

async function verifyAdminChangedPathSelection() {
  const cases = [
    [
      "client/admin/workspaces/admin/src/modules/workspaces/index.spec.tsx",
      "admin.workspaces.vitest",
    ],
    [
      "client/admin/workspaces/admin/src/modules/git-sync/policy-tab.spec.tsx",
      "admin.git-sync.vitest",
    ],
    [
      "client/admin/workspaces/admin/src/modules/pdf-export/components/upload-template-dialog.spec.tsx",
      "admin.pdf-export.vitest",
    ],
  ];
  const selections = await Promise.all(
    cases.map(([file]) =>
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        file,
        "--dry-run",
        "--json",
      ]),
    ),
  );
  for (let index = 0; index < cases.length; index += 1) {
    const [file, expectedSuite] = cases[index];
    const ids = new Set(selections[index].selected.map((suite) => suite.id));
    if (
      !ids.has(expectedSuite) ||
      !ids.has("admin.typecheck") ||
      ids.has("admin.vitest")
    ) {
      throw new Error(
        `${file} must select ${expectedSuite} and Admin typecheck without broad Admin Vitest`,
      );
    }
  }

  const adminConfig = readFileSync(
    path.join(repoRoot, "client/admin/vitest.config.mts"),
    "utf8",
  );
  if (adminConfig.includes("client/libs/core/src/**/__tests__")) {
    throw new Error(
      "Admin Vitest must not execute Core-owned tests already covered by Core suites",
    );
  }
}

async function verifyFastTierSelection() {
  const selection = await runNodeJson([
    "build/scripts/test/run.mjs",
    "--tier",
    "fast",
    "--dry-run",
    "--json",
  ]);
  const selected = new Set(selection.selected.map((suite) => suite.id));
  const pathOwnedSuites = [
    "admin.queue.vitest",
    "admin.organization.vitest",
    "admin.workspaces.vitest",
    "admin.git-sync.vitest",
    "admin.pdf-export.vitest",
    "storage.vitest",
    "core.i18n-quality.vitest",
    "core.database.vitest",
    "web.vitest",
    "virgultum.data-view.vitest",
    "virgultum.store.vitest",
    "virgultum.std.vitest",
    "virgultum.mermaid.vitest",
    "ui-facade.vitest",
    "branding.vitest",
    "server.api.unit",
    "server.domain.unit",
    "server.infrastructure.unit",
    "server.mcp.unit",
    "server.rendering.unit",
    "server.document.unit",
    "electron.vitest",
  ];
  const leaked = pathOwnedSuites.filter((id) => selected.has(id));
  if (leaked.length > 0) {
    throw new Error(
      `generic fast tier must not execute changed-path owner suites: ${leaked.join(", ")}`,
    );
  }
}

function verifyStandardCargoProfiles() {
  const rootManifest = readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8");
  const serverManifest = readFileSync(
    path.join(repoRoot, "server/Cargo.toml"),
    "utf8",
  );
  const runner = readFileSync(
    path.join(repoRoot, "build/scripts/test/run.mjs"),
    "utf8",
  );
  const quickScript = readFileSync(
    path.join(repoRoot, "build/scripts/test/api-integration-quick.sh"),
    "utf8",
  );
  const profileContract =
    /\[profile\.dev\]\s+debug\s*=\s*0\s+strip\s*=\s*"debuginfo"[\s\S]*?\[profile\.test\]\s+debug\s*=\s*0\s+strip\s*=\s*"debuginfo"/;
  if (
    !profileContract.test(rootManifest) ||
    !profileContract.test(serverManifest)
  ) {
    throw new Error(
      "root and server standard dev/test Cargo profiles must omit debug information",
    );
  }
  if (
    !runner.includes('CARGO_PROFILE_DEV_DEBUG: "0"') ||
    !runner.includes('CARGO_PROFILE_TEST_DEBUG: "0"')
  ) {
    throw new Error(
      "matrix Rust commands must force the shared no-debug standard profile",
    );
  }
  if (quickScript.includes("CARGO_PROFILE_TEST_DEBUG")) {
    throw new Error(
      "API quick must not create a wrapper-local Cargo profile distinct from the repository standard",
    );
  }

  const suites = JSON.parse(
    readFileSync(path.join(repoRoot, "build/test-matrix/suites.json"), "utf8"),
  );
  const qualitySuite = suites.find(
    (suite) => suite.id === "test.quality-ratchet",
  );
  if (qualitySuite?.command.includes(">/dev/null")) {
    throw new Error(
      "blocking quality gates must expose actionable findings in matrix output",
    );
  }
}

async function verifyQualityScannerSemantics() {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "myoxus-quality-scanner-"),
  );
  try {
    writeFileSync(
      path.join(fixtureRoot, "transport.spec.ts"),
      [
        "if (!response.ok()) throw new Error('request failed');",
        "assert.ok(value);",
      ].join("\n"),
    );
    const result = await runNodeJson([
      "build/scripts/ci/audit-test-quality.mjs",
      "--json",
      "--scan-root",
      fixtureRoot,
    ]);
    const bareOk = result.findings.filter(
      (finding) => finding.pattern === "bare_ok",
    );
    if (
      result.totals?.bare_ok !== 1 ||
      bareOk.length !== 1 ||
      !bareOk[0].text.includes("assert.ok(value)")
    ) {
      throw new Error(
        "quality scanner must flag assert.ok without misclassifying response.ok()",
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function verifyApiQuickCompileBoundary() {
  const quickScript = readFileSync(
    path.join(repoRoot, "build/scripts/test/api-integration-quick.sh"),
    "utf8",
  );
  const quickTarget = readFileSync(
    path.join(repoRoot, "server/crates/api/tests/integration_quick.rs"),
    "utf8",
  );
  const declaredTestModules = [
    ...quickTarget.matchAll(
      /#\[path = "(?!support\/)([^"]+)"\]\s+mod\s+[A-Za-z0-9_]+;/g,
    ),
  ].map((match) => match[1]);
  const groups = JSON.parse(
    readFileSync(
      path.join(repoRoot, "build/test-matrix/api-standard-filters.json"),
      "utf8",
    ),
  );
  const exactFilters = Object.values(groups).flat();
  if (
    !quickScript.includes("--test integration_quick") ||
    quickScript.includes("--test integration ")
  ) {
    throw new Error(
      "the API quick wrapper must execute only the dedicated integration_quick target",
    );
  }
  // Assignment changes must preserve the complete reviewed standard inventory.
  // This fingerprint protects names, not a minimum count that replacements could satisfy.
  if (
    new Set(exactFilters).size !== exactFilters.length ||
    createHash("sha256")
      .update([...exactFilters].sort().join("\n"))
      .digest("hex") !==
      "da6b824a646fb299348436b925a0cd0cf239c7290abf08c01fe2ae03b338dd3d"
  ) {
    throw new Error(
      "API standard assignment lost, duplicated or replaced an existing test",
    );
  }
  if (declaredTestModules.length !== 42 || exactFilters.length !== 87) {
    throw new Error(
      `API quick compile boundary drifted: modules=${declaredTestModules.length}, filters=${exactFilters.length}`,
    );
  }
  if (
    !quickScript.includes("stack-up.sh") ||
    !quickScript.includes("stack-down.sh")
  ) {
    throw new Error(
      "the API quick wrapper must own isolated test-service provisioning and cleanup",
    );
  }
}

function verifyMatrixResultPolicy() {
  for (const [result, budgetFailure, expected] of [
    [{ status: 101, timedOut: false }, true, 101],
    [{ status: 0, timedOut: false }, true, 125],
    [{ status: 0, timedOut: false }, false, 0],
    [{ status: null, timedOut: false }, true, 1],
    [{ status: 101, timedOut: true }, true, 124],
  ]) {
    if (suiteExitCode(result, budgetFailure) !== expected) {
      throw new Error(
        "command failures and timeouts must take priority over runtime-budget failures",
      );
    }
  }
  const runtimeFailure = classifyBlockingResult({ exitCode: 125 }, "blocking");
  const productFailure = classifyBlockingResult({ exitCode: 1 }, "blocking");
  if (!runtimeFailure.shouldContinue || runtimeFailure.exitCode !== 125) {
    throw new Error(
      "strict runtime-budget failures must remain failing without aborting evidence collection",
    );
  }
  if (productFailure.shouldContinue || productFailure.exitCode !== 1) {
    throw new Error(
      "blocking product/test failures must still stop the selected matrix",
    );
  }
}

async function verifyTimeoutProcessTree() {
  const result = await runWithProcessTreeTimeout(
    "bash",
    ["-lc", "bash -c 'trap \"\" TERM; while :; do sleep 1; done' & wait"],
    {
      timeoutMs: 100,
      killGraceMs: 100,
      stdio: "ignore",
    },
  );

  if (!result.timedOut || result.status !== 124 || !result.pid) {
    throw new Error(
      `expected process-tree timeout status 124, got status=${result.status} signal=${result.signal}`,
    );
  }

  try {
    process.kill(-result.pid, 0);
    throw new Error(`timed-out process group ${result.pid} is still alive`);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function verifyCargoDiagnosticContract() {
  const cargoConfig = readFileSync(
    path.join(repoRoot, ".cargo/config.toml"),
    "utf8",
  );
  if (
    !/^\[build\]$/m.test(cargoConfig) ||
    !/^jobs[ \t]*=[ \t]*8[ \t]*$/m.test(cargoConfig) ||
    !/^incremental[ \t]*=[ \t]*false[ \t]*$/m.test(cargoConfig)
  ) {
    throw new Error(
      "repository Cargo defaults must cap jobs at eight and disable incremental state",
    );
  }

  const defaultEnvironment = { ...process.env };
  delete defaultEnvironment.CARGO_BUILD_JOBS;
  const diagnosticArguments = [
    "build/scripts/test/run-cargo-diagnostic.mjs",
    "--timeout-seconds",
    "17",
    "--dry-run",
    "--json",
    "--",
    "check",
    "--manifest-path",
    "server/Cargo.toml",
    "-p",
    "myoxus-api",
  ];
  const diagnostic = await runNodeJson(diagnosticArguments, defaultEnvironment);
  if (
    diagnostic.command !== "cargo" ||
    diagnostic.cwd !== repoRoot ||
    diagnostic.timeoutSeconds !== 17 ||
    diagnostic.environment?.CARGO_BUILD_JOBS !== "8" ||
    diagnostic.environment?.CARGO_INCREMENTAL !== "0" ||
    diagnostic.args?.join(" ") !==
      "check --manifest-path server/Cargo.toml -p myoxus-api"
  ) {
    throw new Error("bounded Cargo diagnostic dry-run contract drifted");
  }

  const approvedJobs = String(Math.min(24, availableParallelism()));
  const configured = await runNodeJson(diagnosticArguments, {
    ...defaultEnvironment,
    CARGO_BUILD_JOBS: approvedJobs,
  });
  if (
    configured.environment?.CARGO_BUILD_JOBS !== approvedJobs ||
    configured.environment?.CARGO_INCREMENTAL !== "0" ||
    configured.timeoutSeconds !== diagnostic.timeoutSeconds
  ) {
    throw new Error(
      "host Cargo job setting must survive without weakening timeouts",
    );
  }
  const fixture = mkdtempSync(path.join(tmpdir(), "myoxus-cargo-jobs-"));
  try {
    writeFileSync(
      path.join(fixture, "cargo"),
      '#!/bin/sh\nprintf "%s\\n" "$CARGO_BUILD_JOBS"\n',
      { mode: 0o755 },
    );
    const execution = await runNodeCaptured(
      ["build/scripts/test/run-cargo-diagnostic.mjs", "--", "check"],
      {
        ...defaultEnvironment,
        PATH: `${fixture}${path.delimiter}${process.env.PATH}`,
        CARGO_BUILD_JOBS: approvedJobs,
      },
    );
    if (execution.status !== 0 || execution.stdout.trim() !== approvedJobs) {
      throw new Error(
        "executed Cargo must receive the approved host job count",
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  for (const jobs of [
    "0",
    "-1",
    "1.5",
    "invalid",
    String(availableParallelism() + 1),
  ]) {
    const invalid = await runNodeStatus(diagnosticArguments, {
      ...defaultEnvironment,
      CARGO_BUILD_JOBS: jobs,
    });
    if (invalid.status !== 2 || invalid.signal !== null) {
      throw new Error(`invalid host Cargo job count ${jobs} must be rejected`);
    }
  }

  const override = await runNodeStatus([
    "build/scripts/test/run-cargo-diagnostic.mjs",
    "--dry-run",
    "--",
    "check",
    "--jobs=24",
    "--manifest-path",
    "server/Cargo.toml",
  ]);
  if (override.status !== 2 || override.signal !== null) {
    throw new Error(
      `bounded Cargo diagnostics must reject job overrides with exit 2; status=${override.status} signal=${override.signal}`,
    );
  }
}

async function verifyApiStandardRouting() {
  const cases = [
    ["server/crates/api/src/handlers/health.rs", ["api"]],
    ["server/crates/api/src/git_sync_engine/runner.rs", ["api", "git-sync"]],
    ["server/crates/api/src/graphql/auth/calendar.rs", ["api", "calendar"]],
    [
      "server/crates/api/src/lib.rs",
      [
        "api",
        "auth",
        "config",
        "calendar",
        "git-sync",
        "organization",
        "documents",
        "storage",
      ],
    ],
    [
      "server/crates/api/src/git_sync_engine/runner.rs,server/crates/api/src/graphql/auth/calendar.rs",
      ["api", "git-sync", "calendar"],
    ],
  ];
  const selections = await Promise.all(
    cases.map(([files]) =>
      runNodeJson([
        "build/scripts/test/run.mjs",
        "--files",
        files,
        "--dry-run",
        "--json",
      ]),
    ),
  );
  for (const [index, [files, expectedGroups]] of cases.entries()) {
    const result = selections[index];
    const actual = result.selected
      .filter((suite) =>
        suite.command.startsWith(
          "bash build/scripts/test/api-integration-quick.sh",
        ),
      )
      .map((suite) =>
        suite.id === "api.integration.quick" ? "api" : suite.id.split(".")[1],
      )
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expectedGroups].sort())) {
      throw new Error(
        `API standard routing for ${files}: got ${actual}, expected ${expectedGroups}`,
      );
    }
  }
}

async function verifyVitestDiagnosticContract() {
  const diagnostic = createVitestDiagnosticContract([
    "run",
    "client/libs/core/src/modules/database/model.spec.ts",
  ]);
  if (
    diagnostic.command !== "node (installed Vitest CLI)" ||
    diagnostic.matrixSuiteId !== null ||
    diagnostic.timeoutSeconds !== 300 ||
    diagnostic.args?.join(" ") !==
      "run client/libs/core/src/modules/database/model.spec.ts --maxWorkers=8"
  ) {
    throw new Error("bounded Vitest diagnostic dry-run contract drifted");
  }

  try {
    createVitestDiagnosticContract([
      "run",
      "client/libs/core/src/modules/database/model.spec.ts",
      "--maxWorkers=9",
    ]);
    throw new Error("bounded Vitest diagnostics accepted nine workers");
  } catch (error) {
    if (!(error instanceof VitestDiagnosticUsageError)) throw error;
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.scripts?.vitest !==
    "node build/scripts/test/run-vitest-diagnostic.mjs"
  ) {
    throw new Error("yarn vitest must route through the bounded diagnostic");
  }
}

await Promise.all([
  runNode(["build/scripts/test/run.mjs", "--list", "--json"]),
  verifyCargoDiagnosticContract(),
  verifyAdminChangedPathSelection(),
  verifyFastTierSelection(),
  verifyGraphqlChangedPathSelection(),
  verifyQualityScannerSemantics(),
  verifyRustChangedPathSelection(),
  verifyTimeoutProcessTree(),
  verifySuiteSubsumption(),
  verifyVitestDiagnosticContract(),
  verifyRuntimeSummaryContract(),
  verifyApiStandardRouting(),
  runNode(["build/scripts/test/verify-api-integration-domains.mjs"]),
]);
verifyClientNativeRustOwnership();
verifyRuntimeBudgetTolerance();
verifyApiQuickCompileBoundary();
verifyMatrixResultPolicy();
verifyStandardCargoProfiles();

console.log("Matrix source and process-tree self-checks passed.");
