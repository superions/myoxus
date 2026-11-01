#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";
import prettier from "prettier";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourcePath = resolve(
  repoRoot,
  "server/static/branding/theme-catalog.json",
);
const cssOutPath = resolve(repoRoot, "client/branding/theme-fallback.css");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

if (args.has("--help")) {
  console.log(`Usage: export-client-theme-fallback.mjs [--check]

Generates the full-catalog offline fallback consumed only by Electron. Browser
Web and Admin must use the live server projection. The input is the committed
server seed catalog, not a client-owned preset source.

  yarn branding:theme-fallback
  yarn branding:theme-fallback:check`);
  process.exit(0);
}

function kebab(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function urlFileEscape(value) {
  return String(value)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sanitizeCssIdent(value) {
  const ident = String(value).trim();
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(ident) ? ident : "normal";
}

function formatCssNumber(value) {
  return Number(value)
    .toFixed(4)
    .replace(/\.?0+$/, "");
}

function parseHexColor(value) {
  const hex = String(value).trim().replace(/^#/, "");
  const normalized =
    hex.length === 3 ? [...hex].map((char) => `${char}${char}`).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }
  return [0, 2, 4].map(
    (offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  );
}

function linearChannel(value) {
  return value <= 0.03928
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color) {
  const rgb = parseHexColor(color);
  if (!rgb) {
    return null;
  }
  return (
    0.2126 * linearChannel(rgb[0]) +
    0.7152 * linearChannel(rgb[1]) +
    0.0722 * linearChannel(rgb[2])
  );
}

function contrastRatio(a, b) {
  const aLum = relativeLuminance(a);
  const bLum = relativeLuminance(b);
  if (aLum == null || bLum == null) {
    return 0;
  }
  const lighter = Math.max(aLum, bLum);
  const darker = Math.min(aLum, bLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function adaptiveForeground(background) {
  return contrastRatio(background, "#000000") >=
    contrastRatio(background, "#ffffff")
    ? "#000000"
    : "#ffffff";
}

function pArThemeCssVars(token) {
  switch (token) {
    case "paper":
      return ["--myoxus-sem-surface-page", "--myoxus-background-primary-color"];
    case "paper-deep":
      return [
        "--myoxus-sem-surface-card",
        "--myoxus-sem-surface-elevated",
        "--myoxus-sem-surface-muted",
        "--myoxus-background-secondary-color",
        "--myoxus-background-tertiary-color",
        "--myoxus-background-overlay-panel-color",
        "--myoxus-hover-color",
        "--myoxus-selfhost-sidebar-bg",
      ];
    case "background-code-block":
      return ["--myoxus-background-code-block"];
    case "ink":
      return ["--myoxus-sem-text-primary", "--myoxus-text-primary-color"];
    case "ink-soft":
      return [
        "--myoxus-sem-text-secondary",
        "--myoxus-text-secondary-color",
        "--myoxus-icon-color",
      ];
    case "ink-mute":
      return [
        "--myoxus-sem-text-muted",
        "--myoxus-placeholder-color",
        "--myoxus-text-disable-color",
        "--myoxus-icon-secondary",
      ];
    case "rule":
      return [
        "--myoxus-sem-border-default",
        "--myoxus-border-color",
        "--myoxus-divider-color",
      ];
    case "accent-primary":
      return [
        "--myoxus-accent-primary",
        "--myoxus-sem-button-primary-bg",
        "--myoxus-primary-color",
        "--myoxus-brand-color",
        "--myoxus-text-emphasis-color",
      ];
    case "link-default":
      return ["--myoxus-sem-link-default", "--myoxus-link-color"];
    case "accent-secondary":
      return [
        "--myoxus-accent-secondary",
        "--myoxus-secondary-color",
        "--myoxus-sem-button-secondary-bg",
      ];
    case "status-success-paper":
      return [
        "--myoxus-sem-status-success-paper",
        "--myoxus-background-success-color",
      ];
    case "status-success-deep":
      return [
        "--myoxus-sem-status-success",
        "--myoxus-sem-status-success-deep",
        "--myoxus-success-color",
      ];
    case "status-pending-paper":
      return [
        "--myoxus-sem-status-pending-paper",
        "--myoxus-background-warning-color",
      ];
    case "status-pending-deep":
      return [
        "--myoxus-sem-status-warning",
        "--myoxus-sem-status-pending-deep",
        "--myoxus-warning-color",
      ];
    case "status-error-paper":
      return [
        "--myoxus-sem-status-error-paper",
        "--myoxus-background-error-color",
      ];
    case "status-error-deep":
      return [
        "--myoxus-sem-status-error",
        "--myoxus-sem-status-error-deep",
        "--myoxus-error-color",
      ];
    case "status-info-paper":
      return [
        "--myoxus-sem-status-info-paper",
        "--myoxus-background-processing-color",
      ];
    case "status-info-deep":
      return [
        "--myoxus-sem-status-info",
        "--myoxus-sem-status-info-deep",
        "--myoxus-processing-color",
      ];
    case "status-preset-paper":
      return ["--myoxus-sem-status-preset-paper"];
    case "status-preset-deep":
      return ["--myoxus-sem-status-preset-deep"];
    default:
      return [];
  }
}

function quotedFontFamily(family) {
  return `"${cssEscape(family)}"`;
}

function emitThemeColorTokens(lines, indent, tokens) {
  const primary = tokens["accent-primary"] ?? "#1e96eb";
  const secondary = tokens["accent-secondary"] ?? "#44b931";
  emitDerivedButtonForegrounds(lines, indent, primary, secondary);
  for (const [token, value] of Object.entries(tokens).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!String(value).trim()) {
      continue;
    }
    emitThemeColorToken(lines, indent, token, value);
  }
  if (!Object.hasOwn(tokens, "accent-primary")) {
    emitThemeColorToken(lines, indent, "accent-primary", primary);
  }
  if (!Object.hasOwn(tokens, "accent-secondary")) {
    emitThemeColorToken(lines, indent, "accent-secondary", secondary);
  }
}

function emitThemeColorToken(lines, indent, token, value) {
  // Keep the generated fallback identical to the runtime CSS contract: the
  // dedicated code surface has one canonical, unversioned variable.
  if (token !== "background-code-block") {
    lines.push(`${indent}--myoxus-sem-${kebab(token)}: ${value};`);
  }
  for (const cssVar of pArThemeCssVars(token)) {
    lines.push(`${indent}${cssVar}: ${value};`);
  }
}

function emitDerivedButtonForegrounds(lines, indent, primary, secondary) {
  // Persisted schemas keep P-AR accent tokens only. The offline CSS fallback
  // mirrors the server endpoint and materializes atomic button bg/fg pairs for
  // hover derivation without adding duplicate fields to the data model.
  const primaryFg = adaptiveForeground(primary);
  const secondaryFg = adaptiveForeground(secondary);
  lines.push(`${indent}--myoxus-sem-button-primary-fg: ${primaryFg};`);
  lines.push(`${indent}--myoxus-sem-button-secondary-fg: ${secondaryFg};`);
  lines.push(`${indent}--myoxus-branding-button-primary-fg: ${primaryFg};`);
}

function typographySlotName(styleKey) {
  switch (styleKey) {
    case "page.title":
      return "page-title";
    case "section.title":
      return "section-title";
    case "card.title":
      return "card-title";
    case "modal.title":
      return "modal-title";
    case "heading.h1":
      return "h1";
    case "heading.h2":
      return "h2";
    case "heading.h3":
      return "h3";
    case "heading.h4":
      return "h4";
    case "heading.h5":
      return "h5";
    case "body.default":
      return "body";
    case "body.small":
      return "body-small";
    case "label.compact":
      return "label-compact";
    case "quote.block":
      return "blockquote";
    case "link.default":
      return "link";
    case "code.inline":
      return "mono";
    case "code.block":
      return "code-block";
    default:
      return null;
  }
}

function emitTypographyStyleVars(lines, indent, styles) {
  for (const style of styles) {
    const slot = typographySlotName(style.styleKey);
    if (!slot) {
      continue;
    }
    const family = quotedFontFamily(style.cssFamily ?? style.fontFamily);
    lines.push(`${indent}--myoxus-typography-${slot}-family: ${family};`);
    lines.push(
      `${indent}--myoxus-typography-${slot}-weight: ${style.fontWeight};`,
    );
    lines.push(
      `${indent}--myoxus-typography-${slot}-font-style: ${sanitizeCssIdent(style.fontStyle)};`,
    );
    if (style.sizePx != null) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-size: ${formatCssNumber(style.sizePx)}px;`,
      );
    }
    if (style.lineHeight != null) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-line-height: ${formatCssNumber(style.lineHeight)};`,
      );
    }
    if (style.letterSpacingEm != null) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-letter-spacing: ${formatCssNumber(style.letterSpacingEm)}em;`,
      );
    }
    if (style.decoration) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-decoration: ${sanitizeCssIdent(style.decoration)};`,
      );
    }
    if (style.hoverDecoration) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-hover-decoration: ${sanitizeCssIdent(style.hoverDecoration)};`,
      );
    }
    if (style.textTransform) {
      lines.push(
        `${indent}--myoxus-typography-${slot}-text-transform: ${sanitizeCssIdent(style.textTransform)};`,
      );
    }
    if (slot === "body") {
      lines.push(`${indent}--myoxus-typography-ui-font-family: ${family};`);
      lines.push(`${indent}--myoxus-font-family: ${family};`);
      if (style.sizePx != null) {
        lines.push(
          `${indent}--myoxus-typography-base-size: ${formatCssNumber(style.sizePx)}px;`,
        );
        lines.push(
          `${indent}--myoxus-font-base: ${formatCssNumber(style.sizePx)}px;`,
        );
      }
      if (style.lineHeight != null) {
        lines.push(
          `${indent}--myoxus-typography-base-line-height: ${formatCssNumber(style.lineHeight)};`,
        );
        lines.push(
          `${indent}--myoxus-line-height: ${formatCssNumber(style.lineHeight)};`,
        );
      }
    }
    if (slot === "mono") {
      lines.push(`${indent}--myoxus-typography-mono-font-family: ${family};`);
      lines.push(`${indent}--myoxus-font-code-family: ${family};`);
      lines.push(`${indent}--myoxus-font-family-mono: ${family};`);
    }
  }
}

function emitThemeProjection(lines, indent, theme, mode) {
  const projection = [];
  const tokens = theme.colors[mode] ?? {};
  projection.push(`${indent}--myoxus-theme-slug: "${cssEscape(theme.slug)}";`);
  emitThemeColorTokens(projection, indent, tokens);
  emitTypographyStyleVars(projection, indent, theme.typographyStyles);

  const emitted = new Set();
  for (const line of projection) {
    const property = /^\s*(--myoxus-[a-z0-9_-]+)\s*:/.exec(line)?.[1];
    if (property && emitted.has(property)) {
      continue;
    }
    if (property) {
      emitted.add(property);
    }
    lines.push(line);
  }
}

function buildFallbackCss(sourceCatalog) {
  const defaultTheme = sourceCatalog.themes.find((theme) => theme.isDefault);
  if (!defaultTheme) {
    throw new Error("theme catalog has no default theme");
  }
  const lines = [
    "/*",
    " * Generated by build/scripts/branding/export-client-theme-fallback.mjs.",
    " * Do not edit manually. The server-owned theme catalog is the source.",
    ` * catalogHash: ${sourceCatalog.catalogHash}`,
    " */",
    "",
  ];

  for (const family of sourceCatalog.fontFamilies) {
    for (const asset of family.assets ?? []) {
      if (asset.usage !== "web" || asset.format !== "woff2") {
        continue;
      }
      lines.push("@font-face {");
      lines.push(`  font-family: "${cssEscape(family.cssFamily)}";`);
      lines.push(
        `  src: url("/api/fonts/${urlFileEscape(asset.assetKey)}?v=${cssEscape(asset.sha256.slice(0, 8))}") format("woff2");`,
      );
      lines.push(`  font-weight: ${asset.weightMin} ${asset.weightMax};`);
      lines.push(`  font-style: ${sanitizeCssIdent(asset.style)};`);
      lines.push("  font-display: swap;");
      lines.push("}");
      lines.push("");
    }
  }

  lines.push(":root {");
  emitThemeProjection(lines, "  ", defaultTheme, "light");
  lines.push("}");
  lines.push("");
  lines.push("@media (prefers-color-scheme: dark) {");
  lines.push("  :root {");
  emitThemeProjection(lines, "    ", defaultTheme, "dark");
  lines.push("  }");
  lines.push("}");
  lines.push("");
  lines.push("[data-theme='light'] {");
  emitThemeProjection(lines, "  ", defaultTheme, "light");
  lines.push("}");
  lines.push("");
  lines.push("[data-theme='dark'] {");
  emitThemeProjection(lines, "  ", defaultTheme, "dark");
  lines.push("}");
  lines.push("");

  for (const theme of sourceCatalog.themes) {
    const slug = cssEscape(theme.slug);
    lines.push(`/* Electron offline theme: ${slug} */`);
    lines.push(`:root[data-myoxus-theme="${slug}"] {`);
    emitThemeProjection(lines, "  ", theme, "light");
    lines.push("}");
    lines.push("");
    lines.push("@media (prefers-color-scheme: dark) {");
    lines.push(`  :root[data-myoxus-theme="${slug}"] {`);
    emitThemeProjection(lines, "    ", theme, "dark");
    lines.push("  }");
    lines.push("}");
    lines.push("");
    lines.push(`[data-myoxus-theme="${slug}"][data-theme="light"] {`);
    emitThemeProjection(lines, "  ", theme, "light");
    lines.push("}");
    lines.push("");
    lines.push(`[data-myoxus-theme="${slug}"][data-theme="dark"] {`);
    emitThemeProjection(lines, "  ", theme, "dark");
    lines.push("}");
    lines.push("");
  }

  lines.push(
    readFileSync(
      resolve(repoRoot, "server/static/branding/text-marker.css"),
      "utf8",
    ),
  );
  return lines.join("\n");
}

function assertFullCatalogFallback(css, sourceCatalog) {
  const themes = sourceCatalog.themes ?? [];
  if (themes.length === 0) {
    throw new Error("theme catalog has no themes");
  }
  const slugs = new Set();
  for (const theme of themes) {
    if (!theme.slug || slugs.has(theme.slug)) {
      throw new Error(
        `theme catalog has an invalid or duplicate slug: ${theme.slug}`,
      );
    }
    slugs.add(theme.slug);
    for (const mode of ["light", "dark"]) {
      if (
        !theme.colors?.[mode] ||
        Object.keys(theme.colors[mode]).length === 0
      ) {
        throw new Error(`${theme.slug} has no ${mode} color projection`);
      }
      const selector = `[data-myoxus-theme="${theme.slug}"][data-theme="${mode}"]`;
      if (!css.includes(selector)) {
        throw new Error(`Electron fallback is missing ${selector}`);
      }
    }
  }

  const root = postcss.parse(css);
  root.walkRules((rule) => {
    const declarations = new Set();
    rule.walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--myoxus-")) {
        return;
      }
      if (declarations.has(declaration.prop)) {
        throw new Error(
          `duplicate projection variable ${declaration.prop} in ${rule.selector}`,
        );
      }
      declarations.add(declaration.prop);
    });
  });
}

function checkFile(path, expected) {
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) {
    console.error(`theme fallback drift: ${path} is not generated output`);
    return false;
  }
  return true;
}

const sourceCatalog = JSON.parse(readFileSync(sourcePath, "utf8"));
const css = await prettier.format(buildFallbackCss(sourceCatalog), {
  parser: "css",
});
assertFullCatalogFallback(css, sourceCatalog);

if (checkOnly) {
  const cssOk = checkFile(cssOutPath, css);
  if (!cssOk) {
    console.error("Run `yarn branding:theme-fallback` and commit the result.");
    process.exit(1);
  }
  console.log(
    `Electron theme fallback ok: themes=${sourceCatalog.themes.length}`,
  );
} else {
  mkdirSync(dirname(cssOutPath), { recursive: true });
  writeFileSync(cssOutPath, css);
  console.log(`wrote ${cssOutPath}`);
  console.log(`themes=${sourceCatalog.themes.length}`);
}
