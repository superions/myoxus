import {
  Bound,
  getCenterAreaBounds,
  getPointsFromBoundWithRotation,
  type IBound,
  type IVec,
  linePolygonIntersects,
  pointInPolygon,
  PointLocation,
  pointOnPolygonStoke,
  polygonGetPointTangent,
  polygonNearestPoint,
  rotatePoints,
} from "@virgultum/global/gfx";
import type { PointTestOptions } from "@virgultum/std/gfx";

import {
  DEFAULT_CENTRAL_AREA_RATIO,
  ShapeType,
} from "../../../consts/index.js";
import type { ShapeElementModel } from "../shape.js";
import { ellipse } from "./ellipse.js";

/** One normalized technical contour serves Canvas, DOM SVG and polygon hits. */
export function mermaidContourPoints(
  contour: readonly (readonly [number, number])[],
  { x, y, w, h }: IBound,
): IVec[] {
  return contour
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([px, py]) => [x + w * px, y + h * py]);
}
type SoftShapeSegment =
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, number, number];
const cloudSegments: readonly SoftShapeSegment[] = [
  [-0.04, 0.72, -0.02, 0.32, 0.15, 0.3],
  [0.08, -0.03, 0.39, -0.05, 0.44, 0.14],
  [0.57, -0.07, 0.85, -0.01, 0.85, 0.27],
  [1.04, 0.24, 1.06, 0.65, 0.91, 0.73],
  [1.01, 1.01, 0.68, 1.07, 0.61, 0.89],
  [0.46, 1.08, 0.19, 1.01, 0.21, 0.83],
  [0.17, 0.88, 0.1, 0.86, 0.12, 0.75],
];
const bangSegments: readonly SoftShapeSegment[] = [
  [0.125, 0.2, 0.25, 0],
  [0.375, 0.2, 0.5, 0],
  [0.625, 0.2, 0.75, 0],
  [0.875, 0.2, 1, 0],
  [0.8, 0.165, 1, 0.33],
  [0.8, 0.5, 1, 0.67],
  [0.8, 0.835, 1, 1],
  [0.875, 0.8, 0.75, 1],
  [0.625, 0.8, 0.5, 1],
  [0.375, 0.8, 0.25, 1],
  [0.125, 0.8, 0, 1],
  [0.2, 0.835, 0, 0.67],
  [0.2, 0.5, 0, 0.33],
  [0.2, 0.165, 0, 0],
];

function softShapeParts(
  type: ShapeType,
): { start: IVec; segments: readonly SoftShapeSegment[] } | null {
  return type === ShapeType.MermaidCloud
    ? { start: [0.12, 0.75], segments: cloudSegments }
    : type === ShapeType.MermaidBang
      ? { start: [0, 0], segments: bangSegments }
      : null;
}

/** Cloud lobes and concave Bang scallops share one bounded silhouette across
 * native Canvas/SVG and hit geometry. Its central 64% × 50% protects labels. */
export function mermaidSoftShapePath(
  type: ShapeType,
  w: number,
  h: number,
): string | null {
  const parts = softShapeParts(type);
  if (!parts) return null;
  return `M ${parts.start[0] * w} ${parts.start[1] * h} ${parts.segments
    .map(
      (segment) =>
        `${segment.length === 4 ? "Q" : "C"} ${segment.map((value, index) => value * (index % 2 ? h : w)).join(" ")}`,
    )
    .join(" ")} Z`;
}

function softShapeContour(
  type: ShapeType,
  { x, y, w, h }: IBound,
): IVec[] | null {
  const parts = softShapeParts(type);
  if (!parts) return null;
  let start = parts.start;
  const contour: IVec[] = [[x + start[0] * w, y + start[1] * h]];
  for (const segment of parts.segments) {
    for (let step = 1; step <= 12; step++) {
      const t = step / 12,
        u = 1 - t;
      const coordinate = (axis: number) =>
        segment.length === 4
          ? u * u * start[axis] +
            2 * u * t * segment[axis] +
            t * t * segment[axis + 2]
          : u * u * u * start[axis] +
            3 * u * u * t * segment[axis] +
            3 * u * t * t * segment[axis + 2] +
            t * t * t * segment[axis + 4];
      contour.push([x + coordinate(0) * w, y + coordinate(1) * h]);
    }
    start = [segment[segment.length - 2], segment[segment.length - 1]];
  }
  return contour;
}

/** Shared silhouette, body text region and drawing primitives for a neutral Person.
 * The head overlaps the rounded body; ports and hits use the union's contour,
 * never the blank corners of the object's bounding rectangle. */
