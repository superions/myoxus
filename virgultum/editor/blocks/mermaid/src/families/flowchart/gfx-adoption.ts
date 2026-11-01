// SPDX-License-Identifier: AGPL-3.0-or-later

import { readMermaidGfxMeta } from "../../mermaid-gfx-metadata.js";

export function finalizeFlowchartAdoptedNodeElementProps(
  _model: unknown,
  existingElement: unknown,
  projectedProps: Readonly<Record<string, unknown>>,
) {
  const styleClass = readMermaidGfxMeta(
    existingElement,
    "mermaidNodeStyleClass",
  );
  if (
    styleClass !== "accent" &&
    styleClass !== "error" &&
    styleClass !== "neutral" &&
    styleClass !== "processing" &&
    styleClass !== "success" &&
    styleClass !== "warning"
  ) {
    return { ...projectedProps };
  }
  const next: Record<string, unknown> = {
    ...projectedProps,
    mermaidNodeStyleClass: styleClass,
  };
  delete next.color;
  delete next.fillColor;
  delete next.strokeColor;
  delete next.strokeWidth;
  return next;
}
