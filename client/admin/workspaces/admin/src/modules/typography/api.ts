// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

/**
 * Typography projection helpers for the server-owned theme model.
 *
 * The Admin UI no longer reads or writes the legacy AppConfig typography slot.
 * These helpers adapt `ThemeDefinition.typographyStyles` and the DB-owned
 * `ThemeFontFamily[]` catalog into the legacy component token shape while the
 * visual editor is moved to typed DB mutations.
 */
import type { TypographyStylePatchInput } from "../theme/theme-api";
import type {
  ThemeDefinition,
  ThemeFontFamily,
  ThemeTypographyStyle,
} from "../theme/theme-contract";

export type HierarchyTokenKey = "h1" | "h2" | "h3" | "h4" | "h5";
export type BodyTokenKey = "body" | "bodySmall" | "blockquote";
export type InlineTokenKey = "link" | "mono";
export type TypographyTokenKey =
  HierarchyTokenKey | BodyTokenKey | InlineTokenKey;

export interface TypographyFontRef {
  /** Preserve theme properties without controls when projecting editable previews. */
  sourceStyle?: ThemeTypographyStyle;
  family: string;
  cssFamily?: string;
}

export interface TypographyFontFamilyEntry extends TypographyFontRef {
  slug: string;
  name: string;
  category: string;
  weights: number[];
}

export interface HierarchyToken extends TypographyFontRef {
  weight: number;
  size: number;
  lineHeight: number;
  letterSpacing: number;
}

export interface BodyToken extends TypographyFontRef {
  weight: number;
  size: number;
  lineHeight: number;
  letterSpacing: number;
}

export interface BlockquoteToken extends TypographyFontRef {
  weight: number;
  size: number;
  lineHeight: number;
  fontStyle: "normal" | "italic";
}

export interface LinkToken extends TypographyFontRef {
  weight: number;
  decoration: "none" | "underline";
  hoverDecoration: "none" | "underline";
}

export interface MonoToken extends TypographyFontRef {
  weight: number;
  size: number;
}

export interface TypographyTokens {
  h1: HierarchyToken;
  h2: HierarchyToken;
  h3: HierarchyToken;
  h4: HierarchyToken;
  h5: HierarchyToken;
  body: BodyToken;
  bodySmall: BodyToken;
  blockquote: BlockquoteToken;
  link: LinkToken;
  mono: MonoToken;
}

export const WEIGHT_LABELS: Record<number, string> = {
  200: "Thin",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

export const ORDERED_WEIGHTS: number[] = Object.keys(WEIGHT_LABELS)
  .map((w) => Number(w))
  .sort((a, b) => a - b);

type GenericFontClass = "sans-serif" | "serif" | "monospace";

const CSS_GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
]);

function normalizeGenericClass(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sans") return "sans-serif";
  if (normalized === "mono") return "monospace";
  return normalized ?? "";
}

function catalogDisplayName(family: ThemeFontFamily): string {
  return family.displayName.trim() || family.slug;
}

export function typographyFontFamilyCss(
  ref: TypographyFontRef | null | undefined,
  fallbackGeneric: string = "sans-serif",
): string {
  const cssFamily = ref?.cssFamily?.trim();
  if (cssFamily) return cssFamily;

  const generic = normalizeGenericClass(fallbackGeneric) || "sans-serif";
  const family = ref?.family?.trim();
  if (!family) return generic;
  if (family.includes(",") || CSS_GENERIC_FAMILIES.has(family.toLowerCase())) {
    return family;
  }
  return `${JSON.stringify(family)}, ${generic}`;
}

function weightsFromAssets(family: ThemeFontFamily): number[] {
  const webAssets = family.assets.filter((asset) => asset.usage === "web");
  const assets = webAssets.length > 0 ? webAssets : family.assets;
  const weights = new Set<number>();

  for (const asset of assets) {
    for (const weight of ORDERED_WEIGHTS) {
      if (weight >= asset.weightMin && weight <= asset.weightMax) {
        weights.add(weight);
      }
    }
    if (ORDERED_WEIGHTS.includes(asset.weightDefault)) {
      weights.add(asset.weightDefault);
    }
  }

  return ORDERED_WEIGHTS.filter((weight) => weights.has(weight));
}

