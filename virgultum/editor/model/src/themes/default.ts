import type { Palette, Theme } from "./types";
import { buildPalettes, getColorByKey, pureBlack, pureWhite } from "./utils";

const Transparent = "transparent";
const White = getColorByKey("white");
const Black = getColorByKey("black");

const Light = {
  Red: getColorByKey("tagRed"),
  Orange: getColorByKey("tagOrange"),
  Yellow: getColorByKey("tagYellow"),
  Green: getColorByKey("tagGreen"),
  Blue: getColorByKey("tagBlue"),
  Purple: getColorByKey("tagPurple"),
  Magenta: getColorByKey("tagMagenta"),
  Grey: getColorByKey("tagGray"),
} as const;

const Medium = {
  Red: getColorByKey("paletteLineRed"),
  Orange: getColorByKey("paletteLineOrange"),
  Yellow: getColorByKey("paletteLineYellow"),
  Green: getColorByKey("paletteLineGreen"),
  Blue: getColorByKey("paletteLineBlue"),
  Purple: getColorByKey("paletteLinePurple"),
  Magenta: getColorByKey("paletteLineMagenta"),
  Grey: getColorByKey("paletteLineGrey"),
} as const;

const Heavy = {
  Red: getColorByKey("textHighlightForegroundRed"),
  Orange: getColorByKey("textHighlightForegroundOrange"),
  Yellow: getColorByKey("textHighlightForegroundYellow"),
  Green: getColorByKey("textHighlightForegroundGreen"),
  Blue: getColorByKey("textHighlightForegroundBlue"),
  Purple: getColorByKey("textHighlightForegroundPurple"),
  Magenta: getColorByKey("textHighlightForegroundPurple"),
} as const;

const NoteBackgroundColorMap = {
  Red: getColorByKey("noteBackgroundRed"),
  Orange: getColorByKey("noteBackgroundOrange"),
  Yellow: getColorByKey("noteBackgroundYellow"),
  Green: getColorByKey("noteBackgroundGreen"),
  Blue: getColorByKey("noteBackgroundBlue"),
  Purple: getColorByKey("noteBackgroundPurple"),
  Magenta: getColorByKey("noteBackgroundMagenta"),
  White: getColorByKey("noteBackgroundWhite"),
  Transparent: Transparent,
} as const;

const Palettes: Palette[] = [
  // Light
  ...buildPalettes(Light, "Light"),

  { key: "Transparent", value: Transparent },

  // Medium
  ...buildPalettes(Medium, "Medium"),

  { key: "White", value: White },

  // Heavy
  ...buildPalettes(Heavy, "Heavy"),

  { key: "Black", value: Black },
] as const;

const NoteBackgroundColorPalettes: Palette[] = [
  ...buildPalettes(NoteBackgroundColorMap),
] as const;

const StrokeColorShortMap = { ...Medium, Black, White } as const;

const StrokeColorShortPalettes: Palette[] = [
  ...buildPalettes(StrokeColorShortMap),
] as const;

const FillColorShortMap = { ...Medium, Black, White, Transparent } as const;

const FillColorShortPalettes: Palette[] = [
  ...buildPalettes(FillColorShortMap),
] as const;

const ShapeTextColorShortMap = {
  ...Medium,
  Black: pureBlack,
  White: pureWhite,
} as const;

const ShapeTextColorShortPalettes: Palette[] = [
  ...buildPalettes({ ...ShapeTextColorShortMap }),
] as const;

const ShapeTextColorPalettes: Palette[] = [
  // Light
  ...buildPalettes(Light, "Light"),

  { key: "Transparent", value: Transparent },

  // Medium
  ...buildPalettes(Medium, "Medium"),

  { key: "White", value: pureWhite },

  // Heavy
  ...buildPalettes(Heavy, "Heavy"),

  { key: "Black", value: pureBlack },
] as const;

export const DefaultTheme: Theme = {
  pureBlack,
  pureWhite,
  black: Black,
  white: White,
  transparent: Transparent,
  textColor: Black,
  shapeTextColor: pureBlack,
  shapeStrokeColor: Medium.Yellow,
  shapeFillColor: Medium.Yellow,
  connectorColor: Medium.Grey,
  noteBackgrounColor: NoteBackgroundColorMap.White,
  // 30% transparent `Medium.Blue`
  hightlighterColor: "#84cfff4d",
  Palettes,
  ShapeTextColorPalettes,
  NoteBackgroundColorMap,
  NoteBackgroundColorPalettes,
  StrokeColorShortMap,
  StrokeColorShortPalettes,
  FillColorShortMap,
  FillColorShortPalettes,
  ShapeTextColorShortMap,
  ShapeTextColorShortPalettes,
} as const;
