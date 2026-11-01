#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const activeRoots = [
  "build/scripts/branding/export-client-theme-fallback.mjs",
  "build/scripts/branding/export-theme-catalog.mjs",
  "build/scripts/branding/verify-theme-font-materialization.mjs",
  "docs/ops/config",
  "server/crates/api/src",
  "server/crates/application/src",
  "server/crates/domain/src",
  "server/crates/infrastructure/src",
  "server/crates/worker/src",
  "server/crates/pdf_export/src",
  "server/config",
  "server/static/branding",
  "client/admin/workspaces/admin/src",
  "client/web/workspaces/web/src",
  "client/apps/electron-renderer/src",
  "client/libs/core/src",
  "client/libs/graphql/src/graphql",
];

const skippedDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "__tests__",
]);

const scannedExtensions = new Set([
  ".gql",
  ".graphql",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".rs",
  ".ts",
  ".tsx",
]);

const skippedFilePatterns = [
  /\.d\.ts$/,
  /\.map$/,
  /\.spec\.[cm]?[tj]sx?$/,
  /\.test\.[cm]?[tj]sx?$/,
  /_test\.rs$/,
];

const forbiddenPatterns = [
  {
    id: "retired-app-config-branding-schema",
    re: /\bbranding\.schema\b/,
  },
  {
    id: "retired-app-config-branding-typography",
    re: /(?<!\.)\bbranding\.typography\b(?!\.)/,
  },
  {
    id: "retired-app-config-theme-preset",
    re: /\btheme_preset\b/,
  },
  {
    id: "retired-app-config-theme-mode-yaml",
    re: /^\s*theme_mode\s*:/,
    extensions: new Set([".yaml", ".yml"]),
  },
  {
    id: "retired-app-config-typography-tokens",
    re: /\btypography_tokens\b/,
  },
  {
    id: "retired-workspace-body-font-column",
    re: /\bbody_font_family\b/,
    // PreviewTheme consumes the server-resolved font; this is not the retired
    // persisted column. Keep the exception limited to this initializer.
    allowLines: new Map([
      [
        "server/crates/api/src/preview.rs",
        /^\s*body_font_family: families\[0\]\.clone\(\),$/,
      ],
    ]),
  },
  {
    id: "retired-pdf-brand-heading-font",
    re: /\bbrandHeadingFont\b/,
  },
  {
    id: "retired-pdf-brand-body-font",
    re: /\bbrandBodyFont\b/,
  },
  {
    id: "retired-pdf-brand-mono-font",
    re: /\bbrandMonoFont\b/,
  },
  {
    id: "retired-pdf-brand-heading-font-snake",
    re: /\bbrand_heading_font\b/,
  },
  {
    id: "retired-pdf-brand-body-font-snake",
    re: /\bbrand_body_font\b/,
  },
  {
    id: "retired-pdf-brand-mono-font-snake",
    re: /\bbrand_mono_font\b/,
  },
  {
    id: "retired-pdf-brand-font-mutation",
    re: /\bupdateBrandFonts\b/,
  },
  {
    id: "retired-graphql-body-font-family",
    re: /\bbodyFontFamily\b/,
  },
  {
    id: "retired-graphql-clear-body-font-family",
    re: /\bclearBodyFontFamily\b/,
  },
  {
    id: "retired-app-config-branding-assets",
    re: /\bappConfig\.branding\.assets\b/,
  },
  {
    id: "retired-app-config-branding-logo-url",
    re: /\bbranding\.logoUrl\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-app-config-branding-product-mark-url",
    re: /\bbranding\.productMarkUrl\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-app-config-branding-accent-primary",
    re: /\bbranding\.accentPrimary\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-app-config-branding-accent-secondary",
    re: /\bbranding\.accentSecondary\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-app-config-branding-accent-primary-dark",
    re: /\bbranding\.accentPrimaryDark\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-app-config-branding-accent-secondary-dark",
    re: /\bbranding\.accentSecondaryDark\b/,
    allowFiles: new Set(["server/crates/api/src/graphql/config.rs"]),
  },
  {
    id: "retired-nested-branding-assets-payload",
    re: /\bpayload\?\.branding\?\.assets\b/,
  },
  {
    id: "retired-optional-branding-assets",
    re: /\bbranding\?\.assets\b/,
  },
  {
    id: "client-theme-preset-runtime-import",
    re: /(?:from\s+["'][^"']*(?:client\/libs\/theme\/src\/v2\/themes|@myoxus\/theme[^"']*\/themes|\/v2\/themes)[^"']*["']|import\([^)]*(?:client\/libs\/theme\/src\/v2\/themes|@myoxus\/theme[^"']*\/themes|\/v2\/themes)[^)]*\))/,
  },
];

function shouldSkipFile(path) {
  const name = basename(path);
  if (path.endsWith("server/config/local.yaml")) {
    return true;
  }
  if (skippedFilePatterns.some((pattern) => pattern.test(name))) {
    return true;
  }
  return !scannedExtensions.has(extname(name));
}

function walk(path, files) {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        walk(child, files);
      }
      continue;
    }
    if (entry.isFile() && !shouldSkipFile(child)) {
      files.push(child);
    }
  }
}

function existingRootFiles() {
  const files = [];
  for (const root of activeRoots) {
    const absolute = resolve(repoRoot, root);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(absolute, files);
    } else if (stat.isFile() && !shouldSkipFile(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

const findings = [];
const files = existingRootFiles();

for (const file of files) {
  const relativeFile = relative(repoRoot, file);
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const pattern of forbiddenPatterns) {
      if (pattern.extensions && !pattern.extensions.has(extname(file))) {
        continue;
      }
      if (pattern.allowFiles?.has(relativeFile)) {
        continue;
      }
      if (pattern.allowLines?.get(relativeFile)?.test(line)) {
        continue;
      }
      if (pattern.re.test(line)) {
        findings.push({
          id: pattern.id,
          file: relativeFile,
          line: index + 1,
          text: line.trim(),
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error("theme db cut-over guard failed:");
  for (const finding of findings) {
    console.error(
      `- ${finding.id}: ${finding.file}:${finding.line}: ${finding.text}`,
    );
  }
  process.exit(1);
}

console.log(
  `theme db cut-over guard ok: scanned ${files.length} active source files`,
);