export function typographyFontEntriesFromCatalog(
  fontFamilies: readonly ThemeFontFamily[],
): TypographyFontFamilyEntry[] {
  return fontFamilies
    .filter((family) => family.isSelectable)
    .map((family) => {
      const name = catalogDisplayName(family);
      const category =
        normalizeGenericClass(family.genericClass) || "sans-serif";
      return {
        slug: family.slug,
        name,
        family: name,
        cssFamily: typographyFontFamilyCss(
          {
            family: name,
            cssFamily: family.cssFamily,
          },
          category,
        ),
        category,
        weights: weightsFromAssets(family),
      };
    });
}

export function findTypographyFontEntry(
  entries: readonly TypographyFontFamilyEntry[],
  value: string,
): TypographyFontFamilyEntry | null {
  const key = value.trim();
  if (!key) return null;
  return (
    entries.find(
      (entry) =>
        entry.name === key || entry.slug === key || entry.cssFamily === key,
    ) ?? null
  );
}

export function typographyFontRefFromCatalog(
  fontFamilies: readonly ThemeFontFamily[],
  value: string,
  fallbackGeneric: string = "sans-serif",
): TypographyFontRef {
  const entry = findTypographyFontEntry(
    typographyFontEntriesFromCatalog(fontFamilies),
    value,
  );
  return entry
    ? { family: entry.name, cssFamily: entry.cssFamily }
    : {
        family: value,
        cssFamily: typographyFontFamilyCss({ family: value }, fallbackGeneric),
      };
}

function selectableCatalogFonts(fontFamilies: readonly ThemeFontFamily[]) {
  const selectable = fontFamilies.filter((family) => family.isSelectable);
  return selectable.length > 0 ? selectable : fontFamilies;
}

function defaultFontRef(
  fontFamilies: readonly ThemeFontFamily[],
  genericClass: GenericFontClass,
): TypographyFontRef {
  const candidates = selectableCatalogFonts(fontFamilies);
  const family =
    candidates.find(
      (candidate) =>
        normalizeGenericClass(candidate.genericClass) === genericClass,
    ) ??
    candidates[0] ??
    null;

  if (!family) {
    return { family: genericClass, cssFamily: genericClass };
  }

  const name = catalogDisplayName(family);
  return {
    family: name,
    cssFamily: typographyFontFamilyCss(
      { family: name, cssFamily: family.cssFamily },
      genericClass,
    ),
  };
}

function catalogFontForStyle(
  fontFamilies: readonly ThemeFontFamily[],
  style: ThemeTypographyStyle | null,
): ThemeFontFamily | null {
  if (!style) return null;
  const slug = style.fontFamilySlug?.trim();
  if (slug) {
    const bySlug = fontFamilies.find((family) => family.slug === slug);
    if (bySlug) return bySlug;
  }

  const familyName = style.fontFamily?.trim();
  if (!familyName) return null;
  return (
    fontFamilies.find(
      (family) =>
        family.displayName === familyName || family.cssFamily === familyName,
    ) ?? null
  );
}

function styleFontRef(
  style: ThemeTypographyStyle | null,
  fallback: TypographyFontRef,
  fontFamilies: readonly ThemeFontFamily[],
): TypographyFontRef {
  if (!style) return fallback;

  const catalogFamily = catalogFontForStyle(fontFamilies, style);
  const family =
    style.fontFamily?.trim() ||
    (catalogFamily ? catalogDisplayName(catalogFamily) : "") ||
    fallback.family;
  const cssFamily =
    style.cssFamily?.trim() ||
    catalogFamily?.cssFamily?.trim() ||
    fallback.cssFamily ||
    typographyFontFamilyCss({ family });

  return { family, cssFamily, sourceStyle: style };
}

const HEADING_DEFAULT = (
  size: number,
  font: TypographyFontRef,
  weight = 600,
): HierarchyToken => ({
  ...font,
  weight,
  size,
  lineHeight: 1.2,
  letterSpacing: -0.01,
});

