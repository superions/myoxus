// https://www.w3.org/TR/css-color-4/
import clamp from "lodash-es/clamp";

import type { Color } from "../models/themes/color.js";

// Red, green, blue. All in the range [0, 1].
export type Rgb = {
  // red 0-1
  r: number;
  // green 0-1
  g: number;
  // blue 0-1
  b: number;
};

// Red, green, blue, alpha. All in the range [0, 1].
export type Rgba = Rgb & {
  // alpha 0-1
  a: number;
};

export const bound01 = (n: number, max: number) => {
  n = clamp(n, 0, max);

  // Handle floating point rounding errors
  if (Math.abs(n - max) < 0.000001) {
    return 1;
  }

  // Convert into [0, 1] range if it isn't already
  return (n % max) / max;
};

export const rgbToHex = ({ r, g, b }: Rgb) =>
  [r, g, b]
    .map((n) => n * 255)
    .map(Math.round)
    .map((s) => s.toString(16).padStart(2, "0"))
    .join("");

export const rgbaToHex8 = ({ r, g, b, a }: Rgba) => {
  const hex = [r, g, b, a]
    .map((n) => n * 255)
    .map(Math.round)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
};

export const parseHexToRgba = (hex: string) => {
  if (hex.startsWith("#")) {
    hex = hex.substring(1);
  }

  const len = hex.length;
  let arr: string[] = [];

  if (len === 3 || len === 4) {
    arr = hex.split("").map((s) => s.repeat(2));
  } else if (len === 6 || len === 8) {
    arr = Array.from<number>({ length: len / 2 })
      .fill(0)
      .map((n, i) => n + i * 2)
      .map((n) => hex.substring(n, n + 2));
  }

  const [r, g, b, a = 1] = arr
    .map((s) => parseInt(s, 16))
    .map((n) => bound01(n, 255));

  return { r, g, b, a };
};

export const parseStringToRgba = (value: string) => {
  value = value.trim();

  // Compatible old format: `--myoxus-palette-transparent`
  if (value.endsWith("transparent")) {
    return { r: 1, g: 1, b: 1, a: 0 };
  }

  if (value.startsWith("#")) {
    return parseHexToRgba(value);
  }

  if (value.startsWith("rgb")) {
    const [r, g, b, a = 1] = value
      .replace(/^rgba?/, "")
      .replace(/\(|\)/, "")
      .split(",")
      .map((s) => parseFloat(s.trim()))
      // In CSS, the alpha is already in the range [0, 1]
      .map((n, i) => bound01(n, i === 3 ? 1 : 255));

    return { r, g, b, a };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
};

// Opaque control swatches accept the same hex/RGB(A) projection as the model.
// Slicing by string length corrupts server-projected `rgba(...)` into invalid
// SVG/CSS. Reuse the colour parser; never rewrite the persisted colour/alpha.
export const keepColor = (color: string) => {
  if (color.startsWith("#") || color.startsWith("rgb")) {
    return `#${rgbToHex(parseStringToRgba(color))}`;
  }
  // Transparent and unresolved CSS-token inputs retain their existing meaning.
  return color;
};

export const packColor = (key: string, color: Color) => {
  return { [key]: typeof color === "object" ? { ...color } : color };
};

export const adjustColorAlpha = (color: Color, a: number): Color => {
  let newColor;
  if (typeof color === "object") {
    if ("normal" in color) {
      const rgba = parseStringToRgba(color.normal);
      rgba.a = a;
      newColor = { normal: rgbaToHex8(rgba) };
    } else {
      const newDarkRgba = parseStringToRgba(color.dark);
      newDarkRgba.a = a;
      const newLightRgba = parseStringToRgba(color.light);
      newLightRgba.a = a;
      newColor = {
        dark: rgbaToHex8(newDarkRgba),
        light: rgbaToHex8(newLightRgba),
      };
    }
  } else {
    const rgba = parseStringToRgba(color);
    rgba.a = a;
    newColor = rgbaToHex8(rgba);
  }

  return newColor;
};
