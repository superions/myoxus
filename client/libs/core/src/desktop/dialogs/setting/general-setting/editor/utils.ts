// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import {
  type Color,
  ColorScheme,
  FontWeight,
  type Palette,
  resolveColor,
} from "@virgultum/editor/model";

export function colorsEqual(a: Color, b: Color): boolean {
  if (a === b) return true;
  if (typeof a === "string" || typeof b === "string") return false;
  if ("normal" in a && "normal" in b) {
    return a.normal === b.normal;
  }
  if ("dark" in a && "dark" in b) {
    return a.dark === b.dark && a.light === b.light;
  }
  return false;
}

export function useResolvedTheme(): ColorScheme {
  const { resolvedTheme } = useMyoxusTheme();
  return resolvedTheme === ColorScheme.Dark
    ? ColorScheme.Dark
    : ColorScheme.Light;
}

export function translatePaletteLabel(
  t: ReturnType<typeof useI18n>,
  paletteKey: string,
): string {
  const slug = paletteKey
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/\s+/g, "-")
    .toLowerCase();
  const key = `com.myoxus.settings.editorSettings.edgeless.palette.${slug}`;
  const resolver = (t as unknown as Record<string, (() => string) | undefined>)[
    key
  ];
  return resolver?.() ?? paletteKey;
}

export function usePalettes(
  sourcePalettes: Palette[],
  fallbackColor: Color,
  keepBlackWhiteLabels = false,
) {
  const t = useI18n();
  const theme = useResolvedTheme();
  const isDark = theme === ColorScheme.Dark;

  const palettes = sourcePalettes.map(({ key, value }) => {
    let displayKey = key;
    if (!keepBlackWhiteLabels && isDark) {
      if (key === "Black") displayKey = "White";
      else if (key === "White") displayKey = "Black";
    }

    return {
      key: displayKey,
      label: translatePaletteLabel(t, displayKey),
      value,
      resolvedValue: resolveColor(value, theme),
    };
  });

  return {
    palettes,
    getCurrentColor: (color: Color) =>
      palettes.find((entry) => colorsEqual(entry.value, color)) ??
      palettes.find((entry) => colorsEqual(entry.value, fallbackColor)),
  };
}

export const sortedFontWeightEntries = Object.entries(FontWeight).sort(
  (a, b) => Number(a[1]) - Number(b[1]),
);