export function createDefaultTypographyTokens(
  fontFamilies: readonly ThemeFontFamily[] = [],
): TypographyTokens {
  const sans = defaultFontRef(fontFamilies, "sans-serif");
  const serif = defaultFontRef(fontFamilies, "serif");
  const mono = defaultFontRef(fontFamilies, "monospace");

  return {
    h1: HEADING_DEFAULT(34, sans, 700),
    h2: HEADING_DEFAULT(28, sans, 700),
    h3: HEADING_DEFAULT(22, sans, 600),
    h4: HEADING_DEFAULT(18, sans, 600),
    h5: HEADING_DEFAULT(15, sans, 600),
    body: {
      ...sans,
      weight: 400,
      size: 15,
      lineHeight: 1.5,
      letterSpacing: 0,
    },
    bodySmall: {
      ...sans,
      weight: 400,
      size: 13,
      lineHeight: 1.45,
      letterSpacing: 0,
    },
    blockquote: {
      ...serif,
      weight: 400,
      size: 16,
      lineHeight: 1.5,
      fontStyle: "italic",
    },
    link: {
      ...sans,
      weight: 500,
      decoration: "none",
      hoverDecoration: "underline",
    },
    mono: {
      ...mono,
      weight: 400,
      size: 13,
    },
  };
}

export const DEFAULT_TYPOGRAPHY_TOKENS: TypographyTokens =
  createDefaultTypographyTokens();

const STYLE_KEYS: Record<TypographyTokenKey, readonly string[]> = {
  h1: ["heading.h1", "page.title", "pdf.heading"],
  h2: ["heading.h2", "section.title", "pdf.heading"],
  h3: ["heading.h3", "card.title", "section.title"],
  h4: ["heading.h4", "card.title"],
  h5: ["heading.h5", "label.compact"],
  body: ["body.default", "pdf.body"],
  bodySmall: ["body.small", "label.compact"],
  blockquote: ["quote.block"],
  link: ["link.default"],
  mono: ["code.inline", "code.block", "pdf.mono"],
};

function findStyle(
  theme: ThemeDefinition | null | undefined,
  key: TypographyTokenKey,
): ThemeTypographyStyle | null {
  if (!theme) return null;
  const candidates = STYLE_KEYS[key];
  const styles = theme.typographyStyles ?? [];
  return (
    candidates
      .map((styleKey) => styles.find((style) => style.styleKey === styleKey))
      .find(Boolean) ?? null
  );
}

