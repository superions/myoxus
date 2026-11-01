// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import type { MermaidMindmapModel } from "../../../engine/mindmap/index.js";
import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import type { MermaidGfxActionContext } from "../../runtime/editor-capabilities.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import { mermaidVisualFamilyPayload } from "../../runtime/gfx-family-data.js";

type Rect = { left: number; top: number; width: number; height: number };
type Point = { left: number; top: number };
export type MindmapNodeHandlePlan = {
  key: string;
  bounds: Rect;
  clientBounds: Rect;
  actions: {
    id: string;
    kind: "add-child" | "add-sibling" | "toggle-collapse";
    side?: LayoutType.LEFT | LayoutType.RIGHT;
    point: Point;
    clientPoint: Point;
    hit: Rect;
  }[];
};

export function mindmapChildSideOptions(
  visual: MermaidVisualModel,
  model: MermaidMindmapModel,
  key: string,
  parentKey?: string,
  side?: LayoutType.LEFT | LayoutType.RIGHT,
) {
  const options = { ...readMindmapProjectionOptions(visual) };
  // Creating a child reveals it in the same accepted history operation.
  if (parentKey && options.collapsed?.has(parentKey)) {
    const collapsed = new Set(options.collapsed);
    collapsed.delete(parentKey);
    options.collapsed = collapsed;
  }
  if (
    side === undefined ||
    !model.nodes.find((n) => n.sourceKey === parentKey)?.root
  )
    return options;
  return { ...options, rootSides: new Map(options.rootSides).set(key, side) };
}

/** Existing Selected-Rect spacing separates creation from the renderer's
 * collapse glyph. Bounds are native measurements, never inferred hierarchy. */
