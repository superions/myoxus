// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidVisualNodeShape } from "./families/runtime/gfx-model.js";
import { MERMAID_FLOWCHART_EXPANDED_SHAPE_LABELS } from "./mermaid-block-constants.js";

/**
 * Returns the product label for a Flowchart shape. Rendering belongs to the
 * React family host; this pure vocabulary helper remains in the source owner.
 */
export function mermaidShapeSyntaxLabel(shape: MermaidVisualNodeShape) {
  return (MERMAID_FLOWCHART_EXPANDED_SHAPE_LABELS[shape] ?? shape)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