function numberOr(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function commonStyle<T extends HierarchyToken | BodyToken>(
  style: ThemeTypographyStyle | null,
  fallback: T,
  fontFamilies: readonly ThemeFontFamily[],
): T {
  if (!style) return fallback;
  const font = styleFontRef(style, fallback, fontFamilies);
  return {
    ...font,
    weight: numberOr(style.fontWeight, fallback.weight),
    size: numberOr(style.sizePx, fallback.size),
    lineHeight: numberOr(style.lineHeight, fallback.lineHeight),
    letterSpacing: numberOr(style.letterSpacingEm, fallback.letterSpacing),
  } as T;
}

export function readTypographyTokensFromTheme(
  theme: ThemeDefinition | null | undefined,
  fontFamilies: readonly ThemeFontFamily[] = [],
): TypographyTokens {
  const defaults = createDefaultTypographyTokens(fontFamilies);
  const blockquoteStyle = findStyle(theme, "blockquote");
  const linkStyle = findStyle(theme, "link");
  const monoStyle = findStyle(theme, "mono");

  return {
    h1: commonStyle(findStyle(theme, "h1"), defaults.h1, fontFamilies),
    h2: commonStyle(findStyle(theme, "h2"), defaults.h2, fontFamilies),
    h3: commonStyle(findStyle(theme, "h3"), defaults.h3, fontFamilies),
    h4: commonStyle(findStyle(theme, "h4"), defaults.h4, fontFamilies),
    h5: commonStyle(findStyle(theme, "h5"), defaults.h5, fontFamilies),
    body: commonStyle(findStyle(theme, "body"), defaults.body, fontFamilies),
    bodySmall: commonStyle(
      findStyle(theme, "bodySmall"),
      defaults.bodySmall,
      fontFamilies,
    ),
    blockquote: {
      ...styleFontRef(blockquoteStyle, defaults.blockquote, fontFamilies),
      weight: numberOr(blockquoteStyle?.fontWeight, defaults.blockquote.weight),
      size: numberOr(blockquoteStyle?.sizePx, defaults.blockquote.size),
      lineHeight: numberOr(
        blockquoteStyle?.lineHeight,
        defaults.blockquote.lineHeight,
      ),
      fontStyle: blockquoteStyle?.fontStyle === "italic" ? "italic" : "normal",
    },
    link: {
      ...styleFontRef(linkStyle, defaults.link, fontFamilies),
      weight: numberOr(linkStyle?.fontWeight, defaults.link.weight),
      decoration: linkStyle?.decoration === "underline" ? "underline" : "none",
      hoverDecoration:
        linkStyle?.hoverDecoration === "none" ? "none" : "underline",
    },
    mono: {
      ...styleFontRef(monoStyle, defaults.mono, fontFamilies),
      weight: numberOr(monoStyle?.fontWeight, defaults.mono.weight),
      size: numberOr(monoStyle?.sizePx, defaults.mono.size),
    },
  };
}

export const HIERARCHY_TOKEN_KEYS: HierarchyTokenKey[] = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
];
export const BODY_TOKEN_KEYS: BodyTokenKey[] = [
  "body",
  "bodySmall",
  "blockquote",
];
export const INLINE_TOKEN_KEYS: InlineTokenKey[] = ["link", "mono"];
const EDITABLE_TOKEN_KEYS: TypographyTokenKey[] = [
  ...HIERARCHY_TOKEN_KEYS,
  ...BODY_TOKEN_KEYS,
  ...INLINE_TOKEN_KEYS,
];

function fontRefEqual(a: TypographyFontRef, b: TypographyFontRef): boolean {
  return a.family === b.family && (a.cssFamily ?? "") === (b.cssFamily ?? "");
}

function hierarchyTokenEqual(a: HierarchyToken, b: HierarchyToken): boolean {
  return (
    fontRefEqual(a, b) &&
    a.weight === b.weight &&
    a.size === b.size &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing
  );
}

function bodyTokenEqual(a: BodyToken, b: BodyToken): boolean {
  return hierarchyTokenEqual(a, b);
}

function blockquoteTokenEqual(a: BlockquoteToken, b: BlockquoteToken): boolean {
  return (
    fontRefEqual(a, b) &&
    a.weight === b.weight &&
    a.size === b.size &&
    a.lineHeight === b.lineHeight &&
    a.fontStyle === b.fontStyle
  );
}

function linkTokenEqual(a: LinkToken, b: LinkToken): boolean {
  return (
    fontRefEqual(a, b) &&
    a.weight === b.weight &&
    a.decoration === b.decoration &&
    a.hoverDecoration === b.hoverDecoration
  );
}

function monoTokenEqual(a: MonoToken, b: MonoToken): boolean {
  return fontRefEqual(a, b) && a.weight === b.weight && a.size === b.size;
}

export function typographyTokensEqual(
  a: TypographyTokens,
  b: TypographyTokens,
): boolean {
  return (
    hierarchyTokenEqual(a.h1, b.h1) &&
    hierarchyTokenEqual(a.h2, b.h2) &&
    hierarchyTokenEqual(a.h3, b.h3) &&
    hierarchyTokenEqual(a.h4, b.h4) &&
    hierarchyTokenEqual(a.h5, b.h5) &&
    bodyTokenEqual(a.body, b.body) &&
    bodyTokenEqual(a.bodySmall, b.bodySmall) &&
    blockquoteTokenEqual(a.blockquote, b.blockquote) &&
    linkTokenEqual(a.link, b.link) &&
    monoTokenEqual(a.mono, b.mono)
  );
}

/**
 * Keeps unsaved token-editor changes alive when another typography surface
 * saves a fresher Theme DB baseline.
 */
