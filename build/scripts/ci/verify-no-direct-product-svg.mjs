#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const report = args.has("--report") || !check;

const scannedRoots = [
  "client/web",
  "client/libs/core/src",
  "client/libs/ui-facade/src",
  "client/admin/workspaces/admin/src",
];

const sourceExtensions = new Set([
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const ignoredPathFragments = [
  "/__tests__/",
  "/test/",
  "/tests/",
  ".spec.",
  ".test.",
  "client/libs/ui-facade/src/type.d.ts",
];

const technicalExceptionPrefixes = [
  // Generated/owned icon and artwork sources are allowed to contain SVG. Product
  // chrome must consume them through @myoxus/icons/react or Facade primitives.
  "client/libs/icons/",
  "client/branding/",
  "client/libs/core/public/imgs/",
  // Renderer/export/user-content plumbing handles SVG as a document format.
  "client/libs/core/src/components/hooks/myoxus/use-export-page.ts",
  "client/libs/core/src/editor/ai/",
  "client/libs/core/src/modules/workspace-engine/",
  "client/libs/core/src/modules/media/",
  "client/libs/core/src/modules/pdf/",
  "client/libs/core/src/editor/attachment-viewer/",
  // Data visualizations are semantic chart renderers, not product chrome icons.
  "client/admin/workspaces/admin/src/modules/performance/",
];

const artworkCallsitePaths = new Set([
  "client/libs/core/src/components/myoxus/empty/collection-detail.tsx",
  "client/libs/core/src/components/myoxus/empty/collections.tsx",
  "client/libs/core/src/components/myoxus/empty/docs.tsx",
  "client/libs/core/src/components/myoxus/empty/tags.tsx",
  "client/libs/core/src/components/myoxus/myoxus-error-boundary/error-basic/error-detail.tsx",
  "client/libs/core/src/components/myoxus/page-history-modal/empty-history-shape.tsx",
  "client/libs/core/src/components/document-header-menu/history-tips-modal/top-svg.tsx",
  "client/libs/core/src/components/page-list/view/myoxus-shape.tsx",
  "client/libs/core/src/desktop/dialogs/setting/general-setting/about/index.tsx",
  "client/libs/core/src/desktop/dialogs/setting/general-setting/experimental-features/dark-art-svg.ts",
  "client/libs/core/src/desktop/dialogs/setting/general-setting/experimental-features/light-art-svg.ts",
  "client/libs/core/src/desktop/dialogs/setting/general-setting/meetings/welcome-page.tsx",
  "client/libs/core/src/desktop/pages/workspace/detail-page/sidecards/journal/assets.ts",
  "client/libs/ui-facade/src/auth-layout.tsx",
]);

// Only these renderer roots may emit geometry. A new icon in the same file
// remains blocking; importing SVG assets is not admitted by these patterns.
const rendererSvgRoots = new Map([
  [
    "client/libs/core/src/desktop/pages/workspace/diagrams/diagram-preview.tsx",
    /viewBox="0 0 120 82"/,
  ],
  [
    "client/libs/ui-facade/src/data-views/charts/sankey-chart.tsx",
    /viewBox=\{`0 0 \$\{layoutWidth\} \$\{geometry\.height\}`\}/,
  ],
  [
    "client/libs/ui-facade/src/data-views/charts/treemap-chart.tsx",
    /viewBox=\{`0 0 \$\{width\} \$\{height\}`\}/,
  ],
  [
    "client/libs/ui-facade/src/data-views/gantt/gantt-dependencies.tsx",
    /data-myoxus-ui-role="gantt-dependenc(?:ies|y-handles)"/,
  ],
  [
    "client/libs/ui-facade/src/data-views/gantt/gantt-task.tsx",
    /className="myoxus-gantt-range-shape"/,
  ],
  [
    "client/libs/ui-facade/src/data-views/temporal/temporal.tsx",
    /data-myoxus-ui-role="temporal-dependencies"/,
  ],
]);

const chartGeometrySelectors = new Set([
  ".myoxus-data-sankey-chart-surface svg {",
  '.myoxus-data-sankey-chart-surface svg:not([data-use-max-width="true"]) {',
  ".myoxus-data-treemap-chart-surface svg {",
  "svg[data-reparent-target-id]",
  ".myoxus-data-radar-chart-surface svg {",
]);

const loadingArtworkImports = new Set([
  "./assets/page-detail-loading.dark.svg",
  "./assets/page-detail-loading.light.svg",
]);

const blockedChromePrefixes = [
  "client/web/",
  "client/libs/core/src/components/",
  "client/libs/core/src/desktop/",
  "client/libs/core/src/mobile/",
  "client/libs/core/src/modules/app-sidebar/",
  "client/libs/core/src/modules/quicksearch/",
  "client/libs/core/src/modules/share-menu/",
  "client/libs/core/src/modules/workbench/",
  "client/libs/ui-facade/src/",
  "client/admin/workspaces/admin/src/",
];

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isIgnored(relPath) {
  return ignoredPathFragments.some((fragment) => relPath.includes(fragment));
}

function isTechnicalException(relPath) {
  return technicalExceptionPrefixes.some((prefix) =>
    relPath.startsWith(prefix),
  );
}

function isArtworkException(relPath) {
  return artworkCallsitePaths.has(relPath);
}

function isProductChrome(relPath) {
  return blockedChromePrefixes.some((prefix) => relPath.startsWith(prefix));
}

function walk(root, files = []) {
  if (!existsSync(root)) return files;
  const stat = statSync(root);
  if (stat.isFile()) {
    files.push(root);
    return files;
  }
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") {
      continue;
    }
    walk(path.join(root, entry), files);
  }
  return files;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function selectorLineLooksLikeSvgChrome(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("svg")) return false;
  if (/data-myoxus-art|data-myoxus-renderer|user-content/i.test(trimmed)) {
    return false;
  }
  return /(^|[\s>+~.:#\]])svg([.{:#\s>+~,[]|$)/i.test(trimmed);
}

function collectFindings(filePath) {
  const relPath = relativePath(filePath);
  const ext = path.extname(filePath);
  if (!sourceExtensions.has(ext) || isIgnored(relPath)) return [];

  const source = readFileSync(filePath, "utf8");
  const findings = [];

  const directInlineSvg = /<svg(?=[\s>])/g;
  for (const match of source.matchAll(directInlineSvg)) {
    findings.push({
      kind: "inline-svg",
      technicalException:
        rendererSvgRoots
          .get(relPath)
          ?.test(
            source.slice(match.index).match(/^<svg\b[\s\S]*?>/)?.[0] ?? "",
          ) ?? false,
      line: lineNumberAt(source, match.index ?? 0),
      relPath,
    });
  }

  source.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    const importsSvg =
      /^\s*import\s+(?:type\s+)?[^"'\n]+from\s+["'][^"']+\.svg["']/.test(
        line,
      ) || /require\(["'][^"']+\.svg["']\)/.test(line);
    if (importsSvg) {
      findings.push({
        kind: "svg-import",
        technicalException:
          relPath === "client/libs/ui-facade/src/page-detail-loading.tsx" &&
          loadingArtworkImports.has(line.match(/from\s+["']([^"']+)["']/)?.[1]),
        line: lineNumber,
        relPath,
      });
    }

    const importsInlineSvg =
      /^\s*import\s+(?:type\s+)?[^"'\n]+from\s+["'][^"']+\.inline\.svg["']/.test(
        line,
      ) || /["'][^"']+\.inline\.svg["']/.test(line);
    if (importsInlineSvg) {
      findings.push({
        kind: "inline-svg-import",
        line: lineNumber,
        relPath,
      });
    }
  });

  if (ext === ".css") {
    source.split("\n").forEach((line, index) => {
      if (selectorLineLooksLikeSvgChrome(line)) {
        findings.push({
          kind: "css-svg-selector",
          technicalException:
            relPath ===
              "client/libs/ui-facade/src/data-views/charts/charts.css" &&
            chartGeometrySelectors.has(line.trim()),
          line: index + 1,
          relPath,
        });
      }
    });
  }

  return findings.map((finding) => ({
    ...finding,
    blocking:
      isProductChrome(relPath) &&
      !isTechnicalException(relPath) &&
      !isArtworkException(relPath) &&
      !finding.technicalException &&
      !(
        finding.kind === "css-svg-selector" &&
        relPath.includes("page-detail-loading.css")
      ),
  }));
}

const findings = scannedRoots
  .flatMap((root) => walk(path.join(repoRoot, root)))
  .flatMap(collectFindings);
const blocking = findings.filter((finding) => finding.blocking);

if (report || blocking.length > 0) {
  const groups = new Map();
  for (const finding of findings) {
    const key = finding.blocking ? "BLOCKING" : "allowed";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }

  for (const [group, items] of groups) {
    console.log(`\n${group} direct SVG findings (${items.length})`);
    for (const finding of items) {
      console.log(`  ${finding.relPath}:${finding.line} ${finding.kind}`);
    }
  }
}

if (blocking.length > 0) {
  console.error(
    `\n[FAIL] ${blocking.length} direct SVG usage(s) in product icon/control chrome. Use @myoxus/icons/react, @myoxus/ui-facade primitives, or an explicit artwork exception instead.`,
  );
  process.exit(1);
}

console.log("[PASS] no direct SVG usage in product icon/control chrome");
