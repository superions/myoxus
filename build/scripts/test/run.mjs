#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Matrix-aware test runner. It intentionally keeps selection and command
// listing in one place so local runbooks and CI workflows can converge on the
// same suite IDs instead of copying shell snippets.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  classifyBlockingResult,
  suiteExitCode,
} from "./matrix-result-policy.mjs";
import { runWithProcessTreeTimeout } from "./process-tree-runner.mjs";
import { evaluateRuntimeBudget } from "./runtime-budget.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const matrixRoot = path.join(repoRoot, "build/test-matrix");
const suitePath = path.join(matrixRoot, "suites.json");
const ownersPath = path.join(matrixRoot, "owners.json");
const pathRulesPath = path.join(matrixRoot, "path-rules.json");
const runtimeBudgetsPath = path.join(matrixRoot, "runtime-budgets.json");
const testQualityBudgetsPath = path.join(
  matrixRoot,
  "test-quality-budgets.json",
);
const runOutputRoot = path.join(repoRoot, "output/test-runs");

const argv = process.argv.slice(2);
const options = {
  suites: [],
  tiers: [],
  onlyTiers: [],
  files: [],
  changed: false,
  list: false,
  dryRun: false,
  json: false,
  strict: false,
  allowNightly: false,
  includeManual: false,
  base: "origin/wip",
  extraArgs: [],
};

