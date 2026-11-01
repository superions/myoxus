// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

const seed = JSON.parse(
  readFileSync(
    new URL("../../../server/static/branding/theme-seed.json", import.meta.url),
    "utf8",
  ),
);

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("every preset keeps text links underlined and readable on its text surfaces", () => {
  for (const theme of seed.themes) {
    const link = theme.typographyStyles.find(
      (style: { styleKey: string }) => style.styleKey === "link.default",
    );
    expect(link?.decoration, theme.slug).toBe("underline");
    expect(link?.hoverDecoration, theme.slug).toBe("underline");
    for (const [mode, colors] of Object.entries(theme.colors) as [
      string,
      Record<string, string>,
    ][]) {
      for (const surface of ["paper", "paper-deep"]) {
        const [low, high] = [
          luminance(colors["link-default"]),
          luminance(colors[surface]),
        ].sort((a, b) => a - b);
        expect(
          (high + 0.05) / (low + 0.05),
          `${theme.slug}/${mode}/${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});
