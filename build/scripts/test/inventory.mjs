#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reproducible test/CI inventory for the matrix consolidation work.
// Keep this script source-only and dependency-free so baseline reports can be
// regenerated before runner or package-manager setup is trusted.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const serverTestOwnershipOnly = args.includes("--server-test-ownership-only");
const writeReport = args.includes("--write-report");
const reportDir =
  args
    .find((arg) => arg.startsWith("--report-dir="))
    ?.slice("--report-dir=".length) ?? "output/test-inventory";

const ignoredPathParts = new Set([
  ".git",
  ".yarn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
]);

const jsTestFileRe = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const testCallRe =
  /\b(?:test|it)(?:\.(?:skip|only|todo|fixme|concurrent|serial))*\s*\(/g;
const rustTestAttrRe = /#\s*\[\s*(?:tokio::test|test)(?:\s*\([^]*?\))?\s*\]/g;
const rustPatterns = [
  ["ok_call", /\.ok\s*\(\s*\)/g],
  ["setup_app", /\bsetup_app\b/g],
  ["setup_pool", /\bsetup_pool\b/g],
  ["sleep", /\b(?:sleep|timeout|wait_for|wait_until)\b/g],
  [
    "lock_or_once",
    /\b(?:Mutex|RwLock|OnceLock|LazyLock|THEME_BRANDING_LOCK)\b/g,
  ],
  [
    "global_state_write",
    /\b(?:app_config|admin_audit_log|global_theme|theme_profiles|brand_identity|config_changelog)\b/g,
  ],
];

function gitFiles(patterns = []) {
  return execFileSync("git", ["ls-files", ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .filter(
      (file) => !file.split(/[\\/]/).some((part) => ignoredPathParts.has(part)),
    );
}

function countMatches(source, re) {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(source) !== null) count += 1;
  return count;
}

function browserSuiteFor(file) {
  if (file.startsWith("tests/client/adminfrontend/e2e/")) return "admin-e2e";
  if (file.startsWith("tests/client/webfrontend/smoke/")) return "web-smoke";
  if (file.startsWith("tests/client/webfrontend/flow/tests/doc-versioning/"))
    return "web-document-history";
  if (file.startsWith("tests/client/webfrontend/flow/")) return "web-flow";
  if (file.startsWith("tests/client/webfrontend/editor-flow/"))
    return "web-editor-flow";
  if (file.startsWith("tests/client/webfrontend/visual/")) return "web-visual";
  if (file.startsWith("tests/client/webfrontend/local/")) return "web-local";
  if (file.startsWith("tests/client/editor-core/virgultum/"))
    return "editor-core-virgultum";
  if (file.startsWith("tests/client/mobile/app/")) return "mobile-app";
  if (file.startsWith("tests/client/desktop/local/")) return "desktop-local";
  return null;
}

function isRustTestOwned(file) {
  return (
    file.includes("/tests/") ||
    file.endsWith("_test.rs") ||
    file.endsWith("tests.rs") ||
    file.includes("/test_")
  );
}

function serverCrateFor(file) {
  return /^server\/crates\/([^/]+)\//.exec(file)?.[1] ?? "server-root";
}

function serverTierFor(file, source) {
  if (/\b(?:load|stress|benchmark|perf)\b/i.test(file))
    return "nightly-or-manual";
  if (/\b(?:minio|s3|opendal|object_store)\b/i.test(`${file}\n${source}`))
    return "minio-backed";
  if (/\b(?:redis|queue|worker)\b/i.test(`${file}\n${source}`))
    return "redis-backed";
  if (
    /\b(?:PgPool|sqlx|DATABASE_URL|TEST_DATABASE_URL|setup_pool|setup_app)\b/.test(
      source,
    )
  )
    return "postgres-backed";
  if (file.includes("/src/")) return "service-free-inline";
  return "service-free-or-contract";
}

function collectServerTestOwnership(rustFiles, sources) {
  const ownership = new Map();
  for (const file of rustFiles) {
    const source =
      sources?.get(file) ?? readFileSync(path.join(repoRoot, file), "utf8");
    if (!isRustTestOwned(file) && !source.includes("#[cfg(test)]")) continue;
    const crate = serverCrateFor(file);
    if (!ownership.has(crate)) {
      ownership.set(crate, {
        files: 0,
        rustTestAttributes: 0,
        tiers: {},
      });
    }
    const entry = ownership.get(crate);
    const tier = serverTierFor(file, source);
    entry.files += 1;
    entry.rustTestAttributes += countMatches(source, rustTestAttrRe);
    entry.tiers[tier] = (entry.tiers[tier] ?? 0) + 1;
  }
  return ownership;
}

if (serverTestOwnershipOnly) {
  const ownership = collectServerTestOwnership(gitFiles(["server/**/*.rs"]));
  console.log(
    JSON.stringify({
      serverTestOwnership: Object.fromEntries(
        [...ownership.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ),
    }),
  );
  process.exit(0);
}

function workflowCommands() {
  const commands = [];
  for (const file of gitFiles([".forgejo/workflows/*.yml"])) {
    const lines = readFileSync(path.join(repoRoot, file), "utf8").split(
      /\r?\n/,
    );
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\s*run:\s*(?:\||>|[^#].*)?/.test(lines[index])) continue;
      const inline = lines[index].replace(/^\s*run:\s*/, "").trim();
      if (inline && inline !== "|" && inline !== ">") {
        commands.push({ workflow: file, line: index + 1, command: inline });
        continue;
      }
      const block = [];
      const baseIndent = lines[index].match(/^(\s*)/)?.[1].length ?? 0;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (line.trim() && indent <= baseIndent) break;
        if (line.trim()) block.push(line.trim());
      }
      commands.push({
        workflow: file,
        line: index + 1,
        command: block.join(" && "),
      });
    }
  }
  return commands;
}

const jsFiles = gitFiles(["client", "tests", "virgultum"]).filter((file) =>
  jsTestFileRe.test(path.basename(file)),
);
let jsTestCalls = 0;
const browserFiles = new Map();

for (const file of jsFiles) {
  const source = readFileSync(path.join(repoRoot, file), "utf8");
  jsTestCalls += countMatches(source, testCallRe);
  const browserSuite = browserSuiteFor(file);
  if (browserSuite)
    browserFiles.set(browserSuite, (browserFiles.get(browserSuite) ?? 0) + 1);
}

function testQualitySummary() {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "build/scripts/ci/audit-test-quality.mjs"),
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    ),
  );
}