export function mindmapNodeHandlePlans(
  model: MermaidMindmapModel,
  visual: MermaidVisualModel,
  resolve: NonNullable<MermaidGfxActionContext["resolveVisualBounds"]>,
): MindmapNodeHandlePlan[] {
  const options = readMindmapProjectionOptions(visual);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const byKey = new Map(visual.nodes.map((n) => [n.id, n]));
  const parents = new Set(model.nodes.map((n) => n.parentId));
  // One viewport snapshot per plan. Obstacle checks must not perform a DOM
  // measurement for every pair of nodes in a large tree.
  const geometry = new Map(
    model.nodes
      .filter((node) => byKey.has(node.sourceKey))
      .map((node) => [
        node.sourceKey,
        {
          bounds: resolve("node", node.sourceKey),
          clientBounds: resolve("node", node.sourceKey, true),
        },
      ]),
  );
  return model.nodes
    .filter((node) => byKey.has(node.sourceKey))
    .flatMap((node) => {
      let branch = node;
      while (branch.parentId) {
        const parent = byId.get(branch.parentId)!;
        if (options.collapsed?.has(parent.sourceKey)) return [];
        if (parent.root) break;
        branch = parent;
      }
      const { bounds, clientBounds } = geometry.get(node.sourceKey)!;
      if (!bounds || !clientBounds) return [];
      const shape = byKey.get(node.sourceKey);
      const presentation =
        shape &&
        mermaidVisualFamilyPayload(shape.familyData, "mindmap")?.presentation;
      const collapseSize =
        presentation &&
        typeof presentation === "object" &&
        !Array.isArray(presentation) &&
        "collapseSize" in presentation &&
        typeof presentation.collapseSize === "number"
          ? presentation.collapseSize
          : 0;
      const zoom = shape ? bounds.width / shape.width : 1;
      const scale = bounds.width ? clientBounds.width / bounds.width : 1;
      const hasChildren = parents.has(node.id);
      const direction =
        options.layout === LayoutType.BALANCE
          ? node.root
            ? LayoutType.BALANCE
            : (options.rootSides?.get(branch.sourceKey) ?? LayoutType.RIGHT)
          : (options.layout ?? LayoutType.RIGHT);
      const sides =
        direction === LayoutType.BALANCE
          ? ([LayoutType.RIGHT, LayoutType.LEFT] as const)
          : [direction];
      const margin = 13 + (hasChildren ? 32 * zoom : 6);
      const client = (point: Point): Point => ({
        left: clientBounds.left + (point.left - bounds.left) * scale,
        top: clientBounds.top + (point.top - bounds.top) * scale,
      });
      const action = (
        id: string,
        kind: "add-child" | "add-sibling" | "toggle-collapse",
        point: Point,
        side?: LayoutType.LEFT | LayoutType.RIGHT,
      ) => {
        const clientPoint = client(point),
          radius = 14 * scale;
        return {
          id,
          kind,
          side,
          point,
          clientPoint,
          hit: {
            left: Math.min(clientBounds.left, clientPoint.left - radius),
            top: Math.min(clientBounds.top, clientPoint.top - radius),
            width:
              Math.max(
                clientBounds.left + clientBounds.width,
                clientPoint.left + radius,
              ) - Math.min(clientBounds.left, clientPoint.left - radius),
            height:
              Math.max(
                clientBounds.top + clientBounds.height,
                clientPoint.top + radius,
              ) - Math.min(clientBounds.top, clientPoint.top - radius),
          },
        };
      };
      const actions = sides.map((side) =>
        action(
          `child-${side}`,
          "add-child",
          {
            left:
              side === LayoutType.LEFT
                ? bounds.left - margin
                : bounds.left + bounds.width + margin,
            top: bounds.top + bounds.height / 2,
          },
          side,
        ),
      );
      if (!node.root) {
        let left = bounds.left + bounds.width / 2;
        const bottom = bounds.top + bounds.height;
        const obstacles = model.nodes.flatMap((other) =>
          other.sourceKey === node.sourceKey
            ? []
            : (geometry.get(other.sourceKey)?.bounds ?? []),
        );
        const next = obstacles
          .filter(
            (other) =>
              other.top >= bottom &&
              left + 14 >= other.left &&
              left - 14 <= other.left + other.width,
          )
          .sort((a, b) => a.top - b.top)[0];
        const top =
          bottom +
          (next && next.top - bottom >= 28
            ? Math.min(19, (next.top - bottom) / 2)
            : 19);
        const band = obstacles.filter(
          (other) =>
            top + 14 > other.top && top - 14 < other.top + other.height,
        );
        // Low native zoom can leave less than one hit surface between rows.
        // Keep its normal below-node position where possible; otherwise place
        // the hit surface beyond the row's protected object bounds.
        if (
          band.some(
            (other) =>
              left + 14 > other.left && left - 14 < other.left + other.width,
          )
        )
          left =
            direction === LayoutType.LEFT
              ? Math.min(bounds.left, ...band.map((b) => b.left)) - 19
              : Math.max(
                  bounds.left + bounds.width,
                  ...band.map((b) => b.left + b.width),
                ) + 19;
        actions.push(
          action("sibling", "add-sibling", {
            left,
            top,
          }),
        );
      }
      if (hasChildren)
        actions.push(
          action("collapse", "toggle-collapse", {
            left:
              direction === LayoutType.LEFT
                ? bounds.left - (6 + collapseSize / 2) * zoom
                : bounds.left + bounds.width + (6 + collapseSize / 2) * zoom,
            top: bounds.top + bounds.height / 2,
          }),
        );
      return [{ key: node.sourceKey, bounds, clientBounds, actions }];
    });
}

function includes(rect: Rect, x: number, y: number) {
  return (
    x >= rect.left &&
    x <= rect.left + rect.width &&
    y >= rect.top &&
    y <= rect.top + rect.height
  );
}

/** Retain hover across the gap into a handle's response zone. Another node
 * still wins when entered; this never changes Source selection or tree order. */
export function mindmapHandleHover(
  plans: readonly MindmapNodeHandlePlan[],
  x: number,
  y: number,
  previous: string | null,
) {
  return (
    plans.find((p) => includes(p.clientBounds, x, y))?.key ??
    plans.find(
      (p) => p.key === previous && p.actions.some((a) => includes(a.hit, x, y)),
    )?.key ??
    null
  );
}
