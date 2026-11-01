import { effect } from "@preact/signals-core";
import { AStarRunner, Overlay } from "@virgultum/block-surface";
import { VirgultumError } from "@virgultum/global/exceptions";
import {
  almostEqual,
  Bound,
  getBezierCurveBoundingBox,
  getBezierParameters,
  getBoundFromPoints,
  getBoundWithRotation,
  getPointFromBoundsWithRotation,
  type IBound,
  isOverlap,
  isVecZero,
  type IVec,
  type IVec3,
  lineIntersects,
  PI2,
  PointLocation,
  sign,
  toRadian,
  Vec,
} from "@virgultum/global/gfx";
import { assertType } from "@virgultum/global/utils";
import {
  type BrushElementModel,
  type Connection,
  ConnectorElementModel,
  ConnectorMode,
  getConnectorStrokeBounds,
  GroupElementModel,
  type LocalConnectorElementModel,
} from "@virgultum/model";
import { ThemeProvider } from "@virgultum/shared/services";
import type {
  GfxController,
  GfxLocalElementModel,
  GfxModel,
} from "@virgultum/std/gfx";
import last from "lodash-es/last";

export type Connectable = Exclude<
  GfxModel,
  ConnectorElementModel | BrushElementModel | GroupElementModel
>;

export type OrthogonalConnectorInput = {
  startBound: Bound | null;
  endBound: Bound | null;
  startPoint: PointLocation;
  endPoint: PointLocation;
  obstacleBounds?: readonly Bound[];
  protectedBounds?: readonly Bound[];
  clearance?: number;
  laneOffset?: number;
};

function excludeRoutingTerminal(stroke: Bound, terminal: Bound): Bound[] {
  const left = Math.max(stroke.x, terminal.x),
    right = Math.min(stroke.maxX, terminal.maxX),
    top = Math.max(stroke.y, terminal.y),
    bottom = Math.min(stroke.maxY, terminal.maxY);
  if (left >= right || top >= bottom) return [stroke];
  return [
    new Bound(stroke.x, stroke.y, stroke.w, top - stroke.y),
    new Bound(stroke.x, bottom, stroke.w, stroke.maxY - bottom),
    new Bound(stroke.x, top, left - stroke.x, bottom - top),
    new Bound(right, top, stroke.maxX - right, bottom - top),
  ].filter((piece) => piece.w > 0 && piece.h > 0);
}

export const ConnectorEndpointLocations: IVec[] = [
  // At top
  [0.5, 0],
  // At right
  [1, 0.5],
  // At bottom
  [0.5, 1],
  // At left
  [0, 0.5],
];

export const ConnectorEndpointLocationsOnTriangle: IVec[] = [
  // At top
  [0.5, 0],
  // At right
  [0.75, 0.5],
  // At bottom
  [0.5, 1],
  // At left
  [0.25, 0.5],
];

export function isConnectorWithLabel(model: GfxModel | GfxLocalElementModel) {
  return model instanceof ConnectorElementModel && model.hasLabel();
}

export function calculateNearestLocation(
  point: IVec,
  bounds: IBound,
  locations = ConnectorEndpointLocations,
  shortestDistance = Number.POSITIVE_INFINITY,
) {
  const { x, y, w, h } = bounds;
  return locations
    .map<IVec>((offset) => [x + offset[0] * w, y + offset[1] * h])
    .map((point) => getPointFromBoundsWithRotation(bounds, point))
    .reduce(
      (prev, curr, index) => {
        const d = Vec.dist(point, curr);
        if (d < shortestDistance) {
          const location = locations[index];
          shortestDistance = d;
          prev[0] = location[0];
          prev[1] = location[1];
        }
        return prev;
      },
      [...locations[0]],
    );
}

function rBound(ele: GfxModel, anti = false): IBound {
  const bound = Bound.deserialize(ele.xywh);
  return { ...bound, rotate: anti ? -ele.rotate : ele.rotate };
}

export function isConnectorAndBindingsAllSelected(
  connector: ConnectorElementModel | LocalConnectorElementModel,
  selected: GfxModel[],
) {
  const connectorSelected = selected.find((s) => s.id === connector.id);
  if (!connectorSelected) {
    return false;
  }
  const { source, target } = connector;
  const startSelected = selected.find((s) => s.id === source?.id);
  const endSelected = selected.find((s) => s.id === target?.id);
  if (!source.id && !target.id) {
    return true;
  }
  if (!source.id && endSelected) {
    return true;
  }
  if (!target.id && startSelected) {
    return true;
  }
  if (startSelected && endSelected) {
    return true;
  }
  return false;
}

export function getAnchors(ele: GfxModel) {
  const bound = Bound.deserialize(ele.xywh);
  const offset = 10;
  const anchors: { point: PointLocation; coord: IVec }[] = [];
  const rotate = ele.rotate;

  (
    [
      [bound.center[0], bound.y - offset],
      [bound.center[0], bound.maxY + offset],
      [bound.x - offset, bound.center[1]],
      [bound.maxX + offset, bound.center[1]],
    ] satisfies IVec[]
  )
    .map((vec) => getPointFromBoundsWithRotation({ ...bound, rotate }, vec))
    .forEach((vec) => {
      const rst = ele.getLineIntersections(bound.center, vec);
      if (!rst) return;

      const originPoint = getPointFromBoundsWithRotation(
        { ...bound, rotate: -rotate },
        rst[0],
      );
      anchors.push({ point: rst[0], coord: bound.toRelative(originPoint) });
    });
  return anchors;
}

function getConnectableRelativePosition(connectable: GfxModel, position: IVec) {
  const location = connectable.getRelativePointLocation(position);
  if (isVecZero(Vec.sub(position, [0, 0.5])))
    location.tangent = Vec.rot([0, -1], toRadian(connectable.rotate));
  else if (isVecZero(Vec.sub(position, [1, 0.5])))
    location.tangent = Vec.rot([0, 1], toRadian(connectable.rotate));
  else if (isVecZero(Vec.sub(position, [0.5, 0])))
    location.tangent = Vec.rot([1, 0], toRadian(connectable.rotate));
  else if (isVecZero(Vec.sub(position, [0.5, 1])))
    location.tangent = Vec.rot([-1, 0], toRadian(connectable.rotate));
  return location;
}