const qualitySummary = testQualitySummary();

const rustFiles = gitFiles(["server/**/*.rs"]);
const rustSources = new Map(
  rustFiles.map((file) => [
    file,
    readFileSync(path.join(repoRoot, file), "utf8"),
  ]),
);
let rustTestAttrs = 0;
const rustQualityTotals = Object.fromEntries(
  rustPatterns.map(([id]) => [id, 0]),
);
const rustQualityByFile = [];
const serverTestOwnership = collectServerTestOwnership(rustFiles, rustSources);

for (const file of rustFiles) {
  const source = rustSources.get(file);
  rustTestAttrs += countMatches(source, rustTestAttrRe);
  if (!isRustTestOwned(file)) continue;
  const counts = Object.fromEntries(rustPatterns.map(([id]) => [id, 0]));
  let fileTotal = 0;
  for (const [id, re] of rustPatterns) {
    const count = countMatches(source, re);
    counts[id] = count;
    rustQualityTotals[id] += count;
    fileTotal += count;
  }
  if (fileTotal > 0) rustQualityByFile.push({ file, counts });
}

const supportedEntryPoints = [
  {
    path: "build/scripts/test/scope-guard.sh",
    decision: "keep-call-from-runner",
    reason: "Existing policy guard for broad Vitest/yarn test invocations.",
  },
  {
    path: "build/scripts/ci/test-matrix-local.sh",
    decision: "replace-with-runner-wrapper",
    reason:
      "The name conflicts with the new matrix concept and currently hides yarn build/test/typecheck.",
  },
  {
    path: "build/scripts/server/test-quick.sh",
    decision: "replace-with-safe-matrix-suite",
    reason:
      "Current command calls invalid API targets and parses text instead of exit codes.",
  },
  {
    path: "build/scripts/server/release-gate-frontend.sh",
    decision: "keep-release-strict-matrix-entry-point",
    reason:
      "Current command uses supported integration filters and the owning Web/Admin browser suites.",
  },
];

