import { z } from "zod";

import type { Color } from "../themes/color.js";
import { createEnumMap } from "../utils/enum.js";

export enum TextAlign {
  Center = "center",
  Left = "left",
  Right = "right",
}

export const TextAlignMap = createEnumMap(TextAlign);

export enum TextVerticalAlign {
  Bottom = "bottom",
  Center = "center",
  Top = "top",
}

export type TextStyleProps = {
  color: Color;
  fontFamily: FontFamily;
  fontSize: number;
  fontStyle: FontStyle;
  fontWeight: FontWeight;
  textAlign: TextAlign;
};

export enum FontWeight {
  Bold = "700",
  Light = "300",
  Medium = "500",
  Regular = "400",
  SemiBold = "600",
}

export const FontWeightMap = createEnumMap(FontWeight);

export enum FontStyle {
  Italic = "italic",
  Normal = "normal",
}

// Persisted identifiers remain stable; these constants are not an authoring catalogue.
export const FontFamily = {
  BebasNeue: "virgultum:surface:BebasNeue",
  Inter: "virgultum:surface:Inter",
  Kalam: "virgultum:surface:Kalam",
  Lora: "virgultum:surface:Lora",
  Montserrat: "virgultum:surface:Montserrat",
  OrelegaOne: "virgultum:surface:OrelegaOne",
  Poppins: "virgultum:surface:Poppins",
} as const;
export type FontFamily = string;

export enum TextResizing {
  AUTO_WIDTH_AND_HEIGHT,
  AUTO_HEIGHT,
}

export const FontFamilySchema = z.string().trim().min(1).max(256);
export const FontWeightSchema = z.nativeEnum(FontWeight);
export const FontStyleSchema = z.nativeEnum(FontStyle);
export const TextAlignSchema = z.nativeEnum(TextAlign);