export function getNearestConnectableAnchor(ele: Connectable, point: IVec) {
  const anchors = getAnchors(ele);
  return closestPoint(
    anchors.map((a) => a.point),
    point,
  );
}

function closestPoint(
  points: PointLocation[],
  point: IVec,
): PointLocation | null {
  if (points.length === 0) return null;
  const rst = points.map((p) => ({ p, d: Vec.dist(p, point) }));
  rst.sort((a, b) => a.d - b.d);
  return rst[0].p;
}

function computePoints(
  startPoint: IVec,
  endPoint: IVec,
  nextStartPoint: IVec,
  lastEndPoint: IVec,
  startBound: Bound | null,
  endBound: Bound | null,
  expandStartBound: Bound | null,
  expandEndBound: Bound | null,
): [IVec3[], IVec3, IVec3, IVec3, IVec3] {
  const startPointVec3 = downscalePrecision(startPoint);
  const endPointVec3 = downscalePrecision(endPoint);
  let nextStartPointVec3 = downscalePrecision(nextStartPoint);
  let lastEndPointVec3 = downscalePrecision(lastEndPoint);

  const result = getConnectablePoints(
    startPointVec3,
    endPointVec3,
    nextStartPointVec3,
    lastEndPointVec3,
    startBound,
    endBound,
    expandStartBound,
    expandEndBound,
  );
  const points = result.points;
  nextStartPointVec3 = result.nextStartPoint;
  lastEndPointVec3 = result.lastEndPoint;
  const finalPoints = filterConnectablePoints(
    filterConnectablePoints(points, expandStartBound?.expand(-1) ?? null),
    expandEndBound?.expand(-1) ?? null,
  );
  return [
    finalPoints,
    startPointVec3,
    endPointVec3,
    nextStartPointVec3,
    lastEndPointVec3,
  ];
}

function downscalePrecision(point: IVec | IVec3): IVec3 {
  return [
    Number(point[0].toFixed(2)),
    Number(point[1].toFixed(2)),
    point[2] ?? 0,
  ];
}

function filterConnectablePoints<T extends IVec3 | IVec>(
  points: T[],
  bound: Bound | null,
): T[] {
  return points.filter((point) => {
    if (!bound) return true;
    return !bound.isPointInBound([point[0], point[1]]);
  });
}

function pushWithPriority(points: number[][], vecs: IVec[], priority = 0) {
  points.push(...vecs.map((vec) => [...vec, priority]));
}

function pushLineIntersectsToPoints(
  points: IVec3[],
  aLine: IVec[],
  bLine: IVec[],
  priority = 0,
) {
  const rst = lineIntersects(aLine[0], aLine[1], bLine[0], bLine[1], true);
  if (rst) {
    pushWithPriority(points, [rst], priority);
  }
}

function pushOuterPoints(
  points: IVec3[],
  expandStartBound: Bound,
  expandEndBound: Bound,
  outerBound: Bound,
) {
  if (expandStartBound && expandEndBound && outerBound) {
    pushWithPriority(points, outerBound.getVerticesAndMidpoints());
    pushWithPriority(points, [outerBound.center], 2);
    [
      expandStartBound.upperLine,
      expandStartBound.horizontalLine,
      expandStartBound.lowerLine,
      expandEndBound.upperLine,
      expandEndBound.horizontalLine,
      expandEndBound.lowerLine,
    ].forEach((line) => {
      pushLineIntersectsToPoints(points, line, outerBound.leftLine, 0);
      pushLineIntersectsToPoints(points, line, outerBound.rightLine, 0);
    });
    [
      expandStartBound.leftLine,
      expandStartBound.verticalLine,
      expandStartBound.rightLine,
      expandEndBound.leftLine,
      expandEndBound.verticalLine,
      expandEndBound.rightLine,
    ].forEach((line) => {
      pushLineIntersectsToPoints(points, line, outerBound.upperLine, 0);
      pushLineIntersectsToPoints(points, line, outerBound.lowerLine, 0);
    });
  }
}

function pushBoundMidPoint(
  points: IVec3[],
  bound1: Bound,
  bound2: Bound,
  expandBound1: Bound,
  expandBound2: Bound,
) {
  if (bound1.maxX < bound2.x) {
    const midX = (bound1.maxX + bound2.x) / 2;
    [
      expandBound1.horizontalLine,
      expandBound2.horizontalLine,
      expandBound1.upperLine,
      expandBound1.lowerLine,
      expandBound2.upperLine,
      expandBound2.lowerLine,
    ].forEach((line, index) => {
      pushLineIntersectsToPoints(
        points,
        line,
        [
          [midX, 0],
          [midX, 1],
        ],
        index === 0 || index === 1 ? 6 : 3,
      );
    });
  }
  if (bound1.maxY < bound2.y) {
    const midY = (bound1.maxY + bound2.y) / 2;
    [
      expandBound1.verticalLine,
      expandBound2.verticalLine,
      expandBound1.leftLine,
      expandBound1.rightLine,
      expandBound2.leftLine,
      expandBound2.rightLine,
    ].forEach((line, index) => {
      pushLineIntersectsToPoints(
        points,
        line,
        [
          [0, midY],
          [1, midY],
        ],
        index === 0 || index === 1 ? 6 : 3,
      );
    });
  }
}

