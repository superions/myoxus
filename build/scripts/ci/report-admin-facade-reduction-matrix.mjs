#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Compose the canonical frontend debt reports with the Admin route matrix.
 *
 * The existing Facade and CSS/typography scanners remain the metric owners.
 * This script only adds Admin module/route attribution and structural
 * candidates so reduction work can start from one complete generated matrix.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const adminSourceRoot = "client/admin/workspaces/admin/src";
const facadeSourceRoot = "client/libs/ui-facade/src";
const routeMatrixPath =
  "docs/dev/clients/adminfrontend/admin-ui-facade-route-matrix.json";
const facadeReportScript =
  "build/scripts/ci/verify-frontend-facade-reduction.mjs";
const cssReportScript =
  "build/scripts/ci/report-frontend-css-typography-inventory.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const outputArg = args.find((argument) => argument.startsWith("--write="));
const outputPath = outputArg?.slice("--write=".length);

const sourcePattern = /\.(?:js|jsx|mjs|ts|tsx)$/;
const wrapperLikeNamePattern = /(?:Container|Layout|Wrapper)$/;
const classNamePattern = /\bclassName=/g;
const stylePropPattern = /\bstyle=/g;
const directMantineImportPattern = /from\s+["']@mantine\//g;
const rawStructuralTags = [
  "article",
  "aside",
  "div",
  "footer",
  "header",
  "main",
  "nav",
  "section",
];
const rawStructuralFormattingPattern =
  /\b(?:className|style|gap|padding|width|height|minWidth|maxWidth|radius|shadow|fz|fw|lh)=/;

function runJson(script, scriptArgs) {
  return JSON.parse(
    execFileSync(process.execPath, [resolve(repoRoot, script), ...scriptArgs], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

function isTestFile(file) {
  return (
    file.includes("/__tests__/") ||
    file.includes("/fixtures/") ||
    /\.(?:spec|test)\.[jt]sx?$/.test(file)
  );
}

function listSourceFiles(relativeRoot) {
  const files = [];
  const visit = (absolutePath) => {
    const stat = statSync(absolutePath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolutePath)) {
        visit(resolve(absolutePath, entry));
      }
      return;
    }
    const file = relative(repoRoot, absolutePath).replaceAll("\\", "/");
    if (sourcePattern.test(file) && !isTestFile(file)) files.push(file);
  };
  visit(resolve(repoRoot, relativeRoot));
  return files.sort();
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function collectJsxOpeningTags(source, tagName) {
  const matches = [];
  const regexp = new RegExp(`<${tagName}(?=[\\s>])`, "g");
  let match;
  while ((match = regexp.exec(source)) !== null) {
    const startIndex = match.index ?? 0;
    let index = startIndex + tagName.length + 1;
    let braceDepth = 0;
    let quote = null;
    while (index < source.length) {
      const character = source[index];
      if (quote) {
        if (character === quote && source[index - 1] !== "\\") quote = null;
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;
      } else if (character === ">" && braceDepth === 0) {
        break;
      }
      index += 1;
    }
    matches.push(source.slice(startIndex, index + 1));
  }
  return matches;
}

function moduleForFile(file) {
  const moduleMatch = file.match(
    /^client\/admin\/workspaces\/admin\/src\/modules\/([^/]+)\//,
  );
  if (moduleMatch) return moduleMatch[1];
  if (file.includes("/src/modules/")) return "_shared-modules";
  if (file.includes("/src/components/")) return "_shared-components";
  if (file.includes("/src/providers/")) return "_providers";
  return "_shell-runtime";
}

function analyzeStructure(file) {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const jsxComponentNames = [
    ...source.matchAll(/<([A-Z][A-Za-z0-9.]*)\b/g),
  ].map((match) => match[1]);
  const wrapperLikeNames = jsxComponentNames.filter((name) =>
    wrapperLikeNamePattern.test(name),
  );
  const rawStructuralElements = rawStructuralTags.reduce(
    (sum, tagName) => sum + collectJsxOpeningTags(source, tagName).length,
    0,
  );
  const formattedRawStructuralElements = rawStructuralTags.reduce(
    (sum, tagName) =>
      sum +
      collectJsxOpeningTags(source, tagName).filter((openingTag) =>
        rawStructuralFormattingPattern.test(openingTag),
      ).length,
    0,
  );

  return {
    file,
    module: moduleForFile(file),
    classNameReferences: countMatches(source, classNamePattern),
    stylePropReferences: countMatches(source, stylePropPattern),
    rawStructuralElements,
    formattedRawStructuralElements,
    wrapperLikeElementReferences: wrapperLikeNames.length,
    wrapperLikeNames: [...new Set(wrapperLikeNames)].sort(),
    directMantineImports: countMatches(source, directMantineImportPattern),
  };
}

function sum(records, key) {
  return records.reduce((total, record) => total + (record[key] ?? 0), 0);
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) => `| ${row.map((value) => escapeCell(value)).join(" | ")} |`,
    ),
  ].join("\n");
}

