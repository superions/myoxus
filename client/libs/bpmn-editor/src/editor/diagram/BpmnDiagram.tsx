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

import {
  type DiagramRef,
  type OnConnectedNodeAdded,
  type OnEdgeAdded,
  type OnEdgeDeleted,
  type OnEdgeUpdated,
  type OnEscPressed,
  type OnNodeAdded,
  type OnNodeDeleted,
  type OnNodeParented,
  type OnNodeRepositioned,
  type OnNodeResized,
  type OnNodeUnparented,
  type OnResetToBeforeEditingBegan,
  type OnWaypointAdded,
  type OnWaypointDeleted,
  type OnWaypointRepositioned,
  XyFlowReactKieDiagram,
} from "../../xyflow/diagram/XyFlowReactKieDiagram";
import { ConnectionLine as ReactFlowDiagramConnectionLine } from "../../xyflow/edges/ConnectionLine";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { EdgeMarkers } from "../../xyflow/edges/EdgeMarkers";
import {
  ContainmentMode,
  getEdgeTypesBetween,
  getDefaultEdgeTypeBetween,
} from "../../xyflow/graph/graphStructure";
import {
  getHandlePosition,
  getPointForHandle,
  getDistance,
} from "../../xyflow/maths/DcMaths";
import type { DC__Point, DC__Bounds } from "../../xyflow/maths/model";
import { PositionalNodeHandleId } from "../../xyflow/nodes/PositionalNodeHandles";
import { type Draft } from "immer";
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Select,
  Stack,
  Group,
  Button,
  NumberInput,
} from "@myoxus/ui-facade";
import {
  DiagramActionContext,
  type DiagramActionRequest,
} from "../../xyflow/diagram/DiagramActionContext";
import { useI18n } from "@myoxus/i18n";
import { snapPoint } from "../../xyflow/snapgrid/SnapGrid";
import * as RF from "@xyflow/react";
import { useBpmnEditor } from "../BpmnEditorContext";
import { addConnectedNode } from "../mutations/addConnectedNode";
import { dataAssociationById } from "../mutations/data-association";
import { dataAssociationRouteEndpoints } from "../mutations/data-association-context";
import { addEdge, DataAssociationBindingRequired } from "../mutations/addEdge";
import { addEdgeWaypoint } from "../mutations/addEdgeWaypoint";
import { moveNodesInsideLane } from "../mutations/moveNodesInsideLane";
import { findEventById } from "../mutations/event";
import { moveNodesInsideSubProcess } from "../mutations/moveNodesInsideSubProcess";
import { addStandaloneNode } from "../mutations/addStandaloneNode";
import { deleteEdge } from "../mutations/deleteEdge";
import { deleteEdgeWaypoint } from "../mutations/deleteEdgeWaypoint";
import { deleteNode } from "../mutations/deleteNode";
import { moveNodesOutOfLane } from "../mutations/moveNodesOutOfLane";
import { moveNodesOutOfSubProcess } from "../mutations/moveNodesOutOfSubProcess";
import { makeBoundaryEvent } from "../mutations/makeBoundaryEvent";
import { detachBoundaryEvent } from "../mutations/detachBoundaryEvent";
import { repositionEdgeWaypoint } from "../mutations/repositionEdgeWaypoint";
import { repositionNode } from "../mutations/repositionNode";
import { resizeNode } from "../mutations/resizeNode";
import { BpmnDiagramLhsPanel, type State } from "../store/Store";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { BpmnDiagramCommands } from "./BpmnDiagramCommands";
import { useCommands } from "../commands/CommandsContextProvider";
import {
  BPMN_CONTAINMENT_MAP,
  BPMN_GRAPH_STRUCTURE,
  BPMN_OUTGOING_STRUCTURE,
  bpmnEdgesOutgoingStuffNodePanelMapping,
  bpmnNodesOutgoingStuffNodePanelMapping,
  type BpmnDiagramEdgeData,
  type BpmnDiagramNodeData,
  type BpmnEdgeType,
  type BpmnNodeType,
  CONNECTION_LINE_EDGE_COMPONENTS_MAPPING,
  CONNECTION_LINE_NODE_COMPONENT_MAPPING,
  DEFAULT_NODE_SIZES,
  elementToNodeType,
  MIN_NODE_SIZES,
  NODE_TYPES,
  XY_FLOW_EDGE_TYPES,
  XY_FLOW_NODE_TYPES,
} from "./BpmnDiagramDomain";
import { BpmnDiagramEmptyState } from "./BpmnDiagramEmptyState";
import { TopRightCornerPanels } from "./BpmnDiagramTopRightPanels";
import {
  BpmnPalette,
  MIME_TYPE_FOR_BPMN_EDITOR_NEW_NODE_FROM_PALETTE,
} from "./BpmnPalette";
import { DiagramContainerContextProvider } from "./DiagramContainerContext";

function nodeActionLabel(node: RF.Node<BpmnDiagramNodeData, BpmnNodeType>) {
  const element = node.data.bpmnElement;
  const name = "@_name" in element ? element["@_name"] : undefined;
  return name ? `${name} (${node.id})` : node.id;
}

function edgeActionLabel(edge: RF.Edge<BpmnDiagramEdgeData>) {
  const element = edge.data?.bpmnElement;
  const name = element && "@_name" in element ? element["@_name"] : undefined;
  return name ? `${name} (${edge.id})` : edge.id;
}

function closestReconnectHandle(
  node: RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
  adjacent: DC__Point,
) {
  const bounds = node.data.shape["dc:Bounds"];
  return [
    PositionalNodeHandleId.Top,
    PositionalNodeHandleId.Right,
    PositionalNodeHandleId.Bottom,
    PositionalNodeHandleId.Left,
  ].reduce((closest, handle) =>
    getDistance(getPointForHandle({ bounds, handle }), adjacent) <
    getDistance(getPointForHandle({ bounds, handle: closest }), adjacent)
      ? handle
      : closest,
  );
}

function outgoingActions(type: BpmnNodeType) {
  if (type === NODE_TYPES.unknown) return [];
  return [
    ...BPMN_OUTGOING_STRUCTURE[type].edges.map((type) => ({
      kind: "edge" as const,
      type,
      value: type,
      label: bpmnEdgesOutgoingStuffNodePanelMapping[type].actionTitle,
    })),
    ...BPMN_OUTGOING_STRUCTURE[type].nodes.map((type) => ({
      kind: "node" as const,
      type,
      value: type,
      label:
        bpmnNodesOutgoingStuffNodePanelMapping[
          type as keyof typeof bpmnNodesOutgoingStuffNodePanelMapping
        ].actionTitle,
    })),
  ];
}
/** Deterministic rightward append in the retained absolute diagram coordinates.
 * Ancestor containers bound placement; sibling containers remain obstacles. */