function pushGapMidPoint(
  points: IVec3[],
  point: IVec3,
  bound: Bound,
  bound2: Bound,
  expandBound: Bound,
  expandBound2: Bound,
) {
  /** on top or on bottom */
  if (
    almostEqual(point[1], bound.y, 0.02) ||
    almostEqual(point[1], bound.maxY, 0.02)
  ) {
    const rst = [
      bound.upperLine,
      bound.lowerLine,
      bound2.upperLine,
      bound2.lowerLine,
    ]
      .map((line) => {
        return lineIntersects(
          [point[0], point[1]],
          [point[0], point[1] + 1],
          line[0],
          line[1],
          true,
        );
      })
      .filter((p) => p !== null);
    rst.sort((a, b) => a[1] - b[1]);
    const midPoint = Vec.lrp(rst[1], rst[2], 0.5);
    pushWithPriority(points, [midPoint], 6);
    [
      expandBound.leftLine,
      expandBound.rightLine,
      expandBound2.leftLine,
      expandBound2.rightLine,
    ].forEach((line) => {
      pushLineIntersectsToPoints(
        points,
        [midPoint, [midPoint[0] + 1, midPoint[1]]],
        line,
        0,
      );
    });
  } else {
    const rst = [
      bound.leftLine,
      bound.rightLine,
      bound2.leftLine,
      bound2.rightLine,
    ]
      .map((line) => {
        return lineIntersects(
          [point[0], point[1]],
          [point[0] + 1, point[1]],
          line[0],
          line[1],
          true,
        );
      })
      .filter((p) => p !== null);
    rst.sort((a, b) => a[0] - b[0]);
    const midPoint = Vec.lrp(rst[1], rst[2], 0.5);
    pushWithPriority(points, [midPoint], 6);
    [
      expandBound.upperLine,
      expandBound.lowerLine,
      expandBound2.upperLine,
      expandBound2.lowerLine,
    ].forEach((line) => {
      pushLineIntersectsToPoints(
        points,
        [midPoint, [midPoint[0], midPoint[1] + 1]],
        line,
        0,
      );
    });
  }
}

function removeDulicatePoints(points: IVec[] | IVec3[]) {
  points = points.map(downscalePrecision);
  points.sort((a, b) => a[0] - b[0]);
  assertType<IVec3[]>(points);
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i];
    const last = points[i - 1];
    if (almostEqual(cur[0], last[0], 0.02)) {
      cur[0] = last[0];
    }
  }
  points.sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i];
    const last = points[i - 1];
    if (almostEqual(cur[1], last[1], 0.02)) {
      cur[1] = last[1];
    }
  }
  points.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    const last = points[i - 1];
    if (
      almostEqual(cur[0], last[0], 0.02) &&
      almostEqual(cur[1], last[1], 0.02)
    ) {
      if (cur[2] <= last[2]) points.splice(i, 1);
      else points.splice(i - 1, 1);
      i--;
      continue;
    }
  }
  return points;
}

function getConnectablePoints(
  startPoint: IVec3,
  endPoint: IVec3,
  nextStartPoint: IVec3,
  lastEndPoint: IVec3,
  startBound: Bound | null,
  endBound: Bound | null,
  expandStartBound: Bound | null,
  expandEndBound: Bound | null,
) {
  const lineBound = Bound.fromPoints([
    [startPoint[0], startPoint[1]],
    [endPoint[0], endPoint[1]],
  ]);
  const outerBound =
    expandStartBound &&
    expandEndBound &&
    expandStartBound.unite(expandEndBound);
  let points = [nextStartPoint, lastEndPoint];
  pushWithPriority(points, lineBound.getVerticesAndMidpoints());

  if (!startBound || !endBound) {
    pushWithPriority(points, [lineBound.center], 3);
  }
  if (outerBound) {
    pushOuterPoints(points, expandStartBound, expandEndBound, outerBound);
  }

  if (startBound && endBound && expandStartBound && expandEndBound) {
    pushGapMidPoint(
      points,
      startPoint,
      startBound,
      endBound,
      expandStartBound,
      expandEndBound,
    );
    pushGapMidPoint(
      points,
      endPoint,
      endBound,
      startBound,
      expandEndBound,
      expandStartBound,
    );
    pushBoundMidPoint(
      points,
      startBound,
      endBound,
      expandStartBound,
      expandEndBound,
    );
    pushBoundMidPoint(
      points,
      endBound,
      startBound,
      expandEndBound,
      expandStartBound,
    );
  }

  if (expandStartBound) {
    pushWithPriority(points, expandStartBound.getVerticesAndMidpoints());
    pushWithPriority(
      points,
      expandStartBound.include([lastEndPoint[0], lastEndPoint[1]]).points,
    );
  }

  if (expandEndBound) {
    pushWithPriority(points, expandEndBound.getVerticesAndMidpoints());
    pushWithPriority(
      points,
      expandEndBound.include([nextStartPoint[0], nextStartPoint[1]]).points,
    );
  }

  points = removeDulicatePoints(points);

  const sorted = points.map((point) => point[0] + "," + point[1]).sort();
  sorted.forEach((cur, index) => {
    if (index === 0) return;
    if (cur === sorted[index - 1]) {
      throw new Error("duplicate point");
    }
  });
  const startEnds = [nextStartPoint, lastEndPoint].map((point) => {
    return points.find(
      (item) =>
        almostEqual(item[0], point[0], 0.02) &&
        almostEqual(item[1], point[1], 0.02),
    );
  });
  if (!startEnds[0] || !startEnds[1]) {
    throw new VirgultumError(
      VirgultumError.ErrorCode.ValueNotExists,
      "Failed to get start and end points when getting connectable points",
    );
  }
  return { points, nextStartPoint: startEnds[0], lastEndPoint: startEnds[1] };
}

function getDirectPath(startPoint: IVec, endPoint: IVec): IVec[] {
  if (
    almostEqual(startPoint[0], endPoint[0], 0.02) ||
    almostEqual(startPoint[1], endPoint[1], 0.02)
  ) {
    return [startPoint, endPoint];
  } else {
    const vec = Vec.sub(endPoint, startPoint);
    const mid: IVec = [startPoint[0], startPoint[1] + vec[1]];
    return [startPoint, mid, endPoint];
  }
}

function mergePath(points: IVec[] | IVec3[]) {
  if (points.length === 0) return [];
  const result: IVec[] = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i];
    const last = points[i - 1];
    const next = points[i + 1];
    if (
      almostEqual(last[0], cur[0], 0.02) &&
      almostEqual(cur[0], next[0], 0.02)
    )
      continue;
    if (
      almostEqual(last[1], cur[1], 0.02) &&
      almostEqual(cur[1], next[1], 0.02)
    )
      continue;
    result.push([cur[0], cur[1]]);
  }
  if (points.length !== 0) {
    result.push([points[points.length - 1][0], points[points.length - 1][1]]);
  }
  for (let i = 0; i < result.length - 1; i++) {
    const cur = result[i];
    const next = result[i + 1];
    const isAlmostEqual =
      almostEqual(cur[0], next[0], 0.02) || almostEqual(cur[1], next[1], 0.02);
    if (!isAlmostEqual) {
      console.warn("Expected equal points");
      console.warn(points);
      console.warn(result);
    }
  }
  return result;
}