export function mermaidPersonGeometry(width: number, height: number) {
  const w = Math.max(1, width),
    h = Math.max(1, height);
  const radius = Math.min(Math.max(w * 0.23, 16), 56, h / 3, w * 0.4);
  const bodyTop = radius * 1.73,
    bodyHeight = h - bodyTop;
  const bodyRadius = Math.min(w * 0.177, bodyHeight * 0.45);
  const contour: IVec[] = [];
  const arc = (
    cx: number,
    cy: number,
    r: number,
    start: number,
    end: number,
    steps: number,
  ) => {
    for (let i = 0; i <= steps; i++) {
      const angle = start + ((end - start) * i) / steps;
      contour.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
  };
  const angle = Math.asin(0.73);
  arc(w / 2, radius, radius, Math.PI - angle, Math.PI * 2 + angle, 32);
  arc(w - bodyRadius, bodyTop + bodyRadius, bodyRadius, -Math.PI / 2, 0, 8);
  arc(w - bodyRadius, h - bodyRadius, bodyRadius, 0, Math.PI / 2, 8);
  arc(bodyRadius, h - bodyRadius, bodyRadius, Math.PI / 2, Math.PI, 8);
  arc(bodyRadius, bodyTop + bodyRadius, bodyRadius, Math.PI, Math.PI * 1.5, 8);
  return {
    head: { cx: w / 2, cy: radius, radius },
    body: {
      x: 0,
      y: bodyTop,
      width: w,
      height: bodyHeight,
      radius: bodyRadius,
    },
    textRegion: {
      x: bodyRadius / 2,
      y: Math.max(bodyTop + bodyRadius / 2, radius * 2),
      width: w - bodyRadius,
      height:
        h - bodyRadius / 2 - Math.max(bodyTop + bodyRadius / 2, radius * 2),
    },
    contour,
  };
}

function pointsFor(
  type: ShapeType,
  { x, y, w, h }: IBound,
  contour: readonly (readonly [number, number])[] = [],
): IVec[] {
  const soft = softShapeContour(type, { x, y, w, h });
  if (soft) return soft;
  if (type === ShapeType.MermaidPerson)
    return mermaidPersonGeometry(w, h).contour.map(([px, py]) => [
      x + px,
      y + py,
    ]);
  if (type === ShapeType.MermaidBlockArrow && contour.length >= 3)
    return mermaidContourPoints(contour, { x, y, w, h });
  const px = (value: number) => x + w * value;
  const py = (value: number) => y + h * value;
  switch (type) {
    case ShapeType.MermaidAsymmetric:
      return [
        [px(0), py(0)],
        [px(0.86), py(0)],
        [px(1), py(0.5)],
        [px(0.86), py(1)],
        [px(0), py(1)],
        [px(0.12), py(0.5)],
      ];
    case ShapeType.MermaidBolt:
      return [
        [px(0.6), py(0)],
        [px(0.28), py(0.46)],
        [px(0.48), py(0.46)],
        [px(0.36), py(1)],
        [px(0.74), py(0.36)],
        [px(0.54), py(0.36)],
      ];
    case ShapeType.MermaidBowRect:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.86), py(0.5)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0.14), py(0.5)],
      ];
    case ShapeType.MermaidCurvTrap:
    case ShapeType.MermaidTrapB:
      return [
        [px(0.18), py(0)],
        [px(0.82), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
      ];
    case ShapeType.MermaidTrapT:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.82), py(1)],
        [px(0.18), py(1)],
      ];
    case ShapeType.MermaidLeanL:
      return [
        [px(0), py(0)],
        [px(0.88), py(0)],
        [px(1), py(1)],
        [px(0.12), py(1)],
      ];
    case ShapeType.MermaidLeanR:
    case ShapeType.MermaidSlRect:
      return [
        [px(0.12), py(0)],
        [px(1), py(0)],
        [px(0.88), py(1)],
        [px(0), py(1)],
      ];
    case ShapeType.MermaidHexagon:
      return [
        [px(0.18), py(0)],
        [px(0.82), py(0)],
        [px(1), py(0.5)],
        [px(0.82), py(1)],
        [px(0.18), py(1)],
        [px(0), py(0.5)],
      ];
    case ShapeType.MermaidHourglass:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.55), py(0.5)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0.45), py(0.5)],
      ];
    case ShapeType.MermaidNotchPent:
      return [
        [px(0.2), py(0)],
        [px(1), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0), py(0.2)],
      ];
    case ShapeType.MermaidNotchRect:
      return [
        [px(0.12), py(0)],
        [px(1), py(0)],
        [px(1), py(1)],
        [px(0), py(1)],
        [px(0), py(0.24)],
        [px(0.12), py(0.14)],
      ];
    case ShapeType.MermaidOdd:
      return [
        [px(0), py(0.12)],
        [px(1), py(0)],
        [px(1), py(0.82)],
        [px(0.18), py(1)],
        [px(0), py(0.74)],
      ];
    case ShapeType.MermaidFlipTri:
      return [
        [px(0), py(0)],
        [px(1), py(0)],
        [px(0.5), py(1)],
      ];
    case ShapeType.MermaidFork:
      return [
        [px(0), py(0.38)],
        [px(1), py(0.38)],
        [px(1), py(0.62)],
        [px(0), py(0.62)],
      ];
    default:
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
  }
}

