// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidC4Boundary,
  MermaidC4Element,
  MermaidC4Model,
} from "../../engine/c4/index.js";
import { readC4Config } from "../../engine/c4/config.js";
import type { MermaidC4Config } from "../../engine/c4/runtime-contract.js";
import { c4NativeSourceStyles } from "./style-projection.js";
import { projectC4ElementNode, c4ContentGeometry } from "./node-projection.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import { c4BoundaryPresentation } from "./gfx-data.js";
import {
  c4BoundaryHeaderHeight,
  c4BoundaryDisplayLabel,
  projectC4BoundaryPresentation,
} from "./boundary-projection.js";
/** Native 11.17.2 spacing contract; all values are renderer geometry. */
export function c4LayoutGeometry(config: MermaidC4Config) {
  const margin = Math.max(0, config.c4ShapeMargin ?? 50);
  return {
    left: Math.max(0, config.diagramMarginX ?? 50),
    top: Math.max(0, config.diagramMarginY ?? 10),
    gap: margin * 2,
    rowOffset: config.nextLinePaddingX ?? 0,
    paddingX: margin,
    paddingTop: margin,
    paddingBottom: margin,
    minWidth: c4ContentGeometry(config).width + margin * 2,
    minHeight: Math.max(1, margin * 2),
  };
}
type C4LayoutGeometry = ReturnType<typeof c4LayoutGeometry>;

type C4LayoutItem = {
  readonly height: number;
  readonly id: string;
  readonly width: number;
};

type C4PackedLayout = {
  readonly height: number;
  readonly positions: ReadonlyMap<string, { x: number; y: number }>;
  readonly width: number;
};

function packC4Grid(
  items: readonly C4LayoutItem[],
  columns: number,
  geometry: C4LayoutGeometry,
) {
  const safeColumns = Math.max(1, columns);
  const rows: C4LayoutItem[][] = [];
  for (let index = 0; index < items.length; index += safeColumns) {
    rows.push(items.slice(index, index + safeColumns));
  }
  const positions = new Map<string, { x: number; y: number }>();
  let y = 0;
  let width = 0;
  let left = 0;
  for (const [rowIndex, row] of rows.entries()) {
    let x = rowIndex ? geometry.rowOffset : 0;
    left = Math.min(left, x);
    const rowHeight = Math.max(0, ...row.map((item) => item.height));
    for (const item of row) {
      positions.set(item.id, { x, y });
      x += item.width + geometry.gap;
    }
    width = Math.max(width, Math.max(0, x - geometry.gap));
    y += rowHeight + geometry.gap;
  }
  // A negative native row offset expands the enclosing body instead of losing
  // children outside its bounds; the relative row displacement stays intact.
  if (left < 0) for (const position of positions.values()) position.x -= left;
  return {
    height: Math.max(0, y - geometry.gap),
    positions,
    width: width - left,
  } satisfies C4PackedLayout;
}

/** An explicit Source move packs only its previewed parents, using retained
 * object sizes. Translating a sibling boundary preserves its descendants' local
 * presentation; label/style edits never call this operation. */
