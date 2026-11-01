import { Bound } from "@virgultum/global/gfx";

import type { MermaidGfxArrowDirection } from "./mermaid-gfx-node-selection.js";

export type MermaidGfxResizeStart = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type MermaidGfxResizeTargetKind = "node" | "subgraph";

export type MermaidGfxResizableModel = {
  xywh?: string;
};

export type MermaidGfxResolvedResizeTarget = {
  id: string;
  kind: MermaidGfxResizeTargetKind;
  xywh: string;
};

export function resolveMermaidGfxResizeTarget({
  isReadonly,
  kind,
  nodeId,
  nodeModel,
  subgraphId,
  subgraphModel,
}: {
  isReadonly: boolean;
  kind: MermaidGfxResizeTargetKind;
  nodeId: string;
  nodeModel?: MermaidGfxResizableModel | null;
  subgraphId: string;
  subgraphModel?: MermaidGfxResizableModel | null;
}): MermaidGfxResolvedResizeTarget | null {
  if (isReadonly) return null;

  const id = kind === "node" ? nodeId : subgraphId;
  const model = kind === "node" ? nodeModel : subgraphModel;
  if (!id || !model?.xywh) return null;

  return {
    id,
    kind,
    xywh: model.xywh,
  };
}

export function mermaidGfxResizeCoalesceKey({
  id,
  kind,
}: {
  id: string;
  kind: MermaidGfxResizeTargetKind;
}) {
  return `flowchart-${kind}-resize:${id}`;
}

export function resizeMermaidGfxBoundByDirection({
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
    height:
      direction === "down"
        ? bound.h + step
        : direction === "up"
          ? bound.h - step
          : bound.h,
    width:
      direction === "right"
        ? bound.w + step
        : direction === "left"
          ? bound.w - step
          : bound.w,
  };
}

export function createMermaidGfxResizeStart({
  pointer,
  xywh,
}: {
  pointer: { x: number; y: number };
  xywh: string;
}): MermaidGfxResizeStart {
  const bound = Bound.deserialize(xywh);
  return {
    height: bound.h,
    width: bound.w,
    x: pointer.x,
    y: pointer.y,
  };
}

export function resizeMermaidGfxBoundFromDrag({
  pointer,
  start,
}: {
  pointer: { x: number; y: number };
  start: MermaidGfxResizeStart;
}) {
  return {
    height: start.height + pointer.y - start.y,
    width: start.width + pointer.x - start.x,
  };
}

export function resizeMermaidViewportHeightByDirection({
  currentHeight,
  direction,
  step,
}: {
  currentHeight: number;
  direction: MermaidGfxArrowDirection;
  step: number;
}) {
  if (direction === "down") return currentHeight + step;
  if (direction === "up") return currentHeight - step;
  return null;
}
