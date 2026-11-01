// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WCAG contrast invariants for the server-owned theme seed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const themeSeed = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "server/static/branding/theme-seed.json"),
    "utf8",
  ),
);

function parseHex(hex: string): [number, number, number] {
  const trimmed = hex.replace("#", "").trim();
  if (trimmed.length !== 6 && trimmed.length !== 3) {
    throw new Error(`unsupported hex color: ${hex}`);
  }
  const expanded =
    trimmed.length === 3
      ? trimmed
          .split("")
          .map((c) => c + c)
          .join("")
      : trimmed;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("server theme seed contrast", () => {
  for (const theme of themeSeed.themes) {
    describe(`theme: ${theme.slug}`, () => {
      it("inv_theme_contrast_ink_on_paper_light_aa", () => {
        const ratio = contrastRatio(
          theme.colors.light.ink,
          theme.colors.light.paper,
        );
        expect(
          ratio,
          `${theme.slug} light ink/paper contrast ${ratio.toFixed(2)} < 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      });

      it("inv_theme_contrast_ink_on_paper_dark_aa", () => {
        const ratio = contrastRatio(
          theme.colors.dark.ink,
          theme.colors.dark.paper,
        );
        expect(
          ratio,
          `${theme.slug} dark ink/paper contrast ${ratio.toFixed(2)} < 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      });

      it("inv_theme_contrast_ink_soft_on_paper_light_aa", () => {
        const ratio = contrastRatio(
          theme.colors.light["ink-soft"],
          theme.colors.light.paper,
        );
        expect(
          ratio,
          `${theme.slug} light ink-soft/paper contrast ${ratio.toFixed(2)} < 3`,
        ).toBeGreaterThanOrEqual(3);
      });

      it("inv_theme_contrast_ink_soft_on_paper_dark_aa", () => {
        const ratio = contrastRatio(
          theme.colors.dark["ink-soft"],
          theme.colors.dark.paper,
        );
        expect(
          ratio,
          `${theme.slug} dark ink-soft/paper contrast ${ratio.toFixed(2)} < 3`,
        ).toBeGreaterThanOrEqual(3);
      });
    });
  }

  for (const slug of ["stuttgart", "zuerich"]) {
    describe(`theme: ${slug} AAA-class`, () => {
      const theme = themeSeed.themes.find(
        (candidate: { slug: string }) => candidate.slug === slug,
      );
      it("inv_theme_contrast_ink_on_paper_light_aaa", () => {
        const ratio = contrastRatio(
          theme.colors.light.ink,
          theme.colors.light.paper,
        );
        expect(
          ratio,
          `${slug} light ink/paper ${ratio.toFixed(2)} < 7`,
        ).toBeGreaterThanOrEqual(7);
      });
      it("inv_theme_contrast_ink_on_paper_dark_aaa", () => {
        const ratio = contrastRatio(
          theme.colors.dark.ink,
          theme.colors.dark.paper,
        );
        expect(
          ratio,
          `${slug} dark ink/paper ${ratio.toFixed(2)} < 7`,
        ).toBeGreaterThanOrEqual(7);
      });
    });
  }
});
