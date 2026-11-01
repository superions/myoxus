#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fontManifestPath = resolve(repoRoot, "server/static/fonts/manifest.json");
const themeSeedPath = resolve(
  repoRoot,
  "server/static/branding/theme-seed.json",
);
const outPath = resolve(repoRoot, "server/static/branding/theme-catalog.json");
const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

if (args.has("--help")) {
  console.log(`Usage: export-theme-catalog.mjs [--check]

Generates server/static/branding/theme-catalog.json from the server-owned theme
seed and bundled font manifest. Use --check in CI to fail when the committed
catalog drifts.

  yarn branding:theme-catalog
  yarn branding:theme-catalog:check`);
  process.exit(0);
}

const fontManifest = JSON.parse(readFileSync(fontManifestPath, "utf8"));
const themeSeed = JSON.parse(readFileSync(themeSeedPath, "utf8"));

const REQUIRED_STYLE_KEYS = [
  "page.title",
  "section.title",
  "card.title",
  "modal.title",
  "body.default",
  "body.small",
  "quote.block",
  "code.inline",
  "code.block",
  "link.default",
  "label.compact",
  "pdf.heading",
  "pdf.body",
  "pdf.mono",
  "pdf.symbol",
];
const REQUIRED_PDF_ROLES = new Set(["heading", "body", "mono", "symbol"]);
const RAW_TO_STYLE_FIELDS = new Map([
  ["family", "fontFamily"],
  ["weight", "fontWeight"],
  ["size", "sizePx"],
  ["lineHeight", "lineHeight"],
  ["letterSpacing", "letterSpacingEm"],
]);

function fail(message) {
  throw new Error(`theme catalog seed invalid: ${message}`);
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashCatalog(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function genericClass(family) {
  const category = family.category || "";
  if (category === "sans-serif") return "sans";
  if (category === "serif") return "serif";
  if (category === "monospace") return "mono";
  if (category === "handwriting") return "handwriting";
  if (category === "display") return "display";
  return family.decorative ? "display" : "sans";
}

function ttfAssets(family) {
  const assets = [];
  const seen = new Set();
  const add = (entry, format) => {
    if (!entry?.file || seen.has(entry.file)) return;
    seen.add(entry.file);
    assets.push({
      usage: "pdf",
      format,
      style:
        entry.style ?? (entry.file.includes("italic") ? "italic" : "normal"),
      weightMin: format === "variable_ttf" ? 100 : (entry.weight ?? 400),
      weightMax: format === "variable_ttf" ? 900 : (entry.weight ?? 400),
      weightDefault: entry.weight ?? 400,
      assetKey: entry.file,
      sha256: entry.sha256,
      mime: "font/ttf",
      unicodeRanges: [],
      subsetTags: [],
    });
  };
  const ttf = family.ttf ?? {};
  for (const entry of ttf.vf?.all ?? []) add(entry, "variable_ttf");
  if (ttf.vf?.file && assets.every((asset) => asset.assetKey !== ttf.vf.file)) {
    add(ttf.vf, "variable_ttf");
  }
  for (const entry of ttf.static ?? []) {
    add(entry, entry.file.endsWith(".otf") ? "otf" : "ttf");
  }
  return assets;
}

function webAssets(family) {
  return (family.woff2_subsets ?? []).map((entry) => ({
    usage: "web",
    format: "woff2",
    style: entry.style ?? "normal",
    weightMin: entry.weight ?? 400,
    weightMax: entry.weight ?? 400,
    weightDefault: entry.weight ?? 400,
    assetKey: entry.file,
    sha256: entry.sha256,
    mime: "font/woff2",
    unicodeRanges: [],
    subsetTags: entry.subset ? [entry.subset] : [],
  }));
}

function fontFamilies() {
  return [...fontManifest.families]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((family) => {
      const assets = [...webAssets(family), ...ttfAssets(family)];
      const hasWeb = assets.some((asset) => asset.usage === "web");
      const hasPdf = assets.some((asset) => asset.usage === "pdf");
      return {
        slug: slugify(family.name),
        displayName: family.name,
        cssFamily: family.name,
        genericClass: genericClass(family),
        source: "bundled",
        licenseSpdx: family.license?.toLowerCase().endsWith("-ofl.txt")
          ? "OFL-1.1"
          : (family.license ?? "OFL-1.1"),
        licenseStatus: "approved",
        isSelectable: hasWeb && hasPdf,
        assets: assets.sort((a, b) =>
          `${a.usage}:${a.assetKey}:${a.weightDefault}`.localeCompare(
            `${b.usage}:${b.assetKey}:${b.weightDefault}`,
          ),
        ),
      };
    });
}

function assertArray(name, value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${name} must be a non-empty array`);
  }
}

function assertUnique(name, values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      fail(`${name} contains duplicate value ${value}`);
    }
    seen.add(value);
  }
}

function assertNonEmptyString(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${name} must be a non-empty string`);
  }
}

function assertFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${name} must be a finite number`);
  }
}

function validateStyle(themeSlug, style, fontFamilyNames) {
  assertNonEmptyString(
    `${themeSlug}.${style.styleKey}.styleKey`,
    style.styleKey,
  );
  for (const rawField of themeSeed.requiredTypographyFields) {
    const field = RAW_TO_STYLE_FIELDS.get(rawField) ?? rawField;
    if (!(field in style)) {
      fail(`${themeSlug}.${style.styleKey} misses typography field ${field}`);
    }
  }
  assertNonEmptyString(
    `${themeSlug}.${style.styleKey}.fontFamily`,
    style.fontFamily,
  );
  if (!fontFamilyNames.has(style.fontFamily)) {
    fail(
      `${themeSlug}.${style.styleKey} references unknown font ${style.fontFamily}`,
    );
  }
  assertFiniteNumber(
    `${themeSlug}.${style.styleKey}.fontWeight`,
    style.fontWeight,
  );
  assertFiniteNumber(`${themeSlug}.${style.styleKey}.sizePx`, style.sizePx);
  assertFiniteNumber(
    `${themeSlug}.${style.styleKey}.lineHeight`,
    style.lineHeight,
  );
  assertFiniteNumber(
    `${themeSlug}.${style.styleKey}.letterSpacingEm`,
    style.letterSpacingEm,
  );
  if (style.fontFeatures == null || typeof style.fontFeatures !== "object") {
    fail(`${themeSlug}.${style.styleKey}.fontFeatures must be an object`);
  }
  if (
    style.fontVariations == null ||
    typeof style.fontVariations !== "object"
  ) {
    fail(`${themeSlug}.${style.styleKey}.fontVariations must be an object`);
  }
  if (style.pdfRole != null && !REQUIRED_PDF_ROLES.has(style.pdfRole)) {
    fail(`${themeSlug}.${style.styleKey}.pdfRole is invalid: ${style.pdfRole}`);
  }
}

function validateSeed(families) {
  if (themeSeed.schemaVersion !== 1) {
    fail(`schemaVersion must be 1, got ${themeSeed.schemaVersion}`);
  }
  assertArray("requiredColorKeys", themeSeed.requiredColorKeys);
  assertArray("requiredTypographyFields", themeSeed.requiredTypographyFields);
  assertArray("themes", themeSeed.themes);
  assertUnique("requiredColorKeys", themeSeed.requiredColorKeys);
  assertUnique("requiredTypographyFields", themeSeed.requiredTypographyFields);

  const fontFamilyNames = new Set(
    families.flatMap((family) => [family.cssFamily, family.displayName]),
  );
  const defaultThemes = themeSeed.themes.filter((theme) => theme.isDefault);
  if (defaultThemes.length !== 1) {
    fail(`expected exactly one default theme, got ${defaultThemes.length}`);
  }
  assertUnique(
    "theme slugs",
    themeSeed.themes.map((theme) => theme.slug),
  );
  assertUnique(
    "theme previewOrder",
    themeSeed.themes.map(
      (theme) => `${theme.previewGroup}:${theme.previewOrder}`,
    ),
  );

  for (const theme of themeSeed.themes) {
    assertNonEmptyString("theme.slug", theme.slug);
    assertNonEmptyString(`${theme.slug}.name`, theme.name);
    assertNonEmptyString(`${theme.slug}.category`, theme.category);
    assertNonEmptyString(`${theme.slug}.previewGroup`, theme.previewGroup);
    assertFiniteNumber(`${theme.slug}.previewOrder`, theme.previewOrder);
    assertNonEmptyString(`${theme.slug}.taglineKey`, theme.taglineKey);
    assertNonEmptyString(`${theme.slug}.descriptionKey`, theme.descriptionKey);
    assertNonEmptyString(
      `${theme.slug}.colorSchemaSlug`,
      theme.colorSchemaSlug,
    );
    assertNonEmptyString(`${theme.slug}.typographySlug`, theme.typographySlug);

    for (const mode of ["light", "dark"]) {
      const colors = theme.colors?.[mode];
      if (!colors || typeof colors !== "object") {
        fail(`${theme.slug}.${mode} colors missing`);
      }
      for (const key of themeSeed.requiredColorKeys) {
        assertNonEmptyString(`${theme.slug}.${mode}.${key}`, colors[key]);
      }
    }

    assertArray(`${theme.slug}.typographyStyles`, theme.typographyStyles);
    const stylesByKey = new Map();
    const pdfRoles = new Set();
    for (const style of theme.typographyStyles) {
      validateStyle(theme.slug, style, fontFamilyNames);
      if (stylesByKey.has(style.styleKey)) {
        fail(`${theme.slug} duplicates typography style ${style.styleKey}`);
      }
      stylesByKey.set(style.styleKey, style);
      if (style.pdfRole) {
        if (pdfRoles.has(style.pdfRole)) {
          fail(`${theme.slug} duplicates pdfRole ${style.pdfRole}`);
        }
        pdfRoles.add(style.pdfRole);
      }
    }
    for (const styleKey of REQUIRED_STYLE_KEYS) {
      if (!stylesByKey.has(styleKey)) {
        fail(`${theme.slug} misses required typography style ${styleKey}`);
      }
    }
    for (const pdfRole of REQUIRED_PDF_ROLES) {
      if (!pdfRoles.has(pdfRole)) {
        fail(`${theme.slug} misses required PDF role ${pdfRole}`);
      }
    }
  }
}

const families = fontFamilies();
validateSeed(families);

const catalogWithoutHash = {
  schemaVersion: themeSeed.schemaVersion,
  generatedFrom: [
    "server/static/branding/theme-seed.json",
    "server/static/fonts/manifest.json",
  ],
  requiredColorKeys: [...themeSeed.requiredColorKeys],
  requiredTypographyFields: [...themeSeed.requiredTypographyFields],
  fontFamilies: families,
  themes: themeSeed.themes,
};

const catalog = {
  catalogHash: hashCatalog(catalogWithoutHash),
  ...catalogWithoutHash,
};

const serializedCatalog = `${JSON.stringify(catalog, null, 2)}\n`;

if (checkOnly) {
  const committedCatalog = readFileSync(outPath, "utf8");
  if (committedCatalog !== serializedCatalog) {
    console.error(
      `theme catalog drift: ${outPath} does not match the generated catalog`,
    );
    console.error("Run `yarn branding:theme-catalog` and commit the result.");
    process.exit(1);
  }
  console.log(
    `theme catalog ok: themes=${catalog.themes.length} fontFamilies=${catalog.fontFamilies.length} hash=${catalog.catalogHash}`,
  );
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, serializedCatalog);
  console.log(`wrote ${outPath}`);
  console.log(
    `themes=${catalog.themes.length} fontFamilies=${catalog.fontFamilies.length} hash=${catalog.catalogHash}`,
  );
}
