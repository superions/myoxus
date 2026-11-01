import { useI18n } from "@myoxus/i18n";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import {
  type Color,
  ColorScheme,
  FontWeight,
  type Palette,
  resolveColor,
} from "@virgultum/editor/model";
import { isEqual } from "lodash-es";

export const useResolvedTheme = () => {
  const { resolvedTheme } = useMyoxusTheme();
  return resolvedTheme === ColorScheme.Dark
    ? ColorScheme.Dark
    : ColorScheme.Light;
};

export const usePalettes = (
  originalPalettes: Palette[],
  defaultColor: Color,
  isShapeText = false,
) => {
  const t = useI18n();
  const theme = useResolvedTheme();
  const isDark = theme === ColorScheme.Dark;
  const palettes = originalPalettes.map(({ key, value }) => {
    // Title needs to be inverted.
    if (!isShapeText && isDark) {
      if (key === "Black") {
        key = "White";
      } else if (key === "White") {
        key = "Black";
      }
    }

    return {
      key,
      label: translatePaletteLabel(t, key),
      value,
      resolvedValue: resolveColor(value, theme),
    };
  });
  return {
    palettes,
    getCurrentColor: (color: Color) =>
      palettes.find(({ value }) => isEqual(value, color)) ||
      palettes.find(({ value }) => isEqual(value, defaultColor)),
  };
};

const translatePaletteLabel = (
  t: ReturnType<typeof useI18n>,
  paletteKey: string,
) => {
  const normalizedKey = paletteKey
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/\s+/g, "-")
    .toLowerCase();
  const translationKey = `com.myoxus.settings.editorSettings.edgeless.palette.${normalizedKey}`;
  const translate = (
    t as unknown as Record<string, (() => string) | undefined>
  )[translationKey];
  return translate?.() ?? paletteKey;
};

export const sortedFontWeightEntries = Object.entries(FontWeight).sort(
  (a, b) => Number(a[1]) - Number(b[1]),
);
