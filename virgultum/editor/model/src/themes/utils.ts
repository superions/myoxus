import { type MyoxusTheme, darkTheme, lightTheme } from "@myoxus/theme";

import type { Color } from "./color";
import type { Palette } from "./types";

// Converts a color map to color list.
export function buildPalettes(
  obj: Record<string, Color>,
  prefix = "",
): Palette[] {
  return Object.entries<Color>(obj).map(([key, value]) => ({
    key: `${prefix}${key}`,
    value,
  }));
}

export function getColorByKey(
  key: keyof Omit<MyoxusTheme, "editorMode">,
): Color {
  const dark = darkTheme[key];
  const light = lightTheme[key];
  if (dark === light) return dark;
  return { dark, light };
}

export const pureBlack = lightTheme.pureBlack;
export const pureWhite = lightTheme.pureWhite;