function collect() {
  const facadeReport = runJson(facadeReportScript, ["--report", "--json"]);
  const cssReport = runJson(cssReportScript, ["--mode=both", "--json"]);
  const routeMatrix = JSON.parse(
    readFileSync(resolve(repoRoot, routeMatrixPath), "utf8"),
  );
  const sourceFiles = listSourceFiles(adminSourceRoot);
  const structureByFile = new Map(
    sourceFiles.map((file) => {
      const record = analyzeStructure(file);
      return [file, record];
    }),
  );
  const facadeDebtByFile = new Map(
    facadeReport.sourceRecords
      .filter((record) => record.file.startsWith(`${adminSourceRoot}/`))
      .map((record) => [record.file, record]),
  );
  const typographyByFile = new Map(
    cssReport.records
      .filter((record) => record.file.startsWith(`${adminSourceRoot}/`))
      .map((record) => [record.file, record.counters]),
  );

  const sourceRecords = sourceFiles.map((file) => ({
    ...structureByFile.get(file),
    ...(facadeDebtByFile.get(file) ?? {
      wrapperReferences: 0,
      broadVisualFormattingReferences: 0,
      hardPixelReferences: 0,
    }),
    inlineStyleBlocks: typographyByFile.get(file)?.inlineStyleBlocks ?? 0,
    inlineTypographyProps:
      typographyByFile.get(file)?.inlineTypographyProps ?? 0,
    rawMantineTypographyProps:
      typographyByFile.get(file)?.rawMantineTypographyProps ?? 0,
  }));

  const debtRecords = sourceRecords
    .filter(
      (record) =>
        record.wrapperReferences > 0 ||
        record.broadVisualFormattingReferences > 0 ||
        record.hardPixelReferences > 0 ||
        record.classNameReferences > 0 ||
        record.stylePropReferences > 0 ||
        record.inlineTypographyProps > 0 ||
        record.directMantineImports > 0 ||
        record.formattedRawStructuralElements > 0 ||
        record.wrapperLikeElementReferences > 0,
    )
    .sort(
      (left, right) =>
        right.wrapperReferences +
          right.broadVisualFormattingReferences +
          right.hardPixelReferences -
          (left.wrapperReferences +
            left.broadVisualFormattingReferences +
            left.hardPixelReferences) || left.file.localeCompare(right.file),
    );

  const routeByModule = new Map(
    routeMatrix.routes.map((route) => [route.module, route]),
  );
  const moduleNames = new Set(sourceRecords.map((record) => record.module));
  const modules = [...moduleNames]
    .map((module) => {
      const records = sourceRecords.filter(
        (record) => record.module === module,
      );
      const debt = debtRecords.filter((record) => record.module === module);
      const route = routeByModule.get(module);
      return {
        module,
        routeId: route?.id ?? "",
        routePath: route?.path ?? "",
        sourceFiles: records.length,
        debtFiles: debt.length,
        wrapperReferences: sum(records, "wrapperReferences"),
        broadVisualFormattingReferences: sum(
          records,
          "broadVisualFormattingReferences",
        ),
        hardPixelReferences: sum(records, "hardPixelReferences"),
        classNameReferences: sum(records, "classNameReferences"),
        stylePropReferences: sum(records, "stylePropReferences"),
        inlineTypographyProps: sum(records, "inlineTypographyProps"),
        formattedRawStructuralElements: sum(
          records,
          "formattedRawStructuralElements",
        ),
        wrapperLikeElementReferences: sum(
          records,
          "wrapperLikeElementReferences",
        ),
      };
    })
    .sort(
      (left, right) =>
        right.wrapperReferences +
          right.broadVisualFormattingReferences +
          right.hardPixelReferences -
          (left.wrapperReferences +
            left.broadVisualFormattingReferences +
            left.hardPixelReferences) ||
        left.module.localeCompare(right.module),
    );

  const adminLocalCss = cssReport.records.filter(
    (record) => record.owner === "admin" && (record.counters.cssFiles ?? 0) > 0,
  );
  const adminAppCss = cssReport.records.find(
    (record) => record.file === `${facadeSourceRoot}/admin-app.css`,
  );
  const cssCountersByFile = new Map(
    cssReport.records.map((record) => [record.file, record.counters]),
  );
  const facadeCss = facadeReport.facadeCss.map((record) => ({
    ...record,
    counters: cssCountersByFile.get(record.file) ?? {},
  }));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const productWorktreeDirty =
    execFileSync(
      "git",
      ["status", "--porcelain", "--", adminSourceRoot, facadeSourceRoot],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    ).trim().length > 0;

  return {
    generatedAt: new Date().toISOString(),
    sourceCommit,
    productWorktreeDirty,
    canonicalReports: [facadeReportScript, cssReportScript],
    routeMatrix: routeMatrixPath,
    summary: {
      adminSourceFiles: sourceRecords.length,
      adminDebtFiles: debtRecords.length,
      wrapperReferences: sum(sourceRecords, "wrapperReferences"),
      broadVisualFormattingReferences: sum(
        sourceRecords,
        "broadVisualFormattingReferences",
      ),
      hardPixelReferences: sum(sourceRecords, "hardPixelReferences"),
      classNameReferences: sum(sourceRecords, "classNameReferences"),
      stylePropReferences: sum(sourceRecords, "stylePropReferences"),
      formattedRawStructuralElements: sum(
        sourceRecords,
        "formattedRawStructuralElements",
      ),
      wrapperLikeElementReferences: sum(
        sourceRecords,
        "wrapperLikeElementReferences",
      ),
      inlineStyleBlocks: sum(sourceRecords, "inlineStyleBlocks"),
      inlineTypographyProps: sum(sourceRecords, "inlineTypographyProps"),
      rawMantineTypographyProps: sum(
        sourceRecords,
        "rawMantineTypographyProps",
      ),
      directMantineImports: sum(sourceRecords, "directMantineImports"),
      adminLocalCssFiles: adminLocalCss.length,
      adminAppCssLines:
        facadeCss.find((record) => record.file.endsWith("/admin-app.css"))
          ?.lines ?? 0,
      adminAppCssSelectors: adminAppCss?.counters.selectors ?? 0,
      adminAppCssDeclarations: adminAppCss?.counters.declarations ?? 0,
      sharedFacadeCssFiles: facadeCss.length,
      sharedFacadeCssLines: sum(facadeCss, "lines"),
      sharedFacadeCssSelectors: sum(facadeCss, "selectors"),
      sharedFacadeCssDeclarations: sum(facadeCss, "declarations"),
    },
    modules,
    sourceRecords: debtRecords,
    adminLocalCss,
    adminAppCss,
    facadeCss,
  };
}

