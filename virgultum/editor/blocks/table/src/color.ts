import {
  adaptiveForeground,
  contrastRatio,
  type HexColor,
} from "@myoxus/theme";
import {
  parseStringToRgba,
  rgbToHex,
} from "@virgultum/components/color-picker/utils";
import type { ThemeService } from "@virgultum/shared/services";
import { cssVar } from "@virgultum/shared/theme";
type Color = {
  name: string;
  color: string;
};
export const colorList: Color[] = [
  {
    name: "Blue",
    color: cssVar("tagBlue"),
  },
  {
    name: "Green",
    color: cssVar("tagGreen"),
  },
  {
    name: "Grey",
    color: cssVar("tagGray"),
  },
  {
    name: "Orange",
    color: cssVar("tagOrange"),
  },
  {
    name: "Purple",
    color: cssVar("tagPurple"),
  },
  {
    name: "Red",
    color: cssVar("tagRed"),
  },
  {
    name: "Teal",
    color: cssVar("tagTeal"),
  },
  {
    name: "Yellow",
    color: cssVar("tagYellow"),
  },
];

// Cells use the same named choices; status fills retain stable source semantics.
export const cellColorList = colorList.map((item) => ({
  ...item,
  color:
    (
      {
        Green: "--myoxus-sem-status-success-paper",
        Yellow: "--myoxus-sem-status-preset-paper",
        Red: "--myoxus-sem-status-error-paper",
      } as Record<string, string>
    )[item.name] ?? item.color,
}));

const colorMap = Object.fromEntries(
  colorList.map((item) => [item.color, item]),
);

export const getColorByColor = (color: string): Color | undefined => {
  return colorMap[color] ?? undefined;
};

const concreteRgba = (value: string) => {
  value = value.trim().toLowerCase();
  if (
    !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) &&
    !/^rgba?\([\d.,+\-\s]+\)$/i.test(value)
  )
    return;
  const rgba = parseStringToRgba(value);
  if (![rgba.r, rgba.g, rgba.b, rgba.a].every(Number.isFinite)) return;
  return rgba;
};

/** Resolve viewer paint without writing materialized colors into shared cells. */
export function resolveTableColors(theme: ThemeService, fill: string) {
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/.exec(fill)?.[1] ?? fill;
  const mode = theme.theme$.value;
  const rgba = concreteRgba(
    theme.getColorValue(reference, undefined, true, mode) ?? "",
  );
  if (!rgba) return {};
  // Exported cells must paint identically without the app's surrounding canvas.
  if (rgba.a < 1) {
    const canvas = concreteRgba(
      theme.getColorValue(
        "--myoxus-background-primary-color",
        undefined,
        true,
        mode,
      ) ?? "",
    );
    if (!canvas || canvas.a !== 1) return {};
    rgba.r = rgba.r * rgba.a + canvas.r * (1 - rgba.a);
    rgba.g = rgba.g * rgba.a + canvas.g * (1 - rgba.a);
    rgba.b = rgba.b * rgba.a + canvas.b * (1 - rgba.a);
  }
  const background: HexColor = `#${rgbToHex(rgba)}`;
  const foregroundRgba = concreteRgba(
    theme.getColorValue("--myoxus-text-primary-color", undefined, true, mode) ??
      "",
  );
  const foreground: HexColor | undefined =
    foregroundRgba?.a === 1 ? `#${rgbToHex(foregroundRgba)}` : undefined;
  return {
    backgroundColor: background,
    color:
      foreground && contrastRatio(background, foreground) >= 4.5
        ? foreground
        : adaptiveForeground(background),
  };
}
