/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

interface ThemeCatalogColorMode {
  paper: string;
  "paper-deep": string;
  "background-code-block": string;
  ink: string;
  "ink-soft": string;
  "accent-primary": string;
  "accent-secondary": string;
}

interface ThemeCatalogTheme {
  slug: string;
  colors: {
    light: ThemeCatalogColorMode;
    dark: ThemeCatalogColorMode;
  };
}

interface ThemeCatalog {
  themes: ThemeCatalogTheme[];
}

const __dirname_resolved =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(
  __dirname_resolved,
  "../../../../../../../../server/static/branding/theme-catalog.json",
);
// Validate colors from the server-owned seed projection, not a client preset registry.
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ThemeCatalog;

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) {
    throw new Error(`Unsupported color ${hex}; expected #RRGGBB`);
  }
  const value = Number.parseInt(clean, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe("Theme DB seed contrast validation", () => {
  const entries = catalog.themes;

  for (const theme of entries) {
    for (const mode of ["light", "dark"] as const) {
      test(`${theme.slug} ${mode} body and secondary text pass WCAG gates`, () => {
        const colors = theme.colors[mode];
        const body = contrastRatio(colors.ink, colors.paper);
        const secondary = contrastRatio(colors["ink-soft"], colors.paper);
        const codeText = contrastRatio(
          colors.ink,
          colors["background-code-block"],
        );
        const codeSurface = contrastRatio(
          colors.paper,
          colors["background-code-block"],
        );

        expect(
          body,
          `${theme.slug} ${mode} ink/paper ${body.toFixed(2)} < 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          secondary,
          `${theme.slug} ${mode} ink-soft/paper ${secondary.toFixed(2)} < 3`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          codeText,
          `${theme.slug} ${mode} ink/code-block ${codeText.toFixed(2)} < 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          codeSurface,
          `${theme.slug} ${mode} paper/code-block ${codeSurface.toFixed(2)} < 1.15`,
        ).toBeGreaterThanOrEqual(1.15);
      });
    }
  }
});