function nextElementPosition(
  state: State,
  source: RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
  type: BpmnNodeType,
  renderer:
    | RF.ReactFlowInstance<
        RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
        RF.Edge<BpmnDiagramEdgeData>
      >
    | undefined,
  root: HTMLElement | null,
) {
  const grid = state.xyFlowReactKieDiagram.snapGrid;
  const size = DEFAULT_NODE_SIZES[type]({ snapGrid: grid });
  const bounds = source.data.shape["dc:Bounds"];
  const ancestors = new Set<string>();
  let container: typeof source | undefined;
  for (
    let parent = source.data.parentXyFlowNode;
    parent;
    parent = parent.data.parentXyFlowNode
  ) {
    if (
      parent.type === NODE_TYPES.lane ||
      parent.type === NODE_TYPES.subProcess
    ) {
      ancestors.add(parent.id);
      container ??= parent as typeof source;
    }
  }
  const limit = container?.data.shape["dc:Bounds"];
  const occupied: DC__Bounds[] = [];
  for (const node of state
    .computed(state)
    .getDiagramData()
    .nodesById.values()) {
    if (node.hidden) continue;
    if (!ancestors.has(node.id) && node.type !== NODE_TYPES.group)
      occupied.push(node.data.shape["dc:Bounds"]);
    const label = node.data.shape["bpmndi:BPMNLabel"]?.["dc:Bounds"];
    if (label) occupied.push(label);
  }
  for (const edge of state
    .computed(state)
    .getDiagramData()
    .edgesById.values()) {
    const label = edge.data?.bpmnEdge?.["bpmndi:BPMNLabel"]?.["dc:Bounds"];
    if (!edge.hidden && label) occupied.push(label);
  }
  // Default captions need no invented DI. Their painted bounds use the native
  // viewport conversion; imported explicit label bounds remain reserved above.
  if (renderer)
    for (const label of root?.querySelectorAll<HTMLElement>(
      ".xyflow-react-kie-diagram--editable-node-name-input span",
    ) ?? []) {
      const rect = label.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const a = renderer.screenToFlowPosition(
        { x: rect.left, y: rect.top },
        { snapToGrid: false },
      );
      const b = renderer.screenToFlowPosition(
        { x: rect.right, y: rect.bottom },
        { snapToGrid: false },
      );
      occupied.push({
        "@_x": a.x,
        "@_y": a.y,
        "@_width": b.x - a.x,
        "@_height": b.y - a.y,
      });
    }
  const gap = grid.x * 2;
  const start = snapPoint(
    grid,
    {
      "@_x": bounds["@_x"] + bounds["@_width"] + gap,
      "@_y": bounds["@_y"] + (bounds["@_height"] - size["@_height"]) / 2,
    },
    "ceil",
  );
  // Vertical centering rounds to the nearest grid position, not upward.
  const y = snapPoint(grid, {
    "@_x": 0,
    "@_y": bounds["@_y"] + (bounds["@_height"] - size["@_height"]) / 2,
  })["@_y"];
  let x = start["@_x"];
  for (let remaining = occupied.length + 1; remaining > 0; remaining--) {
    if (
      limit &&
      (x < limit["@_x"] ||
        x + size["@_width"] > limit["@_x"] + limit["@_width"] ||
        y < limit["@_y"] ||
        y + size["@_height"] > limit["@_y"] + limit["@_height"])
    )
      break;
    const collisions = occupied.filter(
      (b) =>
        x < b["@_x"] + b["@_width"] &&
        x + size["@_width"] > b["@_x"] &&
        y < b["@_y"] + b["@_height"] &&
        y + size["@_height"] > b["@_y"],
    );
    if (!collisions.length)
      return {
        x,
        y,
        laneId: container?.type === NODE_TYPES.lane ? container.id : undefined,
      };
    // Jump past blocking bounds rather than iterating across an imported
    // diagram's potentially huge empty coordinate ranges.
    x = snapPoint(
      grid,
      {
        "@_x": Math.max(
          x + grid.x,
          ...collisions.map((b) => b["@_x"] + b["@_width"] + gap),
        ),
        "@_y": y,
      },
      "ceil",
    )["@_x"];
  }
  throw new Error("BPMN_ACTIVITY_SCOPE");
}