function computeOffset(startBound: Bound | null, endBound: Bound | null) {
  const startOffset = [20, 20, 20, 20];
  const endOffset = [20, 20, 20, 20];
  if (!(startBound && endBound)) {
    return [startOffset, endOffset];
  }
  // left, top, right, bottom
  let overlap = isOverlap(startBound.upperLine, endBound.lowerLine, 0, false);
  let dist: number;
  if (overlap && startBound.upperLine[0][1] > endBound.lowerLine[0][1]) {
    dist = Vec.distanceToLineSegment(
      startBound.upperLine[0],
      startBound.upperLine[1],
      endBound.lowerLine[0],
      false,
    );
    startOffset[1] = Math.max(Math.min(dist / 2, startOffset[1]), 0);
  }

  overlap = isOverlap(startBound.rightLine, endBound.leftLine, 1, false);
  if (overlap && startBound.rightLine[0][0] < endBound.leftLine[0][0]) {
    dist = Vec.distanceToLineSegment(
      startBound.rightLine[0],
      startBound.rightLine[1],
      endBound.leftLine[0],
      false,
    );
    startOffset[2] = Math.max(Math.min(dist / 2, startOffset[2]), 0);
  }

  overlap = isOverlap(startBound.lowerLine, endBound.upperLine, 0, false);
  if (overlap && startBound.lowerLine[0][1] < endBound.upperLine[0][1]) {
    dist = Vec.distanceToLineSegment(
      startBound.lowerLine[0],
      startBound.lowerLine[1],
      endBound.upperLine[0],
      false,
    );
    startOffset[3] = Math.max(Math.min(dist / 2, startOffset[3]), 0);
  }

  startOffset[0] = endOffset[2] =
    Math.min(startOffset[0], endOffset[2]) === 0
      ? 20
      : Math.min(startOffset[0], endOffset[2]);
  startOffset[1] = endOffset[3] =
    Math.min(startOffset[1], endOffset[3]) === 0
      ? 20
      : Math.min(startOffset[1], endOffset[3]);
  startOffset[2] = endOffset[0] =
    Math.min(startOffset[2], endOffset[0]) === 0
      ? 20
      : Math.min(startOffset[2], endOffset[0]);
  startOffset[3] = endOffset[1] =
    Math.min(startOffset[3], endOffset[1]) === 0
      ? 20
      : Math.min(startOffset[3], endOffset[1]);

  return [startOffset, endOffset];
}

function getNextPoint(
  bound: Bound,
  point: PointLocation,
  offsetX = 10,
  offsetY = 10,
  offsetW = 10,
  offsetH = 10,
) {
  const result: IVec = [point[0], point[1]];
  if (almostEqual(bound.x, result[0])) result[0] -= offsetX;
  else if (almostEqual(bound.y, result[1])) result[1] -= offsetY;
  else if (almostEqual(bound.maxX, result[0])) result[0] += offsetW;
  else if (almostEqual(bound.maxY, result[1])) result[1] += offsetH;
  else {
    const direction = Vec.normalize(Vec.sub(result, bound.center));
    const xDirection = direction[0] > 0 ? 1 : -1;
    const yDirection = direction[1] > 0 ? 1 : -1;

    const slope =
      Math.abs(point.tangent[0]) < Math.abs(point.tangent[1]) ? 0 : 1;
    // if the slope is big, use the x direction
    if (slope === 0) {
      if (xDirection > 0) {
        const intersects = lineIntersects(
          bound.rightLine[0],
          bound.rightLine[1],
          result,
          [bound.maxX + 10, result[1]],
        );
        if (!intersects) {
          throw new VirgultumError(
            VirgultumError.ErrorCode.ValueNotExists,
            "Failed to get line intersections for getNextPoint",
          );
        }
        result[0] = intersects[0] + offsetX;
      } else {
        const intersects = lineIntersects(
          bound.leftLine[0],
          bound.leftLine[1],
          result,
          [bound.x - 10, result[1]],
        );
        if (!intersects) {
          throw new VirgultumError(
            VirgultumError.ErrorCode.ValueNotExists,
            "Failed to get line intersections for getNextPoint",
          );
        }
        result[0] = intersects[0] - offsetX;
      }
    } else {
      if (yDirection > 0) {
        const intersects = lineIntersects(
          bound.lowerLine[0],
          bound.lowerLine[1],
          result,
          [result[0], bound.maxY + 10],
        );
        if (!intersects) {
          throw new VirgultumError(
            VirgultumError.ErrorCode.ValueNotExists,
            "Failed to get line intersections for getNextPoint",
          );
        }
        result[1] = intersects[1] + offsetY;
      } else {
        const intersects = lineIntersects(
          bound.upperLine[0],
          bound.upperLine[1],
          result,
          [result[0], bound.y - 10],
        );
        if (!intersects) {
          throw new VirgultumError(
            VirgultumError.ErrorCode.ValueNotExists,
            "Failed to get line intersections for getNextPoint",
          );
        }
        result[1] = intersects[1] - offsetY;
      }
    }
  }
  return result;
}

function computeNextStartEndpoint(
  startPoint: PointLocation,
  endPoint: PointLocation,
  startBound: Bound | null,
  endBound: Bound | null,
  startOffset: number[] | null,
  endOffset: number[] | null,
) {
  const nextStartPoint =
    startBound && startOffset
      ? getNextPoint(
          startBound,
          startPoint,
          startOffset[0],
          startOffset[1],
          startOffset[2],
          startOffset[3],
        )
      : startPoint;
  const lastEndPoint =
    endBound && endOffset
      ? getNextPoint(
          endBound,
          endPoint,
          endOffset[0],
          endOffset[1],
          endOffset[2],
          endOffset[3],
        )
      : endPoint;
  return [nextStartPoint, lastEndPoint];
}

function adjustStartEndPoint(
  startPoint: IVec3,
  endPoint: IVec3,
  startBound: Bound | null = null,
  endBound: Bound | null = null,
) {
  if (!endBound) {
    if (
      Math.abs(endPoint[0] - startPoint[0]) >
      Math.abs(endPoint[1] - startPoint[1])
    ) {
      endPoint[0] += sign(endPoint[0] - startPoint[0]) * 20;
    } else {
      endPoint[1] += sign(endPoint[1] - startPoint[1]) * 20;
    }
  }
  if (!startBound) {
    if (
      Math.abs(endPoint[0] - startPoint[0]) >
      Math.abs(endPoint[1] - startPoint[1])
    ) {
      startPoint[0] -= sign(endPoint[0] - startPoint[0]) * 20;
    } else {
      startPoint[1] -= sign(endPoint[1] - startPoint[1]) * 20;
    }
  }
}

