// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type Color,
  type ColorScheme,
  type Palette,
  DefaultTheme,
  resolveColor,
} from "@virgultum/model";
import type { ToolbarControl } from "./action";

/** Native swatches display resolved colors while preserving authored theme pairs. */
export function createToolbarColorControl({
  value,
  theme,
  palettes = DefaultTheme.Palettes,
  custom = true,
  change,
  start,
}: {
  value: string;
  theme: ColorScheme;
  palettes?: readonly Palette[];
  custom?: boolean;
  change: (value: Color) => void;
  start?: () => () => void;
}): ToolbarControl {
  const swatches = palettes.map((palette) =>
    resolveColor(palette.value, theme),
  );
  return {
    type: "color",
    value,
    swatches,
    custom,
    start,
    change: (color) =>
      change(
        palettes.find((_, index) => swatches[index] === color)?.value ?? color,
      ),
  };
}