export function reflowC4SourceScopes(
  visual: MermaidVisualModel,
  model: MermaidC4Model,
  scopes: readonly (string | null)[],
): MermaidVisualModel {
  if (visual.diagramType !== "c4" || !scopes.length) return visual;
  const geometry = c4LayoutGeometry(readC4Config(model.sourceDocument).config);
  const nodes = new Map(visual.nodes.map((n) => [n.id, { ...n }]));
  const groups = new Map(visual.subgraphs?.map((g) => [g.id, { ...g }]));
  const aliases = new Map(
    model.boundaries.map((b) => [b.alias, b.resolution!.selectionId]),
  );
  const parents = new Map<string, string | null>([
    ...model.elements.map(
      (e) =>
        [e.resolution!.selectionId, aliases.get(e.boundaryId) ?? null] as const,
    ),
    ...model.boundaries.map(
      (b) =>
        [b.resolution!.selectionId, aliases.get(b.parentId) ?? null] as const,
    ),
  ]);
  const depth = (id: string | null) => {
    let parent = id,
      result = 0;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      result++;
      parent = parents.get(parent) ?? null;
    }
    return result;
  };
  const translate = (id: string, dx: number, dy: number) => {
    const pending = [id],
      seen = new Set<string>();
    while (pending.length) {
      const key = pending.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = groups.get(key) ?? nodes.get(key);
      if (!item) continue;
      item.x += dx;
      item.y += dy;
      const group = groups.get(key);
      if (group) {
        const expanded = c4BoundaryPresentation(
          group.familyData,
        ).expandedBounds;
        if (expanded)
          group.familyData = createMermaidVisualFamilyData("c4", {
            ...mermaidVisualFamilyPayload(group.familyData, "c4"),
            expandedBounds: {
              ...expanded,
              x: expanded.x + dx,
              y: expanded.y + dy,
            },
          });
        pending.push(
          ...[...parents]
            .filter(([, parent]) => parent === key)
            .map(([child]) => child),
        );
      }
    }
  };
  // Pack inner scopes first so their new extents participate in outer packing.
  for (const scope of [...new Set(scopes)].sort(
    (a, b) => depth(b) - depth(a),
  )) {
    const parent = scope ? groups.get(scope) : undefined;
    if (scope && !parent) continue;
    const boundaries = model.boundaries
      .filter((b) => parents.get(b.resolution!.selectionId) === scope)
      .sort((a, b) => a.order - b.order)
      .flatMap((b) => {
        const group = groups.get(b.resolution!.selectionId);
        if (!group) return [];
        const expanded = c4BoundaryPresentation(group.familyData);
        return [
          {
            id: group.id,
            width: expanded.collapsed
              ? (expanded.expandedBounds?.width ?? group.width)
              : group.width,
            height: expanded.collapsed
              ? (expanded.expandedBounds?.height ?? group.height)
              : group.height,
          },
        ];
      });
    const elements = model.elements
      .filter((e) => parents.get(e.resolution!.selectionId) === scope)
      .sort((a, b) => a.order - b.order)
      .flatMap((e) => {
        const node = nodes.get(e.resolution!.selectionId);
        return node
          ? [{ id: node.id, width: node.width, height: node.height }]
          : [];
      });
    const childLayout = packC4Grid(
        boundaries,
        model.layoutBoundaryInRow,
        geometry,
      ),
      elementLayout = packC4Grid(elements, model.layoutShapeInRow, geometry);
    const gap = boundaries.length && elements.length ? geometry.gap : 0;
    if (parent)
      parent.width = Math.max(
        geometry.minWidth,
        Math.max(childLayout.width, elementLayout.width) +
          geometry.paddingX * 2,
      );
    const x = parent ? parent.x + geometry.paddingX : geometry.left;
    const y = parent
      ? parent.y + Math.max(geometry.paddingTop, c4BoundaryHeaderHeight(parent))
      : geometry.top;
    for (const [id, position] of childLayout.positions) {
      const group = groups.get(id)!;
      translate(id, x + position.x - group.x, y + position.y - group.y);
    }
    for (const [id, position] of elementLayout.positions) {
      const node = nodes.get(id)!;
      node.x = x + position.x;
      node.y = y + childLayout.height + gap + position.y;
    }
    if (parent) {
      const width = parent.width;
      const height = Math.max(
        geometry.minHeight,
        y -
          parent.y +
          childLayout.height +
          gap +
          elementLayout.height +
          geometry.paddingBottom,
      );
      const presentation = c4BoundaryPresentation(parent.familyData);
      if (presentation.collapsed)
        parent.familyData = createMermaidVisualFamilyData("c4", {
          ...mermaidVisualFamilyPayload(parent.familyData, "c4"),
          expandedBounds: { x: parent.x, y: parent.y, width, height },
        });
      else parent.height = height;
    }
  }
  return projectC4BoundaryPresentation({
    ...visual,
    nodes: visual.nodes.map((n) => nodes.get(n.id)!),
    subgraphs: visual.subgraphs?.map((g) => groups.get(g.id)!),
  });
}

