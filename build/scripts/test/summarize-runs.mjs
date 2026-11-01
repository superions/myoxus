#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Summarize matrix timing JSON artifacts into a compact baseline report. The
// runner remains the source of execution; this script only turns its artifacts
// into a reviewable timing table.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { evaluateRuntimeBudget } from "./runtime-budget.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const matrixRoot = path.join(repoRoot, "build/test-matrix");
const runtimeBudgetsPath = path.join(matrixRoot, "runtime-budgets.json");
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const writeReport = argv.includes("--write-report");

function optionValue(name, fallback = null) {
  const prefixed = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return fallback;
}

const inputDir = path.resolve(
  repoRoot,
  optionValue("--input-dir", "output/test-runs"),
);
const reportDir = path.resolve(
  repoRoot,
  optionValue("--report-dir", "output/test-runs"),
);
const runtimeBudgets = JSON.parse(readFileSync(runtimeBudgetsPath, "utf8"));
const runtimeBudgetBySuite = new Map(
  (runtimeBudgets.budgets ?? []).map((budget) => [budget.suite_id, budget]),
);
const runtimeBudgetTolerancePercent = Number(
  runtimeBudgets.policy?.fluctuation_tolerance_percent,
);

function readRuns() {
  const entries = [];
  let files;
  try {
    files = readdirSync(inputDir);
  } catch (error) {
    // A fresh checkout has no ignored run directory yet. Only that absence is
    // an empty baseline; existing but unreadable inputs must remain failures.
    if (error?.code === "ENOENT") return entries;
    throw error;
  }

  for (const file of files.filter((entry) =>
    /^matrix-run-.*\.json$/.test(entry),
  )) {
    const fullPath = path.join(inputDir, file);
    let source;
    try {
      source = readFileSync(fullPath, "utf8");
    } catch (error) {
      throw new Error(
        `Failed to read runtime artifact ${path.relative(repoRoot, fullPath)}: ${error.message}`,
        { cause: error },
      );
    }
    let payload;
    try {
      payload = JSON.parse(source);
    } catch (error) {
      throw new Error(
        `Failed to parse runtime artifact ${path.relative(repoRoot, fullPath)}: ${error.message}`,
        { cause: error },
      );
    }
    for (const result of payload.results ?? []) {
      entries.push({
        artifact: path.relative(repoRoot, fullPath),
        generatedAt: payload.generatedAt,
        dryRun: payload.dryRun,
        suite: result.id,
        status: result.status,
        elapsedMs: result.elapsedMs,
        exitCode: result.exitCode,
        selectedCount: payload.selected?.length ?? 0,
      });
    }
  }
  return entries.sort(
    (a, b) =>
      a.suite.localeCompare(b.suite) ||
      a.generatedAt.localeCompare(b.generatedAt),
  );
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index];
}

function summarize(entries) {
  const bySuite = new Map();
  for (const entry of entries) {
    if (!bySuite.has(entry.suite)) bySuite.set(entry.suite, []);
    bySuite.get(entry.suite).push(entry);
  }
  return [...bySuite.entries()].map(([suite, suiteEntries]) => {
    const elapsed = suiteEntries
      .map((entry) => entry.elapsedMs)
      .filter((value) => Number.isFinite(value));
    const latest = suiteEntries[suiteEntries.length - 1];
    const budget = runtimeBudgetBySuite.get(suite) ?? null;
    const latestBudget = evaluateRuntimeBudget(
      latest?.elapsedMs,
      budget,
      runtimeBudgetTolerancePercent,
    );
    return {
      suite,
      runs: suiteEntries.length,
      passed: suiteEntries.filter((entry) => entry.status === "passed").length,
      failed: suiteEntries.filter((entry) => entry.status === "failed").length,
      minMs: Math.min(...elapsed),
      medianMs: percentile(elapsed, 50),
      p95Ms: percentile(elapsed, 95),
      maxMs: Math.max(...elapsed),
      latestMs: latest?.elapsedMs ?? null,
      latestStatus: latest?.status,
      latestArtifact: latest?.artifact,
      runtimeBudget: budget,
      latestBudgetStatus: latestBudget?.status ?? "unbudgeted",
    };
  });
}

function renderMarkdown(payload) {
  const lines = [];
  lines.push("# Test Matrix Runtime Summary");
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(`Input: \`${path.relative(repoRoot, inputDir)}\``);
  lines.push("");
  lines.push(
    "| Suite | Runs | Passed | Failed | Median | p95 | Latest | Budget | Decision | Artifact |",
  );
  lines.push(
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  );
  for (const row of payload.suites) {
    const budget = row.runtimeBudget;
    const budgetLabel = budget
      ? `${row.latestBudgetStatus} (${budget.warn_budget_ms}/${budget.strict_budget_ms}ms, +${runtimeBudgetTolerancePercent}% fluctuation)`
      : row.latestBudgetStatus;
    lines.push(
      `| \`${row.suite}\` | ${row.runs} | ${row.passed} | ${row.failed} | ${row.medianMs}ms | ${row.p95Ms}ms | ${row.latestMs}ms ${row.latestStatus} | ${budgetLabel} | ${budget?.decision ?? ""} | \`${row.latestArtifact}\` |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const entries = readRuns();
const payload = {
  generatedAt: new Date().toISOString(),
  inputDir: path.relative(repoRoot, inputDir),
  runtimeBudgetPolicy: runtimeBudgets.policy,
  suites: summarize(entries),
};

if (writeReport) {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(
    path.join(reportDir, "matrix-runtime-summary.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  writeFileSync(
    path.join(reportDir, "matrix-runtime-summary.md"),
    renderMarkdown(payload),
  );
}

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(renderMarkdown(payload));
}
