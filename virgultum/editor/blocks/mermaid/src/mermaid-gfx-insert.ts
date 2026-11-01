import { Bound } from "@virgultum/global/gfx";

import type { MermaidVisualNodeShape } from "./families/runtime/gfx-model.js";

export function resolveMermaidGfxPendingNodeInsert({
  ownerXywh,
  modelPoint,
  pendingShape,
}: {
  ownerXywh: string;
  modelPoint: { x: number; y: number };
  pendingShape: MermaidVisualNodeShape | null;
}) {
  if (!pendingShape) return null;
  const ownerBound = Bound.deserialize(ownerXywh);

  return {
    centerX: modelPoint.x - ownerBound.x,
    centerY: modelPoint.y - ownerBound.y,
    shape: pendingShape,
  };
}
