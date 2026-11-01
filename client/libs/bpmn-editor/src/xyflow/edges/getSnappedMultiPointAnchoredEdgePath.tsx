/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import { type DC__Point, type DC__Shape } from "../maths/model";
import { type SnapGrid, snapPoint } from "../snapgrid/SnapGrid";
import { PositionalNodeHandleId } from "../nodes/PositionalNodeHandles";
import {
  getHandlePosition,
  getLineRectangleIntersectionPoint,
  pointsToPath,
} from "../maths/DcMaths";
import {
  type Bounds,
  getBoundsCenterPoint,
  getDiscretelyAutoPositionedEdgeParams,
} from "../maths/Maths";
import { AutoPositionedEdgeMarker } from "./AutoPositionedEdgeMarker";

export type MultiPointAnchoredEdge = {
  "@_id": string;
  "di:waypoint": DC__Point[];
};

/** Paint stored DI exactly; only explicitly auto-positioned routes derive live anchors. */
export function getCanonicalMultiPointEdgePath({
  edge,
  shapeSource,
  shapeTarget,
}: {
  edge: MultiPointAnchoredEdge | undefined;
  shapeSource: DC__Shape | undefined;
  shapeTarget: DC__Shape | undefined;
}) {
  if (!edge?.["di:waypoint"] || edge["di:waypoint"].length < 2)
    return { path: undefined, points: [] };
  const auto = Object.values(AutoPositionedEdgeMarker).some((marker) =>
    edge["@_id"].endsWith(marker),
  );
  if (!auto)
    return {
      path: pointsToPath(edge["di:waypoint"]),
      points: edge["di:waypoint"],
    };
  const bounds = (shape: DC__Shape | undefined) =>
    shape
      ? {
          x: shape["dc:Bounds"]["@_x"],
          y: shape["dc:Bounds"]["@_y"],
          width: shape["dc:Bounds"]["@_width"],
          height: shape["dc:Bounds"]["@_height"],
        }
      : undefined;
  return getSnappedMultiPointAnchoredEdgePath({
    edge,
    shapeSource,
    shapeTarget,
    // The grid step is irrelevant while disabled; render never snaps source geometry.
    snapGrid: { isEnabled: false, x: 1, y: 1 },
    snappedSourceNodeBounds: bounds(shapeSource),
    snappedTargetNodeBounds: bounds(shapeTarget),
  });
}

