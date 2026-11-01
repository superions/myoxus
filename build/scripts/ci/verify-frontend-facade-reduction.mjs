#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const finalCheck = args.has("--final-check") || args.has("--check");
const json = args.has("--json");

const facadeRoot = "client/libs/ui-facade/src";
const scanRoots = [
  "client/libs/ui-facade/src",
  "client/libs/core/src",
  "client/web/workspaces/web/src",
  "client/admin/workspaces/admin/src",
];

const ignoredSegments = new Set([
  ".git",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "test-results",
]);

const sourcePattern = /\.(?:css|ts|tsx|js|jsx|mjs)$/;
const cssPattern = /\.css$/;
const tsxPattern = /\.(?:ts|tsx|js|jsx|mjs)$/;
const selectorPattern = /(^|})\s*([^@{}][^{}]*)\{/g;
const declarationPattern = /[a-z-]+\s*:\s*[^;{}]+;/gi;
const wrapperPattern = /\b(?:FlexWrapper|StackWrapper)\b/g;
const visualFormattingPattern =
  /\b(?:style=\{\{|className=|padding=|gap=|width=|height=|minWidth=|maxWidth=|radius=|shadow=|fz=|fw=|lh=)/g;
const hardPixelPattern = /\b\d+px\b/g;

const targetCssLineBudgets = new Map([
  ["client/libs/ui-facade/src/page-shell.css", 51],
  ["client/libs/ui-facade/src/app-sidebar.css", 6],
  ["client/libs/ui-facade/src/sidebar-callout.css", 4],
  ["client/libs/ui-facade/src/sidebar-footer.css", 4],
  ["client/libs/ui-facade/src/sidebar-section.css", 4],
  ["client/libs/ui-facade/src/sidebar-status.css", 8],
  ["client/libs/ui-facade/src/sidebar-technical.css", 1],
  ["client/libs/ui-facade/src/workbench-sidebar.css", 6],
  ["client/libs/ui-facade/src/property.css", 16],
  ["client/libs/ui-facade/src/surface-list.css", 12],
]);

const targetCssDeclarationBudgets = new Map([
  ["client/libs/ui-facade/src/page-shell.css", 22],
  ["client/libs/ui-facade/src/app-sidebar.css", 3],
  ["client/libs/ui-facade/src/sidebar-callout.css", 2],
  ["client/libs/ui-facade/src/sidebar-footer.css", 2],
  ["client/libs/ui-facade/src/sidebar-section.css", 2],
  ["client/libs/ui-facade/src/sidebar-status.css", 4],
  ["client/libs/ui-facade/src/sidebar-technical.css", 1],
  ["client/libs/ui-facade/src/workbench-sidebar.css", 1],
  ["client/libs/ui-facade/src/property.css", 8],
  ["client/libs/ui-facade/src/surface-list.css", 4],
]);

const targetCssSelectorBudgets = new Map([
  ["client/libs/ui-facade/src/page-shell.css", 7],
  ["client/libs/ui-facade/src/app-sidebar.css", 1],
  ["client/libs/ui-facade/src/sidebar-callout.css", 1],
  ["client/libs/ui-facade/src/sidebar-footer.css", 1],
  ["client/libs/ui-facade/src/sidebar-section.css", 1],
  ["client/libs/ui-facade/src/sidebar-status.css", 1],
  ["client/libs/ui-facade/src/sidebar-technical.css", 1],
  ["client/libs/ui-facade/src/workbench-sidebar.css", 1],
  ["client/libs/ui-facade/src/property.css", 2],
  ["client/libs/ui-facade/src/surface-list.css", 2],
]);

const budgets = {
  facadeCssFiles: 38,
  facadeCssTotalLines: 388,
  facadeCssTotalSelectors: 51,
  facadeCssTotalDeclarations: 183,
  wrapperReferences: 98,
  broadVisualFormattingReferences: 143,
  hardPixelReferences: 6,
};

function isIgnored(absolutePath) {
  return path
    .relative(repoRoot, absolutePath)
    .split(path.sep)
    .some((part) => ignoredSegments.has(part));
}

function walk(relativeRoot) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const visit = (absolutePath) => {
    if (isIgnored(absolutePath)) return;
    const stat = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) {
        visit(path.join(absolutePath, entry));
      }
      return;
    }
    if (stat.isFile() && sourcePattern.test(absolutePath)) {
      files.push(path.relative(repoRoot, absolutePath).replaceAll("\\", "/"));
    }
  };
  visit(absoluteRoot);
  return files.sort();
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function isTestFile(file) {
  return (
    file.includes("/__tests__/") ||
    file.includes("/fixtures/") ||
    /\.spec\.[jt]sx?$/.test(file) ||
    /\.test\.[jt]sx?$/.test(file)
  );
}

function lineCount(source) {
  if (source.length === 0) return 0;
  return source.split("\n").length;
}

function collect() {
  const facadeCss = walk(facadeRoot)
    .filter((file) => cssPattern.test(file))
    .map((file) => {
      const source = read(file);
      return {
        file,
        lines: lineCount(source),
        selectors: countMatches(source, selectorPattern),
        declarations: countMatches(source, declarationPattern),
      };
    });

  const sourceFiles = scanRoots
    .flatMap(walk)
    .filter((file, index, files) => files.indexOf(file) === index)
    .filter((file) => tsxPattern.test(file))
    .filter((file) => !isTestFile(file));

  const sourceRecords = sourceFiles
    .map((file) => {
      const source = read(file);
      return {
        file,
        wrapperReferences: countMatches(source, wrapperPattern),
        broadVisualFormattingReferences: countMatches(
          source,
          visualFormattingPattern,
        ),
        hardPixelReferences: countMatches(source, hardPixelPattern),
      };
    })
    .filter(
      (record) =>
        record.wrapperReferences > 0 ||
        record.broadVisualFormattingReferences > 0 ||
        record.hardPixelReferences > 0,
    );

  const totals = {
    facadeCssFiles: facadeCss.length,
    facadeCssTotalLines: facadeCss.reduce(
      (sum, record) => sum + record.lines,
      0,
    ),
    facadeCssTotalSelectors: facadeCss.reduce(
      (sum, record) => sum + record.selectors,
      0,
    ),
    facadeCssTotalDeclarations: facadeCss.reduce(
      (sum, record) => sum + record.declarations,
      0,
    ),
    wrapperReferences: sourceRecords.reduce(
      (sum, record) => sum + record.wrapperReferences,
      0,
    ),
    broadVisualFormattingReferences: sourceRecords.reduce(
      (sum, record) => sum + record.broadVisualFormattingReferences,
      0,
    ),
    hardPixelReferences: sourceRecords.reduce(
      (sum, record) => sum + record.hardPixelReferences,
      0,
    ),
  };

  const findings = [];
  for (const [metric, max] of Object.entries(budgets)) {
    const actual = totals[metric] ?? 0;
    if (actual > max) {
      findings.push({
        rule: "facade-reduction-budget",
        metric,
        actual,
        max,
        overBy: actual - max,
      });
    }
  }

  for (const record of facadeCss) {
    const maxLines = targetCssLineBudgets.get(record.file);
    if (maxLines !== undefined && record.lines > maxLines) {
      findings.push({
        rule: "target-facade-css-file-budget",
        file: record.file,
        metric: "lines",
        actual: record.lines,
        max: maxLines,
        overBy: record.lines - maxLines,
      });
    }

    const maxDeclarations = targetCssDeclarationBudgets.get(record.file);
    if (
      maxDeclarations !== undefined &&
      record.declarations > maxDeclarations
    ) {
      findings.push({
        rule: "target-facade-css-file-budget",
        file: record.file,
        metric: "declarations",
        actual: record.declarations,
        max: maxDeclarations,
        overBy: record.declarations - maxDeclarations,
      });
    }

    const maxSelectors = targetCssSelectorBudgets.get(record.file);
    if (maxSelectors !== undefined && record.selectors > maxSelectors) {
      findings.push({
        rule: "target-facade-css-file-budget",
        file: record.file,
        metric: "selectors",
        actual: record.selectors,
        max: maxSelectors,
        overBy: record.selectors - maxSelectors,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: finalCheck ? "final-check" : "report",
    budgets,
    targetCssBudgets: {
      lines: Object.fromEntries(targetCssLineBudgets),
      declarations: Object.fromEntries(targetCssDeclarationBudgets),
      selectors: Object.fromEntries(targetCssSelectorBudgets),
    },
    totals,
    findings,
    facadeCss: facadeCss.sort((a, b) => b.lines - a.lines),
    sourceRecords: sourceRecords.sort(
      (a, b) =>
        b.wrapperReferences +
        b.broadVisualFormattingReferences +
        b.hardPixelReferences -
        (a.wrapperReferences +
          a.broadVisualFormattingReferences +
          a.hardPixelReferences),
    ),
  };
}

function printText(report) {
  console.log("frontend facade reduction guard");
  console.log(`mode=${report.mode}`);
  console.log(`findings=${report.findings.length}`);
  console.log("");
  console.log("## totals");
  for (const [key, value] of Object.entries(report.totals)) {
    console.log(`${key}: ${value}`);
  }
  console.log("");
  console.log("## largest facade css files");
  for (const record of report.facadeCss.slice(0, 20)) {
    console.log(
      `${record.file}\tlines=${record.lines}\tselectors=${record.selectors}\tdeclarations=${record.declarations}`,
    );
  }
  console.log("");
  console.log("## top wrapper/formatting sources");
  for (const record of report.sourceRecords.slice(0, 30)) {
    console.log(
      `${record.file}\twrapper=${record.wrapperReferences}\tformatting=${record.broadVisualFormattingReferences}\tpx=${record.hardPixelReferences}`,
    );
  }
  if (report.findings.length > 0) {
    console.log("");
    console.log("## findings");
    for (const finding of report.findings) {
      const target = finding.file ? `${finding.file} ` : "";
      console.log(
        `${finding.rule}\t${target}${finding.metric}: actual=${finding.actual} max=${finding.max} overBy=${finding.overBy}`,
      );
    }
  }
}

const report = collect();

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printText(report);
}

if (finalCheck && report.findings.length > 0) {
  console.error(
    `frontend facade reduction final-check failed: ${report.findings.length} finding(s)`,
  );
  process.exit(1);
}
