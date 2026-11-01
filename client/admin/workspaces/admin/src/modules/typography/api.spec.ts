import type { ThemeDefinition } from "../theme/theme-contract";
import type { ThemeFontAsset } from "../theme/theme-contract";
import type { ThemeFontFamily } from "../theme/theme-contract";
import { typographyFullPreviewStyle } from "./preview-styles";
import { describe, expect, test } from "vitest";

import {
  readTypographyTokensFromTheme,
  typographyFontFamilyCss,
  typographyStylePatchesFromTokens,
} from "./api";

function webAsset(weight: number): ThemeFontAsset {
  return {
    usage: "web",
    format: "woff2",
    style: "normal",
    weightMin: weight,
    weightMax: weight,
    weightDefault: weight,
    assetKey: `${weight}.woff2`,
    sha256: String(weight),
    mime: "font/woff2",
    unicodeRanges: ["latin"],
    subsetTags: ["latin"],
  };
}

function fontFamily(
  slug: string,
  displayName: string,
  genericClass: string,
  weights: number[] = [400, 700],
  isSelectable = true,
): ThemeFontFamily {
  return {
    slug,
    displayName,
    cssFamily: displayName,
    genericClass,
    source: "bundled",
    licenseSpdx: "OFL-1.1",
    licenseStatus: "approved",
    isSelectable,
    assets: weights.map(webAsset),
  };
}

const FONT_FAMILIES = [
  fontFamily("catalog-sans", "Catalog Sans", "sans-serif", [400, 600, 700]),
  fontFamily("catalog-serif", "Catalog Serif", "serif", [400, 700]),
  fontFamily("catalog-mono", "Catalog Mono", "monospace", [400, 500]),
  fontFamily("blocked", "Blocked", "serif", [400], false),
];

function themeWithStyles(
  typographyStyles: ThemeDefinition["typographyStyles"],
): ThemeDefinition {
  return {
    slug: "catalog-serif",
    name: "Catalog Serif",
    origin: "system",
    locked: true,
    isDefault: true,
    colorSchemaSlug: "catalog-light",
    typographySlug: "serif-profile",
    colors: {},
    typographyStyles,
  };
}

describe("readTypographyTokensFromTheme", () => {
  test("maps Theme DB typography styles and catalog families into GUI tokens", () => {
    const tokens = readTypographyTokensFromTheme(
      themeWithStyles([
        {
          styleKey: "heading.h1",
          fontFamilySlug: "catalog-serif",
          fontFamily: "Catalog Serif",
          fontWeight: 700,
          sizePx: 48,
          lineHeight: 1.1,
          letterSpacingEm: -0.03,
        },
        {
          styleKey: "link.default",
          fontFamilySlug: "catalog-sans",
          fontFamily: "Catalog Sans",
          fontWeight: 600,
          decoration: "underline",
          hoverDecoration: "none",
        },
        {
          styleKey: "quote.block",
          fontFamilySlug: "catalog-serif",
          fontFamily: "Catalog Serif",
          fontWeight: 400,
          fontStyle: "italic",
          sizePx: 19,
          lineHeight: 1.6,
        },
        {
          styleKey: "code.inline",
          fontFamilySlug: "catalog-mono",
          fontFamily: "Catalog Mono",
          fontWeight: 500,
          sizePx: 14,
        },
      ]),
      FONT_FAMILIES,
    );

    expect(tokens.h1).toMatchObject({
      family: "Catalog Serif",
      cssFamily: "Catalog Serif",
      weight: 700,
      size: 48,
      lineHeight: 1.1,
      letterSpacing: -0.03,
    });
    expect(tokens.link).toMatchObject({
      family: "Catalog Sans",
      weight: 600,
      decoration: "underline",
      hoverDecoration: "none",
    });
    expect(tokens.blockquote).toMatchObject({
      family: "Catalog Serif",
      weight: 400,
      size: 19,
      lineHeight: 1.6,
      fontStyle: "italic",
    });
    expect(tokens.mono).toMatchObject({
      family: "Catalog Mono",
      weight: 500,
      size: 14,
    });
  });
});

describe("typography font catalog helpers", () => {
  test("builds CSS font-family stacks without preview-only aliases", () => {
    expect(typographyFontFamilyCss({ family: "Catalog Serif" }, "serif")).toBe(
      '"Catalog Serif", serif',
    );
    expect(typographyFontFamilyCss({ family: "serif" }, "sans-serif")).toBe(
      "serif",
    );
    expect(
      typographyFontFamilyCss({
        family: "Catalog Sans",
        cssFamily: "Catalog Sans",
      }),
    ).toBe("Catalog Sans");
  });
});