function takeValue(args, index, flag) {
  const current = args[index];
  if (current.includes("="))
    return [current.slice(current.indexOf("=") + 1), index];
  if (index + 1 >= args.length) throw new Error(`${flag} expects a value`);
  return [args[index + 1], index + 1];
}

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--") {
    options.extraArgs = argv.slice(index + 1);
    break;
  }
  if (arg === "--changed") {
    options.changed = true;
  } else if (arg === "--list") {
    options.list = true;
  } else if (arg === "--dry-run") {
    options.dryRun = true;
  } else if (arg === "--json") {
    options.json = true;
  } else if (arg === "--strict") {
    options.strict = true;
  } else if (arg === "--allow-nightly") {
    options.allowNightly = true;
  } else if (arg === "--include-manual") {
    options.includeManual = true;
  } else if (arg === "--suite" || arg.startsWith("--suite=")) {
    const [value, next] = takeValue(argv, index, "--suite");
    options.suites.push(
      ...value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    index = next;
  } else if (arg === "--tier" || arg.startsWith("--tier=")) {
    const [value, next] = takeValue(argv, index, "--tier");
    options.tiers.push(
      ...value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    index = next;
  } else if (arg === "--only-tier" || arg.startsWith("--only-tier=")) {
    const [value, next] = takeValue(argv, index, "--only-tier");
    options.onlyTiers.push(
      ...value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    index = next;
  } else if (arg === "--files" || arg.startsWith("--files=")) {
    const [value, next] = takeValue(argv, index, "--files");
    options.files.push(
      ...value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    index = next;
  } else if (arg === "--base" || arg.startsWith("--base=")) {
    const [value, next] = takeValue(argv, index, "--base");
    options.base = value;
    index = next;
  } else {
    throw new Error(`Unknown option: ${arg}`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const suites = readJson(suitePath);
const owners = readJson(ownersPath);
const pathRules = readJson(pathRulesPath);
const runtimeBudgets = readJson(runtimeBudgetsPath);
const testQualityBudgets = readJson(testQualityBudgetsPath);
const suiteById = new Map(suites.map((suite) => [suite.id, suite]));
const runtimeBudgetBySuite = new Map(
  (runtimeBudgets.budgets ?? []).map((budget) => [budget.suite_id, budget]),
);
const runtimeBudgetTolerancePercent = Number(
  runtimeBudgets.policy?.fluctuation_tolerance_percent,
);

const requiredSuiteFields = [
  "id",
  "tier",
  "owner_domain",
  "command",
  "cwd",
  "current_workflows",
  "replaces_scripts",
  "blocking_mode",
  "default_gate",
  "default_inclusion_reason",
  "estimated_cost_center",
  "cheaper_layer_candidate",
  "removal_or_quarantine_candidate",
  "changed_path_selectors",
  "required_services",
  "expected_artifacts",
  "timeout_seconds",
  "parallelism_rule",
  "cleanup_isolation_rule",
  "quality_budget",
  "documentation_output_target",
  "replacement_notes",
];

function validateMatrix() {
  const errors = [];
  if (runtimeBudgets.schema_version !== 1) {
    errors.push("runtime budgets: unsupported schema_version");
  }
  if (
    !Number.isFinite(runtimeBudgetTolerancePercent) ||
    runtimeBudgetTolerancePercent < 0 ||
    runtimeBudgetTolerancePercent > 100
  ) {
    errors.push(
      "runtime budgets: policy.fluctuation_tolerance_percent must be between 0 and 100",
    );
  }
  const seen = new Set();
  for (const suite of suites) {
    if (seen.has(suite.id)) errors.push(`duplicate suite id: ${suite.id}`);
    seen.add(suite.id);
    for (const field of requiredSuiteFields) {
      if (!(field in suite)) errors.push(`${suite.id}: missing field ${field}`);
    }
    if (!owners[suite.owner_domain]) {
      errors.push(`${suite.id}: unknown owner_domain ${suite.owner_domain}`);
    }
    if (suite.tier !== "retired" && !String(suite.command ?? "").trim()) {
      errors.push(`${suite.id}: runnable suite has empty command`);
    }
    if (
      suite.tier !== "retired" &&
      invalidApiTarget(String(suite.command ?? ""))
    ) {
      errors.push(
        `${suite.id}: uses a removed myoxus-api integration file target; use --test integration <filter>`,
      );
    }
    if (suite.tier !== "retired" && Number(suite.timeout_seconds) <= 0) {
      errors.push(`${suite.id}: timeout_seconds must be positive`);
    }
    if (suite.default_gate) {
      for (const field of [
        "default_inclusion_reason",
        "estimated_cost_center",
        "cheaper_layer_candidate",
        "cleanup_isolation_rule",
      ]) {
        if (!String(suite[field] ?? "").trim())
          errors.push(`${suite.id}: default suite has empty ${field}`);
      }
    }
    if (
      suite.tier_default === false &&
      !String(suite.replacement_notes ?? "").includes("--tier")
    ) {
      errors.push(
        `${suite.id}: tier_default=false must document the explicit --tier selection decision in replacement_notes`,
      );
    }
  }
  for (const suite of suites) {
    if (
      "subsumes_suites" in suite &&
      (!Array.isArray(suite.subsumes_suites) ||
        !suite.subsumes_suites.every((suiteId) => typeof suiteId === "string"))
    ) {
      errors.push(`${suite.id}: subsumes_suites must be an array of suite ids`);
      continue;
    }
    for (const suiteId of suite.subsumes_suites ?? []) {
      if (suiteId === suite.id) {
        errors.push(`${suite.id}: a suite cannot subsume itself`);
      } else if (!suiteById.has(suiteId)) {
        errors.push(`${suite.id}: subsumes unknown suite ${suiteId}`);
      }
    }
  }
  for (const rule of pathRules) {
    for (const suiteId of rule.select_suites ?? []) {
      if (!suiteById.has(suiteId))
        errors.push(`${rule.id}: unknown suite ${suiteId}`);
    }
    if (
      "exclude_paths" in rule &&
      (!Array.isArray(rule.exclude_paths) ||
        !rule.exclude_paths.every((glob) => typeof glob === "string"))
    ) {
      errors.push(`${rule.id}: exclude_paths must be an array of glob strings`);
    }
  }
  for (const budget of runtimeBudgets.budgets ?? []) {
    if (!suiteById.has(budget.suite_id)) {
      errors.push(`runtime budget references unknown suite ${budget.suite_id}`);
    }
    for (const field of [
      "baseline_ms",
      "warn_budget_ms",
      "strict_budget_ms",
      "cost_center",
      "decision",
      "source_artifact",
    ]) {
      if (!(field in budget)) {
        errors.push(`${budget.suite_id}: runtime budget missing ${field}`);
      }
    }
    if (Number(budget.baseline_ms) <= 0) {
      errors.push(`${budget.suite_id}: baseline_ms must be positive`);
    }
    if (Number(budget.warn_budget_ms) <= 0) {
      errors.push(`${budget.suite_id}: warn_budget_ms must be positive`);
    }
    if (Number(budget.strict_budget_ms) <= 0) {
      errors.push(`${budget.suite_id}: strict_budget_ms must be positive`);
    }
    if (Number(budget.warn_budget_ms) > Number(budget.strict_budget_ms)) {
      errors.push(
        `${budget.suite_id}: warn_budget_ms must be <= strict_budget_ms`,
      );
    }
  }
  validateTestQualityBudgets(errors);
  if (errors.length > 0) {
    throw new Error(
      `Invalid test matrix:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
}

function validateTestQualityBudgets(errors) {
  if (testQualityBudgets.schema_version !== 1) {
    errors.push("test quality budgets: unsupported schema_version");
  }
  const jsDomains = testQualityBudgets.jsTs?.domains;
  if (!jsDomains || typeof jsDomains !== "object") {
    errors.push("test quality budgets: missing jsTs.domains");
  } else {
    for (const [domain, counts] of Object.entries(jsDomains)) {
      for (const [pattern, value] of Object.entries(counts ?? {})) {
        if (!Number.isInteger(value) || value < 0) {
          errors.push(
            `test quality budgets: ${domain}.${pattern} must be a non-negative integer`,
          );
        }
      }
    }
  }
  const rustCrates = testQualityBudgets.rust?.crates;
  if (!rustCrates || typeof rustCrates !== "object") {
    errors.push("test quality budgets: missing rust.crates");
  } else {
    for (const [crate, counts] of Object.entries(rustCrates)) {
      for (const [pattern, value] of Object.entries(counts ?? {})) {
        if (!Number.isInteger(value) || value < 0) {
          errors.push(
            `test quality budgets: ${crate}.${pattern} must be a non-negative integer`,
          );
        }
      }
    }
  }
}

function globToRegExp(glob) {
  let re = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      re += ".*";
      index += 1;
    } else if (char === "*") {
      re += "[^/]*";
    } else if (char === "?") {
      re += ".";
    } else {
      re += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re);
}

const pathRuleRegexCache = new Map();

function matchesGlob(file, glob) {
  if (!pathRuleRegexCache.has(glob))
    pathRuleRegexCache.set(glob, globToRegExp(glob));
  return pathRuleRegexCache.get(glob).test(file);
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function changedFiles() {
  if (options.files.length > 0) return [...new Set(options.files)];
  return [
    ...gitOutput(["diff", "--name-only", "--cached"]),
    ...gitOutput(["diff", "--name-only"]),
    ...gitOutput(["diff", "--name-only", `${options.base}...HEAD`]),
    ...gitOutput(["ls-files", "--others", "--exclude-standard"]),
  ]
    .filter(Boolean)
    .filter((file, index, all) => all.indexOf(file) === index);
}

function selectedFromChanged(files) {
  const selection = new Map();
  for (const rule of pathRules) {
    const matched = files.filter(
      (file) =>
        (rule.paths ?? []).some((glob) => matchesGlob(file, glob)) &&
        !(rule.exclude_paths ?? []).some((glob) => matchesGlob(file, glob)),
    );
    if (matched.length === 0) continue;
    for (const suiteId of rule.select_suites ?? []) {
      if (!selection.has(suiteId)) selection.set(suiteId, []);
      selection.get(suiteId).push({
        rule: rule.id,
        reason: rule.reason,
        files: matched.slice(0, 12),
        fileCount: matched.length,
      });
    }
  }
  return selection;
}

function invalidApiTarget(command) {
  const match =
    /cargo\s+test\s+(?:-p\s+myoxus-api|--manifest-path\s+server\/Cargo\.toml\s+-p\s+myoxus-api)[^&|;]*--test\s+([A-Za-z0-9_]+)/.exec(
      command,
    );
  if (!match) return false;
  // Keep the full matrix consolidated. The two bounded targets isolate
  // changed-path smoke/protocol compile surfaces from the 1,000+ test target.
  return !new Set([
    "integration",
    "integration_quick",
    "sync_load_protocol",
  ]).has(match[1]);
}

function requiresStrict(suite) {
  return suite.tier === "release-strict" && !options.strict;
}

function requiresNightly(suite) {
  return suite.tier === "nightly" && !options.allowNightly;
}

function requiresManualOptIn(suite, reasonItems) {
  // Explicit suite selection is already a manual action. Changed-path and tier
  // selection may surface manual browser/device suites for visibility, but they
  // must not spend local/CI time unless the caller opted into that cost.
  if (reasonItems.some((reason) => reason.type === "explicit")) return false;
  if (suite.blocking_mode === "manual-only") return !options.includeManual;
  if (suite.blocking_mode === "manual-or-strict") {
    return !options.includeManual && !options.strict;
  }
  return false;
}

function canSelectFromTier(suite) {
  if (suite.tier_default === false) return false;
  if (suite.blocking_mode === "manual-only") return options.includeManual;
  if (suite.blocking_mode === "manual-or-strict") {
    return options.includeManual;
  }
  return true;
}

function selectSuites() {
  const reasons = new Map();
  const add = (suite, reason) => {
    if (!reasons.has(suite.id)) reasons.set(suite.id, []);
    reasons.get(suite.id).push(reason);
  };

  if (options.suites.length > 0) {
    for (const suiteId of options.suites) {
      const suite = suiteById.get(suiteId);
      if (!suite) throw new Error(`Unknown suite: ${suiteId}`);
      add(suite, {
        type: "explicit",
        reason: `selected by --suite ${suiteId}`,
      });
    }
  }

  for (const tier of options.tiers) {
    for (const suite of suites.filter(
      (candidate) =>
        candidate.tier === tier &&
        candidate.tier !== "retired" &&
        canSelectFromTier(candidate),
    )) {
      add(suite, { type: "tier", reason: `selected by --tier ${tier}` });
    }
  }

  const hasChangedSelection = options.changed || options.files.length > 0;
  if (hasChangedSelection) {
    const files = changedFiles();
    const changedSelection = selectedFromChanged(files);
    for (const [suiteId, ruleReasons] of changedSelection.entries()) {
      const suite = suiteById.get(suiteId);
      if (!suite) continue;
      add(suite, { type: "changed", files, rules: ruleReasons });
    }
    if (
      files.length === 0 &&
      options.suites.length === 0 &&
      options.tiers.length === 0
    ) {
      return { selected: [], reasons, changedFiles: files };
    }
  }

  const onlyTierSet =
    options.onlyTiers.length > 0 ? new Set(options.onlyTiers) : null;
  const selected = [...reasons.keys()]
    .map((suiteId) => suiteById.get(suiteId))
    .filter((suite) => !onlyTierSet || onlyTierSet.has(suite.tier));
  const retainedIds = new Set(selected.map((suite) => suite.id));
  for (const suite of selected) {
    for (const subsumedId of suite.subsumes_suites ?? []) {
      if (!retainedIds.has(subsumedId)) continue;
      const subsumedWasExplicit = (reasons.get(subsumedId) ?? []).some(
        (reason) => reason.type === "explicit",
      );
      if (subsumedWasExplicit) continue;
      retainedIds.delete(subsumedId);
      reasons.get(suite.id)?.push({
        type: "subsumes",
        reason: `${suite.id} already executes the selected ${subsumedId} scope`,
      });
    }
  }
  return {
    selected: selected.filter((suite) => retainedIds.has(suite.id)),
    reasons,
    changedFiles: hasChangedSelection ? changedFiles() : [],
  };
}

function suiteSummary(suite, reasonItems) {
  const runtimeBudget = runtimeBudgetBySuite.get(suite.id) ?? null;
  return {
    id: suite.id,
    tier: suite.tier,
    owner_domain: suite.owner_domain,
    blocking_mode: suite.blocking_mode,
    default_gate: suite.default_gate,
    cwd: suite.cwd,
    command: suite.command,
    required_services: suite.required_services,
    expected_artifacts: suite.expected_artifacts,
    timeout_seconds: suite.timeout_seconds,
    subsumes_suites: suite.subsumes_suites ?? [],
    parallelism_rule: suite.parallelism_rule,
    cleanup_isolation_rule: suite.cleanup_isolation_rule,
    runtime_budget: runtimeBudget,
    manual_opt_in_required: requiresManualOptIn(suite, reasonItems),
    reasons: reasonItems,
  };
}

function printHumanSelection(selected, reasons, changed) {
  if (changed) {
    console.log(`Changed files considered: ${changed.length}`);
    for (const file of changed.slice(0, 40)) console.log(`  - ${file}`);
    if (changed.length > 40) console.log(`  ... ${changed.length - 40} more`);
    console.log("");
  }
  if (selected.length === 0) {
    console.log("No suites selected.");
    return;
  }
  console.log("Selected suites:");
  for (const suite of selected) {
    console.log(`- ${suite.id} [${suite.tier}/${suite.owner_domain}]`);
    console.log(`  cwd: ${suite.cwd}`);
    console.log(`  command: ${suite.command || "(retired)"}`);
    console.log(
      `  services: ${(suite.required_services ?? []).join(", ") || "none"}`,
    );
    console.log(`  timeout: ${suite.timeout_seconds}s`);
    const runtimeBudget = runtimeBudgetBySuite.get(suite.id);
    if (runtimeBudget) {
      const warnCeiling =
        Number(runtimeBudget.warn_budget_ms) *
        (1 + runtimeBudgetTolerancePercent / 100);
      const strictCeiling =
        Number(runtimeBudget.strict_budget_ms) *
        (1 + runtimeBudgetTolerancePercent / 100);
      console.log(
        `  runtime budget: warn ${runtimeBudget.warn_budget_ms}ms, strict ${runtimeBudget.strict_budget_ms}ms; ` +
          `${runtimeBudgetTolerancePercent}% fluctuation ceilings ${warnCeiling}ms/${strictCeiling}ms`,
      );
    }
    console.log(
      `  artifacts: ${(suite.expected_artifacts ?? []).join(", ") || "none"}`,
    );
    for (const reason of reasons.get(suite.id) ?? []) {
      if (reason.type === "changed") {
        for (const rule of reason.rules) {
          console.log(
            `  reason: ${rule.rule} - ${rule.reason} (${rule.fileCount} file(s))`,
          );
        }
      } else {
        console.log(`  reason: ${reason.reason}`);
      }
    }
    if (requiresManualOptIn(suite, reasons.get(suite.id) ?? [])) {
      console.log(
        "  manual-only: will be skipped unless selected with --suite or --include-manual",
      );
    }
  }
}

async function runSuite(suite, reasonItems) {
  if (suite.tier === "retired") {
    return {
      id: suite.id,
      status: "retired",
      elapsedMs: 0,
      exitCode: 0,
      skipped: true,
    };
  }
  if (requiresStrict(suite)) {
    return {
      id: suite.id,
      status: "skipped",
      elapsedMs: 0,
      exitCode: 0,
      skipped: true,
      reason: "release-strict suite requires --strict",
    };
  }
  if (requiresNightly(suite)) {
    return {
      id: suite.id,
      status: "skipped",
      elapsedMs: 0,
      exitCode: 0,
      skipped: true,
      reason: "nightly suite requires --allow-nightly",
    };
  }
  if (requiresManualOptIn(suite, reasonItems)) {
    return {
      id: suite.id,
      status: "skipped",
      elapsedMs: 0,
      exitCode: 0,
      skipped: true,
      reason: "manual-only suite requires explicit --suite or --include-manual",
    };
  }
  if (invalidApiTarget(suite.command)) {
    return {
      id: suite.id,
      status: "blocked",
      elapsedMs: 0,
      exitCode: 2,
      error:
        "Refusing an unowned myoxus-api integration target. Use `integration`, `integration_quick` or `sync_load_protocol`.",
    };
  }
  const suiteCwd = path.resolve(repoRoot, suite.cwd);
  const command =
    options.extraArgs.length > 0
      ? `${suite.command} ${options.extraArgs.join(" ")}`
      : suite.command;
  const suiteEnv = {
    ...process.env,
    // Matrix Cargo shapes intentionally trade incremental state for bounded,
    // repeatable host pressure. Standard gates never emit debug information,
    // so adjacent Rust suites can reuse one cache-compatible artifact shape.
    // Explicit native-crash diagnostics run outside the matrix and may opt in.
    CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0",
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "8",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    MYOXUS_MATRIX_SUITE_ID: suite.id,
  };
  const result = await runWithProcessTreeTimeout(
    "bash",
    [
      path.join(repoRoot, "build/scripts/test/scope-guard.sh"),
      "bash",
      // Keep the caller's selected toolchain. A second login shell can reset
      // PATH to Apple's Python after a Homebrew preflight already succeeded.
      "-c",
      command,
    ],
    {
      cwd: suiteCwd,
      stdio: "inherit",
      timeoutMs: Number(suite.timeout_seconds) * 1000,
      env: suiteEnv,
    },
  );
  const elapsedMs = result.elapsedMs;
  const timedOut = result.timedOut;
  const runtimeBudget = runtimeBudgetBySuite.get(suite.id) ?? null;
  const budget = evaluateRuntimeBudget(
    elapsedMs,
    runtimeBudget,
    runtimeBudgetTolerancePercent,
  );
  const budgetFailure =
    options.strict && budget?.strictExceeded === true && !timedOut;
  const exitCode = suiteExitCode(result, budgetFailure);
  if (budget && budget.status !== "within") {
    const action = budgetFailure
      ? "failing strict run"
      : budget.toleratedFluctuation
        ? "tolerating configured fluctuation"
        : "recording warning";
    console.warn(
      `runtime budget ${budget.status} for ${suite.id}: ${elapsedMs}ms ` +
        `(declared warn ${budget.warnBudgetMs}ms, strict ${budget.strictBudgetMs}ms; ` +
        `${budget.fluctuationTolerancePercent}% ceilings ${budget.warnToleranceCeilingMs}ms/${budget.strictToleranceCeilingMs}ms); ${action}`,
    );
  }
  return {
    id: suite.id,
    status: exitCode === 0 ? "passed" : "failed",
    elapsedMs,
    exitCode,
    timedOut,
    budget,
    signal: result.signal,
    error: timedOut
      ? `suite exceeded ${suite.timeout_seconds}s; complete process group terminated`
      : result.error?.message,
  };
}

function writeRunArtifact(payload) {
  mkdirSync(runOutputRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(runOutputRoot, `matrix-run-${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return path.relative(repoRoot, file);
}

validateMatrix();

if (options.list) {
  const list = suites.map((suite) => ({
    id: suite.id,
    tier: suite.tier,
    owner_domain: suite.owner_domain,
    blocking_mode: suite.blocking_mode,
    default_gate: suite.default_gate,
    command: suite.command,
  }));
  if (options.json) console.log(JSON.stringify({ suites: list }, null, 2));
  else {
    for (const suite of list) {
      console.log(
        `${suite.id.padEnd(34)} ${suite.tier.padEnd(15)} ${suite.owner_domain.padEnd(20)} ${suite.blocking_mode}`,
      );
    }
  }
  process.exit(0);
}

const { selected, reasons, changedFiles: changed } = selectSuites();
const payload = {
  generatedAt: new Date().toISOString(),
  dryRun: options.dryRun,
  runtimeBudgetPolicy: runtimeBudgets.policy,
  changedFiles: changed,
  selected: selected.map((suite) =>
    suiteSummary(suite, reasons.get(suite.id) ?? []),
  ),
};

if (options.dryRun) {
  // A large selection must drain its pipe before exit; otherwise Node can
  // truncate machine-readable plans at the pipe buffer boundary.
  if (options.json)
    await new Promise((resolve) =>
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`, resolve),
    );
  else printHumanSelection(selected, reasons, changed);
  process.exit(0);
}

printHumanSelection(selected, reasons, changed);
const results = [];
let exitCode = 0;
for (const suite of selected) {
  console.log("");
  console.log(`==> ${suite.id}`);
  const result = await runSuite(suite, reasons.get(suite.id) ?? []);
  results.push(result);
  const policy = classifyBlockingResult(result, suite.blocking_mode);
  if (policy.exitCode !== 0) exitCode = policy.exitCode;
  if (!policy.shouldContinue) {
    break;
  }
}

const runPayload = {
  ...payload,
  results,
};
const artifact = writeRunArtifact(runPayload);
console.log("");
console.log(`Matrix timing/result artifact: ${artifact}`);
if (options.json) console.log(JSON.stringify(runPayload, null, 2));
process.exit(exitCode);
