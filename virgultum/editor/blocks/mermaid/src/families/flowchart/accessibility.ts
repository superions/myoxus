// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualModel } from "../runtime/gfx-model.js";

function normalizedAccessibilityTitle(value: string) {
  return value
    .replaceAll(/\s*\r?\n\s*/g, " ")
    .trim()
    .replace(/[\t ]{2,}/g, " ");
}

function normalizedAccessibilityDescription(value: string) {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/^\s*/gm, "")
    .replace(/\s+$/gm, "")
    .replace(/[\t ]{2,}/gm, " ")
    .replace(/\n{2,}/g, "\n");
}

export function withFlowchartAccessibility(
  model: MermaidVisualModel,
  values: { readonly description: string; readonly title: string },
): MermaidVisualModel {
  return {
    ...model,
    accessibilityDescription: normalizedAccessibilityDescription(
      values.description,
    ),
    accessibilityTitle: normalizedAccessibilityTitle(values.title),
  };
}
