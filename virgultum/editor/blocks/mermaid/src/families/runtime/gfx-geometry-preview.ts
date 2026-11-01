// SPDX-License-Identifier: AGPL-3.0-or-later
import { Bound } from "@virgultum/global/gfx";
import {
  ConnectorElementModel,
  ShapeElementModel,
  type MermaidBlockModel,
} from "@virgultum/model";
import { getGfxMeta } from "../../commands/materialization.js";
import { resolveMermaidGfxProjectionOwner } from "../../presentation/gfx-projection-owner.js";
import { getMermaidBlockSource } from "../../utils.js";
import type { MermaidVisualModel } from "./gfx-model.js";

/** Stash only the active Surface wrappers. The caller defers owner readback
 * until release; a scoped viewport must not also mutate its persisted owner. */
export function beginMermaidGeometryPreview(
  owner: MermaidBlockModel,
  model: MermaidVisualModel,
  viewportIdentity?: object,
  resolveVisibleElement?: (id: string) => unknown,
) {
  const projection = resolveMermaidGfxProjectionOwner(owner);
  if (!projection) return null;
  const shapes = projection.childElementIds.flatMap((id) => {
    const element = resolveVisibleElement
      ? resolveVisibleElement(id)
      : projection.getElementById(id);
    if (!(element instanceof ShapeElementModel)) return [];
    const xywh = element.xywh;
    element.stash("xywh");
    return [{ element, xywh }];
  });
  const connectors = projection.childElementIds.flatMap((id) => {
    const element = resolveVisibleElement
      ? resolveVisibleElement(id)
      : projection.getElementById(id);
    if (!(element instanceof ConnectorElementModel)) return [];
    const xywh = element.xywh,
      labelXYWH = element.labelXYWH,
      path = element.path;
    element.stash("xywh");
    element.stash("labelXYWH");
    return [{ element, xywh, labelXYWH, path }];
  });
  return {
    model,
    viewportIdentity,
    source: getMermaidBlockSource(owner.props),
    shapes,
    connectors,
  };
}
export type MermaidGeometryPreview = NonNullable<
  ReturnType<typeof beginMermaidGeometryPreview>
>;

/** Keep the gesture's original coordinate origin when its first node moves. */
export function readMermaidGeometryPreview(
  preview: MermaidGeometryPreview,
): MermaidVisualModel {
  const geometry = (
    id: string,
    key: string,
    original: { x: number; y: number; width: number; height: number },
  ) => {
    const shape = preview.shapes.find(
      ({ element }) => getGfxMeta(element, key) === id,
    );
    if (!shape) return original;
    const before = Bound.deserialize(shape.xywh),
      after = Bound.deserialize(shape.element.xywh);
    return {
      x: original.x + after.x - before.x,
      y: original.y + after.y - before.y,
      width: after.w,
      height: after.h,
    };
  };
  return {
    ...preview.model,
    nodes: preview.model.nodes.map((node) => ({
      ...node,
      ...geometry(node.id, "mermaidNodeId", node),
    })),
    subgraphs: preview.model.subgraphs?.map((group) => ({
      ...group,
      ...geometry(group.id, "mermaidSubgraphId", group),
    })),
  };
}

export function previewMermaidNodeSize(
  preview: MermaidGeometryPreview,
  id: string,
  width: number,
  height: number,
) {
  const target = preview.shapes.find(
    ({ element }) => getGfxMeta(element, "mermaidNodeId") === id,
  );
  if (!target) return;
  const original = Bound.deserialize(target.xywh);
  target.element.xywh = new Bound(
    original.x,
    original.y,
    width,
    height,
  ).serialize();
  for (const { element, xywh } of preview.shapes) {
    if (getGfxMeta(element, "mermaidDetailOwnerNodeId") !== id) continue;
    const bound = Bound.deserialize(xywh);
    element.xywh = new Bound(
      bound.x,
      bound.y,
      Math.max(1, bound.w + width - original.w),
      bound.h,
    ).serialize();
  }
}
export function previewMermaidSubgraphBound(
  preview: MermaidGeometryPreview,
  id: string,
  change: { x?: number; y?: number; width?: number; height?: number },
) {
  const target = preview.shapes.find(
    ({ element }) => getGfxMeta(element, "mermaidSubgraphId") === id,
  );
  if (!target) return;
  const original = Bound.deserialize(target.xywh),
    dx = (change.x ?? original.x) - original.x,
    dy = (change.y ?? original.y) - original.y;
  const groups = new Set([id]),
    nodes = new Set<string>();
  const visit = (key: string) => {
    const group = preview.model.subgraphs?.find((group) => group.id === key);
    for (const nodeId of group?.nodeIds ?? []) nodes.add(nodeId);
    for (const child of preview.model.subgraphs ?? []) {
      if (child.parentId !== key || groups.has(child.id)) continue;
      groups.add(child.id);
      visit(child.id);
    }
  };
  visit(id);
  for (const { element, xywh } of preview.shapes) {
    const groupId = getGfxMeta(element, "mermaidSubgraphId"),
      nodeId =
        getGfxMeta(element, "mermaidNodeId") ||
        getGfxMeta(element, "mermaidDetailOwnerNodeId");
    if (!groups.has(groupId) && !nodes.has(nodeId)) continue;
    const bound = Bound.deserialize(xywh);
    element.xywh = new Bound(
      bound.x + dx,
      bound.y + dy,
      element === target.element ? (change.width ?? bound.w) : bound.w,
      element === target.element ? (change.height ?? bound.h) : bound.h,
    ).serialize();
  }
}
export function releaseMermaidGeometryPreview(preview: MermaidGeometryPreview) {
  for (const { element, xywh } of preview.shapes) {
    element.xywh = xywh;
    element.pop("xywh");
  }
  for (const { element, xywh, labelXYWH, path } of preview.connectors) {
    element.xywh = xywh;
    element.labelXYWH = labelXYWH;
    element.path = path;
    element.pop("xywh");
    element.pop("labelXYWH");
  }
}
