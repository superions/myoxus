// SPDX-License-Identifier: AGPL-3.0-or-later
import { projectMermaidSourceStyle } from "../runtime/source-style-projection.js";
import type { MermaidVisualNode } from "../runtime/gfx-model.js";
import { requirementNodeGfxData } from "./gfx-data.js";

/** Only the native DB's consumed declaration stream contributes appearance.
 * Unknown declarations remain in Source; the shared projection owns its subset. */
export function requirementSourceStyles(declarations: readonly string[] = []) {
  const styles: Record<string, string> = {};
  for (const declaration of declarations)
    for (const entry of declaration.split(";")) {
      const colon = entry.indexOf(":");
      if (colon >= 0)
        styles[entry.slice(0, colon).trim().toLowerCase()] = entry
          .slice(colon + 1)
          .trim();
    }
  return styles;
}
export function projectedRequirementStyle(node: MermaidVisualNode) {
  return projectMermaidSourceStyle(requirementNodeGfxData(node)?.styles);
}