describe("typographyStylePatchesFromTokens", () => {
  test("preserves hidden PDF roles and optional style metadata by omitting them", () => {
    const theme = themeWithStyles([
      {
        styleKey: "body.default",
        fontFamilySlug: "catalog-sans",
        fontFamily: "Catalog Sans",
        fontWeight: 400,
        sizePx: 17,
        lineHeight: 1.6,
        letterSpacingEm: 0,
      },
      {
        styleKey: "pdf.body",
        fontFamilySlug: "catalog-mono",
        fontFamily: "Catalog Mono",
        fontWeight: 400,
        sizePx: 13,
        pdfRole: "body",
      },
      {
        styleKey: "pdf.symbol",
        fontFamilySlug: "catalog-mono",
        fontFamily: "Catalog Mono",
        fontWeight: 400,
        sizePx: 13,
        pdfRole: "symbol",
      },
    ]);
    const base = readTypographyTokensFromTheme(theme, FONT_FAMILIES);
    const draft = JSON.parse(JSON.stringify(base)) as typeof base;
    draft.body.family = "Catalog Serif";
    draft.body.cssFamily = "Catalog Serif";
    draft.body.size = 18;

    const patches = typographyStylePatchesFromTokens(
      theme,
      base,
      draft,
      FONT_FAMILIES,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual(
      expect.not.objectContaining({ pdfRole: expect.anything() }),
    );
    expect(patches[0]).toEqual(
      expect.objectContaining({
        styleKey: "body.default",
        fontFamilySlug: "catalog-serif",
        fontWeight: 400,
        sizePx: 18,
      }),
    );
  });

  test("creates focused patches for link, blockquote and mono controls", () => {
    const theme = themeWithStyles([
      {
        styleKey: "quote.block",
        fontFamilySlug: "catalog-serif",
        fontFamily: "Catalog Serif",
        fontWeight: 400,
        fontStyle: "italic",
        sizePx: 19,
        lineHeight: 1.6,
      },
      {
        styleKey: "link.default",
        fontFamilySlug: "catalog-sans",
        fontFamily: "Catalog Sans",
        fontWeight: 600,
        decoration: "underline",
        hoverDecoration: "none",
      },
      {
        styleKey: "code.inline",
        fontFamilySlug: "catalog-mono",
        fontFamily: "Catalog Mono",
        fontWeight: 500,
        sizePx: 14,
      },
    ]);
    const base = readTypographyTokensFromTheme(theme, FONT_FAMILIES);
    const draft = JSON.parse(JSON.stringify(base)) as typeof base;
    draft.blockquote.fontStyle = "normal";
    draft.blockquote.lineHeight = 1.7;
    draft.link.decoration = "none";
    draft.mono.size = 15;

    expect(
      typographyStylePatchesFromTokens(theme, base, draft, FONT_FAMILIES),
    ).toEqual([
      expect.objectContaining({
        styleKey: "quote.block",
        fontStyle: "normal",
        sizePx: 19,
        lineHeight: 1.7,
      }),
      expect.objectContaining({
        styleKey: "link.default",
        decoration: "none",
        hoverDecoration: "none",
      }),
      expect.objectContaining({
        styleKey: "code.inline",
        sizePx: 15,
      }),
    ]);
  });
});

test("preserves heading style and link states through drafts and previews", () => {
  const theme = themeWithStyles([
    {
      styleKey: "heading.h1",
      fontFamily: "Catalog Serif",
      fontFamilySlug: "catalog-serif",
      fontWeight: 700,
      sizePx: 48,
      fontStyle: "italic",
      textTransform: "uppercase",
    },
    {
      styleKey: "link.default",
      fontFamily: "Catalog Sans",
      fontFamilySlug: "catalog-sans",
      fontWeight: 600,
      sizePx: 17,
      decoration: "underline",
      hoverDecoration: "none",
    },
  ]);
  const base = readTypographyTokensFromTheme(theme, FONT_FAMILIES);
  const draft = structuredClone(base);
  draft.h1.size = 52;
  const preview = typographyFullPreviewStyle(draft);
  expect(preview["--authoring-typography-h1-size"]).toBe("52px");
  expect(preview["--authoring-typography-h1-style"]).toBe("italic");
  expect(preview["--authoring-typography-h1-transform"]).toBe("uppercase");
  expect(preview["--authoring-typography-link-size"]).toBe("17px");
  expect(preview["--authoring-typography-link-decoration"]).toBe("underline");
  expect(preview["--authoring-typography-link-hover-decoration"]).toBe("none");
  expect(
    typographyStylePatchesFromTokens(theme, base, draft, FONT_FAMILIES),
  ).toEqual([
    expect.objectContaining({
      styleKey: "heading.h1",
      sizePx: 52,
      fontStyle: "italic",
    }),
  ]);
});
