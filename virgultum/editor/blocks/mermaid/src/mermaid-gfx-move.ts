import { Bound } from "@virgultum/global/gfx";

import type { MermaidGfxArrowDirection } from "./mermaid-gfx-node-selection.js";

export type MermaidGfxMoveStart = {
  x: number;
  y: number;
  pointerX: number;
  pointerY: number;
};

export function createMermaidGfxMoveStart({
  pointer,
  xywh,
}: {
  pointer: { x: number; y: number };
  xywh: string;
}): MermaidGfxMoveStart {
  const bound = Bound.deserialize(xywh);
  return {
    pointerX: pointer.x,
    pointerY: pointer.y,
    x: bound.x,
    y: bound.y,
  };
}

export function moveMermaidGfxBoundFromDrag({
  pointer,
  start,
}: {
  pointer: { x: number; y: number };
  start: MermaidGfxMoveStart;
}) {
  return {
    x: start.x + pointer.x - start.pointerX,
    y: start.y + pointer.y - start.pointerY,
  };
}

export function moveMermaidGfxBoundByDirection({
  direction,
  step,
  xywh,
}: {
  direction: MermaidGfxArrowDirection;
  step: number;
  xywh: string;
}) {
  const bound = Bound.deserialize(xywh);
  return {
    x:
      direction === "right"
        ? bound.x + step
        : direction === "left"
          ? bound.x - step
          : bound.x,
    y:
      direction === "down"
        ? bound.y + step
        : direction === "up"
          ? bound.y - step
          : bound.y,
  };
}

export function mermaidGfxMoveCoalesceKey({
  id,
  kind,
}: {
  id: string;
  kind: "subgraph";
}) {
  return `flowchart-${kind}-move:${id}`;
}