export function getSnappedMultiPointAnchoredEdgePath({
  snapGrid,
  edge,
  snappedSourceNodeBounds,
  snappedTargetNodeBounds,
  shapeSource,
  shapeTarget,
}: {
  snapGrid: SnapGrid;
  edge: MultiPointAnchoredEdge | undefined;
  snappedSourceNodeBounds: Bounds | undefined;
  snappedTargetNodeBounds: Bounds | undefined;
  shapeSource: DC__Shape | undefined;
  shapeTarget: DC__Shape | undefined;
}) {
  if (!snappedSourceNodeBounds || !snappedTargetNodeBounds) {
    return { path: undefined, points: [] };
  }

  const points: DC__Point[] = [];
  points.length = Math.max(2, edge?.["di:waypoint"]?.length ?? 0);

  const discreteAuto = getDiscretelyAutoPositionedEdgeParams(
    snappedSourceNodeBounds,
    snappedTargetNodeBounds,
    edge?.["di:waypoint"],
  );

  if (edge?.["@_id"]?.endsWith(AutoPositionedEdgeMarker.BOTH)) {
    points[0] = { "@_x": discreteAuto.sx, "@_y": discreteAuto.sy };
    points[points.length - 1] = {
      "@_x": discreteAuto.tx,
      "@_y": discreteAuto.ty,
    };
  } else if (edge?.["@_id"]?.endsWith(AutoPositionedEdgeMarker.SOURCE)) {
    points[0] = { "@_x": discreteAuto.sx, "@_y": discreteAuto.sy };
  } else if (edge?.["@_id"]?.endsWith(AutoPositionedEdgeMarker.TARGET)) {
    points[points.length - 1] = {
      "@_x": discreteAuto.tx,
      "@_y": discreteAuto.ty,
    };
  }

  ///////

  if (!edge?.["di:waypoint"]) {
    points[0] = { "@_x": discreteAuto.sx, "@_y": discreteAuto.sy };
    points[points.length - 1] = {
      "@_x": discreteAuto.tx,
      "@_y": discreteAuto.ty,
    };
  } else if (edge?.["di:waypoint"].length < 2) {
    points[0] = { "@_x": discreteAuto.sx, "@_y": discreteAuto.sy };
    points[points.length - 1] = {
      "@_x": discreteAuto.tx,
      "@_y": discreteAuto.ty,
    };
  } else {
    const { handlePosition: sourceHandlePosition } = getHandlePosition({
      shapeBounds: shapeSource!["dc:Bounds"],
      waypoint: points[0] ?? edge["di:waypoint"][0],
    });

    const { handlePosition: targetHandlePosition } = getHandlePosition({
      shapeBounds: shapeTarget!["dc:Bounds"],
      waypoint:
        points[points.length - 1] ??
        edge["di:waypoint"][edge["di:waypoint"].length - 1],
    });

    if (sourceHandlePosition === PositionalNodeHandleId.Center) {
      points[0] ??= getSnappedHandlePosition(
        snappedSourceNodeBounds,
        snapPoint(
          snapGrid,
          points.length > 2
            ? (points[1] ?? edge["di:waypoint"][1])
            : getBoundsCenterPoint(snappedTargetNodeBounds),
        ),
        sourceHandlePosition,
      );
    }
    if (targetHandlePosition === PositionalNodeHandleId.Center) {
      points[points.length - 1] ??= getSnappedHandlePosition(
        snappedTargetNodeBounds,
        snapPoint(
          snapGrid,
          points.length > 2
            ? (points[points.length - 2] ??
                edge["di:waypoint"][edge["di:waypoint"].length - 2])
            : getBoundsCenterPoint(snappedSourceNodeBounds),
        ),
        targetHandlePosition,
      );
    }

    const secondWaypoint = points[1] ?? edge["di:waypoint"][1];
    const sourceHandlePoint = getSnappedHandlePosition(
      snappedSourceNodeBounds,
      snapPoint(snapGrid, secondWaypoint),
      sourceHandlePosition,
    );
    points[0] ??= sourceHandlePoint;

    const secondToLastWaypoint =
      points[points.length - 2] ??
      edge["di:waypoint"][edge["di:waypoint"].length - 2];
    const targetHandlePoint = getSnappedHandlePosition(
      snappedTargetNodeBounds,
      snapPoint(snapGrid, secondToLastWaypoint),
      targetHandlePosition,
    );
    points[points.length - 1] ??= targetHandlePoint;
  }

  ///////

  // skip first and last elements, as they are pre-filled using the logic below.
  for (let i = 1; i < points.length - 1; i++) {
    points[i] = snapPoint(snapGrid, { ...(edge?.["di:waypoint"] ?? [])[i] });
  }

  return { path: pointsToPath(points), points };
}

export function getSnappedHandlePosition(
  snappedNode: Bounds,
  snappedSecondWaypoint: DC__Point,
  handlePosition: PositionalNodeHandleId,
): DC__Point {
  const centerHandleWaypoint = getBoundsCenterPoint(snappedNode);
  const nodeRectangle = {
    x: snappedNode.x ?? 0,
    y: snappedNode.y ?? 0,
    width: snappedNode.width ?? 0,
    height: snappedNode.height ?? 0,
  };

  return {
    [PositionalNodeHandleId.Top]: {
      "@_x": nodeRectangle.x + nodeRectangle.width / 2,
      "@_y": nodeRectangle.y,
    },
    [PositionalNodeHandleId.Right]: {
      "@_x": nodeRectangle.x + nodeRectangle.width,
      "@_y": nodeRectangle.y + nodeRectangle.height / 2,
    },
    [PositionalNodeHandleId.Bottom]: {
      "@_x": nodeRectangle.x + nodeRectangle.width / 2,
      "@_y": nodeRectangle.y + nodeRectangle.height,
    },
    [PositionalNodeHandleId.Left]: {
      "@_x": nodeRectangle.x,
      "@_y": nodeRectangle.y + nodeRectangle.height / 2,
    },
    [PositionalNodeHandleId.Center]: getLineRectangleIntersectionPoint(
      snappedSecondWaypoint,
      centerHandleWaypoint,
      nodeRectangle,
    ),
  }[handlePosition];
}
