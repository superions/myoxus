#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Inventory weak test patterns without turning the inventory into a blanket gate.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const json = args.has("--json");
const ratchet = args.has("--ratchet");
const checkBudgets = args.has("--check-budgets");
const report = args.has("--report") || (!json && !ratchet);

function optionValue(name, fallback = null) {
  const prefixed = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefixed));
  if (inline) return inline.slice(prefixed.length);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return fallback;
}

function optionValues(name) {
  const values = [];
  const prefixed = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(prefixed)) {
      values.push(arg.slice(prefixed.length));
      continue;
    }
    if (arg === name && index + 1 < argv.length) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

const diffBase = optionValue("--base");
const diffFile = optionValue("--diff-file");
const budgetFile = optionValue(
  "--budget-file",
  "build/test-matrix/test-quality-budgets.json",
);

const defaultScanRoots = ["client", "tests", "virgultum"];
const scanRoots = optionValues("--scan-root");
const effectiveScanRoots = scanRoots.length > 0 ? scanRoots : defaultScanRoots;
const ignoredDirs = new Set([
  ".git",
  ".yarn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".turbo",
  "coverage",
]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const patterns = [
  {
    id: "test_only",
    label: "test.only / describe.only",
    re: /\b(?:test|describe)\.only\s*\(/g,
    ratchet: "block",
    risk: "Focused tests must never be committed because they hide the rest of the suite.",
  },
  {
    id: "test_skip",
    label: "test.skip",
    re: /\btest\.skip\s*\(/g,
    ratchet: "block",
    risk: "Skipped product checks hide known defects unless the skip is platform-scoped and justified.",
  },
  {
    id: "catch_null",
    label: ".catch(() => null)",
    re: /\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*null\s*\)/g,
    ratchet: "block",
    risk: "Swallowed failures can turn broken setup or API calls into false-green tests.",
  },
  {
    id: "truthy",
    label: "toBeTruthy()",
    re: /\.toBeTruthy\s*\(\s*\)/g,
    ratchet: "report",
    risk: "Truthy assertions are often weaker than role/text/state/shape assertions.",
  },
  {
    id: "bare_ok",
    label: "assert.ok",
    re: /\bassert\.ok\s*\(/g,
    ratchet: "block",
    risk: "Bare assertions need review when they replace semantic assertions; response.ok() is a transport predicate and is not an assertion.",
  },
];

function domainFor(relativePath) {
  if (relativePath.startsWith("tests/client/adminfrontend/e2e/"))
    return "admin-e2e";
  if (relativePath.startsWith("tests/client/webfrontend/smoke/"))
    return "web-smoke";
  if (
    relativePath.startsWith(
      "tests/client/webfrontend/flow/tests/doc-versioning/",
    )
  )
    return "web-document-history";
  if (relativePath.startsWith("tests/client/webfrontend/flow/"))
    return "web-flow";
  if (relativePath.startsWith("tests/client/webfrontend/editor-flow/"))
    return "web-editor-flow";
  if (relativePath.startsWith("tests/client/webfrontend/visual/"))
    return "web-visual";
  if (relativePath.startsWith("tests/client/webfrontend/shared/"))
    return "web-playwright-shared";
  if (relativePath.startsWith("tests/client/webfrontend/local/"))
    return "web-local";
  if (relativePath.startsWith("tests/client/editor-core/virgultum/"))
    return "editor-core-virgultum";
  if (relativePath.startsWith("tests/client/mobile/app/")) return "mobile-app";
  if (relativePath.startsWith("tests/client/desktop/local/"))
    return "desktop-local";
  if (relativePath.startsWith("tests/client/shared/")) return "client-shared";
  if (relativePath.startsWith("client/admin/")) return "admin-unit";
  if (relativePath.startsWith("client/web/")) return "web-unit";
  if (relativePath.startsWith("client/libs/core/")) return "core-unit";
  if (relativePath.startsWith("client/libs/ui-facade/"))
    return "ui-facade-unit";
  if (relativePath.startsWith("client/libs/")) return "client-libs";
  if (relativePath.startsWith("client/apps/")) return "client-apps";
  if (relativePath.startsWith("virgultum/")) return "virgultum";
  return "other";
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function scanRootDescriptor(root) {
  const fullPath = path.resolve(repoRoot, root);
  const prefix = path.isAbsolute(root)
    ? path.basename(root)
    : toPosix(root).replace(/\/+$/, "");
  return {
    fullPath,
    relativePath(file) {
      return toPosix(path.join(prefix, path.relative(fullPath, file)));
    },
  };
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walk(fullPath);
      continue;
    }
    if (!stat.isFile()) continue;
    if (!extensions.has(path.extname(entry))) continue;
    yield fullPath;
  }
}

function isTestFile(relativePath) {
  const base = path.basename(relativePath);
  return (
    relativePath.startsWith("tests/") ||
    relativePath.includes("/__tests__/") ||
    /\.spec\.[tj]sx?$/.test(base) ||
    /\.test\.[tj]sx?$/.test(base)
  );
}

function gitDiff(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function changedDiffs() {
  const gitRoots = effectiveScanRoots.filter((root) => !path.isAbsolute(root));
  const diffRoots = gitRoots.length > 0 ? gitRoots : defaultScanRoots;
  if (diffFile) return [readFileSync(path.resolve(repoRoot, diffFile), "utf8")];
  if (diffBase) {
    return [
      gitDiff([
        "diff",
        "--unified=0",
        "--no-ext-diff",
        `${diffBase}...HEAD`,
        "--",
        ...diffRoots,
      ]),
    ];
  }
  return [
    gitDiff([
      "diff",
      "--cached",
      "--unified=0",
      "--no-ext-diff",
      "--",
      ...diffRoots,
    ]),
    gitDiff(["diff", "--unified=0", "--no-ext-diff", "--", ...diffRoots]),
  ];
}

function ratchetFindingsFromDiffs() {
  const findings = [];
  const seen = new Set();
  for (const diff of changedDiffs()) {
    let currentFile = null;
    let newLine = 0;
    for (const line of diff.split(/\r?\n/)) {
      const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (fileMatch) {
        currentFile = fileMatch[2];
        newLine = 0;
        continue;
      }
      if (!currentFile || !isTestFile(currentFile)) continue;
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunkMatch) {
        newLine = Number(hunkMatch[1]);
        continue;
      }
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) {
        const added = line.slice(1);
        for (const pattern of patterns.filter(
          (candidate) => candidate.ratchet === "block",
        )) {
          pattern.re.lastIndex = 0;
          if (!pattern.re.test(added)) continue;
          const key = `${currentFile}:${newLine}:${pattern.id}:${added}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            pattern: pattern.id,
            label: pattern.label,
            domain: domainFor(currentFile),
            file: currentFile,
            line: newLine,
            text: added.trim(),
          });
        }
        newLine += 1;
      } else if (line.startsWith(" ")) {
        newLine += 1;
      }
    }
  }
  return findings;
}

const findings = [];
const totals = Object.fromEntries(patterns.map((pattern) => [pattern.id, 0]));
const byDomain = new Map();

for (const root of effectiveScanRoots) {
  const descriptor = scanRootDescriptor(root);
  try {
    statSync(descriptor.fullPath);
  } catch {
    continue;
  }
  for (const file of walk(descriptor.fullPath)) {
    const rel = descriptor.relativePath(file);
    if (!isTestFile(rel)) continue;
    const source = readFileSync(file, "utf8");
    const domain = domainFor(rel);
    if (!byDomain.has(domain)) {
      byDomain.set(
        domain,
        Object.fromEntries(patterns.map((pattern) => [pattern.id, 0])),
      );
    }
    const domainTotals = byDomain.get(domain);
    const lines = source.split(/\r?\n/);
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(source)) !== null) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        const text = lines[line - 1]?.trim() ?? "";
        totals[pattern.id] += 1;
        domainTotals[pattern.id] += 1;
        findings.push({
          pattern: pattern.id,
          label: pattern.label,
          domain,
          file: rel,
          line,
          text,
        });
      }
    }
  }
}

function loadBudget() {
  const fullPath = path.resolve(repoRoot, budgetFile);
  return {
    path: fullPath,
    data: JSON.parse(readFileSync(fullPath, "utf8")),
  };
}

function qualityBudgetFindings(data, budget) {
  const findings = [];
  const budgetDomains = budget.jsTs?.domains ?? {};
  for (const [domain, counts] of Object.entries(data.byDomain)) {
    const limits = budgetDomains[domain] ?? {};
    for (const pattern of patterns) {
      const actual = Number(counts[pattern.id] ?? 0);
      const max = Number(limits[pattern.id] ?? 0);
      if (actual <= max) continue;
      findings.push({
        domain,
        pattern: pattern.id,
        label: pattern.label,
        actual,
        max,
        delta: actual - max,
      });
    }
  }
  return findings;
}

const summary = {
  generatedAt: new Date().toISOString(),
  totals,
  byDomain: Object.fromEntries(
    [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ),
  patternRisks: Object.fromEntries(
    patterns.map((pattern) => [pattern.id, pattern.risk]),
  ),
  findings,
  ratchet: ratchet
    ? {
        base: diffBase,
        blockingPatterns: patterns
          .filter((pattern) => pattern.ratchet === "block")
          .map((pattern) => pattern.id),
        findings: ratchetFindingsFromDiffs(),
      }
    : undefined,
};

let budgetFindings = [];
if (checkBudgets) {
  const budget = loadBudget();
  budgetFindings = qualityBudgetFindings(summary, budget.data);
  summary.budget = {
    budgetFile: path.relative(repoRoot, budget.path),
    policy: budget.data.policy,
    findings: budgetFindings,
  };
}

if (json) {
  console.log(JSON.stringify(summary, null, 2));
}

if (report) {
  console.log("Test quality inventory");
  console.log("======================");
  for (const pattern of patterns) {
    console.log(
      `${pattern.label.padEnd(22)} ${String(totals[pattern.id]).padStart(5)}  ${pattern.risk}`,
    );
  }
  console.log("");
  console.log("By domain");
  console.log("---------");
  for (const [domain, counts] of Object.entries(summary.byDomain)) {
    const parts = patterns
      .map((pattern) => `${pattern.id}=${counts[pattern.id] ?? 0}`)
      .join(", ");
    console.log(`${domain.padEnd(18)} ${parts}`);
  }
  console.log("");
  console.log("Top findings");
  console.log("------------");
  for (const item of findings.slice(0, 40)) {
    console.log(`${item.file}:${item.line} [${item.label}] ${item.text}`);
  }
  if (findings.length > 40) {
    console.log(
      `... ${findings.length - 40} more findings. Use --json for full output.`,
    );
  }
  if (checkBudgets) {
    console.log("");
    console.log("Domain budget ratchet");
    console.log("---------------------");
    if (budgetFindings.length === 0) {
      console.log("No domain budget increases found.");
    } else {
      for (const item of budgetFindings) {
        console.log(
          `${item.domain} ${item.label}: ${item.actual} > ${item.max} (+${item.delta})`,
        );
      }
    }
  }
}

function printBudgetFindings() {
  console.log("");
  console.log("Domain budget ratchet");
  console.log("---------------------");
  if (budgetFindings.length === 0) {
    console.log("No domain budget increases found.");
  } else {
    for (const item of budgetFindings) {
      console.log(
        `${item.domain} ${item.label}: ${item.actual} > ${item.max} (+${item.delta})`,
      );
    }
  }
}

let exitCode = 0;
if (ratchet) {
  const ratchetFindings = summary.ratchet.findings;
  if (!json) {
    console.log("Changed-line test quality ratchet");
    console.log("=================================");
    if (ratchetFindings.length === 0) {
      console.log("No newly added blocked weak-test patterns found.");
    } else {
      for (const item of ratchetFindings) {
        console.log(`${item.file}:${item.line} [${item.label}] ${item.text}`);
      }
    }
  }
  if (checkBudgets && !json && !report) printBudgetFindings();
  if (ratchetFindings.length > 0) exitCode = 1;
}

if (checkBudgets && budgetFindings.length > 0) {
  exitCode = 1;
}

if (exitCode !== 0) process.exit(exitCode);