export function layoutC4Diagram(model: MermaidC4Model) {
  const {
    boundaries,
    elements,
    layoutShapeInRow: shapeColumns,
    layoutBoundaryInRow: boundaryColumns,
    sourceDocument: document,
  } = model;
  const config = readC4Config(document).config;
  const geometry = c4LayoutGeometry(config);
  const sizes = new Map(
    elements.map((element) => {
      const node = projectC4ElementNode(element, config, document);
      return [
        element.id,
        { id: element.id, width: node.width, height: node.height },
      ] as const;
    }),
  );
  const boundariesByParent = new Map<string, MermaidC4Boundary[]>();
  for (const boundary of boundaries) {
    const siblings = boundariesByParent.get(boundary.parentId) ?? [];
    siblings.push(boundary);
    boundariesByParent.set(boundary.parentId, siblings);
  }
  for (const siblings of boundariesByParent.values()) {
    siblings.sort((a, b) => a.order - b.order);
  }
  const elementsByBoundary = new Map<string, MermaidC4Element[]>();
  for (const element of elements) {
    const siblings = elementsByBoundary.get(element.boundaryId) ?? [];
    siblings.push(element);
    elementsByBoundary.set(element.boundaryId, siblings);
  }
  for (const siblings of elementsByBoundary.values()) {
    siblings.sort((a, b) => a.order - b.order);
  }

  type BoundaryLayout = C4LayoutItem & {
    readonly childLayout: C4PackedLayout;
    readonly elementLayout: C4PackedLayout;
    readonly elementStartY: number;
    readonly headerHeight: number;
  };
  const measured = new Map<string, BoundaryLayout>();
  const visiting = new Set<string>();
  const measureBoundary = (boundary: MermaidC4Boundary): BoundaryLayout => {
    const cached = measured.get(boundary.id);
    if (cached) return cached;
    if (visiting.has(boundary.id)) {
      throw new Error("Cyclic Mermaid C4 boundary hierarchy");
    }
    visiting.add(boundary.id);
    const childLayout = packC4Grid(
      (boundariesByParent.get(boundary.id) ?? []).map(measureBoundary),
      boundaryColumns,
      geometry,
    );
    const elementLayout = packC4Grid(
      (elementsByBoundary.get(boundary.id) ?? []).map((element) =>
        sizes.get(element.id)!,
      ),
      shapeColumns,
      geometry,
    );
    const hasChildren = childLayout.positions.size > 0;
    const hasElements = elementLayout.positions.size > 0;
    const width = Math.max(
      geometry.minWidth,
      Math.max(childLayout.width, elementLayout.width) + geometry.paddingX * 2,
    );
    const headerHeight = Math.max(
      geometry.paddingTop,
      c4BoundaryHeaderHeight({
        width,
        title: boundary.label,
        displayLabel: c4BoundaryDisplayLabel(boundary),
        familyData: createMermaidVisualFamilyData("c4", {
          effectiveSprite: boundary.sprite,
          styles: c4NativeSourceStyles(boundary, config),
        }),
      }),
    );
    const elementStartY =
      headerHeight +
      childLayout.height +
      (hasChildren && hasElements ? geometry.gap : 0);
    const contentHeight =
      childLayout.height +
      (hasChildren && hasElements ? geometry.gap : 0) +
      elementLayout.height;
    const layout: BoundaryLayout = {
      childLayout,
      elementLayout,
      elementStartY,
      headerHeight,
      height: Math.max(
        geometry.minHeight,
        headerHeight + contentHeight + geometry.paddingBottom,
      ),
      id: boundary.id,
      width,
    };
    visiting.delete(boundary.id);
    measured.set(boundary.id, layout);
    return layout;
  };

  const rootBoundaries = boundariesByParent.get("") ?? [];
  const rootBoundaryLayout = packC4Grid(
    rootBoundaries.map(measureBoundary),
    boundaryColumns,
    geometry,
  );
  if (measured.size !== boundaries.length) {
    throw new Error("Disconnected Mermaid C4 boundary hierarchy");
  }
  const rootElementLayout = packC4Grid(
    (elementsByBoundary.get("") ?? []).map((element) => sizes.get(element.id)!),
    shapeColumns,
    geometry,
  );
  const rootElementStartY =
    geometry.top +
    rootBoundaryLayout.height +
    (rootBoundaryLayout.positions.size && rootElementLayout.positions.size
      ? geometry.gap
      : 0);
  const positionedBoundaries = new Map<string, MermaidC4Boundary>();
  const positionedElements = new Map<string, MermaidC4Element>();
  const placeBoundary = (boundary: MermaidC4Boundary, x: number, y: number) => {
    const layout = measured.get(boundary.id);
    if (!layout) throw new Error("Missing Mermaid C4 boundary layout");
    positionedBoundaries.set(boundary.id, {
      ...boundary,
      height: layout.height,
      width: layout.width,
      x,
      y,
    });
    for (const child of boundariesByParent.get(boundary.id) ?? []) {
      const position = layout.childLayout.positions.get(child.id);
      if (!position) continue;
      placeBoundary(
        child,
        x + geometry.paddingX + position.x,
        y + layout.headerHeight + position.y,
      );
    }
    for (const element of elementsByBoundary.get(boundary.id) ?? []) {
      const position = layout.elementLayout.positions.get(element.id);
      const size = sizes.get(element.id)!;
      if (!position) continue;
      positionedElements.set(element.id, {
        ...element,
        width: size.width,
        x: x + geometry.paddingX + position.x,
        y: y + layout.elementStartY + position.y,
      });
    }
  };
  for (const boundary of rootBoundaries) {
    const position = rootBoundaryLayout.positions.get(boundary.id);
    if (position) {
      placeBoundary(
        boundary,
        geometry.left + position.x,
        geometry.top + position.y,
      );
    }
  }
  for (const element of elementsByBoundary.get("") ?? []) {
    const position = rootElementLayout.positions.get(element.id);
    const size = sizes.get(element.id)!;
    if (!position) continue;
    positionedElements.set(element.id, {
      ...element,
      width: size.width,
      x: geometry.left + position.x,
      y: rootElementStartY + position.y,
    });
  }
  return {
    boundaries: boundaries.map((boundary) => {
      const positioned = positionedBoundaries.get(boundary.id);
      if (!positioned) throw new Error("Missing Mermaid C4 boundary position");
      return positioned;
    }),
    elements: elements.map((element) => {
      const positioned = positionedElements.get(element.id);
      if (!positioned) throw new Error("Missing Mermaid C4 element position");
      return positioned;
    }),
  };
}