export function rebaseTypographyDraftTokens(
  baseline: TypographyTokens,
  draft: TypographyTokens,
  nextBaseline: TypographyTokens,
): TypographyTokens {
  return {
    h1: tokenEqual("h1", baseline, draft) ? nextBaseline.h1 : draft.h1,
    h2: tokenEqual("h2", baseline, draft) ? nextBaseline.h2 : draft.h2,
    h3: tokenEqual("h3", baseline, draft) ? nextBaseline.h3 : draft.h3,
    h4: tokenEqual("h4", baseline, draft) ? nextBaseline.h4 : draft.h4,
    h5: tokenEqual("h5", baseline, draft) ? nextBaseline.h5 : draft.h5,
    body: tokenEqual("body", baseline, draft) ? nextBaseline.body : draft.body,
    bodySmall: tokenEqual("bodySmall", baseline, draft)
      ? nextBaseline.bodySmall
      : draft.bodySmall,
    blockquote: tokenEqual("blockquote", baseline, draft)
      ? nextBaseline.blockquote
      : draft.blockquote,
    link: tokenEqual("link", baseline, draft) ? nextBaseline.link : draft.link,
    mono: tokenEqual("mono", baseline, draft) ? nextBaseline.mono : draft.mono,
  };
}

function tokenEqual(
  key: TypographyTokenKey,
  a: TypographyTokens,
  b: TypographyTokens,
): boolean {
  switch (key) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
      return hierarchyTokenEqual(a[key], b[key]);
    case "body":
    case "bodySmall":
      return bodyTokenEqual(a[key], b[key]);
    case "blockquote":
      return blockquoteTokenEqual(a.blockquote, b.blockquote);
    case "link":
      return linkTokenEqual(a.link, b.link);
    case "mono":
      return monoTokenEqual(a.mono, b.mono);
  }
}

function patchFontSlug(
  fontFamilies: readonly ThemeFontFamily[],
  token: TypographyFontRef,
): string {
  const entry = findTypographyFontEntry(
    typographyFontEntriesFromCatalog(fontFamilies),
    token.family,
  );
  if (!entry) {
    throw new Error(
      `Typography font family is not selectable: ${token.family}`,
    );
  }
  return entry.slug;
}

function commonStylePatch(
  style: ThemeTypographyStyle,
  token: TypographyFontRef & { weight: number; fontStyle?: string },
  fontFamilies: readonly ThemeFontFamily[],
): TypographyStylePatchInput {
  return {
    styleKey: style.styleKey,
    fontFamilySlug: patchFontSlug(fontFamilies, token),
    fontWeight: token.weight,
    fontStyle: token.fontStyle ?? style.fontStyle ?? "normal",
  };
}

export function typographyStylePatchesFromTokens(
  theme: ThemeDefinition,
  baseTokens: TypographyTokens,
  nextTokens: TypographyTokens,
  fontFamilies: readonly ThemeFontFamily[],
): TypographyStylePatchInput[] {
  const patches: TypographyStylePatchInput[] = [];
  for (const tokenKey of EDITABLE_TOKEN_KEYS) {
    if (tokenEqual(tokenKey, baseTokens, nextTokens)) continue;
    const style = findStyle(theme, tokenKey);
    if (!style) continue;

    switch (tokenKey) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "body":
      case "bodySmall": {
        const token = nextTokens[tokenKey];
        patches.push({
          ...commonStylePatch(style, token, fontFamilies),
          sizePx: token.size,
          lineHeight: token.lineHeight,
          letterSpacingEm: token.letterSpacing,
        });
        break;
      }
      case "blockquote": {
        const token = nextTokens.blockquote;
        patches.push({
          ...commonStylePatch(style, token, fontFamilies),
          sizePx: token.size,
          lineHeight: token.lineHeight,
        });
        break;
      }
      case "link": {
        const token = nextTokens.link;
        patches.push({
          ...commonStylePatch(style, token, fontFamilies),
          decoration: token.decoration,
          hoverDecoration: token.hoverDecoration,
        });
        break;
      }
      case "mono": {
        const token = nextTokens.mono;
        patches.push({
          ...commonStylePatch(style, token, fontFamilies),
          sizePx: token.size,
        });
        break;
      }
    }
  }
  return patches;
}