function renderRect(
  ctx: CanvasRenderingContext2D,
  bounds: IBound,
  color: string,
  lineWidth: number,
) {
  const { x, y, w, h } = bounds;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([lineWidth * 2, lineWidth * 2]);
  ctx.strokeRect(x, y, w, h);
  ctx.closePath();
  ctx.restore();
}

export class ConnectionOverlay extends Overlay {
  static override overlayName = "connection";

  private _emphasisColor: string;

  private _themeDisposer: (() => void) | null = null;

  highlightPoint: IVec | null = null;

  points: IVec[] = [];

  sourceBounds: IBound | null = null;

  targetBounds: IBound | null = null;

  constructor(gfx: GfxController) {
    super(gfx);
    this._emphasisColor = this._getEmphasisColor();
    this._setupThemeListener();
  }

  private _findConnectablesInViews() {
    const gfx = this.gfx;
    const bound = gfx.viewport.viewportBounds;
    return gfx.getElementsByBound(bound).filter((ele) => ele.connectable);
  }

  private _getEmphasisColor(): string {
    return getComputedStyle(this.gfx.std.host).getPropertyValue(
      "--myoxus-text-emphasis-color",
    );
  }

  private _setupThemeListener(): void {
    const themeService = this.gfx.std.get(ThemeProvider);
    this._themeDisposer = effect(() => {
      void themeService.theme$.value;
      this._emphasisColor = this._getEmphasisColor();
    });
  }

  _clearRect() {
    this.points = [];
    this.highlightPoint = null;
    this._renderer?.refresh();
  }

  override clear() {
    this.sourceBounds = null;
    this.targetBounds = null;
    this._clearRect();
  }

  override dispose() {
    this._themeDisposer?.();
    if (!this._renderer) return;
    this._renderer.removeOverlay(this);
    this._renderer = null;
  }

  override render(ctx: CanvasRenderingContext2D): void {
    const zoom = this.gfx.viewport.zoom;
    const radius = 5 / zoom;
    const color = this._emphasisColor;
    ctx.globalAlpha = 0.6;
    let lineWidth = 1 / zoom;
    if (this.sourceBounds) {
      renderRect(ctx, this.sourceBounds, color, lineWidth);
    }
    if (this.targetBounds) {
      renderRect(ctx, this.targetBounds, color, lineWidth);
    }

    lineWidth = 2 / zoom;
    this.points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], radius, 0, PI2);
      ctx.fillStyle = "white";
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.fill();
      ctx.stroke();
      ctx.closePath();
    });

    ctx.globalAlpha = 1;
    if (this.highlightPoint) {
      ctx.beginPath();
      ctx.arc(this.highlightPoint[0], this.highlightPoint[1], radius, 0, PI2);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.fill();
      ctx.stroke();
      ctx.closePath();
    }
  }

  /**
   * Render the connector at the given point. It will try to find
   * the closest connectable element and render the connector. If the
   * point is not close to any connectable element, it will just render
   * the connector at the given point.
   * @param point the point to render the connector
   * @param excludedIds the ids of the elements that should be excluded
   * @returns the connection result
   */
  renderConnector(point: IVec, excludedIds: string[] = []) {
    const connectables = this._findConnectablesInViews();
    const context = this.gfx;
    const target = [];

    this._clearRect();

    let result: Connection | null = null;
    // oxlint-disable-next-line typescript/prefer-for-of
    for (let i = 0; i < connectables.length; i++) {
      const connectable = connectables[i];
      // first check if in excluedIds
      if (excludedIds.includes(connectable.id)) continue;

      // then check if in expanded bound
      const bound = Bound.deserialize(connectable.xywh);
      const rotateBound = Bound.from(getBoundWithRotation(rBound(connectable)));
      // FIXME: the real path needs to be expanded: diamod, ellipse, trangle.
      if (!rotateBound.expand(10).isPointInBound(point)) continue;

      // then check if closes to anchors
      const anchors = getAnchors(connectable);
      const len = anchors.length;
      const pointerViewCoord = context.viewport.toViewCoord(point[0], point[1]);

      let shortestDistance = Number.POSITIVE_INFINITY;
      let j = 0;

      this.points = anchors.map((a) => a.point);

      for (; j < len; j++) {
        const anchor = anchors[j];
        const anchorViewCoord = context.viewport.toViewCoord(
          anchor.point[0],
          anchor.point[1],
        );
        const d = Vec.dist(anchorViewCoord, pointerViewCoord);
        if (d < shortestDistance) {
          shortestDistance = d;
          target.push(connectable);
          this.highlightPoint = anchor.point;
          result = {
            id: connectable.id,
            position: anchor.coord,
          };
        }
      }

      if (shortestDistance < 8 && result) break;

      // if not, check if closes to bound
      const nearestPoint = connectable.getNearestPoint(point);

      if (Vec.dist(nearestPoint, point) < 8) {
        this.highlightPoint = nearestPoint;
        const originPoint = getPointFromBoundsWithRotation(
          rBound(connectable, true),
          nearestPoint,
        );
        this._renderer?.refresh();
        target.push(connectable);
        result = {
          id: connectable.id,
          position: Vec.clampV(bound.toRelative(originPoint), 0, 1),
        };
      }

      if (result) continue;

      // if not, check if in inside of the element
      if (
        connectable.includesPoint(
          point[0],
          point[1],
          {
            ignoreTransparent: false,
          },
          this.gfx.std.host,
        )
      ) {
        target.push(connectable);
        result = {
          id: connectable.id,
        };
      }
    }

    if (last(target) instanceof GroupElementModel) {
      this.targetBounds = Bound.deserialize(last(target)!.xywh);
    } else {
      this.targetBounds = null;
    }

    // at last, if not, just return the point
    if (!result) {
      result = {
        position: point,
      };
    }

    this._renderer?.refresh();

    return result;
  }
}

