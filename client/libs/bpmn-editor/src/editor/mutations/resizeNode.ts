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
import { type BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  getDiBoundsCenterPoint,
  getHandlePosition,
} from "../../xyflow/maths/DcMaths";
import { type DC__Dimension, type DC__Shape } from "../../xyflow/maths/model";
import { PositionalNodeHandleId } from "../../xyflow/nodes/PositionalNodeHandles";
import {
  type SnapGrid,
  snapShapePosition,
} from "../../xyflow/snapgrid/SnapGrid";
import { type DC__Edge } from "../../xyflow/maths/model";
import {
  type BpmnNodeElement,
  type BpmnNodeType,
  NODE_TYPES,
} from "../diagram/BpmnDiagramDomain";
import { type Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import "./node-nature";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import { repositionNode } from "./repositionNode";
import { dataAssociationLocations } from "./data-association";
import { dataAssociationRouteEndpoints } from "./data-association-context";
export function resizeNode({
  definitions,
  __readonly_snapGrid,
  __readonly_change,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_snapGrid: SnapGrid;
  __readonly_change: {
    bpmnElement: BpmnNodeElement;
    nodeType: BpmnNodeType;
    shapeIndex: number;
    dimension: DC__Dimension;
    sourceEdgeIndexes: number[];
    targetEdgeIndexes: number[];
  };
}) {
  const edgeIndexesAlreadyUpdated = new Set<number>();
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const references = indexBpmnIds(definitions);
  const shape = diagramElements?.[__readonly_change.shapeIndex] as
    Normalized<DC__Shape> | undefined;
  const shapeBounds = shape?.["dc:Bounds"];
  if (!shapeBounds) {
    throw new Error("BPMN MUTATION: Cannot resize non-existent shape bounds");
  }
  const limit = {
    x: 0,
    y: 0,
  };
  const snappedPosition = snapShapePosition(__readonly_snapGrid, shape);
  const newDimensions = {
    width: Math.max(
      __readonly_change.dimension["@_width"],
      limit.x - snappedPosition.x,
    ),
    height: Math.max(
      __readonly_change.dimension["@_height"],
      limit.y - snappedPosition.y,
    ),
  };
  const deltaWidth = newDimensions.width - shapeBounds["@_width"];
  const deltaHeight = newDimensions.height - shapeBounds["@_height"];
  if (
    __readonly_change.nodeType === NODE_TYPES.task ||
    __readonly_change.nodeType === NODE_TYPES.subProcess
  ) {
    const connections = new Map<
      string,
      { sourceId?: string; targetId?: string }
    >();
    visitFlowElementsAndArtifacts(process, ({ element }) => {
      if (element.__$$element === "sequenceFlow")
        connections.set(element["@_id"], {
          sourceId: element["@_sourceRef"],
          targetId: element["@_targetRef"],
        });
      else if (element.__$$element === "association")
        connections.set(element["@_id"], {
          sourceId: references.resolveReference(
            element,
            element["@_sourceRef"],
          ),
          targetId: references.resolveReference(
            element,
            element["@_targetRef"],
          ),
        });
    });
    const dataMappings = new Map(
      dataAssociationLocations(definitions).map((location) => [
        location.association["@_id"],
        location,
      ]),
    );
    visitFlowElementsAndArtifacts(process, ({ element }) => {
      if (
        element.__$$element === "boundaryEvent" &&
        references.resolveReference(element, element["@_attachedToRef"]) ===
          __readonly_change.bpmnElement["@_id"]
      ) {
        const boundaryEventShapeIndex = diagramElements.findIndex(
          (d) =>
            references.resolveReference(d, d["@_bpmnElement"]) ===
            element["@_id"],
        );
        const boundaryEventShape = diagramElements[boundaryEventShapeIndex] as
          Normalized<DC__Shape> | undefined;
        if (!boundaryEventShape) {
          return true; // Ignore this one, but keep visiting.
        }
        const boundaryEventCenterPoint = getDiBoundsCenterPoint(
          boundaryEventShape["dc:Bounds"],
        );
        const activityCenterPoint = getDiBoundsCenterPoint(shapeBounds);
        let deltaX = 0;
        if (
          // reisizng down, boundary event would be outside
          boundaryEventCenterPoint["@_x"] >
            snappedPosition.x + newDimensions.width ||
          // resizing up, boundary event will move together with new size
          boundaryEventCenterPoint["@_x"] > activityCenterPoint["@_x"]
        ) {
          deltaX = deltaWidth;
        }
        let deltaY = 0;
        if (
          // reisizng down, boundary event would be outside
          boundaryEventCenterPoint["@_y"] >
            snappedPosition.y + newDimensions.height ||
          // resizing up, boundary event will move together with new size
          boundaryEventCenterPoint["@_y"] > activityCenterPoint["@_y"]
        ) {
          deltaY = deltaHeight;
        }
        // A resized host can move its attached event. Resolve each visible route
        // against the actual semantic endpoint (data ports stay implicit), then
        // let the shared move owner translate only that endpoint and label DI.
        const sourceEdgeIndexes: number[] = [],
          targetEdgeIndexes: number[] = [];
        diagramElements.forEach((edge, index) => {
          if (edge.__$$element !== "bpmndi:BPMNEdge") return;
          const id = references.resolveReference(edge, edge["@_bpmnElement"])!;
          const dataMapping = dataMappings.get(id);
          const endpoints = dataMapping
            ? dataAssociationRouteEndpoints(definitions, dataMapping, edge)
            : connections.get(id);
          if (endpoints?.sourceId === element["@_id"])
            sourceEdgeIndexes.push(index);
          if (endpoints?.targetId === element["@_id"])
            targetEdgeIndexes.push(index);
        });
        repositionNode({
          definitions,
          controlWaypointsByEdge: new Map(),
          __readonly_change: {
            nodeType: NODE_TYPES.intermediateCatchEvent,
            type: "offset",
            selectedEdges: [],
            sourceEdgeIndexes,
            targetEdgeIndexes,
            shapeIndex: boundaryEventShapeIndex,
            offset: {
              deltaX,
              deltaY,
            },
          },
        });
      }
      return true;
    });
  }
  const offsetByPosition = (position: PositionalNodeHandleId | undefined) => {
    return switchExpression(position, {
      [PositionalNodeHandleId.Center]: {
        x: deltaWidth / 2,
        y: deltaHeight / 2,
      },
      [PositionalNodeHandleId.Top]: {
        x: deltaWidth / 2,
        y: 0,
      },
      [PositionalNodeHandleId.Right]: {
        x: deltaWidth,
        y: deltaHeight / 2,
      },
      [PositionalNodeHandleId.Bottom]: {
        x: deltaWidth / 2,
        y: deltaHeight,
      },
      [PositionalNodeHandleId.Left]: {
        x: 0,
        y: deltaHeight / 2,
      },
    });
  };
  const offsetEdges = (args: {
    edgeIndexes: number[];
    waypointSelector: "last" | "first";
  }) => {
    for (const edgeIndex of args.edgeIndexes) {
      if (edgeIndexesAlreadyUpdated.has(edgeIndex)) {
        continue;
      }
      edgeIndexesAlreadyUpdated.add(edgeIndex);
      const edge = diagramElements[edgeIndex] as
        Normalized<DC__Edge> | undefined;
      if (!edge || !edge["di:waypoint"]) {
        throw new Error("BPMN MUTATION: Cannot reposition non-existent edge");
      }
      const waypoint = switchExpression(args.waypointSelector, {
        first: edge["di:waypoint"][0],
        last: edge["di:waypoint"][edge["di:waypoint"].length - 1],
      });
      const offset = offsetByPosition(
        getHandlePosition({
          shapeBounds,
          waypoint,
        }).handlePosition,
      );
      waypoint["@_x"] += offset.x;
      waypoint["@_y"] += offset.y;
    }
  };

  // Reposition edges after resizing

  offsetEdges({
    edgeIndexes: __readonly_change.sourceEdgeIndexes,
    waypointSelector: "first",
  });
  offsetEdges({
    edgeIndexes: __readonly_change.targetEdgeIndexes,
    waypointSelector: "last",
  });

  // Update at the end because we need the original shapeBounds value to correctly identify the position of the edges

  shapeBounds["@_width"] = newDimensions.width;
  shapeBounds["@_height"] = newDimensions.height;
}
