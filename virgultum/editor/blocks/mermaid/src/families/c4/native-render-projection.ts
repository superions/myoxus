// SPDX-License-Identifier: AGPL-3.0-or-later

import { parseMermaidC4SourceWithDiagnostics } from "../../engine/c4/index.js";
import { resolveMermaidDiagramTitle } from "../../engine/diagram-title.js";
import { c4DiagramTitle } from "./diagram-title.js";

type Point = { x: number; y: number };
export type C4NativeRenderShape = {
  alias: string;
  techn?: unknown;
  intersect?: (point: Point) => Point;
  [field: string]: unknown;
};
export type C4NativeRenderDb = {
  getTitle: () => string;
  getAccTitle: () => string;
  getC4ShapeArray: (parent?: string | null) => C4NativeRenderShape[];
  getC4Shape: (alias: string) => C4NativeRenderShape | undefined;
  getRels: () => Record<string, unknown>[];
};

/** Only the pinned public C4 DB ports participate in this serialized render turn. */
export function isC4NativeRenderDb(db: unknown): db is C4NativeRenderDb {
  return (
    !!db &&
    typeof db === "object" &&
    [
      "getTitle",
      "getAccTitle",
      "getC4ShapeArray",
      "getC4Shape",
      "getRels",
    ].every(
      (key) =>
        key in db && typeof (db as Record<string, unknown>)[key] === "function",
    )
  );
}

function renderRecord<T extends Record<string, unknown>>(record: T): T {
  const projected = { ...record };
  for (const key of ["label", "type", "typeC4Shape", "techn", "descr"]) {
    const value = record[key];
    if (key === "techn" && typeof value === "string")
      projected[key as keyof T] = { text: value } as T[keyof T];
    else if (value && typeof value === "object" && "text" in value)
      projected[key as keyof T] = { ...value } as T[keyof T];
  }
  return projected;
}

/** Preserve native contours for a coincident endpoint too. Feeding a rectangle
 * its own centre produces 0/0; an outward point on that ray yields the existing
 * contour intersection without inventing a loop, port or persisted coordinate. */
function intersectingShape(shape: C4NativeRenderShape) {
  const intersect = shape.intersect;
  if (!intersect) return shape;
  return {
    ...shape,
    intersect: (point: Point) => {
      const { x, y, width, height } = shape;
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof width === "number" &&
        typeof height === "number" &&
        [x, y, width, height].every(Number.isFinite) &&
        point.x === x + width / 2 &&
        point.y === y + height / 2
      )
        return intersect.call(shape, {
          x: point.x + Math.max(width, height, 1),
          y: point.y,
        });
      return intersect.call(shape, point);
    },
  };
}

/** Native Technology updates supply STRING while drawing consumes TextData.
 * One identity cache lets drawing and relation lookup share measured geometry;
 * cloned text carriers also prevent Dynamic from prefixing the DB label itself.
 * The caller must restore these getters in its render-turn finally block. */
export function adaptC4NativeRender(
  source: string,
  db: C4NativeRenderDb,
): () => void {
  const parsed = parseMermaidC4SourceWithDiagnostics(source),
    model = parsed.model;
  const unsupported = parsed.diagnostics.find(
    (d) =>
      d.severity === "error" ||
      (d.blocksNativeRendering && d.code !== "c4.native.technology-string"),
  );
  if (!model || !parsed.projectionRenderable || unsupported)
    throw new Error(unsupported?.message ?? "Invalid C4 render Source");
  const title = resolveMermaidDiagramTitle({
    source,
    diagramType: "c4",
    familyTitle: c4DiagramTitle,
  }).value;
  const original = {
    getTitle: db.getTitle,
    getAccTitle: db.getAccTitle,
    getC4ShapeArray: db.getC4ShapeArray,
    getC4Shape: db.getC4Shape,
    getRels: db.getRels,
  };
  const shapes = new WeakMap<C4NativeRenderShape, C4NativeRenderShape>();
  const shape = (native: C4NativeRenderShape) => {
    let projected = shapes.get(native);
    if (!projected) {
      projected = renderRecord(native);
      shapes.set(native, projected);
    }
    return projected;
  };
  db.getTitle = () => title;
  db.getAccTitle = () => model.accessibilityTitle;
  db.getC4ShapeArray = (parent) =>
    original.getC4ShapeArray.call(db, parent).map(shape);
  db.getC4Shape = (alias) => {
    const native = original.getC4Shape.call(db, alias);
    return native ? intersectingShape(shape(native)) : undefined;
  };
  db.getRels = () => original.getRels.call(db).map(renderRecord);
  return () => Object.assign(db, original);
}