export class PathGenerator {
  protected _aStarRunner: AStarRunner | null = null;

  protected _prepareOrthogonalConnectorInfo(
    connectorInfo: OrthogonalConnectorInput,
  ): [
    IVec,
    IVec,
    IVec,
    IVec,
    Bound | null,
    Bound | null,
    Bound | null,
    Bound | null,
  ] {
    const { startBound, endBound, startPoint, endPoint } = connectorInfo;

    const [startOffset, endOffset] = computeOffset(startBound, endBound);
    // A third body can be closer than the opposite endpoint. Keep the exit
    // anchors inside that real gap so A* does not start inside an obstacle.
    const obstacles = [
      ...(connectorInfo.obstacleBounds ?? []),
      ...(connectorInfo.protectedBounds ?? []),
    ];
    for (const [bound, offsets] of [
      [startBound, startOffset],
      [endBound, endOffset],
    ] as const) {
      if (!bound) continue;
      for (const obstacle of obstacles) {
        const horizontal = bound.y < obstacle.maxY && bound.maxY > obstacle.y;
        const vertical = bound.x < obstacle.maxX && bound.maxX > obstacle.x;
        const gaps = [
          horizontal ? bound.x - obstacle.maxX : -1,
          vertical ? bound.y - obstacle.maxY : -1,
          horizontal ? obstacle.x - bound.maxX : -1,
          vertical ? obstacle.y - bound.maxY : -1,
        ];
        gaps.forEach((gap, side) => {
          if (gap >= 0) offsets[side] = Math.min(offsets[side], gap / 2);
        });
      }
    }
    const [nextStartPoint, lastEndPoint] = computeNextStartEndpoint(
      startPoint,
      endPoint,
      startBound,
      endBound,
      startOffset,
      endOffset,
    );
    const expandStartBound = startBound
      ? startBound.expand(
          startOffset[0],
          startOffset[1],
          startOffset[2],
          startOffset[3],
        )
      : null;
    const expandEndBound = endBound
      ? endBound.expand(endOffset[0], endOffset[1], endOffset[2], endOffset[3])
      : null;

    return [
      startPoint,
      endPoint,
      nextStartPoint,
      lastEndPoint,
      startBound,
      endBound,
      expandStartBound,
      expandEndBound,
    ];
  }

  generateOrthogonalConnectorPath(input: OrthogonalConnectorInput): IVec[] {
    const info = this._prepareOrthogonalConnectorInfo(input);
    const [startPoint, endPoint, nextStartPoint, lastEndPoint] = info;
    const [, , , , startBound, endBound, expandStartBound, expandEndBound] =
      info;
    const blocks = [];
    const expandBlocks = [];
    startBound && blocks.push(startBound.clone());
    endBound && blocks.push(endBound.clone());
    expandStartBound && expandBlocks.push(expandStartBound.clone());
    expandEndBound && expandBlocks.push(expandEndBound.clone());
    const obstacles = (input.obstacleBounds ?? []).map((bound) =>
      bound.expand(Math.max(1, input.clearance ?? 1)),
    );
    obstacles.push(
      // Visibility coordinates must sit outside the physical collision bound;
      // Graph rejects travel along that bound's edge, even when it is clear.
      ...(input.protectedBounds ?? []).map((bound) => bound.expand(1)),
    );
    blocks.push(...(input.obstacleBounds ?? []).map((bound) => bound.clone()));
    blocks.push(...(input.protectedBounds ?? []).map((bound) => bound.clone()));
    expandBlocks.push(...obstacles);

    if (
      startBound &&
      endBound &&
      startBound.isPointInBound(endPoint) &&
      endBound.isPointInBound(startPoint)
    ) {
      return getDirectPath(startPoint, endPoint);
    }

    if (startBound && expandStartBound?.isPointInBound(endPoint, 0)) {
      return getDirectPath(startPoint, endPoint);
    }

    if (endBound && expandEndBound?.isPointInBound(startPoint, 0)) {
      return getDirectPath(startPoint, endPoint);
    }

    const points = computePoints(
      startPoint,
      endPoint,
      nextStartPoint,
      lastEndPoint,
      startBound,
      endBound,
      expandStartBound,
      expandEndBound,
    );
    const finalPoints = points[0];
    const [, startPointV3, endPointV3, nextStartPointV3, lastEndPointV3] =
      points;

    if (input.laneOffset && startBound && endBound) {
      // Separate parallel routes in the existing gap grid, retaining the
      // endpoint objects that A* uses for identity and the protected exit gap.
      const horizontal =
          almostEqual(startPoint[0], startBound.x, 0.02) ||
          almostEqual(startPoint[0], startBound.maxX, 0.02),
        axis = horizontal ? 0 : 1,
        bounds = [startBound, endBound].sort((a, b) =>
          horizontal ? a.x - b.x : a.y - b.y,
        ),
        low = horizontal ? bounds[0].maxX : bounds[0].maxY,
        high = horizontal ? bounds[1].x : bounds[1].y,
        middle = Number(((low + high) / 2).toFixed(2)),
        offset = Math.max(
          -(high - low) / 4,
          Math.min((high - low) / 4, input.laneOffset),
        );
      if (high > low) {
        for (const point of finalPoints) {
          if (
            point !== nextStartPointV3 &&
            point !== lastEndPointV3 &&
            almostEqual(point[axis], middle, 0.02)
          ) {
            point[axis] = Number((middle + offset).toFixed(2));
          }
        }
      }
    }

    if (obstacles.length) {
      // Reuse the existing orthogonal A* graph. Additional card boundaries
      // supply visibility-grid coordinates; endpoint-only callers stay intact.
      const xs = new Set(finalPoints.map((p) => p[0])),
        ys = new Set(finalPoints.map((p) => p[1]));
      for (const bound of obstacles) {
        xs.add(Number(bound.x.toFixed(2)));
        xs.add(Number(bound.maxX.toFixed(2)));
        ys.add(Number(bound.y.toFixed(2)));
        ys.add(Number(bound.maxY.toFixed(2)));
      }
      const candidates: IVec3[] = [];
      const retained = new Map(
        [...finalPoints, nextStartPointV3, lastEndPointV3].map((p) => [
          `${p[0]}:${p[1]}`,
          p,
        ]),
      );
      for (const x of xs) {
        for (const y of ys) {
          if (!expandBlocks.some((b) => b.expand(-0.5).isPointInBound([x, y])))
            // AStarRunner recognizes the endpoint by object identity.
            candidates.push(retained.get(`${x}:${y}`) ?? [x, y, 0]);
        }
      }
      finalPoints.splice(0, finalPoints.length, ...candidates);
    }

    adjustStartEndPoint(startPointV3, endPointV3, startBound, endBound);
    this._aStarRunner = new AStarRunner(
      finalPoints,
      nextStartPointV3,
      lastEndPointV3,
      startPointV3,
      endPointV3,
      blocks,
      expandBlocks,
    );
    this._aStarRunner.run();
    const path = this._aStarRunner.path;
    if (
      obstacles.length &&
      (!path.length ||
        !almostEqual(path[0][0], startPointV3[0], 0.02) ||
        !almostEqual(path[0][1], startPointV3[1], 0.02) ||
        !almostEqual(path[path.length - 1][0], endPointV3[0], 0.02) ||
        !almostEqual(path[path.length - 1][1], endPointV3[1], 0.02))
    )
      return [];
    if (!endBound) path.pop();
    if (!startBound) path.shift();

    return mergePath(path);
  }
}

