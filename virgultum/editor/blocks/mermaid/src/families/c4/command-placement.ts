// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Model } from "../../engine/c4/index.js";
import { readC4Config } from "../../engine/c4/config.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import { c4LayoutGeometry } from "./layout.js";
import { c4BoundaryHeaderHeight } from "./boundary-projection.js";
import { c4BoundaryPresentation } from "./gfx-data.js";

type Item = { id: string; x: number; y: number; width: number; height: number };

/** Insert against the live Source siblings, without replaying their parser layout.
 * Only new objects move. Their Source ancestors may grow to contain the addition. */
export function placeNewC4CommandObjects(
  visual: MermaidVisualModel,
  stored: MermaidVisualModel,
  source: MermaidC4Model,
  selectionBoundary?: string,
): MermaidVisualModel {
  const retained = new Set([
    ...stored.nodes.map((n) => n.id),
    ...(stored.subgraphs ?? []).map((g) => g.id),
  ]);
  const added = new Set(
    [
      ...visual.nodes.map((n) => n.id),
      ...(visual.subgraphs ?? []).map((g) => g.id),
    ].filter((id) => !retained.has(id)),
  );
  if (!added.size) return visual;
  const geometry = c4LayoutGeometry(
    readC4Config(source.sourceDocument).effective,
  );
  const nodes = visual.nodes.map((n) => ({ ...n }));
  const groups = (visual.subgraphs ?? []).map((g) => ({ ...g }));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const aliases = new Map(
    source.boundaries.map((b) => [b.alias, b.resolution!.selectionId]),
  );
  const parents = new Map([
    ...source.elements.map(
      (e) =>
        [e.resolution!.selectionId, aliases.get(e.boundaryId) ?? ""] as const,
    ),
    ...source.boundaries.map(
      (b) =>
        [b.resolution!.selectionId, aliases.get(b.parentId) ?? ""] as const,
    ),
  ]);
  const overlaps = (a: Item, b: Item) =>
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
  const placed = new Set(retained);
  const place = (items: Item[], columns: number, boundaries: boolean) => {
    const scopes = new Map<string, Item[]>();
    for (const item of items) {
      const parent = parents.get(item.id) ?? "";
      const siblings = scopes.get(parent) ?? [];
      siblings.push(item);
      scopes.set(parent, siblings);
    }
    for (const [parentId, siblings] of scopes) {
      const parent = groupById.get(parentId);
      const columnsInRow = Math.max(1, columns);
      for (const [index, item] of siblings.entries()) {
        if (retained.has(item.id) || item.id === selectionBoundary) {
          placed.add(item.id);
          continue;
        }
        const row = index - (index % columnsInRow);
        const previous = siblings[index - 1];
        if (previous && index > row) {
          item.x = previous.x + previous.width + geometry.gap;
          item.y = Math.min(...siblings.slice(row, index).map((s) => s.y));
        } else if (previous) {
          item.x = siblings[0].x + geometry.rowOffset;
          item.y =
            Math.max(
              ...siblings
                .slice(Math.max(0, row - columnsInRow), row)
                .map((s) => s.y + s.height),
            ) + geometry.gap;
        } else if (parent) {
          item.x = parent.x + geometry.paddingX;
          item.y =
            parent.y +
            Math.max(geometry.paddingTop, c4BoundaryHeaderHeight(parent));
          if (!boundaries) {
            const children = groups.filter(
              (g) => parents.get(g.id) === parentId,
            );
            if (children.length)
              item.y =
                Math.max(...children.map((g) => g.y + g.height)) + geometry.gap;
          }
        } else if (!boundaries && groups.some((g) => !parents.get(g.id))) {
          item.y =
            Math.max(
              ...groups
                .filter((g) => !parents.get(g.id))
                .map((g) => g.y + g.height),
            ) + geometry.gap;
        }
        if (parent) {
          item.x = Math.max(item.x, parent.x + geometry.paddingX);
          item.y = Math.max(
            item.y,
            parent.y +
              Math.max(geometry.paddingTop, c4BoundaryHeaderHeight(parent)),
          );
        }
        // Whole boundary backgrounds contain their children; only their header
        // bands obstruct an insertion. All live bodies remain obstacles.
        const obstacles: Item[] = [
          ...nodes.filter((n) => placed.has(n.id)),
          ...groups
            .filter((g) => placed.has(g.id) && g.id !== parentId)
            .map((g) => ({ ...g, height: c4BoundaryHeaderHeight(g) })),
        ];
        for (;;) {
          const collisions = obstacles.filter(
            (other) => other.id !== item.id && overlaps(item, other),
          );
          if (!collisions.length) break;
          item.x =
            Math.max(...collisions.map((other) => other.x + other.width)) +
            geometry.gap;
        }
        placed.add(item.id);
      }
    }
  };
  place(groups, source.layoutBoundaryInRow, true);
  place(nodes, source.layoutShapeInRow, false);
  const affected = new Set<string>();
  for (const id of added) {
    let parent = parents.get(id);
    while (parent && !affected.has(parent)) {
      affected.add(parent);
      parent = parents.get(parent);
    }
  }
  const depth = (id: string) => {
    let result = 0;
    for (let parent = parents.get(id); parent; parent = parents.get(parent))
      result++;
    return result;
  };
  for (const id of [...affected].sort((a, b) => depth(b) - depth(a))) {
    const group = groupById.get(id);
    if (!group) continue;
    const presentation = c4BoundaryPresentation(group.familyData);
    const bounds = presentation.collapsed
      ? (presentation.expandedBounds ?? group)
      : group;
    const children = [...nodes, ...groups].filter(
      (child) =>
        parents.get(child.id) === id &&
        (added.has(child.id) || affected.has(child.id)),
    );
    const contentBounds = children.map((child) => {
      const nested = groupById.get(child.id);
      const p = nested && c4BoundaryPresentation(nested.familyData);
      return p?.collapsed ? (p.expandedBounds ?? child) : child;
    });
    const width = Math.max(
      bounds.width,
      ...contentBounds.map(
        (child) => child.x + child.width - bounds.x + geometry.paddingX,
      ),
    );
    const height = Math.max(
      bounds.height,
      ...contentBounds.map(
        (child) => child.y + child.height - bounds.y + geometry.paddingBottom,
      ),
    );
    group.width = width;
    if (presentation.collapsed)
      group.familyData = createMermaidVisualFamilyData("c4", {
        ...mermaidVisualFamilyPayload(group.familyData, "c4"),
        expandedBounds: { x: bounds.x, y: bounds.y, width, height },
      });
    else group.height = height;
  }
  return { ...visual, nodes, subgraphs: groups };
}