function renderMarkdown(report) {
  const summaryRows = Object.entries(report.summary).map(([metric, value]) => [
    metric,
    value,
  ]);
  const moduleRows = report.modules.map((record) => [
    record.module,
    record.routePath || "shared/runtime",
    record.sourceFiles,
    record.debtFiles,
    record.wrapperReferences,
    record.broadVisualFormattingReferences,
    record.hardPixelReferences,
    record.stylePropReferences,
    record.inlineTypographyProps,
    record.formattedRawStructuralElements,
    record.wrapperLikeElementReferences,
  ]);
  const sourceRows = report.sourceRecords.map((record) => [
    record.file,
    record.module,
    record.wrapperReferences,
    record.broadVisualFormattingReferences,
    record.hardPixelReferences,
    record.classNameReferences,
    record.stylePropReferences,
    record.inlineStyleBlocks,
    record.inlineTypographyProps,
    record.formattedRawStructuralElements,
    record.wrapperLikeElementReferences,
    record.wrapperLikeNames.join(", "),
  ]);
  const cssRows = report.facadeCss.map((record) => [
    record.file,
    record.file.endsWith("/admin-app.css") ? "Admin shell" : "shared Facade",
    record.lines,
    record.selectors,
    record.declarations,
    record.counters.spacingDeclarations ?? 0,
    record.counters.typographyDeclarations ?? 0,
    record.counters.colorDeclarations ?? 0,
    record.counters.rawColorLiterals ?? 0,
  ]);

  return `<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors -->

# Adminfrontend Facade Reduction Baseline

Generated from source commit \`${report.sourceCommit}\`${
    report.productWorktreeDirty ? " with uncommitted product changes" : ""
  }.

This is a generated source inventory, not a visual acceptance report. The
canonical metric owners are:

- \`${report.canonicalReports[0]}\`
- \`${report.canonicalReports[1]}\`
- route attribution: \`${report.routeMatrix}\`

Counts identify review candidates. Wrapper-like component names and formatted
raw structural elements are not automatically defects; each route tranche must
delete native Mantine/Facade-replaceable chrome and document the remaining
technical or preview exceptions.

## Summary

<!-- prettier-ignore -->
${table(["Metric", "Current"], summaryRows)}

## Route And Module Matrix

<!-- prettier-ignore -->
${table(
  [
    "Module",
    "Route",
    "Source files",
    "Debt files",
    "Wrapper",
    "Formatting",
    "px",
    "style",
    "Typography",
    "Formatted raw structure",
    "Wrapper-like",
  ],
  moduleRows,
)}

## Complete Source Candidate Inventory

<!-- prettier-ignore -->
${table(
  [
    "File",
    "Module",
    "Wrapper",
    "Formatting",
    "px",
    "className",
    "style",
    "Inline style blocks",
    "Typography",
    "Formatted raw structure",
    "Wrapper-like",
    "Wrapper-like names",
  ],
  sourceRows,
)}

## CSS Ownership Inventory

Admin product source currently contains ${report.adminLocalCss.length} local
CSS file(s). \`admin-app.css\` is listed with all shared Facade styles so CSS
reduction is not confused with moving route CSS into another shared file.

<!-- prettier-ignore -->
${table(
  [
    "File",
    "Owner",
    "Lines",
    "Selectors",
    "Declarations",
    "Spacing",
    "Typography",
    "Color",
    "Raw color",
  ],
  cssRows,
)}
`;
}

const report = collect();

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const markdown = renderMarkdown(report);
  if (outputPath) {
    const absoluteOutput = resolve(repoRoot, outputPath);
    if (
      !absoluteOutput.startsWith(`${repoRoot}/`) ||
      outputPath.startsWith("../")
    ) {
      throw new Error(
        `output path must stay inside the repository: ${outputPath}`,
      );
    }
    mkdirSync(dirname(absoluteOutput), { recursive: true });
    writeFileSync(absoluteOutput, markdown);
    console.log(`admin facade reduction matrix written: ${outputPath}`);
  } else {
    process.stdout.write(markdown);
  }
}