export class ConnectorPathGenerator extends PathGenerator {
  constructor(
    private readonly options: {
      getElementById: (id: string) => GfxModel | null;
    },
  ) {
    super();
  }

  static updatePath(
    connector: ConnectorElementModel | LocalConnectorElementModel,
    path: PointLocation[] | null,
    elementGetter?: (id: string) => GfxModel | null,
  ) {
    const instance = new ConnectorPathGenerator({
      getElementById: elementGetter ?? (() => null),
    });
    const points = path ?? instance._generateConnectorPath(connector) ?? [];
    // Overlapping geometry can have no viable route. Keep the last path until
    // the next geometry update rather than writing non-finite derived bounds.
    if (
      points.length < 2 ||
      points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
    )
      return;
    const bound =
      connector.mode === ConnectorMode.Curve
        ? getBezierCurveBoundingBox(getBezierParameters(points))
        : getBoundFromPoints(points);
    const relativePoints = points.map((p: PointLocation) => {
      return p.setVec(Vec.sub(p, [bound.x, bound.y]));
    });

    connector.updatingPath = true;
    // the property assignment order matters
    connector.xywh = bound.serialize();
    connector.path = relativePoints;

    // Updates Connector's Label position.
    if (isConnectorWithLabel(connector)) {
      const model = connector as ConnectorElementModel;
      const currentLabelXYWH = model.labelXYWH!;
      const [, , w, h] = currentLabelXYWH;
      // Keep semantic label anchors durable when the connector path is
      // regenerated; callers must not rely on one-time labelXYWH offsets.
      const nextLabelXYWH = model.getLabelXYWHOnPath(w, h);
      // Yjs treats a freshly allocated tuple as a mutation even when every
      // coordinate is unchanged. Avoid waking frame-bound and connector-path
      // observers recursively for a label that is already at its derived
      // position.
      if (
        !currentLabelXYWH.every((value, index) =>
          Object.is(value, nextLabelXYWH[index]),
        )
      ) {
        model.labelXYWH = [...nextLabelXYWH];
      }
    }

    connector.updatingPath = false;
  }

  private _computeStartEndPoint(
    connector: ConnectorElementModel | LocalConnectorElementModel,
  ) {
    const { source, target } = connector;
    const start = this._getConnectorEndElement(connector, "source");
    const end = this._getConnectorEndElement(connector, "target");

    let startPoint: PointLocation | null = null;
    let endPoint: PointLocation | null = null;
    if (
      source.id &&
      !source.position &&
      target.id &&
      !target.position &&
      start &&
      end
    ) {
      const startAnchors = getAnchors(start);
      const endAnchors = getAnchors(end);
      let minDist = Infinity;
      let minStartAnchor = new PointLocation();
      let minEndAnchor = new PointLocation();
      for (const sa of startAnchors) {
        for (const ea of endAnchors) {
          const dist = Vec.dist(sa.point, ea.point);
          if (dist + 0.1 < minDist) {
            minDist = dist;
            minStartAnchor = sa.point;
            minEndAnchor = ea.point;
          }
        }
      }
      startPoint = minStartAnchor;
      endPoint = minEndAnchor;
    } else {
      startPoint = this._getConnectionPoint(connector, "source");
      endPoint = this._getConnectionPoint(connector, "target");
    }

    if (!startPoint || !endPoint) return [];

    return [startPoint, endPoint];
  }

  private _generateConnectorPath(
    connector: ConnectorElementModel | LocalConnectorElementModel,
  ) {
    const { mode } = connector;
    if (mode === ConnectorMode.Straight) {
      return this._generateStraightConnectorPath(connector);
    } else if (mode === ConnectorMode.Orthogonal) {
      const start = this._getConnectorEndElement(connector, "source");
      const end = this._getConnectorEndElement(connector, "target");

      const [startPoint, endPoint] = this._computeStartEndPoint(connector);

      const startBound = start
        ? Bound.from(getBoundWithRotation(rBound(start)))
        : null;
      const endBound = end
        ? Bound.from(getBoundWithRotation(rBound(end)))
        : null;
      const obstacleBounds: Bound[] = [],
        protectedBounds: Bound[] = [];
      const terminals = [startBound, endBound]
        .filter((bound): bound is Bound => Boolean(bound))
        .map((bound) => bound.expand((connector.routingClearance ?? 1) * 2));
      for (const id of connector.routingObstacleIds ?? []) {
        const obstacle = this.options.getElementById(id);
        if (!obstacle) continue;
        if (!("type" in obstacle) || obstacle.type !== "connector") {
          obstacleBounds.push(Bound.deserialize(obstacle.xywh));
          continue;
        }
        const previous = obstacle as ConnectorElementModel;
        let strokes = getConnectorStrokeBounds(previous).map((bound) =>
          bound.expand(connector.routingClearance ?? 1),
        );
        // Shared ports keep a short terminal corridor. Protect the rest of
        // each earlier painted path; its whole bounding box would block loops.
        for (const terminal of terminals)
          strokes = strokes.flatMap((stroke) =>
            excludeRoutingTerminal(stroke, terminal),
          );
        protectedBounds.push(...strokes);
        if (previous.labelDisplay && previous.labelXYWH)
          protectedBounds.push(new Bound(...previous.labelXYWH));
      }
      for (const [id, region] of Object.entries(
        connector.routingObstacleRegions ?? {},
      )) {
        const model = this.options.getElementById(id);
        if (!model) continue;
        const bound = Bound.deserialize(model.xywh);
        protectedBounds.push(
          new Bound(
            bound.x + region[0],
            bound.y + region[1],
            region[2],
            region[3],
          ),
        );
      }
      const path = this.generateOrthogonalConnectorPath({
        startPoint,
        endPoint,
        startBound,
        endBound,
        obstacleBounds,
        clearance: connector.routingClearance,
        protectedBounds,
        laneOffset: connector.routingLaneOffset,
      });
      return path.map((p) => new PointLocation(p));
    } else if (mode === ConnectorMode.Curve) {
      return this._generateCurveConnectorPath(connector);
    }
    throw new Error("unknown connector mode");
  }

