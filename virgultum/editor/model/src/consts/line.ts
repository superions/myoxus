import { z } from "zod";

import { createEnumMap } from "../utils/enum.js";

export enum LineWidth {
  Two = 2,
  // Thin
  Four = 4,
  Six = 6,
  Eight = 8,
  // Thick
  Ten = 10,
  Twelve = 12,
}

export const BRUSH_LINE_WIDTHS = [
  LineWidth.Two,
  LineWidth.Four,
  LineWidth.Six,
  LineWidth.Eight,
  LineWidth.Ten,
  LineWidth.Twelve,
];

export const HIGHLIGHTER_LINE_WIDTHS = [10, 14, 18, 22, 26, 30];

export const DEFAULT_HIGHLIGHTER_LINE_WIDTH = 22;

/**
 * Use `DefaultTheme.StrokeColorShortMap` instead.
 *
 * @deprecated
 */
export enum LineColor {
  Black = "--myoxus-palette-line-black",
  Blue = "--myoxus-palette-line-blue",
  Green = "--myoxus-palette-line-green",
  Grey = "--myoxus-palette-line-grey",
  Magenta = "--myoxus-palette-line-magenta",
  Orange = "--myoxus-palette-line-orange",
  Purple = "--myoxus-palette-line-purple",
  Red = "--myoxus-palette-line-red",
  Teal = "--myoxus-palette-line-teal",
  White = "--myoxus-palette-line-white",
  Yellow = "--myoxus-palette-line-yellow",
}

export const LineColorMap = createEnumMap(LineColor);

/**
 * Use `DefaultTheme.StrokeColorShortPalettes` instead.
 *
 * @deprecated
 */
export const LINE_COLORS = [
  LineColor.Yellow,
  LineColor.Orange,
  LineColor.Red,
  LineColor.Magenta,
  LineColor.Purple,
  LineColor.Blue,
  LineColor.Teal,
  LineColor.Green,
  LineColor.Black,
  LineColor.Grey,
  LineColor.White,
] as const;

export const LineColorsSchema = z.nativeEnum(LineColor);