export function BpmnDiagram({
  container,
  diagramRef,
  onFitToContent,
}: {
  diagramRef: React.RefObject<DiagramRef<
    BpmnNodeType,
    BpmnDiagramNodeData,
    BpmnDiagramEdgeData
  > | null>;
  container: React.RefObject<HTMLElement | null>;
  locale: string;
  onFitToContent: () => void;
}) {
  const [showEmptyState, setShowEmptyState] = useState(true);
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { commandsRef } = useCommands();
  const model = useBpmnEditorStore((s) => s.bpmn.model);
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const openLhsPanel = useBpmnEditorStore((s) => s.diagram.openLhsPanel);
  const {
    bpmnModelBeforeEditingRef,
    commandError,
    onCommandError: onError,
    clearCommandError,
  } = useBpmnEditor();
  const [binding, setBinding] = useState<{
    model: State["bpmn"]["model"];
    action: DataAssociationBindingRequired;
    source: string | null;
    target: string | null;
  }>();
  const [nodeAction, setNodeAction] = useState<{
    model: State["bpmn"]["model"];
    source: RF.Node<BpmnDiagramNodeData, BpmnNodeType>;
    choice: string;
    target: string | null;
    x: number | string;
    y: number | string;
    width: number | string;
    height: number | string;
    canResize: boolean;
    edge?: RF.Edge<BpmnDiagramEdgeData>;
  }>();
  const actionReturnFocus = React.useRef<HTMLElement | null>(null);
  const reconnectReturnFocus = React.useRef<string | undefined>(undefined);
  useEffect(() => {
    if (nodeAction && (readOnly || nodeAction.model !== model))
      setNodeAction(undefined);
  }, [nodeAction, model, readOnly]);
  const onDiagramError = useCallback(
    (error: unknown) => {
      if (error instanceof DataAssociationBindingRequired) {
        setBinding({
          model: bpmnEditorStoreApi.getState().bpmn.model,
          action: error,
          source: null,
          target: null,
        });
      } else onError(error);
    },
    [bpmnEditorStoreApi, onError],
  );
  // A payload dialog never owns a stale gesture. Host source replacement,
  // history, external edits or a permission change invalidate its retry.
  useEffect(() => {
    if (binding && (readOnly || binding.model !== model)) setBinding(undefined);
  }, [binding, model, readOnly]);
  const onResetToBeforeEditingBegan: OnResetToBeforeEditingBegan<
    State,
    BpmnNodeType,
    BpmnEdgeType,
    BpmnDiagramNodeData,
    BpmnDiagramEdgeData
  > = useCallback(
    (stateDraft: Draft<State>) => {
      // This ref captures the normalized immutable store model at gesture
      // start. Re-normalizing clones it and marks a rejected gesture dirty.
      stateDraft.bpmn.model =
        bpmnModelBeforeEditingRef.current as State["bpmn"]["model"];
      stateDraft.xyFlowReactKieDiagram.draggingNodes = [];
      stateDraft.xyFlowReactKieDiagram.draggingWaypoints = [];
      stateDraft.xyFlowReactKieDiagram.resizingNodes = [];
      stateDraft.xyFlowReactKieDiagram.dropTarget = undefined;
      stateDraft.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
    },
    [bpmnModelBeforeEditingRef],
  );
  const nodes = useBpmnEditorStore((s) => s.computed(s).getDiagramData().nodes);
  const isEmptyStateShowing =
    showEmptyState &&
    nodes.length === 0 &&
    openLhsPanel === BpmnDiagramLhsPanel.NONE;

  // nodes

  const onNodeAdded = useCallback<
    OnNodeAdded<State, BpmnNodeType, BpmnDiagramNodeData, BpmnDiagramEdgeData>
  >(({ state, type, element, dropPoint, data }) => {
    // Attachment docks to the actual host contour after grid rounding. Do not
    // round that final border point again when imported hosts are off-grid.
    const point = {
      "@_x": dropPoint.x,
      "@_y": dropPoint.y,
    };
    const position =
      state.xyFlowReactKieDiagram.dropTarget?.containmentMode ===
      ContainmentMode.BORDER
        ? point
        : snapPoint(state.xyFlowReactKieDiagram.snapGrid, point);
    const { id } = addStandaloneNode({
      definitions: state.bpmn.model.definitions,
      __readonly_element: element as keyof typeof elementToNodeType,
      __readonly_newNode: {
        type,
        bounds: {
          "@_x": position["@_x"],
          "@_y": position["@_y"],
          "@_width": DEFAULT_NODE_SIZES[type]({
            snapGrid: state.xyFlowReactKieDiagram.snapGrid,
          })["@_width"],
          "@_height": DEFAULT_NODE_SIZES[type]({
            snapGrid: state.xyFlowReactKieDiagram.snapGrid,
          })["@_height"],
        },
        data,
      },
    });
    return {
      newNodeId: id,
    };
  }, []);
  const onConnectedNodeAdded = useCallback<
    OnConnectedNodeAdded<
      State,
      BpmnNodeType,
      BpmnEdgeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(({ state, sourceNode, newNodeType, dropPoint }) => {
    const position = snapPoint(state.xyFlowReactKieDiagram.snapGrid, {
      "@_x": dropPoint.x,
      "@_y": dropPoint.y,
    });
    const { id } = addConnectedNode({
      definitions: state.bpmn.model.definitions,
      __readonly_sourceNode: {
        bounds: sourceNode.data.shape["dc:Bounds"],
        id: sourceNode.id,
        shapeId: sourceNode.data.shape["@_id"],
        type: sourceNode.type as BpmnNodeType,
      },
      __readonly_newNode: {
        type: newNodeType,
        bounds: {
          "@_x": position["@_x"],
          "@_y": position["@_y"],
          "@_width": DEFAULT_NODE_SIZES[newNodeType]({
            snapGrid: state.xyFlowReactKieDiagram.snapGrid,
          })["@_width"],
          "@_height": DEFAULT_NODE_SIZES[newNodeType]({
            snapGrid: state.xyFlowReactKieDiagram.snapGrid,
          })["@_height"],
        },
      },
    });
    return {
      newNodeId: id,
    };
  }, []);
  const onNodeRepositioned = useCallback<
    OnNodeRepositioned<
      State,
      BpmnNodeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(({ state, node, controlWaypointsByEdge, newPosition, childNodeIds }) => {
    const { delta } = repositionNode({
      definitions: state.bpmn.model.definitions,
      controlWaypointsByEdge,
      __readonly_change: {
        type: "absolute",
        nodeType: node.type as BpmnNodeType,
        selectedEdges: [
          ...state.computed(state).getDiagramData().selectedEdgesById.keys(),
        ],
        shapeIndex: node.data.shapeIndex,
        sourceEdgeIndexes: state
          .computed(state)
          .getDiagramData()
          .edges.flatMap((e) =>
            e.source === node.id && e.data?.bpmnEdge
              ? [e.data.bpmnEdgeIndex]
              : [],
          ),
        targetEdgeIndexes: state
          .computed(state)
          .getDiagramData()
          .edges.flatMap((e) =>
            e.target === node.id && e.data?.bpmnEdge
              ? [e.data.bpmnEdgeIndex]
              : [],
          ),
        position: newPosition,
      },
    });
    const allEdgeIds = state
      .computed(state)
      .getDiagramData()
      .edges.map((e) => e.id); // Simulate all edges being selected

    for (const nestedId of childNodeIds) {
      const nestedNode = state
        .computed(state)
        .getDiagramData()
        .nodesById.get(nestedId);
      if (!nestedNode) {
        throw new Error("Can't reposition nested node with id " + nestedId);
      }
      repositionNode({
        definitions: state.bpmn.model.definitions,
        controlWaypointsByEdge,
        __readonly_change: {
          type: "offset",
          nodeType: nestedNode.type as BpmnNodeType,
          selectedEdges: allEdgeIds,
          // Makes sure all internal waypoints move too.
          shapeIndex: nestedNode.data.shapeIndex,
          sourceEdgeIndexes: state
            .computed(state)
            .getDiagramData()
            .edges.flatMap((e) =>
              e.source === nestedId && e.data?.bpmnEdge
                ? [e.data.bpmnEdgeIndex]
                : [],
            ),
          targetEdgeIndexes: state
            .computed(state)
            .getDiagramData()
            .edges.flatMap((e) =>
              e.target === nestedId && e.data?.bpmnEdge
                ? [e.data.bpmnEdgeIndex]
                : [],
            ),
          offset: {
            deltaX: delta.x,
            deltaY: delta.y,
          },
        },
      });
    }
  }, []);
  const onNodeDeleted = useCallback<
    OnNodeDeleted<State, BpmnNodeType, BpmnDiagramNodeData, BpmnDiagramEdgeData>
  >(({ state, node }) => {
    deleteNode({
      definitions: state.bpmn.model.definitions,
      __readonly_bpmnElementId: node.data.bpmnElement?.["@_id"],
      __readonly_bpmnEdgeData: state
        .computed(state)
        .getDiagramData()
        .edges.map((e) => e.data!),
    });
  }, []);
  const onNodeUnparented = useCallback<
    OnNodeUnparented<
      State,
      BpmnNodeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(
    ({
      state,
      activeNode,
      exParentNode,
      nextParentNode,
      nextContainmentMode,
      selectedNodes,
    }) => {
      const nextInside = nextContainmentMode === ContainmentMode.INSIDE;
      const sameScopeBorder =
        nextContainmentMode === ContainmentMode.BORDER &&
        findEventById(
          state.bpmn.model.definitions,
          activeNode.id,
        )?.owner.flowElement?.some(
          (element) => element["@_id"] === nextParentNode?.id,
        );
      // Inside-to-inside movement goes straight to its final semantic scope. A
      // temporary root detach can falsely reject connected same-scope data/flows.
      if (
        exParentNode.type === NODE_TYPES.subProcess &&
        !nextInside &&
        !sameScopeBorder
      ) {
        // ContainmentMode was INSIDE
        moveNodesOutOfSubProcess({
          definitions: state.bpmn.model.definitions,
          __readonly_subProcessId: exParentNode.data.bpmnElement?.["@_id"],
          __readonly_nodeIds: selectedNodes.flatMap(
            (s) => s.data.bpmnElement?.["@_id"] ?? [],
          ),
        });
      }
      if (
        exParentNode.type === NODE_TYPES.lane &&
        (!nextInside || nextParentNode?.type !== NODE_TYPES.lane)
      ) {
        // A final lane command handles branch membership itself. Leaving a lane
        // for a plain subprocess still needs this membership-only detach.
        moveNodesOutOfLane({
          definitions: state.bpmn.model.definitions,
          __readonly_laneId: exParentNode.data.bpmnElement?.["@_id"],
          __readonly_nodeIds: selectedNodes.flatMap(
            (s) => s.data.bpmnElement?.["@_id"] ?? [],
          ),
        });
      }
      if (
        (exParentNode.type === NODE_TYPES.subProcess ||
          exParentNode.type === NODE_TYPES.task) &&
        activeNode.type === NODE_TYPES.intermediateCatchEvent &&
        activeNode.data.bpmnElement?.__$$element === "boundaryEvent" &&
        nextContainmentMode !== ContainmentMode.BORDER
      ) {
        if (selectedNodes.length > 1) {
          throw new Error(
            "Can't unparent more than one node when boundary events are selected.",
          );
        }

        // ContainmentMode was BORDER
        // Reattachment goes directly through setEventAttachment. Error/cancel
        // boundaries cannot legally become an intermediate catch on the way.
        detachBoundaryEvent({
          definitions: state.bpmn.model.definitions,
          __readonly_eventId: activeNode.data.bpmnElement?.["@_id"],
        });
      }
    },
    [],
  );
  const onNodeParented = useCallback<
    OnNodeParented<
      State,
      BpmnNodeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(({ state, containmentMode, activeNode, parentNode, selectedNodes }) => {
    if (
      containmentMode === ContainmentMode.INSIDE &&
      parentNode.type === NODE_TYPES.subProcess
    ) {
      moveNodesInsideSubProcess({
        definitions: state.bpmn.model.definitions,
        __readonly_subProcessId: parentNode.data.bpmnElement?.["@_id"],
        __readonly_nodeIds: selectedNodes.flatMap(
          (s) => s.data.bpmnElement?.["@_id"] ?? [],
        ),
      });
    } else if (
      containmentMode === ContainmentMode.INSIDE &&
      parentNode.type === NODE_TYPES.lane
    ) {
      moveNodesInsideLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: parentNode.data.bpmnElement?.["@_id"],
        __readonly_nodeIds: selectedNodes.flatMap(
          (s) => s.data.bpmnElement?.["@_id"] ?? [],
        ),
      });
    } else if (
      containmentMode === ContainmentMode.BORDER &&
      (parentNode.type === NODE_TYPES.subProcess ||
        parentNode.type === NODE_TYPES.task)
    ) {
      makeBoundaryEvent({
        definitions: state.bpmn.model.definitions,
        __readonly_targetActivityId: parentNode.data.bpmnElement?.["@_id"],
        __readonly_eventId: activeNode.data.bpmnElement?.["@_id"],
      });
    }
  }, []);
  const onNodeResized = useCallback<
    OnNodeResized<State, BpmnNodeType, BpmnDiagramNodeData, BpmnDiagramEdgeData>
  >(({ state, node, newDimensions }) => {
    resizeNode({
      definitions: state.bpmn.model.definitions,
      __readonly_snapGrid: state.xyFlowReactKieDiagram.snapGrid,
      __readonly_change: {
        bpmnElement: node.data.bpmnElement,
        nodeType: node.type!,
        shapeIndex: node.data.shapeIndex,
        sourceEdgeIndexes: state
          .computed(state)
          .getDiagramData()
          .edges.flatMap((e) =>
            e.source === node.id && e.data?.bpmnEdge
              ? [e.data.bpmnEdgeIndex]
              : [],
          ),
        targetEdgeIndexes: state
          .computed(state)
          .getDiagramData()
          .edges.flatMap((e) =>
            e.target === node.id && e.data?.bpmnEdge
              ? [e.data.bpmnEdgeIndex]
              : [],
          ),
        dimension: {
          "@_width": newDimensions.width,
          "@_height": newDimensions.height,
        },
      },
    });
  }, []);

  // edges

  const onEdgeAdded = useCallback<
    OnEdgeAdded<
      State,
      BpmnNodeType,
      BpmnEdgeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(
    ({
      state,
      edgeType,
      sourceNode,
      targetNode,
      targetHandle,
      sourceHandle,
    }) => {
      addEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edge: {
          type: edgeType as BpmnEdgeType,
          targetHandle: targetHandle,
          sourceHandle,
          autoPositionedEdgeMarker: undefined,
          name: undefined,
          documentation: undefined,
        },
        __readonly_sourceNode: {
          type: sourceNode.type as BpmnNodeType,
          href: sourceNode.id,
          bounds: sourceNode.data.shape["dc:Bounds"],
          shapeId: sourceNode.data.shape["@_id"],
        },
        __readonly_targetNode: {
          type: targetNode.type as BpmnNodeType,
          href: targetNode.id,
          bounds: targetNode.data.shape["dc:Bounds"],
          shapeId: targetNode.data.shape["@_id"],
        },
        __readonly_keepWaypoints: false,
      });
    },
    [],
  );
  const onEdgeUpdated = useCallback<
    OnEdgeUpdated<
      State,
      BpmnNodeType,
      BpmnEdgeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(
    ({
      state,
      edge,
      targetNode,
      sourceNode,
      targetHandle,
      sourceHandle,
      firstWaypoint,
      lastWaypoint,
    }) => {
      const points = edge.data?.bpmnEdge?.["di:waypoint"] ?? [];
      const { newBpmnEdge } = addEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edge: {
          id: edge.id,
          associationDirection:
            edge.data?.bpmnElement.__$$element === "association"
              ? edge.data.bpmnElement["@_associationDirection"]
              : undefined,
          autoPositionedEdgeMarker: undefined,
          type: edge.type as BpmnEdgeType,
          targetHandle: ((targetHandle as PositionalNodeHandleId) ??
            (edge.target !== targetNode.id
              ? closestReconnectHandle(
                  targetNode,
                  points.at(-2) ?? firstWaypoint,
                )
              : getHandlePosition({
                  shapeBounds: targetNode.data.shape["dc:Bounds"],
                  waypoint: lastWaypoint,
                }).handlePosition)) as PositionalNodeHandleId,
          sourceHandle: ((sourceHandle as PositionalNodeHandleId) ??
            (edge.source !== sourceNode.id
              ? closestReconnectHandle(sourceNode, points[1] ?? lastWaypoint)
              : getHandlePosition({
                  shapeBounds: sourceNode.data.shape["dc:Bounds"],
                  waypoint: firstWaypoint,
                }).handlePosition)) as PositionalNodeHandleId,
          name:
            edge.data?.bpmnElement.__$$element === "sequenceFlow"
              ? edge.data.bpmnElement["@_name"]
              : undefined,
          documentation:
            edge.data?.bpmnElement.__$$element === "sequenceFlow"
              ? edge.data.bpmnElement.documentation
              : undefined,
        },
        __readonly_sourceNode: {
          type: sourceNode.type!,
          href: sourceNode.id,
          bounds: sourceNode.data.shape["dc:Bounds"],
          shapeId: sourceNode.data.shape["@_id"],
        },
        __readonly_targetNode: {
          type: targetNode.type!,
          href: targetNode.id,
          bounds: targetNode.data.shape["dc:Bounds"],
          shapeId: targetNode.data.shape["@_id"],
        },
        __readonly_keepWaypoints: true,
      });
      // Keyboard reconnection supplies no new handle on an unchanged node.
      // Preserve that endpoint verbatim instead of interpreting arbitrary
      // authored border coordinates as the legacy center-handle fallback.
      if (sourceHandle === undefined && edge.source === sourceNode.id)
        newBpmnEdge["di:waypoint"][0] = { ...firstWaypoint };
      if (targetHandle === undefined && edge.target === targetNode.id)
        newBpmnEdge["di:waypoint"][newBpmnEdge["di:waypoint"].length - 1] = {
          ...lastWaypoint,
        };

      // Reconnect retains the semantic/DI identities, metadata and interior
      // waypoints; addEdge validates the complete prospective endpoints first.
      const semanticId = indexBpmnIds(
        state.bpmn.model.definitions,
      ).resolveReference(newBpmnEdge, newBpmnEdge["@_bpmnElement"]);
      if (!semanticId) throw new Error("BPMN_DANGLING_REFERENCE");
      const mapping = dataAssociationById(
        state.bpmn.model.definitions,
        semanticId,
      );
      const endpoint = mapping
        ? dataAssociationRouteEndpoints(
            state.bpmn.model.definitions,
            mapping,
            newBpmnEdge,
          )
        : undefined;
      return {
        id:
          endpoint && endpoint.sourceId !== endpoint.sourceIds[0]
            ? newBpmnEdge["@_id"]
            : semanticId,
      };
    },
    [],
  );
  const onEdgeDeleted = useCallback<
    OnEdgeDeleted<
      State,
      BpmnNodeType,
      BpmnEdgeType,
      BpmnDiagramNodeData,
      BpmnDiagramEdgeData
    >
  >(({ state, edge }) => {
    // Several DI branches can depict one mapping. Group deletion may already
    // have retired it through another selected branch in this transaction.
    if (
      (edge.data?.bpmnElement.__$$element === "dataInputAssociation" ||
        edge.data?.bpmnElement.__$$element === "dataOutputAssociation") &&
      !dataAssociationById(
        state.bpmn.model.definitions,
        edge.data.bpmnElement["@_id"],
      )
    )
      return;
    deleteEdge({
      definitions: state.bpmn.model.definitions,
      __readonly_edgeId: edge.id,
    });
  }, []);

  // waypoints

  const onWaypointAdded = useCallback<OnWaypointAdded>(
    ({ beforeIndex, edgeIndex, waypoint }) => {
      bpmnEditorStoreApi.setState((s) => {
        addEdgeWaypoint({
          definitions: s.bpmn.model.definitions,
          __readonly_edgeIndex: edgeIndex,
          __readonly_beforeIndex: beforeIndex,
          __readonly_waypoint: waypoint,
        });
      });
    },
    [bpmnEditorStoreApi],
  );
  const onWaypointRepositioned = useCallback<OnWaypointRepositioned>(
    ({ waypointIndex, edgeIndex, waypoint }) => {
      bpmnEditorStoreApi.setState((s) => {
        repositionEdgeWaypoint({
          definitions: s.bpmn.model.definitions,
          __readonly_edgeIndex: edgeIndex,
          __readonly_waypoint: waypoint,
          __readonly_waypointIndex: waypointIndex,
        });
      });
    },
    [bpmnEditorStoreApi],
  );
  const onWaypointDeleted = useCallback<OnWaypointDeleted>(
    ({ waypointIndex, edgeIndex }) => {
      bpmnEditorStoreApi.setState((s) => {
        deleteEdgeWaypoint({
          definitions: s.bpmn.model.definitions,
          __readonly_edgeIndex: edgeIndex,
          __readonly_waypointIndex: waypointIndex,
        });
      });
    },
    [bpmnEditorStoreApi],
  );

  // misc

  const onEscPressed = useCallback<OnEscPressed>(() => {
    bpmnEditorStoreApi.setState((state) => {
      state.propertiesPanel.isOpen = false;
      state.diagram.overlaysPanel.isOpen = false;
      state.diagram.openLhsPanel = BpmnDiagramLhsPanel.NONE;
    });
  }, [bpmnEditorStoreApi]);
  const requestDiagramAction = useCallback(
    (request: DiagramActionRequest) => {
      const state = bpmnEditorStoreApi.getState();
      if (state.settings.isReadOnly) return;
      if (state.xyFlowReactKieDiagram.placementElement)
        bpmnEditorStoreApi.setState((draft) => {
          draft.xyFlowReactKieDiagram.placementElement = undefined;
          draft.xyFlowReactKieDiagram.placementModel = undefined;
          draft.xyFlowReactKieDiagram.newNodeProjection = undefined;
          draft.xyFlowReactKieDiagram.dropTarget = undefined;
        });
      const diagram = state.computed(state).getDiagramData();
      const edge =
        "edgeId" in request ? diagram.edgesById.get(request.edgeId) : undefined;
      const nodeId = "nodeId" in request ? request.nodeId : edge?.source;
      const source = state
        .computed(state)
        .getDiagramData()
        .nodesById.get(nodeId!);
      if (!source?.type || source.hidden) return;
      const requestedAction =
        "nodeId" in request
          ? request.action
          : edge
            ? { kind: "edge", type: edge.type }
            : undefined;
      const choices = outgoingActions(source.type),
        choice = requestedAction
          ? choices.find(
              (choice) =>
                choice.kind === requestedAction.kind &&
                choice.type === requestedAction.type,
            )
          : choices[0];
      if (!choice) return;
      actionReturnFocus.current =
        [
          ...(container.current?.querySelectorAll<HTMLElement>(
            "[data-nodehref]",
          ) ?? []),
        ].find((element) => element.dataset.nodehref === nodeId) ?? null;
      reconnectReturnFocus.current = edge?.id;
      if (edge) {
        actionReturnFocus.current = null;
        bpmnEditorStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram._selectedNodes = [];
          state.xyFlowReactKieDiagram._selectedEdges = [edge.id];
        });
      }
      const bounds = source.data.shape["dc:Bounds"],
        grid = state.xyFlowReactKieDiagram.snapGrid;
      const renderer = diagramRef.current?.getReactFlowInstance();
      if (
        "nodeId" in request &&
        request.placement === "next" &&
        choice.kind === "node"
      ) {
        try {
          const position = nextElementPosition(
            state,
            source,
            choice.type,
            renderer,
            container.current,
          );
          let created: string | undefined;
          bpmnEditorStoreApi.setState((draft) => {
            const { newNodeId } = onConnectedNodeAdded({
              state: draft,
              sourceNode: source,
              newNodeType: choice.type,
              edgeType: getDefaultEdgeTypeBetween(
                BPMN_GRAPH_STRUCTURE,
                source.type!,
                choice.type,
              )!,
              dropPoint: position,
            });
            if (position.laneId && choice.type !== NODE_TYPES.textAnnotation)
              moveNodesInsideLane({
                definitions: draft.bpmn.model.definitions,
                __readonly_laneId: position.laneId,
                __readonly_nodeIds: [newNodeId],
              });
            draft.xyFlowReactKieDiagram._selectedNodes = [newNodeId];
            draft.xyFlowReactKieDiagram._selectedEdges = [];
            draft.xyFlowReactKieDiagram.newNodeProjection = undefined;
            draft.xyFlowReactKieDiagram.placementElement = undefined;
            draft.xyFlowReactKieDiagram.placementModel = undefined;
            created = newNodeId;
          });
          const current = bpmnEditorStoreApi.getState();
          const target = created
            ? current.computed(current).getDiagramData().nodesById.get(created)
                ?.data.shape["dc:Bounds"]
            : undefined;
          if (target && renderer)
            void renderer.setCenter(
              target["@_x"] + target["@_width"] / 2,
              target["@_y"] + target["@_height"] / 2,
              { zoom: renderer.getZoom(), duration: 200 },
            );
        } catch (error) {
          onDiagramError(error);
        }
        return;
      }
      let defaults: { x: number; y: number } = {
        x: bounds["@_x"] + bounds["@_width"] + grid.x * 2,
        y: bounds["@_y"],
      };
      if (choice.kind === "node") {
        try {
          defaults = nextElementPosition(
            state,
            source,
            choice.type,
            renderer,
            container.current,
          );
        } catch (error) {
          onDiagramError(error);
          return;
        }
      }
      // These are authored diagram units, not screen pixels or toolbar sizing.
      // The same connected-node owner validates containment as for a canvas drop.
      setNodeAction({
        model: state.bpmn.model,
        source,
        choice: choice.value,
        target: edge?.target ?? null,
        edge,
        x: defaults.x,
        y: defaults.y,
        width: bounds["@_width"],
        height: bounds["@_height"],
        // Reuse the renderer's actual capability, including applicability and
        // selected-state rules; do not maintain a second node-type resize map.
        canResize:
          !edge &&
          !!actionReturnFocus.current
            ?.closest(".react-flow__node")
            ?.querySelector(".react-flow__resize-control"),
      });
    },
    [
      bpmnEditorStoreApi,
      container,
      diagramRef,
      onConnectedNodeAdded,
      onDiagramError,
    ],
  );
  const actionChoices = nodeAction?.source.type
    ? outgoingActions(nodeAction.source.type)
    : [];
  const chosenAction = actionChoices.find(
    (choice) => choice.value === nodeAction?.choice,
  );
  const resizing = nodeAction?.choice === "resize" && nodeAction.canResize;
  const actionState = nodeAction ? bpmnEditorStoreApi.getState() : undefined;
  const actionTargets =
    chosenAction?.kind === "edge" && actionState
      ? actionState
          .computed(actionState)
          .getDiagramData()
          .nodes.filter(
            (node) =>
              !node.hidden &&
              node.id !== nodeAction!.source.id &&
              node.type &&
              getEdgeTypesBetween(
                BPMN_GRAPH_STRUCTURE,
                nodeAction!.source.type!,
                node.type,
              ).includes(chosenAction.type),
          )
      : [];
  return (
    <DiagramActionContext.Provider value={requestDiagramAction}>
      <DiagramContainerContextProvider container={container}>
        <Modal
          open={!!nodeAction && nodeAction.model === model && !readOnly}
          title={t["com.myoxus.actions"]()}
          description={
            nodeAction?.edge
              ? edgeActionLabel(nodeAction.edge)
              : nodeAction
                ? nodeActionLabel(nodeAction.source)
                : undefined
          }
          returnFocusRef={actionReturnFocus}
          returnFocus={!binding}
          onExitTransitionEnd={() => {
            // The payload form is the next owner. Keep the durable edge target
            // until that successor closes instead of falling back to Close.
            if (binding) return;
            const id = reconnectReturnFocus.current;
            reconnectReturnFocus.current = undefined;
            if (id && !binding)
              [
                ...(container.current?.querySelectorAll<SVGElement>(
                  ".react-flow__edge.selected",
                ) ?? []),
              ]
                .find((edge) => edge.dataset.id === id)
                ?.focus();
          }}
          onOpenChange={(open) => {
            if (!open) setNodeAction(undefined);
          }}
        >
          {nodeAction && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const current = bpmnEditorStoreApi.getState();
                if (
                  current.settings.isReadOnly ||
                  current.bpmn.model !== nodeAction.model
                ) {
                  setNodeAction(undefined);
                  return;
                }
                try {
                  bpmnEditorStoreApi.setState((state) => {
                    if (resizing) {
                      const { width, height } = nodeAction;
                      const min = MIN_NODE_SIZES[nodeAction.source.type!]({
                        snapGrid: state.xyFlowReactKieDiagram.snapGrid,
                      });
                      if (
                        typeof width !== "number" ||
                        typeof height !== "number" ||
                        !Number.isFinite(width) ||
                        !Number.isFinite(height) ||
                        width < min["@_width"] ||
                        height < min["@_height"]
                      )
                        throw new Error("BPMN_INVALID_CONNECTION");
                      const bounds = nodeAction.source.data.shape["dc:Bounds"];
                      // Numeric input is already absolute diagram geometry.
                      // Dispatch the pointer resize owner once; unchanged input
                      // must not recalculate manual endpoints or enter history.
                      if (
                        width !== bounds["@_width"] ||
                        height !== bounds["@_height"]
                      )
                        onNodeResized({
                          state,
                          node: nodeAction.source,
                          newDimensions: { width, height },
                        });
                    } else if (chosenAction?.kind === "edge") {
                      const target = actionTargets.find(
                        (node) => node.id === nodeAction.target,
                      );
                      if (!target) throw new Error("BPMN_INVALID_CONNECTION");
                      if (nodeAction.edge) {
                        const edge = nodeAction.edge,
                          points = edge.data?.bpmnEdge?.["di:waypoint"];
                        if (!points?.length)
                          throw new Error("BPMN_INVALID_CONNECTION");
                        // Unchanged semantic endpoints are not a reanchor
                        // request. Preserve their authored DI and history.
                        if (
                          edge.source !== nodeAction.source.id ||
                          edge.target !== target.id
                        ) {
                          const updated = onEdgeUpdated({
                            state,
                            edge,
                            sourceNode: nodeAction.source,
                            targetNode: target,
                            firstWaypoint: points[0],
                            lastWaypoint: points[points.length - 1],
                          });
                          state.xyFlowReactKieDiagram._selectedEdges = [
                            updated.id,
                          ];
                          reconnectReturnFocus.current = updated.id;
                        }
                      } else
                        onEdgeAdded({
                          state,
                          sourceNode: nodeAction.source,
                          targetNode: target,
                          edgeType: chosenAction.type,
                          sourceHandle: PositionalNodeHandleId.Center,
                          targetHandle: PositionalNodeHandleId.Center,
                        });
                    } else if (chosenAction?.kind === "node") {
                      if (
                        typeof nodeAction.x !== "number" ||
                        typeof nodeAction.y !== "number" ||
                        !Number.isFinite(nodeAction.x) ||
                        !Number.isFinite(nodeAction.y)
                      )
                        throw new Error("BPMN_INVALID_CONNECTION");
                      const edgeType = getDefaultEdgeTypeBetween(
                        BPMN_GRAPH_STRUCTURE,
                        nodeAction.source.type!,
                        chosenAction.type,
                      );
                      if (!edgeType) throw new Error("BPMN_INVALID_CONNECTION");
                      const { newNodeId } = onConnectedNodeAdded({
                        state,
                        sourceNode: nodeAction.source,
                        newNodeType: chosenAction.type,
                        edgeType,
                        dropPoint: { x: nodeAction.x, y: nodeAction.y },
                      });
                      state.xyFlowReactKieDiagram._selectedNodes = [newNodeId];
                    }
                  });
                } catch (error) {
                  // A payload choice is the next native modal, not a return to
                  // the canvas. The retiring form must not steal its focus.
                  onDiagramError(error);
                }
                setNodeAction(undefined);
              }}
            >
              <Stack>
                {!nodeAction.edge && (
                  <Select
                    label={t["com.myoxus.actions"]()}
                    data={
                      nodeAction.canResize
                        ? [
                            ...actionChoices,
                            {
                              value: "resize",
                              label: t["com.myoxus.editor.toolbar.size"](),
                            },
                          ]
                        : actionChoices
                    }
                    value={nodeAction.choice}
                    onChange={(choice) => {
                      if (!choice) return;
                      const selected = actionChoices.find(
                        (action) => action.value === choice,
                      );
                      if (selected?.kind === "node") {
                        try {
                          const position = nextElementPosition(
                            bpmnEditorStoreApi.getState(),
                            nodeAction.source,
                            selected.type,
                            diagramRef.current?.getReactFlowInstance(),
                            container.current,
                          );
                          setNodeAction({
                            ...nodeAction,
                            choice,
                            target: null,
                            x: position.x,
                            y: position.y,
                          });
                        } catch (error) {
                          setNodeAction(undefined);
                          onDiagramError(error);
                        }
                      } else
                        setNodeAction({ ...nodeAction, choice, target: null });
                    }}
                  />
                )}
                {nodeAction.edge && (
                  <Select
                    label={t["com.myoxus.editor.bpmn.semantic-source"]()}
                    data={(
                      actionState?.computed(actionState).getDiagramData()
                        .nodes ?? []
                    )
                      .filter(
                        (node) =>
                          !node.hidden &&
                          node.type &&
                          outgoingActions(node.type).some(
                            (choice) =>
                              choice.kind === "edge" &&
                              choice.value === nodeAction.choice,
                          ),
                      )
                      .map((node) => ({
                        value: node.id,
                        label: nodeActionLabel(node),
                      }))}
                    value={nodeAction.source.id}
                    searchable
                    onChange={(id) => {
                      const source = actionState
                        ?.computed(actionState)
                        .getDiagramData()
                        .nodesById.get(id!);
                      if (source) {
                        const target = actionState
                          ?.computed(actionState)
                          .getDiagramData()
                          .nodesById.get(nodeAction.target!);
                        const compatible =
                          source.type &&
                          target?.type &&
                          getEdgeTypesBetween(
                            BPMN_GRAPH_STRUCTURE,
                            source.type,
                            target.type,
                          ).some((type) => type === nodeAction.edge!.type);
                        setNodeAction({
                          ...nodeAction,
                          source,
                          target: compatible ? nodeAction.target : null,
                        });
                      }
                    }}
                  />
                )}
                {resizing ? (
                  <Group>
                    <NumberInput
                      label={t["com.myoxus.editor.width"]()}
                      value={nodeAction.width}
                      min={
                        MIN_NODE_SIZES[nodeAction.source.type!]({
                          snapGrid: actionState!.xyFlowReactKieDiagram.snapGrid,
                        })["@_width"]
                      }
                      onChange={(width) =>
                        setNodeAction({ ...nodeAction, width })
                      }
                    />
                    <NumberInput
                      label={t["com.myoxus.editor.height"]()}
                      value={nodeAction.height}
                      min={
                        MIN_NODE_SIZES[nodeAction.source.type!]({
                          snapGrid: actionState!.xyFlowReactKieDiagram.snapGrid,
                        })["@_height"]
                      }
                      onChange={(height) =>
                        setNodeAction({ ...nodeAction, height })
                      }
                    />
                  </Group>
                ) : chosenAction?.kind === "edge" ? (
                  <Select
                    label={t["com.myoxus.editor.bpmn.semantic-target"]()}
                    data={actionTargets.map((node) => ({
                      value: node.id,
                      label: nodeActionLabel(node),
                    }))}
                    value={nodeAction.target}
                    onChange={(target) =>
                      setNodeAction({ ...nodeAction, target })
                    }
                    searchable
                  />
                ) : (
                  <Group>
                    <NumberInput
                      label="X"
                      value={nodeAction.x}
                      onChange={(x) => setNodeAction({ ...nodeAction, x })}
                    />
                    <NumberInput
                      label="Y"
                      value={nodeAction.y}
                      onChange={(y) => setNodeAction({ ...nodeAction, y })}
                    />
                  </Group>
                )}
                <Group>
                  <Button onClick={() => setNodeAction(undefined)}>
                    {t.Cancel()}
                  </Button>
                  {!nodeAction.edge && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const current = bpmnEditorStoreApi.getState();
                        if (
                          !current.settings.isReadOnly &&
                          current.bpmn.model === nodeAction.model
                        ) {
                          try {
                            // A hover-open action targets its source; an already
                            // selected source keeps the complete multi-selection.
                            if (
                              !current
                                .computed(current)
                                .getDiagramData()
                                .selectedNodesById.has(nodeAction.source.id)
                            )
                              bpmnEditorStoreApi.setState((state) => {
                                state.xyFlowReactKieDiagram._selectedNodes = [
                                  nodeAction.source.id,
                                ];
                                state.xyFlowReactKieDiagram._selectedEdges = [];
                              });
                            commandsRef.current.duplicate();
                          } catch (error) {
                            onDiagramError(error);
                          }
                        }
                        setNodeAction(undefined);
                      }}
                    >
                      {t["com.myoxus.editor.keyboard.duplicate"]()}
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      resizing
                        ? typeof nodeAction.width !== "number" ||
                          typeof nodeAction.height !== "number"
                        : !chosenAction ||
                          (chosenAction.kind === "edge"
                            ? !nodeAction.target
                            : typeof nodeAction.x !== "number" ||
                              typeof nodeAction.y !== "number")
                    }
                  >
                    {t.Save()}
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
        </Modal>
        <Modal
          open={!!binding && binding.model === model && !readOnly}
          onExitTransitionEnd={() => {
            const id = reconnectReturnFocus.current;
            reconnectReturnFocus.current = undefined;
            if (id)
              [
                ...(container.current?.querySelectorAll<SVGElement>(
                  ".react-flow__edge.selected",
                ) ?? []),
              ]
                .find((edge) => edge.dataset.id === id)
                ?.focus();
          }}
          onOpenChange={(open) => {
            if (!open) setBinding(undefined);
          }}
          title={t["com.myoxus.editor.bpmn.data-association"]()}
          description={
            binding
              ? `${binding.action.options.sourceName} → ${binding.action.options.targetName}`
              : undefined
          }
        >
          {binding && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const current = bpmnEditorStoreApi.getState();
                if (
                  current.settings.isReadOnly ||
                  current.bpmn.model !== binding.model
                ) {
                  setBinding(undefined);
                  return;
                }
                try {
                  bpmnEditorStoreApi.setState((state) => {
                    const { newBpmnEdge } = addEdge({
                      definitions: state.bpmn.model.definitions,
                      ...binding.action.request,
                      __readonly_binding: {
                        source: binding.source ?? undefined,
                        target: binding.target ?? undefined,
                      },
                    });
                    const id = indexBpmnIds(
                      state.bpmn.model.definitions,
                    ).resolveReference(
                      newBpmnEdge,
                      newBpmnEdge["@_bpmnElement"],
                    );
                    if (!id) throw new Error("BPMN_DANGLING_REFERENCE");
                    state.xyFlowReactKieDiagram._selectedNodes = [];
                    state.xyFlowReactKieDiagram._selectedEdges = [id];
                  });
                } catch (error) {
                  onError(error);
                }
                setBinding(undefined);
              }}
            >
              <Stack>
                {!!binding.action.options.source.length && (
                  <Select
                    label={t["com.myoxus.editor.bpmn.semantic-source"]()}
                    data={binding.action.options.source}
                    value={binding.source}
                    onChange={(source) => setBinding({ ...binding, source })}
                  />
                )}
                {!!binding.action.options.target.length && (
                  <Select
                    label={t["com.myoxus.editor.bpmn.semantic-target"]()}
                    data={binding.action.options.target}
                    value={binding.target}
                    onChange={(target) => setBinding({ ...binding, target })}
                  />
                )}
                <Group>
                  <Button onClick={() => setBinding(undefined)}>
                    {t.Cancel()}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      (!!binding.action.options.source.length &&
                        !binding.source) ||
                      (!!binding.action.options.target.length &&
                        !binding.target)
                    }
                  >
                    {t.Save()}
                  </Button>
                </Group>
              </Stack>
            </form>
          )}
        </Modal>
        <svg
          width={0}
          height={0}
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          <EdgeMarkers />
        </svg>

        <XyFlowReactKieDiagram
          // infra
          diagramRef={diagramRef}
          container={container}
          readOnly={readOnly}
          onFitToContent={onFitToContent}
          // model
          modelBeforeEditingRef={bpmnModelBeforeEditingRef}
          model={model}
          onResetToBeforeEditingBegan={onResetToBeforeEditingBegan}
          onError={onDiagramError}
          // components
          connectionLineComponent={ConnectionLine}
          nodeComponents={XY_FLOW_NODE_TYPES}
          edgeComponents={XY_FLOW_EDGE_TYPES}
          // domain
          newNodeMimeType={MIME_TYPE_FOR_BPMN_EDITOR_NEW_NODE_FROM_PALETTE}
          containmentMap={BPMN_CONTAINMENT_MAP}
          nodeTypes={NODE_TYPES}
          minNodeSizes={MIN_NODE_SIZES}
          graphStructure={BPMN_GRAPH_STRUCTURE}
          allowCycles={true}
          // actions
          onNodeAdded={onNodeAdded}
          onConnectedNodeAdded={onConnectedNodeAdded}
          onNodeRepositioned={onNodeRepositioned}
          onNodeDeleted={onNodeDeleted}
          onEdgeAdded={onEdgeAdded}
          onEdgeUpdated={onEdgeUpdated}
          onEdgeDeleted={onEdgeDeleted}
          onNodeUnparented={onNodeUnparented}
          onNodeParented={onNodeParented}
          onNodeResized={onNodeResized}
          onEscPressed={onEscPressed}
          onWaypointAdded={onWaypointAdded}
          onWaypointRepositioned={onWaypointRepositioned}
          onWaypointDeleted={onWaypointDeleted}
        >
          <BpmnPalette pulse={isEmptyStateShowing} />
          {commandError && (
            <RF.Panel position="top-center">
              {/* The editor is modal; a provider-level notification can be behind
              its top layer. Keep rejected-command feedback in this canvas. */}
              <Alert
                withCloseButton
                closeButtonLabel={t["com.myoxus.toast.dismiss"]()}
                onClose={clearCommandError}
              >
                {commandError === "in-use"
                  ? t["com.myoxus.editor.bpmn.definition-in-use"]()
                  : t["com.myoxus.editor.bpmn.invalid-graph-action"]()}
              </Alert>
            </RF.Panel>
          )}
          {isEmptyStateShowing && (
            <BpmnDiagramEmptyState setShowEmptyState={setShowEmptyState} />
          )}
          <TopRightCornerPanels />
          <BpmnDiagramCommands />
        </XyFlowReactKieDiagram>
      </DiagramContainerContextProvider>
    </DiagramActionContext.Provider>
  );
}
export function ConnectionLine(props: RF.ConnectionLineComponentProps) {
  return (
    <ReactFlowDiagramConnectionLine
      {...props}
      defaultNodeSizes={DEFAULT_NODE_SIZES}
      minNodeSizes={MIN_NODE_SIZES}
      graphStructure={BPMN_GRAPH_STRUCTURE}
      nodeComponentsMapping={CONNECTION_LINE_NODE_COMPONENT_MAPPING}
      edgeComponentsMapping={CONNECTION_LINE_EDGE_COMPONENTS_MAPPING}
    />
  );
}