const browserOwnership = [
  {
    suite: "admin-e2e",
    path: "tests/client/adminfrontend/e2e/",
    files: browserFiles.get("admin-e2e") ?? 0,
    matrixSuite: "admin.smoke",
    defaultDecision: "manual-or-strict browser smoke/visual",
  },
  {
    suite: "web-smoke",
    path: "tests/client/webfrontend/smoke/",
    files: browserFiles.get("web-smoke") ?? 0,
    matrixSuite: "web.smoke",
    defaultDecision: "explicit for smoke harness or UI/runtime closeout",
  },
  {
    suite: "web-flow",
    path: "tests/client/webfrontend/flow/",
    files: browserFiles.get("web-flow") ?? 0,
    matrixSuite: "web.flow",
    defaultDecision: "manual-or-strict live-stack product flow",
  },
  {
    suite: "web-document-history",
    path: "tests/client/webfrontend/flow/tests/doc-versioning/",
    files: browserFiles.get("web-document-history") ?? 0,
    matrixSuite: "web.document-history",
    defaultDecision: "manual-or-strict document-history closeout",
  },
  {
    suite: "web-editor-flow",
    path: "tests/client/webfrontend/editor-flow/",
    files: browserFiles.get("web-editor-flow") ?? 0,
    matrixSuite: null,
    defaultDecision: "phase-owned diagnostics; no cross-family gate",
  },
  {
    suite: "web-visual",
    path: "tests/client/webfrontend/visual/",
    files: browserFiles.get("web-visual") ?? 0,
    matrixSuite: "web.visual",
    defaultDecision: "manual-or-strict visual evidence only",
  },
  {
    suite: "web-local",
    path: "tests/client/webfrontend/local/",
    files: browserFiles.get("web-local") ?? 0,
    matrixSuite: "web.local.quarantine",
    defaultDecision:
      "manual-only quarantine; Browser Web local workspace assumptions are obsolete",
  },
  {
    suite: "editor-core-virgultum",
    path: "tests/client/editor-core/virgultum/",
    files: browserFiles.get("editor-core-virgultum") ?? 0,
    matrixSuite: "editor-core.virgultum.browser.manual",
    defaultDecision: "manual-only editor visual/e2e closeout",
  },
  {
    suite: "mobile-app",
    path: "tests/client/mobile/app/",
    files: browserFiles.get("mobile-app") ?? 0,
    matrixSuite: "mobile.browser.manual",
    defaultDecision: "manual-only",
  },
  {
    suite: "desktop-local",
    path: "tests/client/desktop/local/",
    files: browserFiles.get("desktop-local") ?? 0,
    matrixSuite: "desktop.local.browser.manual",
    defaultDecision: "manual-only Electron/local harness",
  },
];

