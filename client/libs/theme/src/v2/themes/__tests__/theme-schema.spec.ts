// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Server-owned theme-seed invariants. Client TS city presets are retained only
// as historical/token-library code; they are not the authoring source for the
// active theme catalog.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const themeSeed = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "server/static/branding/theme-seed.json"),
    "utf8",
  ),
);

const REQUIRED_STYLE_KEYS = [
  "page.title",
  "section.title",
  "card.title",
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
const RAW_TO_STYLE_FIELDS: Record<string, string> = {
  family: "fontFamily",
  weight: "fontWeight",
  size: "sizePx",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacingEm",
};

describe("server theme seed schema", () => {
  it("inv_theme_seed_schema_contract", () => {
    expect(themeSeed.schemaVersion).toBe(1);
    expect(themeSeed.requiredColorKeys).toHaveLength(18);
    expect(themeSeed.requiredTypographyFields).toEqual([
      "family",
      "weight",
      "size",
      "lineHeight",
      "letterSpacing",
    ]);
    expect(themeSeed.themes).toHaveLength(16);
  });

  for (const theme of themeSeed.themes) {
    describe(`theme: ${theme.slug}`, () => {
      it("inv_theme_color_keys_complete", () => {
        for (const mode of ["light", "dark"] as const) {
          for (const key of themeSeed.requiredColorKeys) {
            expect(
              theme.colors[mode],
              `${theme.slug}.colors.${mode} missing ${key}`,
            ).toHaveProperty(key);
            expect(theme.colors[mode][key]).toMatch(/^#[0-9a-f]{6}$/i);
          }
        }
      });

      it("inv_theme_typography_styles_complete", () => {
        const stylesByKey = new Map(
          theme.typographyStyles.map((style: { styleKey: string }) => [
            style.styleKey,
            style,
          ]),
        );
        for (const styleKey of REQUIRED_STYLE_KEYS) {
          expect(stylesByKey.has(styleKey), `${theme.slug}.${styleKey}`).toBe(
            true,
          );
        }
        for (const style of theme.typographyStyles) {
          for (const rawField of themeSeed.requiredTypographyFields) {
            const field = RAW_TO_STYLE_FIELDS[rawField] ?? rawField;
            expect(
              style,
              `${theme.slug}.${style.styleKey} missing ${field}`,
            ).toHaveProperty(field);
          }
          expect(style.fontFamily).toEqual(expect.any(String));
          expect(Number.isFinite(style.fontWeight)).toBe(true);
          expect(Number.isFinite(style.sizePx)).toBe(true);
          expect(Number.isFinite(style.lineHeight)).toBe(true);
          expect(Number.isFinite(style.letterSpacingEm)).toBe(true);
        }
      });

      it("inv_theme_preview_metadata_complete", () => {
        expect(theme.name).toEqual(expect.any(String));
        expect(theme.category).toEqual(expect.any(String));
        expect(theme.previewGroup).toEqual(expect.any(String));
        expect(theme.previewOrder).toEqual(expect.any(Number));
        expect(theme.taglineKey).toMatch(/^admin\.design\.theme\..+\.tagline$/);
        expect(theme.descriptionKey).toMatch(
          /^admin\.design\.theme\..+\.description$/,
        );
      });
    });
  }

  it("inv_theme_seed_has_exactly_one_default", () => {
    expect(
      themeSeed.themes.filter(
        (theme: { isDefault: boolean }) => theme.isDefault,
      ),
    ).toHaveLength(1);
    expect(
      themeSeed.themes.find((theme: { isDefault: boolean }) => theme.isDefault)
        .slug,
    ).toBe("stuttgart");
  });
});