  private _generateCurveConnectorPath(
    connector: ConnectorElementModel | LocalConnectorElementModel,
  ) {
    const { source, target } = connector;
    let startPoint: PointLocation | null = null;
    let endPoint: PointLocation | null = null;

    if (source.id || target.id) {
      if (!source.position && !target.position) {
        const start = this._getConnectorEndElement(
          connector,
          "source",
        ) as Connectable;
        const end = this._getConnectorEndElement(
          connector,
          "target",
        ) as Connectable;
        const sb = Bound.deserialize(start.xywh);
        const eb = Bound.deserialize(end.xywh);
        startPoint = getNearestConnectableAnchor(start, eb.center);
        endPoint = getNearestConnectableAnchor(end, sb.center);
      } else {
        startPoint = this._getConnectionPoint(connector, "source");
        endPoint = this._getConnectionPoint(connector, "target");
      }

      if (!startPoint || !endPoint) return [];

      if (source.id) {
        const startTangentVertical = Vec.rot(startPoint.tangent, -Math.PI / 2);
        startPoint.out = isVecZero(startTangentVertical)
          ? Vec.mul(Vec.per(Vec.normalize(Vec.sub(startPoint, endPoint))), 20)
          : Vec.mul(
              startTangentVertical,
              Math.max(
                100,
                Math.abs(
                  Vec.pry(Vec.sub(endPoint, startPoint), startTangentVertical),
                ) / 3,
              ),
            );
      }
      if (target.id) {
        const endTangentVertical = Vec.rot(endPoint.tangent, -Math.PI / 2);
        endPoint.in = isVecZero(endTangentVertical)
          ? Vec.mul(Vec.per(Vec.normalize(Vec.sub(endPoint, startPoint))), 20)
          : Vec.mul(
              endTangentVertical,
              Math.max(
                100,
                Math.abs(
                  Vec.pry(Vec.sub(startPoint, endPoint), endTangentVertical),
                ) / 3,
              ),
            );
      }
      return [startPoint, endPoint];
    } else {
      startPoint = this._getConnectionPoint(connector, "source");
      endPoint = this._getConnectionPoint(connector, "target");

      if (!startPoint || !endPoint) return [];

      if (
        Math.abs(endPoint[0] - startPoint[0]) >
        Math.abs(endPoint[1] - startPoint[1])
      ) {
        startPoint.out = [Vec.mul(Vec.sub(endPoint, startPoint), 2 / 3)[0], 0];
        endPoint.in = [Vec.mul(Vec.sub(startPoint, endPoint), 2 / 3)[0], 0];
      } else {
        startPoint.out = [0, Vec.mul(Vec.sub(endPoint, startPoint), 2 / 3)[1]];
        endPoint.in = [0, Vec.mul(Vec.sub(startPoint, endPoint), 2 / 3)[1]];
      }
      return [startPoint, endPoint];
    }
  }

  private _generateStraightConnectorPath(
    connector: ConnectorElementModel | LocalConnectorElementModel,
  ) {
    const { source, target } = connector;
    if (source.id && !source.position && target.id && !target.position) {
      const start = this._getConnectorEndElement(
        connector,
        "source",
      ) as Connectable;
      const end = this._getConnectorEndElement(
        connector,
        "target",
      ) as Connectable;
      const sb = Bound.deserialize(start.xywh);
      const eb = Bound.deserialize(end.xywh);
      const startPoint = getNearestConnectableAnchor(start, eb.center);
      const endPoint = getNearestConnectableAnchor(end, sb.center);
      return (startPoint && endPoint && [startPoint, endPoint]) ?? [];
    } else {
      const endPoint = this._getConnectionPoint(connector, "target");
      const startPoint = this._getConnectionPoint(connector, "source");
      return (startPoint && endPoint && [startPoint, endPoint]) ?? [];
    }
  }

  private _getConnectionPoint(
    connector: ConnectorElementModel | LocalConnectorElementModel,
    type: "source" | "target",
  ): PointLocation | null {
    const connection = connector[type];

    if (!connection) return null;

    const connectable = this._getConnectorEndElement(connector, type);

    if (!connectable && connection.position) {
      return PointLocation.fromVec(connection.position);
    }

    if (!connectable) return null;

    let point: PointLocation | null = null;

    if (connection.position) {
      point = getConnectableRelativePosition(connectable, connection.position);
    } else {
      const anotherType = type === "source" ? "target" : "source";
      const otherPoint = this._getConnectionPoint(connector, anotherType);
      if (otherPoint) {
        point = getNearestConnectableAnchor(connectable, otherPoint);
      }
    }

    return point;
  }

  private _getConnectorEndElement(
    connector: ConnectorElementModel | LocalConnectorElementModel,
    type: "source" | "target",
  ): Connectable | null {
    const id = connector[type].id;

    if (id) {
      return this.options.getElementById(id) as Connectable;
    }

    return null;
  }

  hasRelatedElement(
    connecter: ConnectorElementModel | LocalConnectorElementModel,
  ) {
    const { source, target } = connecter;
    if (
      (source.id && !this.options.getElementById(source.id)) ||
      (target.id && !this.options.getElementById(target.id))
    ) {
      return false;
    }

    return true;
  }
}