function isEllipseLike(type: ShapeType) {
  return (
    type === ShapeType.MermaidCherryPick ||
    type === ShapeType.MermaidCrossCirc ||
    type === ShapeType.MermaidDoubleCircle ||
    type === ShapeType.MermaidFCirc ||
    type === ShapeType.MermaidFrCirc ||
    type === ShapeType.MermaidSmCirc
  );
}

export function mermaidShape(type: ShapeType) {
  return {
    points(bound: IBound) {
      return pointsFor(type, bound);
    },
    draw(ctx: CanvasRenderingContext2D, bound: IBound) {
      if (isEllipseLike(type)) {
        ellipse.draw(ctx, bound);
        return;
      }
      const points = pointsFor(type, bound);
      ctx.save();
      ctx.translate(bound.x + bound.w / 2, bound.y + bound.h / 2);
      ctx.rotate(((bound.rotate ?? 0) * Math.PI) / 180);
      ctx.translate(-bound.x - bound.w / 2, -bound.y - bound.h / 2);
      ctx.beginPath();
      points.forEach(([px, py], index) => {
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.restore();
    },
    includesPoint(
      this: ShapeElementModel,
      x: number,
      y: number,
      options: PointTestOptions,
    ) {
      if (isEllipseLike(type))
        return ellipse.includesPoint.call(this, x, y, options);
      const point: IVec = [x, y];
      const points = getPointsFromBoundWithRotation(this, (bound) =>
        pointsFor(type, bound, this.mermaidContour),
      );

      let hit = pointOnPolygonStoke(
        point,
        points,
        (options?.hitThreshold ?? 1) / (options.zoom ?? 1),
      );

      if (!hit) {
        if (!options.ignoreTransparent || this.filled) {
          hit = pointInPolygon([x, y], points);
        } else {
          const text = this.text;
          if (!text || !text.length) {
            const centralBounds = getCenterAreaBounds(
              this,
              DEFAULT_CENTRAL_AREA_RATIO,
            );
            hit = pointInPolygon(
              [x, y],
              getPointsFromBoundWithRotation(centralBounds, (bound) =>
                pointsFor(type, bound, this.mermaidContour),
              ),
            );
          } else if (this.textBound) {
            hit = pointInPolygon(
              point,
              getPointsFromBoundWithRotation(
                this,
                () => Bound.from(this.textBound!).points,
              ),
            );
          }
        }
      }

      return hit;
    },
    containsBound(bounds: Bound, element: ShapeElementModel): boolean {
      if (isEllipseLike(type)) return ellipse.containsBound(bounds, element);
      const points = getPointsFromBoundWithRotation(element, (bound) =>
        pointsFor(type, bound, element.mermaidContour),
      );
      return points.some((point) => bounds.containsPoint(point));
    },
    getNearestPoint(point: IVec, element: ShapeElementModel) {
      if (isEllipseLike(type)) return ellipse.getNearestPoint(point, element);
      const points = getPointsFromBoundWithRotation(element, (bound) =>
        pointsFor(type, bound, element.mermaidContour),
      );
      return polygonNearestPoint(points, point);
    },
    getLineIntersections(start: IVec, end: IVec, element: ShapeElementModel) {
      if (isEllipseLike(type)) {
        return ellipse.getLineIntersections(start, end, element);
      }
      const points = getPointsFromBoundWithRotation(element, (bound) =>
        pointsFor(type, bound, element.mermaidContour),
      );
      return linePolygonIntersects(start, end, points);
    },
    getRelativePointLocation(position: IVec, element: ShapeElementModel) {
      if (isEllipseLike(type)) {
        return ellipse.getRelativePointLocation(position, element);
      }
      const bound = Bound.deserialize(element.xywh);
      const point = bound.getRelativePoint(position);
      let points = pointsFor(type, bound, element.mermaidContour);
      points.push(point);
      points = rotatePoints(points, bound.center, element.rotate);
      const relativePoint = points.pop() as IVec;
      const rotatePoint =
        type === ShapeType.MermaidBlockArrow || type === ShapeType.MermaidPerson
          ? polygonNearestPoint(points, relativePoint)
          : relativePoint;
      const tangent = polygonGetPointTangent(points, rotatePoint);
      return new PointLocation(rotatePoint, tangent);
    },
  };
}
