// SPDX-License-Identifier: AGPL-3.0-or-later
import { type CSSProperties } from "react";

export function joinClassName(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" ");
}

type UnitSuffix = "px" | "ms";

export function withUnit(value: string | number, unit: UnitSuffix): string {
  if (typeof value === "number") return `${value}${unit}`;
  if (/^\d+(\.\d+)?$/.test(value)) return `${value}${unit}`;
  return value;
}

export function repeatCssLength(term: string, count: number): string {
  const safeCount = Math.max(1, Math.round(count));
  if (safeCount === 1) return term;
  return `calc(${Array.from({ length: safeCount }, () => term).join(" + ")})`;
}

export function mergeStyles(
  ...styles: Array<CSSProperties | undefined>
): CSSProperties | undefined {
  let merged: CSSProperties | undefined;
  for (const style of styles) {
    if (!style) continue;
    merged = { ...merged, ...style };
  }
  return merged;
}

export function cssLengthToPx(
  value: string | undefined,
  rootFontSize: number,
): number {
  if (!value) return rootFontSize;
  const trimmed = value.trim();
  if (trimmed.endsWith("rem") || trimmed.endsWith("em")) {
    return Number.parseFloat(trimmed) * rootFontSize;
  }
  if (trimmed.endsWith("px")) return Number.parseFloat(trimmed);
  return Number.parseFloat(trimmed) || rootFontSize;
}