function apiIntegrationOwnership() {
  const integrationFile = "server/crates/api/tests/integration.rs";
  const integrationSource = readFileSync(
    path.join(repoRoot, integrationFile),
    "utf8",
  );
  const moduleRe = /#\[path\s*=\s*"([^"]+)"\]\s*\nmod\s+([A-Za-z0-9_]+);/g;
  const ownership = new Map();
  for (const match of integrationSource.matchAll(moduleRe)) {
    const [, relativePath, moduleName] = match;
    const group = path.dirname(relativePath).replaceAll("\\", "/");
    const file = path.posix.join("server/crates/api/tests", relativePath);
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    if (!ownership.has(group)) {
      ownership.set(group, {
        path: `server/crates/api/tests/${group}/`,
        modules: 0,
        rustTestAttributes: 0,
        representativeModules: [],
      });
    }
    const entry = ownership.get(group);
    entry.modules += 1;
    entry.rustTestAttributes += countMatches(source, rustTestAttrRe);
    if (entry.representativeModules.length < 5) {
      entry.representativeModules.push(moduleName);
    }
  }
  return Object.fromEntries(
    [...ownership.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  sourceCommand: "node build/scripts/test/inventory.mjs --json",
  counts: {
    jsTsSpecOrTestFiles: jsFiles.length,
    jsTsTestOrItCalls: jsTestCalls,
    rustTestAttributes: rustTestAttrs,
    rootFrontendUnitSelectionEstimate: jsFiles.filter((file) =>
      file.startsWith("client/"),
    ).length,
    adminVitestSelectionEstimate: jsFiles.filter((file) =>
      file.startsWith("client/admin/"),
    ).length,
    electronVitestSelectionEstimate: jsFiles.filter((file) =>
      file.startsWith("client/apps/electron/"),
    ).length,
    virgultumVitestFiles: jsFiles.filter((file) =>
      file.startsWith("virgultum/"),
    ).length,
    playwrightFiles: Object.fromEntries(
      [...browserFiles.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  },
  quality: {
    totals: qualitySummary.totals,
    byDomain: qualitySummary.byDomain,
  },
  rustQuality: {
    totals: rustQualityTotals,
    topFiles: rustQualityByFile
      .sort(
        (a, b) =>
          Object.values(b.counts).reduce((x, y) => x + y, 0) -
          Object.values(a.counts).reduce((x, y) => x + y, 0),
      )
      .slice(0, 40),
  },
  serverTestOwnership: Object.fromEntries(
    [...serverTestOwnership.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ),
  apiIntegrationOwnership: apiIntegrationOwnership(),
  browserOwnership,
  workflowCommands: workflowCommands(),
  supportedEntryPoints,
  runtimeBaselines: [
    {
      command: "build/scripts/test/run.sh --changed",
      status: "selection-only",
      measured: false,
      matrixSuite: "dynamic",
      dominantCostCenter: "selected suites, not the selector itself",
      decision:
        "keep; per-suite timing artifacts are the baseline source for changed-path runs",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/ci/check-server-fast-local.sh",
      status: "compatibility-wrapper",
      measured: false,
      matrixSuite: "server.fast",
      dominantCostCenter: "Rust clippy/check/unit compile",
      decision:
        "not a changed-path default; path rules prefer service-free subguards",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/ci/verify-server-integration.sh",
      status: "manual-or-ci-service-backed",
      measured: false,
      matrixSuite: "server.integration",
      dominantCostCenter:
        "isolated services, DB migration/seed, API/CLI/worker tests",
      decision:
        "keep explicit service-backed gate; do not use as local default baseline",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/ci/verify-frontend-quality.sh",
      status: "measured",
      measured: true,
      matrixSuite: "frontend.quality",
      baselineMs: 21960,
      dominantCostCenter: "composite frontend/theme/docs guards and font audit",
      decision: "keep compatibility wrapper while path rules prefer subguards",
      sourceArtifact:
        "output/test-runs/matrix-run-2026-06-27T15-01-00-064Z.json",
    },
    {
      command: "build/scripts/ci/verify-admin-vitest.sh",
      status: "measured",
      measured: true,
      matrixSuite: "admin.vitest",
      baselineMs: 37731,
      dominantCostCenter: "Admin Vitest full-suite execution",
      decision:
        "keep blocking Admin-only push gate; route owned module paths to focused suites",
      sourceArtifact:
        "output/test-runs/matrix-run-2026-07-27T23-46-43-344Z.json",
    },
    {
      command: "build/scripts/ci/verify-core-typecheck.sh",
      status: "measured",
      measured: true,
      matrixSuite: "core.typecheck",
      baselineMs: 5375,
      dominantCostCenter: "TypeScript project-reference check",
      decision:
        "keep cheap default contract for ordinary Web/Core source changes",
      sourceArtifact:
        "output/test-runs/matrix-run-2026-06-27T16-07-08-412Z.json",
    },
    {
      command: "build/scripts/ci/verify-graphql-codegen-stack.sh --start-stack",
      status: "service-backed-not-measured-this-pass",
      measured: false,
      matrixSuite: "graphql.codegen.stack",
      dominantCostCenter: "dev stack startup and schema/codegen verification",
      decision: "keep contract gate; measure only with stack lifecycle work",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/server/release-gate-frontend.sh",
      status: "release-strict-manual",
      measured: false,
      matrixSuite: "frontend.release-strict",
      dominantCostCenter: "frontend build plus Web/Admin browser smokes",
      decision:
        "manual/release gate; path rules must not pull it into changed defaults",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/server/playwright-frontend-smoke.sh",
      status: "manual-browser-not-measured-this-pass",
      measured: false,
      matrixSuite: "web.smoke",
      dominantCostCenter: "selfhost stack and browser bootstrap",
      decision:
        "explicit served-bundle/runtime smoke only; visual and editor flows have separate owners",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/server/playwright-web-editor-flow.sh",
      status: "manual-browser-not-measured-this-pass",
      measured: false,
      matrixSuite: null,
      dominantCostCenter:
        "selfhost stack, browser bootstrap and editor interaction depth",
      decision: "phase-owned diagnostic only; no cross-family closeout",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/server/playwright-web-visual.sh",
      status: "manual-browser-not-measured-this-pass",
      measured: false,
      matrixSuite: "web.visual",
      dominantCostCenter:
        "selfhost stack, browser bootstrap and screenshot/report artifacts",
      decision: "explicit UI TODO visual evidence only",
      sourceArtifact: null,
    },
    {
      command: "build/scripts/server/playwright-admin-ui-smoke.sh",
      status: "manual-browser-not-measured-this-pass",
      measured: false,
      matrixSuite: "admin.smoke",
      dominantCostCenter: "selfhost stack and browser bootstrap",
      decision: "explicit Admin UI/runtime closeout only",
      sourceArtifact: null,
    },
  ],
};

function markdownReport(data) {
  const lines = [];
  lines.push("# Test and CI Inventory Baseline");
  lines.push("");
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push(`Source command: \`${data.sourceCommand}\``);
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  for (const [key, value] of Object.entries(data.counts)) {
    lines.push(
      `- \`${key}\`: ${typeof value === "object" ? JSON.stringify(value) : value}`,
    );
  }
  lines.push("");
  lines.push("## Quality Totals");
  lines.push("");
  for (const [key, value] of Object.entries(data.quality.totals)) {
    lines.push(`- \`${key}\`: ${value}`);
  }
  lines.push("");
  lines.push("## Rust Test-Owned Pattern Totals");
  lines.push("");
  for (const [key, value] of Object.entries(data.rustQuality.totals)) {
    lines.push(`- \`${key}\`: ${value}`);
  }
  lines.push("");
  lines.push("## Server Test Ownership");
  lines.push("");
  lines.push("| Crate | Files | Test attrs | Tiers |");
  lines.push("| --- | ---: | ---: | --- |");
  for (const [crate, entry] of Object.entries(data.serverTestOwnership)) {
    lines.push(
      `| \`${crate}\` | ${entry.files} | ${entry.rustTestAttributes} | ${Object.entries(
        entry.tiers,
      )
        .map(([tier, count]) => `${tier}=${count}`)
        .join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("## API Integration Ownership");
  lines.push("");
  lines.push(
    "| Group | Path | Modules | Test attrs | Representative modules |",
  );
  lines.push("| --- | --- | ---: | ---: | --- |");
  for (const [group, entry] of Object.entries(data.apiIntegrationOwnership)) {
    lines.push(
      `| \`${group}\` | \`${entry.path}\` | ${entry.modules} | ${entry.rustTestAttributes} | ${entry.representativeModules.map((module) => `\`${module}\``).join(", ")} |`,
    );
  }
  lines.push("");
  lines.push("## Browser Suite Ownership");
  lines.push("");
  lines.push("| Suite | Path | Files | Matrix suite | Default decision |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const entry of data.browserOwnership) {
    lines.push(
      `| \`${entry.suite}\` | \`${entry.path}\` | ${entry.files} | ${entry.matrixSuite} | ${entry.defaultDecision} |`,
    );
  }
  lines.push("");
  lines.push("## Workflow Commands");
  lines.push("");
  for (const command of data.workflowCommands) {
    lines.push(
      `- ${command.workflow}:${command.line} - \`${command.command}\``,
    );
  }
  lines.push("");
  lines.push("## Entry Point Decisions");
  lines.push("");
  for (const entry of data.supportedEntryPoints) {
    lines.push(`- \`${entry.path}\`: ${entry.decision} - ${entry.reason}`);
  }
  lines.push("");
  lines.push("## Runtime Baseline Gap");
  lines.push("");
  lines.push(
    "Runtime measurements are intentionally separate from counts. Run matrix suites without `--dry-run` to produce timing JSON under `output/test-runs/`.",
  );
  return `${lines.join("\n")}\n`;
}

if (writeReport) {
  const outDir = path.resolve(repoRoot, reportDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "test-inventory-baseline.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(
    path.join(outDir, "test-inventory-baseline.md"),
    markdownReport(summary),
  );
}

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(markdownReport(summary));
}
