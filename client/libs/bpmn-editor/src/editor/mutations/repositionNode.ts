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
// Modified by Myoxus; see provenance.json for retained source and patches.

import { switchExpression } from "../ts-ext/switch-expression";
import {
  type BPMN20__tDefinitions,
  type BPMNDI__BPMNEdge,
  type BPMNDI__BPMNShape,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { type BpmnNodeType } from "../diagram/BpmnDiagramDomain";
import { type Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
export function repositionNode({
  definitions,
  controlWaypointsByEdge,
  __readonly_change,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  /**
   * This will keep track of all waypoints that were updated, in the case where multiple nodes move together.
   * This will make sure we only move edges once, even though they might be source/target edges for multiple nodes.
   */
  controlWaypointsByEdge: Map<number, Set<number>>;
  __readonly_change: {
    nodeType: BpmnNodeType;
    shapeIndex: number;
    sourceEdgeIndexes: number[];
    targetEdgeIndexes: number[];
    selectedEdges: string[];
  } & (
    | {
        type: "absolute";
        position: {
          x: number;
          y: number;
        };
      }
    | {
        type: "offset";
        offset: {
          deltaX: number;
          deltaY: number;
        };
      }
  );
}) {
  const { diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const references = indexBpmnIds(definitions);
  const shape = diagramElements?.[__readonly_change.shapeIndex] as
    Normalized<BPMNDI__BPMNShape> | undefined;
  const shapeBounds = shape?.["dc:Bounds"];
  if (!shapeBounds) {
    throw new Error(
      "BPMN MUTATION: Cannot reposition non-existent shape bounds",
    );
  }
  let deltaX: number;
  let deltaY: number;
  if (__readonly_change.type === "absolute") {
    deltaX = __readonly_change.position.x - (shapeBounds?.["@_x"] ?? 0);
    deltaY = __readonly_change.position.y - (shapeBounds?.["@_y"] ?? 0);
    shapeBounds["@_x"] = __readonly_change.position.x;
    shapeBounds["@_y"] = __readonly_change.position.y;
  } else if (__readonly_change.type === "offset") {
    deltaX = __readonly_change.offset.deltaX;
    deltaY = __readonly_change.offset.deltaY;
    shapeBounds["@_x"] += __readonly_change.offset.deltaX;
    shapeBounds["@_y"] += __readonly_change.offset.deltaY;
  } else {
    throw new Error(
      `BPMN MUTATION: Unknown type of node position change '${(__readonly_change as any).type}'.`,
    );
  }
  // Authored captions move with their shape, including hidden descendants and
  // attached events moved by a container command. Size and relative offset stay
  // authored; missing labels remain absent rather than acquiring default DI.
  const labelBounds = shape?.["bpmndi:BPMNLabel"]?.["dc:Bounds"];
  if (labelBounds) {
    labelBounds["@_x"] += deltaX;
    labelBounds["@_y"] += deltaY;
  }
  const offsetEdges = (args: {
    edgeIndexes: number[];
    waypoint: "last" | "first";
  }) => {
    for (const edgeIndex of args.edgeIndexes) {
      const edge = diagramElements[edgeIndex] as
        Normalized<BPMNDI__BPMNEdge> | undefined;
      if (!edge || !edge["di:waypoint"]) {
        throw new Error("BPMN MUTATION: Cannot reposition non-existent edge");
      }
      const isEdgeSelected =
        __readonly_change.selectedEdges.includes(
          references.resolveReference(edge, edge["@_bpmnElement"])!,
        ) ||
        (!!edge["@_id"] &&
          __readonly_change.selectedEdges.includes(edge["@_id"]));
      const waypointIndexes = switchExpression(args.waypoint, {
        first: isEdgeSelected
          ? arrayRange(0, edge["di:waypoint"].length - 2) // All except last element
          : [0],
        last: isEdgeSelected
          ? arrayRange(1, edge["di:waypoint"].length - 1) // All except first element
          : [edge["di:waypoint"].length - 1],
      });
      controlWaypointsByEdge.set(
        edgeIndex,
        controlWaypointsByEdge.get(edgeIndex) ?? new Set(),
      );
      const waypointsControl = controlWaypointsByEdge.get(edgeIndex)!;
      let movedPoint = false;
      for (const wi of waypointIndexes) {
        if (waypointsControl.has(wi)) {
          continue;
        } else {
          waypointsControl.add(wi);
        }
        const w = edge["di:waypoint"][wi];
        w["@_x"] += deltaX;
        w["@_y"] += deltaY;
        movedPoint = true;
      }
      // A full route translation carries its authored label exactly once when
      // the last still-unmoved point is reached. An endpoint-only deformation
      // keeps manual label geometry fixed. The shared point set spans this one
      // group move, including nested/hidden nodes and DI-identified fan-in routes.
      const label = edge["bpmndi:BPMNLabel"]?.["dc:Bounds"];
      if (
        label &&
        movedPoint &&
        waypointsControl.size === edge["di:waypoint"].length
      ) {
        label["@_x"] += deltaX;
        label["@_y"] += deltaY;
      }
    }
  };
  offsetEdges({
    edgeIndexes: __readonly_change.sourceEdgeIndexes,
    waypoint: "first",
  });
  offsetEdges({
    edgeIndexes: __readonly_change.targetEdgeIndexes,
    waypoint: "last",
  });
  return {
    delta: {
      x: deltaX,
      y: deltaY,
    },
    newPosition: {
      x: shapeBounds["@_x"],
      y: shapeBounds["@_y"],
    },
  };
}
function arrayRange(start: number, stop: number, step = 1) {
  return Array.from(
    {
      length: (stop - start) / step + 1,
    },
    (_, index) => start + index * step,
  );
}
