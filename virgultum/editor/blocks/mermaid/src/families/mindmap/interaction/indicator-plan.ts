// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import type { PathGenerator } from "@virgultum/gfx-connector";
import {
  Bound,
  isVecZero,
  type IVec,
  PointLocation,
  toRadian,
  Vec,
} from "@virgultum/global/gfx";
import { ConnectorMode } from "@virgultum/model";
import {
  NODE_HORIZONTAL_SPACING,
  NODE_VERTICAL_SPACING,
} from "../projection/layout-plan.js";

export const MINDMAP_INDICATOR_SIZE: [number, number] = [48, 22];

/** The native drop indicator is planned from geometry and ordering only. */
export function planMindmapIndicator(options: {
  parent: Bound;
  target: Bound;
  /** Null when the parent is collapsed or has no children. */
  lastChild: Bound | null;
  balanced: boolean;
  firstLevel: boolean;
  insert: { type: "child" } | { type: "sibling"; position: "prev" | "next" };
  direction: LayoutType.LEFT | LayoutType.RIGHT;
}): Bound {
  const { parent, target, lastChild, balanced, firstLevel, insert, direction } =
    options;
  const left = direction === LayoutType.LEFT;
  const beside = (bound: Bound, up: boolean) =>
    bound.moveDelta(
      left ? bound.w - MINDMAP_INDICATOR_SIZE[0] : 0,
      up
        ? -(NODE_VERTICAL_SPACING / 2 + MINDMAP_INDICATOR_SIZE[1] / 2)
        : bound.h + NODE_VERTICAL_SPACING / 2 - MINDMAP_INDICATOR_SIZE[1] / 2,
    );
  let result: Bound;
  if (insert.type === "sibling") {
    result = beside(
      target,
      balanced && firstLevel && left
        ? insert.position === "next"
        : insert.position !== "next",
    );
  } else if (!lastChild) {
    result = parent.moveDelta(
      (left ? -1 : 1) * (NODE_HORIZONTAL_SPACING / 2 + parent.w),
      parent.h / 2 - MINDMAP_INDICATOR_SIZE[1] / 2,
    );
  } else result = beside(lastChild, balanced && firstLevel && left);
  result.w = MINDMAP_INDICATOR_SIZE[0];
  result.h = MINDMAP_INDICATOR_SIZE[1];
  return result;
}

export function generateMindmapIndicatorPath(
  parentBound: Bound,
  targetBound: Bound,
  direction: LayoutType.LEFT | LayoutType.RIGHT,
  mode: ConnectorMode,
  pathGen: PathGenerator,
) {
  const startRelativePos =
    direction === LayoutType.RIGHT
      ? PointLocation.fromVec([1, 0.5])
      : PointLocation.fromVec([0, 0.5]);
  const endRelativePos =
    direction === LayoutType.RIGHT
      ? PointLocation.fromVec([0, 0.5])
      : PointLocation.fromVec([1, 0.5]);
  const newPosBound = targetBound;

  if (mode === ConnectorMode.Orthogonal) {
    return pathGen
      .generateOrthogonalConnectorPath({
        startPoint: getRelativePoint(parentBound!, startRelativePos),
        endPoint: getRelativePoint(newPosBound!, endRelativePos),
        startBound: parentBound,
        endBound: newPosBound,
      })
      .map((p) => new PointLocation(p));
  } else if (mode === ConnectorMode.Curve) {
    const startPoint = getRelativePoint(parentBound!, startRelativePos);
    const endPoint = getRelativePoint(targetBound!, endRelativePos);

    const startTangentVertical = Vec.rot(startPoint.tangent, -Math.PI / 2);
    startPoint.out = Vec.mul(
      startTangentVertical,
      Math.max(
        100,
        Math.abs(Vec.pry(Vec.sub(endPoint, startPoint), startTangentVertical)) /
          3,
      ),
    );

    const endTangentVertical = Vec.rot(endPoint.tangent, -Math.PI / 2);
    endPoint.in = Vec.mul(
      endTangentVertical,
      Math.max(
        100,
        Math.abs(Vec.pry(Vec.sub(startPoint, endPoint), endTangentVertical)) /
          3,
      ),
    );

    return [startPoint, endPoint];
  } else {
    const startPoint = new PointLocation(
      parentBound!.getRelativePoint(startRelativePos),
    );
    const endPoint = new PointLocation(
      targetBound!.getRelativePoint(endRelativePos),
    );

    return [startPoint, endPoint];
  }
}

function getRelativePoint(bound: Bound, position: IVec) {
  const location = new PointLocation(bound.getRelativePoint(position as IVec));

  if (isVecZero(Vec.sub(position, [0, 0.5])))
    location.tangent = Vec.rot([0, -1], toRadian(0));
  else if (isVecZero(Vec.sub(position, [1, 0.5])))
    location.tangent = Vec.rot([0, 1], toRadian(0));
  else if (isVecZero(Vec.sub(position, [0.5, 0])))
    location.tangent = Vec.rot([1, 0], toRadian(0));
  else if (isVecZero(Vec.sub(position, [0.5, 1])))
    location.tangent = Vec.rot([-1, 0], toRadian(0));

  return location;
}
