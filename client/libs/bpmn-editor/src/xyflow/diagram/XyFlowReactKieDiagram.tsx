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

import * as React from "react";
import * as RF from "@xyflow/react";
import { buildHierarchy } from "../graph/graph";
import { getDeepChildNodes } from "../graph/childNodes";
import {
  type ContainmentMap,
  ContainmentMode,
  getDefaultEdgeTypeBetween,
  type GraphStructure,
} from "../graph/graphStructure";
import { checkIsValidConnection } from "../graph/isValidConnection";
import {
  getContainmentRelationship,
  getDiBoundsCenterPoint,
} from "../maths/DcMaths";
import { type DC__Point } from "../maths/model";
import { snapShapeDimensions, snapPoint } from "../snapgrid/SnapGrid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useXyFlowReactKieDiagramStore,
  useXyFlowReactKieDiagramStoreApi,
} from "../store/Store";
import { type NodeSizes } from "../nodes/NodeSizes";
import { SelectionStatusLabel } from "./SelectionStatusLabel";
import {
  type XyFlowDiagramState,
  sourceHandleParts,
  type XyFlowReactKieDiagramEdgeData,
  type XyFlowReactKieDiagramNodeData,
} from "../store/State";
import { castDraft, type Draft } from "immer";
import { PositionalNodeHandleId } from "../nodes/PositionalNodeHandles";
import { NODE_LAYERS } from "../nodes/Hooks";
import { DiagramActionContext } from "./DiagramActionContext";
import {
  WaypointActionsContextProvider,
  type WaypointActionsContextType,
  type WaypointKeyboardFocus,
} from "../waypoints/WaypointActionsContext";
import {
  DEFAULT_BORDER_ALLOWANCE_IN_PX,
  snapToDropTargetsBorder,
} from "../snapgrid/BorderSnapping";
import { useI18n } from "@myoxus/i18n";
import {
  ExpandIcon,
  LockIcon,
  UnlockIcon,
  ZoomUpIcon,
  ZoomDownIcon,
} from "@myoxus/icons/react";
import {
  IconButton,
  IconButtonGroup,
  Alert,
  Button,
  Group,
  useResolvedDomTheme,
} from "@myoxus/ui-facade";
import "@xyflow/react/dist/style.css";
import "../xyflow-customizations.css";

// nodes

export type OnNodeAdded<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  type: N;
  element: string;
  dropPoint: { x: number; y: number };
  data: NData;
}) => {
  newNodeId: string;
};

export type OnConnectedNodeAdded<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  sourceNode: RF.Node<NData, N>;
  newNodeType: N;
  edgeType: E;
  dropPoint: { x: number; y: number };
}) => { newNodeId: string };

export type OnNodeUnparented<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  exParentNode: RF.Node<NData, N>;
  /** Validated final target; the domain decides whether it replaces containment
   * or attachment without passing through a context-invalid intermediate node. */
  nextParentNode?: RF.Node<NData, N>;
  nextContainmentMode?: ContainmentMode;
  activeNode: RF.Node<NData, N>;
  selectedNodes: RF.Node<NData, N>[];
}) => void;

export type OnNodeParented<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  parentNode: RF.Node<NData, N>;
  activeNode: RF.Node<NData, N>;
  containmentMode: ContainmentMode;
  selectedNodes: RF.Node<NData, N>[];
}) => void;

export type OnNodeRepositioned<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  /** Set of waypoint indexes by Edge index */
  controlWaypointsByEdge: Map<number, Set<number>>;
  node: RF.Node<NData, N>;
  newPosition: RF.XYPosition;
  childNodeIds: string[];
}) => void;

export type OnNodeDeleted<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: { state: Draft<S>; node: RF.Node<NData, N> }) => void;

export type OnNodeResized<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  node: RF.Node<NData, N>;
  newDimensions: { width: number; height: number };
}) => void;

// edges

export type OnEdgeAdded<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  sourceNode: RF.Node<NData, N>;
  targetNode: RF.Node<NData, N>;
  edgeType: E;
  sourceHandle: PositionalNodeHandleId;
  targetHandle: PositionalNodeHandleId;
}) => void;

export type OnEdgeUpdated<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  _E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: {
  state: Draft<S>;
  sourceNode: RF.Node<NData, N>;
  targetNode: RF.Node<NData, N>;
  edge: RF.Edge<EData>;
  /** Without a pointer handle, unchanged nodes retain exact DI endpoints and
   * changed nodes use their nearest standard border handle. */
  targetHandle?: PositionalNodeHandleId;
  sourceHandle?: PositionalNodeHandleId;
  firstWaypoint: DC__Point;
  lastWaypoint: DC__Point;
}) => { id: string };

export type OnEdgeDeleted<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  _E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (args: { state: Draft<S>; edge: RF.Edge<EData> }) => void;

// waypoints

export type OnWaypointAdded = (args: {
  beforeIndex: number;
  waypoint: DC__Point;
  edgeIndex: number;
}) => void;
export type OnWaypointDeleted = (args: {
  edgeIndex: number;
  waypointIndex: number;
}) => void;
export type OnWaypointRepositioned = (args: {
  edgeIndex: number;
  waypointIndex: number;
  waypoint: DC__Point;
}) => void;

// misc

export type OnEscPressed = () => void;

// model
export type OnResetToBeforeEditingBegan<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  _E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = (stateDraft: Draft<S>) => void;

//

export type Props<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = {
  // model
  model: unknown;
  modelBeforeEditingRef: React.MutableRefObject<unknown>;
  onResetToBeforeEditingBegan: OnResetToBeforeEditingBegan<
    S,
    N,
    E,
    NData,
    EData
  >;
  // components
  connectionLineComponent: RF.ConnectionLineComponent<RF.Node<NData, N>>;
  nodeComponents: RF.NodeTypes;
  edgeComponents: RF.EdgeTypes;
  // infra
  diagramRef: React.RefObject<DiagramRef<N, NData, EData> | null>;
  children: React.ReactNode;
  container: React.RefObject<HTMLElement | null>;
  // domain
  newNodeMimeType: string;
  containmentMap: ContainmentMap<N>;
  nodeTypes: Record<string, string>;
  minNodeSizes: NodeSizes<N>;
  graphStructure: GraphStructure<N, E>;
  allowCycles: boolean;
  // actions
  onNodeRepositioned: OnNodeRepositioned<S, N, NData, EData>;
  onNodeDeleted: OnNodeDeleted<S, N, NData, EData>;
  onNodeAdded: OnNodeAdded<S, N, NData, EData>;
  onNodeUnparented: OnNodeUnparented<S, N, NData, EData>;
  onNodeParented: OnNodeParented<S, N, NData, EData>;
  onConnectedNodeAdded: OnConnectedNodeAdded<S, N, E, NData, EData>;
  onNodeResized: OnNodeResized<S, N, NData, EData>;
  onEdgeAdded: OnEdgeAdded<S, N, E, NData, EData>;
  onEdgeUpdated: OnEdgeUpdated<S, N, E, NData, EData>;
  onEdgeDeleted: OnEdgeDeleted<S, N, E, NData, EData>;
  onEscPressed: OnEscPressed;
  onWaypointAdded: OnWaypointAdded;
  onWaypointRepositioned: OnWaypointRepositioned;
  onWaypointDeleted: OnWaypointDeleted;
  /** Receives command failures after rollback; hosts must not expose raw model payloads. */
  onError?: (error: unknown) => void;
  /** Disables native editing gestures; the domain store remains the mutation authority. */
  readOnly?: boolean;
  /** Domain renderers can include labels/routes outside native node rectangles. */
  onFitToContent?: () => void;
};

//

const PAN_ON_DRAG = [1, 2];

const FIT_VIEW_OPTIONS = { maxZoom: 1, minZoom: 0.1, duration: 400 };

export const DEFAULT_VIEWPORT = { x: 100, y: 100, zoom: 1 };

const DELETE_NODE_KEY_CODES = ["Backspace", "Delete"];

export type DiagramRef<
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
> = {
  getReactFlowInstance: () =>
    RF.ReactFlowInstance<RF.Node<NData, N>, RF.Edge<EData>> | undefined;
};

/**
 * Retained controlled diagram: callbacks mutate the supplied domain store.
 * Parenting is virtual; node positions and command coordinates stay in flow
 * space. Consumers must share this store's provider with the native XYFlow root.
 */
export function XyFlowReactKieDiagram<
  S extends XyFlowDiagramState<S, N, NData, EData>,
  N extends string,
  E extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
  EData extends XyFlowReactKieDiagramEdgeData,
>({
  // model
  model,
  modelBeforeEditingRef,
  onResetToBeforeEditingBegan,
  // infra
  diagramRef,
  children,
  container,
  // components
  connectionLineComponent,
  nodeComponents,
  edgeComponents,
  // domain
  newNodeMimeType,
  containmentMap,
  nodeTypes,
  minNodeSizes,
  graphStructure,
  allowCycles,
  // actions
  onNodeAdded,
  onConnectedNodeAdded,
  onNodeUnparented,
  onNodeParented,
  onNodeRepositioned,
  onNodeResized,
  onNodeDeleted,
  onEdgeAdded,
  onEdgeUpdated,
  onEdgeDeleted,
  onWaypointAdded,
  onWaypointDeleted,
  onWaypointRepositioned,
  onEscPressed,
  onError,
  readOnly = false,
  onFitToContent,
}: Props<S, N, E, NData, EData>) {
  const t = useI18n();
  const language = t.language;
  const requestDiagramAction = React.useContext(DiagramActionContext);
  const colorMode = useResolvedDomTheme();
  const [interactive, setInteractive] = useState(true);
  const [alignmentGuides, setAlignmentGuides] = useState<
    Array<{ x1: number; y1: number; x2: number; y2: number }>
  >([]);
  const editingAllowed = useRef(false);
  editingAllowed.current = !readOnly && interactive;
  // XYFlow's reachable accessibility defaults are UI copy, not XML vocabulary.
  // Keep the live locale explicit: the shared i18n wrapper retains its identity.
  const ariaLabelConfig = useMemo<Partial<RF.AriaLabelConfig>>(() => {
    const unavailable = readOnly
      ? t["com.myoxus.editor.bpmn.keyboard-read-only"]()
      : !interactive
        ? t["com.myoxus.editor.bpmn.keyboard-locked"]()
        : undefined;
    const numbers = new Intl.NumberFormat(language);
    return {
      "node.a11yDescription.default":
        unavailable ?? t["com.myoxus.editor.bpmn.keyboard-node"](),
      "node.a11yDescription.keyboardDisabled":
        unavailable ?? t["com.myoxus.editor.bpmn.keyboard-node"](),
      "edge.a11yDescription.default":
        unavailable ?? t["com.myoxus.editor.bpmn.keyboard-edge"](),
      "node.a11yDescription.ariaLiveMessage": ({ x, y }) =>
        t["com.myoxus.editor.bpmn.position"]({
          x: numbers.format(x),
          y: numbers.format(y),
        }),
      "handle.ariaLabel": t["com.myoxus.editor.bpmn.connection-point"](),
    };
  }, [interactive, language, readOnly, t]);
  // Contexts
  const xyFlowReactKieDiagramStoreApi = useXyFlowReactKieDiagramStoreApi<
    S,
    N,
    NData,
    EData
  >();
  const snapGrid = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.snapGrid,
  );

  // State
  const [reactFlowInstance, setReactFlowInstance] = useState<
    RF.ReactFlowInstance<RF.Node<NData, N>, RF.Edge<EData>> | undefined
  >(undefined);

  // Refs
  React.useImperativeHandle(
    diagramRef,
    () => ({ getReactFlowInstance: () => reactFlowInstance }),
    [reactFlowInstance],
  );

  const nodeIdBeingDraggedRef = useRef<string | null>(null);
  const reconnectingEndpoint = useRef<RF.HandleType | undefined>(undefined);
  const waypointKeyboardFocus = useRef<WaypointKeyboardFocus | undefined>(
    undefined,
  );
  useEffect(() => {
    if (readOnly || !interactive) waypointKeyboardFocus.current = undefined;
  }, [readOnly, interactive]);
  const selectionBeforeDragRef = useRef({
    nodes: [] as string[],
    edges: [] as string[],
  });

  // Memos

  const xyFlowSnapGrid = useMemo<[number, number]>(
    () => (snapGrid.isEnabled ? [snapGrid.x, snapGrid.y] : [1, 1]),
    [snapGrid.isEnabled, snapGrid.x, snapGrid.y],
  );

  // Callbacks

  const clearConnection = useCallback(() => {
    reconnectingEndpoint.current = undefined;
    xyFlowReactKieDiagramStoreApi.setState((state) => {
      state.xyFlowReactKieDiagram.ongoingConnection = undefined;
      state.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
    });
  }, [xyFlowReactKieDiagramStoreApi]);
  const clearPlacement = useCallback(() => {
    xyFlowReactKieDiagramStoreApi.setState((state) => {
      state.xyFlowReactKieDiagram.placementElement = undefined;
      state.xyFlowReactKieDiagram.placementModel = undefined;
      state.xyFlowReactKieDiagram.newNodeProjection = undefined;
      state.xyFlowReactKieDiagram.dropTarget = undefined;
    });
  }, [xyFlowReactKieDiagramStoreApi]);
  React.useLayoutEffect(() => {
    // Source replacement and access changes invalidate the gesture, not XML or
    // history. Settle this before the next pointer action can choose a new tool.
    clearConnection();
    const placement =
      xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram;
    // A newly chosen tool may already belong to this model before React has
    // projected it. Do not let the preceding command's delayed render cancel it.
    if (readOnly || !interactive || placement.placementModel !== model)
      clearPlacement();
    if (readOnly || !interactive || !placement.draggingNodes.length)
      setAlignmentGuides([]);
  }, [
    model,
    readOnly,
    interactive,
    clearConnection,
    clearPlacement,
    xyFlowReactKieDiagramStoreApi,
  ]);
  useEffect(() => {
    window.addEventListener("blur", clearConnection);
    window.addEventListener("pointercancel", clearConnection);
    return () => {
      window.removeEventListener("blur", clearConnection);
      window.removeEventListener("pointercancel", clearConnection);
      clearConnection();
      clearPlacement();
    };
  }, [clearConnection, clearPlacement]);

  const onConnect = useCallback<RF.OnConnect>(
    ({ source, target, sourceHandle, targetHandle }) => {
      if (!editingAllowed.current) return;
      const state = xyFlowReactKieDiagramStoreApi.getState();
      const sourceNode = state
        .computed(state)
        .getDiagramData()
        .nodesById.get(source!);
      const targetNode = state
        .computed(state)
        .getDiagramData()
        .nodesById.get(target!);
      if (!sourceNode || !targetNode) {
        throw new Error(
          "Cannot create connection without target and source nodes!",
        );
      }

      const sourceBounds = sourceNode.data.shape["dc:Bounds"];
      const targetBounds = targetNode.data.shape["dc:Bounds"];
      if (!sourceBounds || !targetBounds) {
        throw new Error("Cannot create connection without target bounds!");
      }

      try {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          onEdgeAdded({
            state,
            sourceNode,
            targetNode,
            edgeType: sourceHandleParts(sourceHandle).type as E,
            targetHandle: targetHandle as PositionalNodeHandleId,
            sourceHandle: (sourceHandleParts(sourceHandle).side ??
              PositionalNodeHandleId.Center) as PositionalNodeHandleId,
          });
        });
      } catch (error) {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram.ongoingConnection = undefined;
        });
        if (onError) onError(error);
        else throw error;
      }
    },
    [onEdgeAdded, onError, xyFlowReactKieDiagramStoreApi],
  );

  const ongoingConnection = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.ongoingConnection,
  );
  useEffect(() => {
    const edgeUpdaterSource = container.current?.querySelectorAll(
      ".react-flow__edgeupdater-source, .react-flow__edgeupdater-target",
    );
    if (ongoingConnection) {
      edgeUpdaterSource?.forEach((e) => e.classList.add("hidden"));
    } else {
      edgeUpdaterSource?.forEach((e) => e.classList.remove("hidden"));
    }
  }, [ongoingConnection, container]);

  const onConnectStart = useCallback<RF.OnConnectStart>(
    (_e, newConnection) => {
      if (!editingAllowed.current) return;
      clearPlacement();
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        state.xyFlowReactKieDiagram.ongoingConnection = newConnection;
      });
    },
    [xyFlowReactKieDiagramStoreApi, clearPlacement],
  );

  const onConnectEnd = useCallback<RF.OnConnectEnd>(
    (e) => {
      if (!editingAllowed.current || !(e instanceof MouseEvent)) {
        clearConnection();
        return;
      }

      try {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          const targetIsPane = (
            e.target as Element | null
          )?.classList?.contains("react-flow__pane");
          if (
            !targetIsPane ||
            !container.current ||
            !state.xyFlowReactKieDiagram.ongoingConnection ||
            !reactFlowInstance
          ) {
            return;
          }

          const dropPoint = reactFlowInstance.screenToFlowPosition(
            {
              x: e.clientX,
              y: e.clientY,
            },
            { snapToGrid: false },
          );

          // only try to create node if source handle is compatible
          if (
            !Object.values(nodeTypes).some(
              (n) =>
                n === state.xyFlowReactKieDiagram.ongoingConnection!.handleId,
            )
          ) {
            return;
          }

          if (!state.xyFlowReactKieDiagram.ongoingConnection.nodeId) {
            return;
          }

          const sourceNode = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(
              state.xyFlowReactKieDiagram.ongoingConnection.nodeId,
            );
          if (!sourceNode) {
            return;
          }

          const sourceNodeBounds = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(sourceNode.id)?.data.shape["dc:Bounds"];
          if (!sourceNodeBounds) {
            return;
          }

          const newNodeType = state.xyFlowReactKieDiagram.ongoingConnection
            .handleId as N;
          const sourceNodeType = sourceNode.type as N;

          const edgeType = getDefaultEdgeTypeBetween(
            graphStructure,
            sourceNodeType as N,
            newNodeType,
          );
          if (!edgeType) {
            throw new Error(
              `XYFLOW KIE DIAGRAM: Invalid structure: ${sourceNodeType} --(any)--> ${newNodeType}`,
            );
          }

          const { newNodeId } = onConnectedNodeAdded({
            state,
            sourceNode,
            newNodeType,
            edgeType,
            dropPoint,
          });

          state.xyFlowReactKieDiagram._selectedNodes = [newNodeId];
        });
      } catch (error) {
        if (onError) onError(error);
        else throw error;
      } finally {
        // A rejected connected creation rolls back its draft and must also end
        // the gesture, otherwise every outgoing handle stays hidden afterward.
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram.ongoingConnection = undefined;
        });
      }
    },
    [
      xyFlowReactKieDiagramStoreApi,
      container,
      reactFlowInstance,
      nodeTypes,
      graphStructure,
      onConnectedNodeAdded,
      onError,
      clearConnection,
    ],
  );

  const isValidConnection = useCallback<RF.IsValidConnection>(
    (edgeOrConnection) => {
      if (!editingAllowed.current) return false;
      const state = xyFlowReactKieDiagramStoreApi.getState();
      const edgeId = state.xyFlowReactKieDiagram.edgeIdBeingUpdated;
      const edgeType = edgeId
        ? (reactFlowInstance?.getEdge(edgeId)?.type as E)
        : undefined;

      const ongoingConnectionHierarchy = buildHierarchy({
        nodeId: state.xyFlowReactKieDiagram.ongoingConnection?.nodeId,
        edges: state.computed(state).getDiagramData().graphStructureEdges,
      });

      return (
        // Reflexive edges are not allowed
        edgeOrConnection.source !== edgeOrConnection.target &&
        // Matches graph structure.
        checkIsValidConnection(
          graphStructure,
          state.computed(state).getDiagramData().nodesById,
          edgeOrConnection,
          edgeType,
        ) &&
        // Does not form cycles.
        (allowCycles ||
          (!!edgeOrConnection.target &&
            !ongoingConnectionHierarchy.dependencies.has(
              edgeOrConnection.target,
            ) &&
            !!edgeOrConnection.source &&
            !ongoingConnectionHierarchy.dependents.has(
              edgeOrConnection.source,
            )))
      );
    },
    [
      xyFlowReactKieDiagramStoreApi,
      reactFlowInstance,
      graphStructure,
      allowCycles,
    ],
  );

  const onNodesChange = useCallback<RF.OnNodesChange<RF.Node<NData, N>>>(
    (changes) => {
      if (!reactFlowInstance) {
        return;
      }

      const controlWaypointsByEdge = new Map<number, Set<number>>();

      try {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          for (const change of changes) {
            switch (change.type) {
              case "add":
                state
                  .dispatch(state)
                  .setNodeStatus(change.item.id, { selected: true });
                break;
              case "dimensions":
                if (
                  state.xyFlowReactKieDiagram.newNodeProjection?.id ===
                  change.id
                ) {
                  break;
                }

                state
                  .dispatch(state)
                  .setNodeStatus(change.id, { resizing: change.resizing });
                // Measurement notifications are not authoring commands. Only the
                // native resize gesture may change canonical node dimensions.
                if (change.dimensions && change.resizing !== undefined) {
                  const node = state
                    .computed(state)
                    .getDiagramData()
                    .nodesById.get(change.id)!;
                  // We only need to resize the node if its snapped dimensions change, as snapping is non-destructive.
                  const snappedShape = snapShapeDimensions(
                    state.xyFlowReactKieDiagram.snapGrid,
                    node.data.shape,
                    minNodeSizes[node.type as N]({
                      snapGrid: state.xyFlowReactKieDiagram.snapGrid,
                    }),
                  );
                  if (
                    snappedShape.width !== change.dimensions.width ||
                    snappedShape.height !== change.dimensions.height
                  ) {
                    onNodeResized({
                      state,
                      node,
                      newDimensions: { ...change.dimensions },
                    });
                  }
                }
                break;
              case "position": {
                state
                  .dispatch(state)
                  .setNodeStatus(change.id, { dragging: change.dragging });

                // Virtual parents do not shift XYFlow coordinates. Keyboard
                // movement supplies position rather than positionAbsolute.
                const position = change.positionAbsolute ?? change.position;
                if (position) {
                  const allNodes = state.computed(state).getDiagramData().nodes;

                  if (nodeIdBeingDraggedRef.current === change.id) {
                    const nodeBeingDragged =
                      state
                        .computed(state)
                        .getDiagramData()
                        .nodesById.get(change.id) ??
                      state.xyFlowReactKieDiagram.newNodeProjection!;

                    const descendants = new Set(
                      getDeepChildNodes([nodeBeingDragged.id], allNodes).get(
                        nodeBeingDragged.id,
                      ),
                    );
                    let foundContainer = false;
                    const depth = (node: RF.Node<NData, N>) => {
                      const seen = new Set<string>();
                      for (
                        let parent = node.data.parentXyFlowNode;
                        parent && !seen.has(parent.id);
                        parent = parent.data.parentXyFlowNode
                      )
                        seen.add(parent.id);
                      return seen.size;
                    };
                    // The deepest visible owner wins. Render order alone puts a
                    // subprocess above its inner lane and silently reparents a
                    // normal move out of that lane at pointer release.
                    for (const potentialContainer of reactFlowInstance
                      ?.getNodes()
                      .filter((node) => !node.hidden)
                      .reverse()
                      .sort((a, b) => depth(b) - depth(a)) ?? []) {
                      if (
                        potentialContainer.id === nodeBeingDragged.id ||
                        descendants.has(potentialContainer.id)
                      ) {
                        // A virtual parent cannot be dropped into its descendant.
                        continue;
                      }

                      const containmentRelationship =
                        getContainmentRelationship({
                          container:
                            potentialContainer.data.shape["dc:Bounds"]!,
                          bounds: {
                            ...nodeBeingDragged.data.shape["dc:Bounds"],
                            "@_x": position.x,
                            "@_y": position.y,
                          },
                          borderAllowanceInPx: DEFAULT_BORDER_ALLOWANCE_IN_PX,
                        });

                      if (!(
                        containmentRelationship.isAtBorder ||
                        containmentRelationship.isCompletelyInside
                      )) {
                        // `nodeBeingDragged` is not inside `potentialContainer`
                        continue;
                      }

                      let containmentMode: ContainmentMode;
                      if (containmentRelationship.isAtBorder) {
                        containmentMode = ContainmentMode.BORDER;
                      } else if (containmentRelationship.isCompletelyInside) {
                        containmentMode = ContainmentMode.INSIDE;
                      } else {
                        throw new Error(
                          "Can't determine ContainmentMode for a node that is not visually inside the other.",
                        );
                      }

                      const diagramData = state
                        .computed(state)
                        .getDiagramData();
                      if (
                        diagramData.selectedNodesById.size > 1 &&
                        containmentMode === ContainmentMode.BORDER
                      ) {
                        // Containment at border should only be done 1 by 1. Can't drag a selection to the border of another node.
                        continue;
                      }

                      const allowedContainmentModes =
                        containmentMap.get(potentialContainer.type as N) ??
                        new Map<ContainmentMode, Set<N>>();

                      const typesOfNodesBeingDragged = state
                        .xyFlowReactKieDiagram.newNodeProjection?.type
                        ? [
                            state.xyFlowReactKieDiagram.newNodeProjection
                              .type as N,
                          ]
                        : [...diagramData.selectedNodeTypes];

                      const allSelectedNodesRespectContainmentMode =
                        typesOfNodesBeingDragged.every((nodeType) =>
                          allowedContainmentModes
                            .get(containmentMode)
                            ?.has(nodeType),
                        );

                      const newDropTarget = {
                        node: potentialContainer,
                        containmentMode: allSelectedNodesRespectContainmentMode
                          ? containmentMode
                          : containmentMode === ContainmentMode.INSIDE &&
                              allowedContainmentModes.has(
                                ContainmentMode.INSIDE,
                              )
                            ? ContainmentMode.INVALID_INSIDE
                            : containmentMode === ContainmentMode.BORDER &&
                                allowedContainmentModes.has(
                                  ContainmentMode.BORDER,
                                )
                              ? ContainmentMode.INVALID_BORDER
                              : containmentMode === ContainmentMode.INSIDE
                                ? ContainmentMode.INVALID_NON_INSIDE_CONTAINER
                                : containmentMode === ContainmentMode.BORDER
                                  ? ContainmentMode.INVALID_IGNORE
                                  : ContainmentMode.INVALID_IGNORE,
                      };

                      state.xyFlowReactKieDiagram.dropTarget =
                        castDraft(newDropTarget);

                      // If one one those states is reached, we stop searching for a valid container.
                      // As there's no reason to keep looking if the node is already visually completely inside another node.
                      // That's not true for borders, though, as we don't want to let an invalid "border" containment to
                      // stop us from finding an "inside" container, for example.
                      if (
                        newDropTarget.containmentMode ===
                          ContainmentMode.BORDER ||
                        newDropTarget.containmentMode ===
                          ContainmentMode.INSIDE ||
                        newDropTarget.containmentMode ===
                          ContainmentMode.INVALID_INSIDE ||
                        newDropTarget.containmentMode ===
                          ContainmentMode.INVALID_NON_INSIDE_CONTAINER
                      ) {
                        foundContainer = true;
                        break;
                      }
                    }

                    // cleanup from last dragging event if none was found this time.
                    if (!foundContainer) {
                      state.xyFlowReactKieDiagram.dropTarget = undefined;
                    }
                  }

                  const node = state
                    .computed(state)
                    .getDiagramData()
                    .nodesById.get(change.id)!;

                  const dropTarget = state.xyFlowReactKieDiagram
                    .dropTarget as S["xyFlowReactKieDiagram"]["dropTarget"];

                  const newPosition =
                    dropTarget?.containmentMode === ContainmentMode.BORDER
                      ? snapToDropTargetsBorder(
                          dropTarget.node.data.shape["dc:Bounds"]!,
                          {
                            ...(
                              node ??
                              state.xyFlowReactKieDiagram.newNodeProjection
                            ).data.shape["dc:Bounds"],
                            "@_x": position.x,
                            "@_y": position.y,
                          },
                          DEFAULT_BORDER_ALLOWANCE_IN_PX,
                        )
                      : position;

                  if (!node && state.xyFlowReactKieDiagram.newNodeProjection) {
                    state.xyFlowReactKieDiagram.newNodeProjection.position =
                      newPosition;
                    state.xyFlowReactKieDiagram.newNodeProjection.data.shape[
                      "dc:Bounds"
                    ]["@_x"] = newPosition.x;
                    state.xyFlowReactKieDiagram.newNodeProjection.data.shape[
                      "dc:Bounds"
                    ]["@_y"] = newPosition.y;
                  } else {
                    if (isAnyParentSelected(node?.data.parentXyFlowNode)) {
                      // Do nothing.
                      // Nodes that have a virtual parent will be automatically dragged with them, so there's no need to reposition them here.
                    } else {
                      onNodeRepositioned({
                        state,
                        controlWaypointsByEdge,
                        node,
                        newPosition,
                        childNodeIds:
                          getDeepChildNodes([change.id], allNodes).get(
                            change.id,
                          ) ?? [],
                      });
                    }
                  }
                }
                break;
              }
              case "remove": {
                const node = state
                  .computed(state)
                  .getDiagramData()
                  .nodesById.get(change.id)!;

                // An earlier selected ancestor may already own this deletion.
                if (!node) break;
                onNodeDeleted({ state, node });

                state.dispatch(state).setNodeStatus(node.id, {
                  selected: false,
                  dragging: false,
                  resizing: false,
                });
                break;
              }
              case "replace":
                state.dispatch(state).setNodeStatus(change.item.id, {
                  selected: false,
                  dragging: false,
                  resizing: false,
                });
                break;
              case "select":
                state
                  .dispatch(state)
                  .setNodeStatus(change.id, { selected: change.selected });
                break;
            }
          }
        });
      } catch (error) {
        if (onError) onError(error);
        else throw error;
      }
    },
    [
      containmentMap,
      minNodeSizes,
      onNodeDeleted,
      onNodeRepositioned,
      onNodeResized,
      onError,
      reactFlowInstance,
      xyFlowReactKieDiagramStoreApi,
    ],
  );

  const onNodeDrag = useCallback<RF.OnNodeDrag<RF.Node<NData, N>>>(
    (_e, nodeBeingDragged) => {
      nodeIdBeingDraggedRef.current = nodeBeingDragged.id;
      const state = xyFlowReactKieDiagramStoreApi.getState();
      const data = state.computed(state).getDiagramData();
      const current = data.nodesById.get(nodeBeingDragged.id);
      if (!current) {
        setAlignmentGuides([]);
        return;
      }
      const point = snapPoint(state.xyFlowReactKieDiagram.snapGrid, {
        "@_x": nodeBeingDragged.position.x,
        "@_y": nodeBeingDragged.position.y,
      });
      const bounds = current.data.shape["dc:Bounds"];
      const x = point["@_x"],
        y = point["@_y"],
        width = bounds["@_width"],
        height = bounds["@_height"];
      const neighbors = data.nodes
        .filter(
          (node) =>
            node.id !== current.id &&
            !node.hidden &&
            !node.selected &&
            node.data.parentXyFlowNode?.id ===
              current.data.parentXyFlowNode?.id,
        )
        .map((node) => node.data.shape["dc:Bounds"])
        .sort(
          (a, b) =>
            Math.abs(a["@_x"] - x) +
            Math.abs(a["@_y"] - y) -
            Math.abs(b["@_x"] - x) -
            Math.abs(b["@_y"] - y),
        );
      const guides: typeof alignmentGuides = [];
      // Guides compare like centers/edges at the grid candidate; they never
      // magnetize coordinates or mutate neighboring shapes/DI.
      for (const axis of ["x", "y"] as const) {
        for (const fraction of [0.5, 0, 1]) {
          const coordinate =
            axis === "x" ? x + width * fraction : y + height * fraction;
          const neighbor = neighbors.find(
            (b) =>
              Math.abs(
                coordinate -
                  (axis === "x"
                    ? b["@_x"] + b["@_width"] * fraction
                    : b["@_y"] + b["@_height"] * fraction),
              ) < 0.000001,
          );
          if (!neighbor) continue;
          guides.push(
            axis === "x"
              ? {
                  x1: coordinate,
                  x2: coordinate,
                  y1: Math.min(y, neighbor["@_y"]),
                  y2: Math.max(
                    y + height,
                    neighbor["@_y"] + neighbor["@_height"],
                  ),
                }
              : {
                  y1: coordinate,
                  y2: coordinate,
                  x1: Math.min(x, neighbor["@_x"]),
                  x2: Math.max(
                    x + width,
                    neighbor["@_x"] + neighbor["@_width"],
                  ),
                },
          );
          break;
        }
      }
      setAlignmentGuides(guides);
    },
    [xyFlowReactKieDiagramStoreApi],
  );

  const onNodeDragStart = useCallback<RF.OnNodeDrag<RF.Node<NData, N>>>(
    (e, node: RF.Node<NData, N>, nodes) => {
      modelBeforeEditingRef.current = model;
      const state = xyFlowReactKieDiagramStoreApi.getState();
      selectionBeforeDragRef.current = {
        nodes: [...state.xyFlowReactKieDiagram._selectedNodes],
        edges: [...state.xyFlowReactKieDiagram._selectedEdges],
      };
      onNodeDrag(e, node, nodes);
    },
    [modelBeforeEditingRef, onNodeDrag, model, xyFlowReactKieDiagramStoreApi],
  );

  const onNodeDragStop = useCallback<RF.OnNodeDrag<RF.Node<NData, N>>>(() => {
    setAlignmentGuides([]);
    try {
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        const nodeBeingDragged = state
          .computed(state)
          .getDiagramData()
          .nodesById.get(nodeIdBeingDraggedRef.current!);
        nodeIdBeingDraggedRef.current = null;
        if (!nodeBeingDragged) {
          return;
        }

        // Validate
        const dropTarget = state.xyFlowReactKieDiagram.dropTarget;
        state.xyFlowReactKieDiagram.dropTarget = undefined;
        if (
          containmentMap.has(dropTarget?.node.type as N) &&
          (dropTarget?.containmentMode === ContainmentMode.INVALID_INSIDE ||
            /* dropTarget?.containmentMode === ContainmentMode.INVALID_IGNORE // Commented on purpose: We don't want to disallow positioning nodes on top of another. Especially without visual feedback. */
            /* dropTarget?.containmentMode === ContainmentMode.INVALID_BORDER // Commented on purpose: We don't want to disallow positioning nodes slightly on top of another. Especially without visual feedback. */
            dropTarget?.containmentMode ===
              ContainmentMode.INVALID_NON_INSIDE_CONTAINER)
        ) {
          state.xyFlowReactKieDiagram.newNodeProjection = undefined;
          state.xyFlowReactKieDiagram._selectedNodes = [];
          onResetToBeforeEditingBegan(state);
          state.xyFlowReactKieDiagram._selectedNodes =
            selectionBeforeDragRef.current.nodes;
          state.xyFlowReactKieDiagram._selectedEdges =
            selectionBeforeDragRef.current.edges;
          return;
        }

        const selectedNodes = [
          ...state.computed(state).getDiagramData().selectedNodesById.values(),
        ];

        // XYFlow 12 has cleared dragging before this callback. A drag-stop
        // callback, unlike a click, is itself the settled-gesture boundary.

        // Un-parent
        if (
          nodeBeingDragged.data.parentXyFlowNode &&
          dropTarget?.node.id !== nodeBeingDragged.data.parentXyFlowNode.id
        ) {
          const p = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(nodeBeingDragged.data.parentXyFlowNode.id);
          if (p?.type && containmentMap.get(p.type as N)) {
            onNodeUnparented({
              state,
              exParentNode: p,
              nextParentNode:
                dropTarget?.containmentMode === ContainmentMode.INSIDE ||
                dropTarget?.containmentMode === ContainmentMode.BORDER
                  ? (dropTarget.node as RF.Node<NData, N>)
                  : undefined,
              nextContainmentMode: dropTarget?.containmentMode,
              activeNode: nodeBeingDragged,
              selectedNodes,
            });
          }
        }

        // // Parent
        if (
          dropTarget?.node.type &&
          containmentMap.get(dropTarget.node.type as N)
        ) {
          onNodeParented({
            state,
            parentNode: dropTarget.node as RF.Node<NData, N>,
            activeNode: nodeBeingDragged,
            selectedNodes,
            containmentMode: dropTarget.containmentMode,
          });
        }
      });
    } catch (error) {
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        onResetToBeforeEditingBegan(state);
        // A failed palette drop has already selected its tentative new ID.
        // Restore the real pre-gesture selection, not a phantom missing node.
        state.xyFlowReactKieDiagram._selectedNodes =
          selectionBeforeDragRef.current.nodes;
        state.xyFlowReactKieDiagram._selectedEdges =
          selectionBeforeDragRef.current.edges;
      });
      if (onError) onError(error);
      else throw error;
    }
  }, [
    containmentMap,
    onNodeParented,
    onNodeUnparented,
    xyFlowReactKieDiagramStoreApi,
    onResetToBeforeEditingBegan,
    onError,
  ]);

  const onEdgesChange = useCallback<RF.OnEdgesChange<RF.Edge<EData>>>(
    (changes) => {
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        for (const change of changes) {
          switch (change.type) {
            case "select":
              state
                .dispatch(state)
                .setEdgeStatus(change.id, { selected: change.selected });
              break;
            case "remove": {
              const edge = state
                .computed(state)
                .getDiagramData()
                .edgesById.get(change.id);
              if (edge?.data) {
                onEdgeDeleted({ state, edge });

                state.dispatch(state).setEdgeStatus(change.id, {
                  selected: false,
                  draggingWaypoint: false,
                });
              }
              break;
            }
            case "add":
            case "replace":
          }
        }
      });
    },
    [onEdgeDeleted, xyFlowReactKieDiagramStoreApi],
  );

  const onEdgeUpdate = useCallback<RF.OnReconnect<RF.Edge<EData>>>(
    (oldEdge, newConnection) => {
      if (!editingAllowed.current) return;
      try {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          const sourceNode = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(newConnection.source!);
          const targetNode = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(newConnection.target!);
          if (!sourceNode || !targetNode) {
            throw new Error(
              "Cannot create connection without target and source nodes!",
            );
          }

          const sourceBounds = sourceNode.data.shape["dc:Bounds"];
          const targetBounds = targetNode.data.shape["dc:Bounds"];
          if (!sourceBounds || !targetBounds) {
            throw new Error("Cannot create connection without target bounds!");
          }

          const lastWaypoint = oldEdge.data?.edgeInfo
            ? oldEdge.data!["di:waypoint"]![
                oldEdge.data!["di:waypoint"]!.length - 1
              ]!
            : getDiBoundsCenterPoint(targetBounds);
          const firstWaypoint = oldEdge.data?.edgeInfo
            ? oldEdge.data!["di:waypoint"]![0]!
            : getDiBoundsCenterPoint(sourceBounds);

          const { id } = onEdgeUpdated({
            state,
            sourceNode,
            targetNode,
            // Only the changed endpoint has new docking intent. The retained
            // source rendering handle must not reinterpret the untouched route.
            sourceHandle:
              reconnectingEndpoint.current === "source"
                ? ((sourceHandleParts(newConnection.sourceHandle).side ??
                    newConnection.sourceHandle) as PositionalNodeHandleId)
                : undefined,
            targetHandle:
              reconnectingEndpoint.current === "target"
                ? (newConnection.targetHandle as PositionalNodeHandleId)
                : undefined,
            lastWaypoint,
            firstWaypoint,
            edge: oldEdge,
          });

          state.xyFlowReactKieDiagram._selectedEdges = [id]; // Keep the updated edge selected

          // Finish edge update atomically.
          state.xyFlowReactKieDiagram.ongoingConnection = undefined;
          state.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
        });
      } catch (error) {
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram.ongoingConnection = undefined;
          state.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
        });
        if (onError) onError(error);
        else throw error;
      }
    },
    [onEdgeUpdated, onError, xyFlowReactKieDiagramStoreApi],
  );

  const onEdgeUpdateStart = useCallback(
    (
      _e: React.MouseEvent | React.TouchEvent,
      edge: RF.Edge,
      fixedHandleType: RF.HandleType,
    ) => {
      if (!editingAllowed.current) return;
      reconnectingEndpoint.current =
        fixedHandleType === "source" ? "target" : "source";
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        state.xyFlowReactKieDiagram.edgeIdBeingUpdated = edge.id;
      });
    },
    [xyFlowReactKieDiagramStoreApi],
  );

  const onEdgeUpdateEnd = useCallback(() => {
    reconnectingEndpoint.current = undefined;
    // Needed for when the edge update operation doesn't change anything.
    xyFlowReactKieDiagramStoreApi.setState((state) => {
      state.xyFlowReactKieDiagram.ongoingConnection = undefined;
      state.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
    });
  }, [xyFlowReactKieDiagramStoreApi]);

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!container.current || !reactFlowInstance) {
        return;
      }

      if (e.dataTransfer.getData(newNodeMimeType)) {
        const { nodeType, element } = JSON.parse(
          e.dataTransfer.getData(newNodeMimeType),
        ) as {
          nodeType: N;
          element: string;
        };

        e.stopPropagation();

        xyFlowReactKieDiagramStoreApi.setState((state) => {
          const { newNodeId } = onNodeAdded({
            state,
            dropPoint: state.xyFlowReactKieDiagram.newNodeProjection!.position,
            type: nodeType,
            element,
            data: state.xyFlowReactKieDiagram.newNodeProjection!.data as NData,
          });
          state.xyFlowReactKieDiagram._selectedNodes = [newNodeId];
          nodeIdBeingDraggedRef.current = newNodeId;
        });

        onNodeDragStop(undefined as any, { dragging: true } as any, []);

        xyFlowReactKieDiagramStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram.newNodeProjection = undefined;
        });
      }
    },
    [
      container,
      newNodeMimeType,
      onNodeAdded,
      onNodeDragStop,
      reactFlowInstance,
      xyFlowReactKieDiagramStoreApi,
    ],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.some((t) => t === newNodeMimeType)) {
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";

      if (reactFlowInstance) {
        const point = reactFlowInstance.screenToFlowPosition(
          {
            x: e.clientX,
            y: e.clientY,
          },
          { snapToGrid: false },
        );
        const rounded = snapPoint(
          xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
            .snapGrid,
          { "@_x": point.x, "@_y": point.y },
        );
        const position = { x: rounded["@_x"], y: rounded["@_y"] };

        if (
          position.x ===
            xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
              .newNodeProjection?.position.x &&
          position.y ===
            xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
              .newNodeProjection?.position.y
        ) {
          // `onDragOver` is fires continuously as long as the dragged element is inside the target
          // to prevent unnecessary state updates, we only do it when the element's position is different.
          return;
        }

        onNodeDragStart(
          undefined as any,
          xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
            .newNodeProjection!,
          [],
        );

        xyFlowReactKieDiagramStoreApi.setState((s) => {
          if (s.xyFlowReactKieDiagram.newNodeProjection) {
            s.xyFlowReactKieDiagram.newNodeProjection.hidden = false;
          }
        });

        onNodesChange([
          {
            type: "position",
            positionAbsolute: {
              x: position.x,
              y: position.y,
            },
            id: xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
              .newNodeProjection!.id,
          },
        ]);
      }
    },
    [
      newNodeMimeType,
      onNodeDragStart,
      onNodesChange,
      reactFlowInstance,
      xyFlowReactKieDiagramStoreApi,
    ],
  );

  const placementElement = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.placementElement,
  );
  const updatePlacement = useCallback(
    (event: React.MouseEvent) => {
      const state = xyFlowReactKieDiagramStoreApi.getState();
      const projection = state.xyFlowReactKieDiagram.newNodeProjection;
      if (
        !editingAllowed.current ||
        !state.xyFlowReactKieDiagram.placementElement ||
        !projection ||
        !reactFlowInstance
      )
        return;
      const point = reactFlowInstance.screenToFlowPosition(
        { x: event.clientX, y: event.clientY },
        { snapToGrid: false },
      );
      const snapped = snapPoint(state.xyFlowReactKieDiagram.snapGrid, {
        "@_x": point.x,
        "@_y": point.y,
      });
      if (nodeIdBeingDraggedRef.current !== projection.id)
        onNodeDragStart(event.nativeEvent, projection, []);
      xyFlowReactKieDiagramStoreApi.setState((s) => {
        if (s.xyFlowReactKieDiagram.newNodeProjection)
          s.xyFlowReactKieDiagram.newNodeProjection.hidden = false;
      });
      onNodesChange([
        {
          type: "position",
          id: projection.id,
          positionAbsolute: { x: snapped["@_x"], y: snapped["@_y"] },
        },
      ]);
    },
    [
      reactFlowInstance,
      onNodeDragStart,
      onNodesChange,
      xyFlowReactKieDiagramStoreApi,
    ],
  );

  const commitPlacement = useCallback(
    (event: React.MouseEvent) => {
      updatePlacement(event);
      if (!editingAllowed.current) return;
      try {
        // Creation and semantic containment share one model transaction. A
        // rejected container must not leave a node or an extra history entry.
        xyFlowReactKieDiagramStoreApi.setState((state) => {
          const projection = state.xyFlowReactKieDiagram.newNodeProjection;
          const element = state.xyFlowReactKieDiagram.placementElement;
          if (!projection || !element || projection.hidden) return;
          const dropTarget = state.xyFlowReactKieDiagram.dropTarget;
          if (
            dropTarget &&
            containmentMap.has(dropTarget.node.type as N) &&
            (dropTarget.containmentMode === ContainmentMode.INVALID_INSIDE ||
              dropTarget.containmentMode ===
                ContainmentMode.INVALID_NON_INSIDE_CONTAINER)
          )
            throw new Error("BPMN_ACTIVITY_SCOPE");
          const { newNodeId } = onNodeAdded({
            state,
            type: projection.type as N,
            element,
            dropPoint: projection.position,
            data: projection.data as NData,
          });
          const node = state
            .computed(state)
            .getDiagramData()
            .nodesById.get(newNodeId);
          if (!node) throw new Error("BPMN_MISSING_NODE");
          if (
            dropTarget?.node.type &&
            containmentMap.has(dropTarget.node.type as N)
          )
            onNodeParented({
              state,
              parentNode: dropTarget.node as RF.Node<NData, N>,
              activeNode: node,
              selectedNodes: [node],
              containmentMode: dropTarget.containmentMode,
            });
          state.xyFlowReactKieDiagram._selectedNodes = [newNodeId];
          state.xyFlowReactKieDiagram._selectedEdges = [];
          state.xyFlowReactKieDiagram.newNodeProjection = undefined;
          state.xyFlowReactKieDiagram.placementElement = undefined;
          state.xyFlowReactKieDiagram.placementModel = undefined;
          state.xyFlowReactKieDiagram.dropTarget = undefined;
        });
      } catch (error) {
        if (onError) onError(error);
        else throw error;
      } finally {
        nodeIdBeingDraggedRef.current = null;
        clearPlacement();
      }
    },
    [
      updatePlacement,
      onNodeAdded,
      onNodeParented,
      containmentMap,
      onError,
      clearPlacement,
      xyFlowReactKieDiagramStoreApi,
    ],
  );

  // Override Reactflow's behavior by intercepting the keydown event using its `capture` variant.
  const handleRfKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        xyFlowReactKieDiagramStoreApi.getState().xyFlowReactKieDiagram
          .placementElement
      ) {
        e.preventDefault();
        e.stopPropagation();
        clearPlacement();
        return;
      }
      if (
        interactive &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.target instanceof SVGElement
      ) {
        const origin = e.target;
        const edge = origin.closest<SVGElement>(".react-flow__edge");
        const index = origin.getAttribute("data-waypointindex");
        const pointCommand =
          !readOnly &&
          index !== null &&
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Delete",
            "Backspace",
            "Insert",
          ].includes(e.key);
        if (
          edge?.dataset.id &&
          (pointCommand ||
            (origin === edge &&
              ((e.key === "Insert" && !readOnly) ||
                e.key === " " ||
                e.key === "Enter")))
        ) {
          const id = edge.dataset.id;
          const nextIndex =
            e.key === "Delete" ||
            e.key === "Backspace" ||
            e.key === " " ||
            e.key === "Enter"
              ? null
              : e.key === "Insert"
                ? index === null
                  ? 1
                  : Number(index) + 1
                : Number(index);
          // The actual selected route mount consumes this intent. A scheduled
          // frame can run before XYFlow has replaced its controlled SVG layer.
          waypointKeyboardFocus.current = {
            edgeId: id,
            index: nextIndex,
            origin,
          };
          // Preserve native selection dispatch while suppressing Space's page
          // scrolling. Its layer replacement needs the same durable focus owner
          // as a waypoint command, including in a selectable read-only graph.
          if (e.key === " " || e.key === "Enter") e.preventDefault();
        }
      }
      if (
        e.key === "Insert" &&
        interactive &&
        !readOnly &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.target instanceof Element &&
        !e.target.matches("[data-waypointindex]")
      ) {
        const element = e.target.closest<SVGElement>(".react-flow__edge");
        const state = xyFlowReactKieDiagramStoreApi.getState();
        const edge = element?.dataset.id
          ? state
              .computed(state)
              .getDiagramData()
              .selectedEdgesById.get(element.dataset.id)
          : undefined;
        const points = edge?.data?.["di:waypoint"];
        const edgeIndex = edge?.data?.bpmnEdgeIndex;
        if (points && points.length >= 2 && typeof edgeIndex === "number") {
          e.preventDefault();
          e.stopPropagation();
          onWaypointAdded({
            edgeIndex,
            beforeIndex: 1,
            waypoint: {
              "@_x": (points[0]["@_x"] + points[1]["@_x"]) / 2,
              "@_y": (points[0]["@_y"] + points[1]["@_y"]) / 2,
            },
          });
          return;
        }
      }
      if (
        e.key === "F10" &&
        e.shiftKey &&
        interactive &&
        !readOnly &&
        requestDiagramAction
      ) {
        const element =
          e.target instanceof Element
            ? e.target.closest<HTMLElement>(".react-flow__node")
            : null;
        if (element?.dataset.id) {
          e.preventDefault();
          e.stopPropagation();
          requestDiagramAction({ nodeId: element.dataset.id });
          return;
        }
        const edge =
          e.target instanceof Element
            ? e.target.closest<SVGElement>(".react-flow__edge")
            : null;
        if (edge?.dataset.id) {
          e.preventDefault();
          e.stopPropagation();
          requestDiagramAction({ edgeId: edge.dataset.id });
          return;
        }
      }
      if (e.key === "Escape") {
        // Native nested popups consume Escape before canvas deselection or the
        // session-close command. Mantine uses this same target marker at its
        // window capture boundary, before a React bubble handler can intervene.
        if (
          e.target instanceof Element &&
          e.target.closest('[data-mantine-stop-propagation="true"]')
        )
          return;
        const s = xyFlowReactKieDiagramStoreApi.getState();
        if (
          s.computed(s).isDiagramEditingInProgress() &&
          modelBeforeEditingRef.current
        ) {
          e.stopPropagation();
          e.preventDefault();
          xyFlowReactKieDiagramStoreApi.setState((state) => {
            onResetToBeforeEditingBegan(state);
          });
        } else if (!s.xyFlowReactKieDiagram.ongoingConnection) {
          xyFlowReactKieDiagramStoreApi.setState((state) => {
            if (
              state.computed(state).getDiagramData().selectedNodesById.size >
                0 ||
              state.computed(state).getDiagramData().selectedEdgesById.size > 0
            ) {
              state.xyFlowReactKieDiagram._selectedNodes = [];
              state.xyFlowReactKieDiagram._selectedEdges = [];
              e.preventDefault();
            } else if (
              state.computed(state).getDiagramData().selectedNodesById.size <=
                0 &&
              state.computed(state).getDiagramData().selectedEdgesById.size <= 0
            ) {
              e.preventDefault();
              onEscPressed();
            } else {
              // Let the
            }
          });
        } else {
          // Let the KeyboardShortcuts handle it.
        }
      }
    },
    [
      xyFlowReactKieDiagramStoreApi,
      modelBeforeEditingRef,
      onResetToBeforeEditingBegan,
      onEscPressed,
      readOnly,
      clearPlacement,
      requestDiagramAction,
      interactive,
      onWaypointAdded,
    ],
  );

  const nodes = useXyFlowReactKieDiagramStore<
    S,
    N,
    NData,
    EData,
    RF.Node<NData, N>[]
  >((s) => s.computed(s).getDiagramData().nodes);
  const edges = useXyFlowReactKieDiagramStore<
    S,
    N,
    NData,
    EData,
    RF.Edge<EData>[]
  >((s) => s.computed(s).getDiagramData().edges);

  const waypointActionsContextValue = useMemo<WaypointActionsContextType>(
    () => ({
      keyboardFocus: waypointKeyboardFocus,
      disabled: readOnly || !interactive,
      onWaypointAdded: (args) => {
        if (interactive && !readOnly) onWaypointAdded(args);
      },
      onWaypointDeleted: (args) => {
        if (interactive && !readOnly) onWaypointDeleted(args);
      },
      onWaypointRepositioned: (args) => {
        if (interactive && !readOnly) onWaypointRepositioned(args);
      },
    }),
    [
      onWaypointAdded,
      onWaypointDeleted,
      onWaypointRepositioned,
      interactive,
      readOnly,
    ],
  );

  return (
    <WaypointActionsContextProvider value={waypointActionsContextValue}>
      <RF.ReactFlow<RF.Node<NData, N>, RF.Edge<EData>>
        onMouseMoveCapture={(event) => {
          if (!(event.target as Element).closest(".react-flow__panel"))
            updatePlacement(event);
        }}
        onClickCapture={(event) => {
          if (
            !placementElement ||
            (event.target as Element).closest(
              ".react-flow__panel,button,input,textarea,select",
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          commitPlacement(event);
        }}
        proOptions={{ hideAttribution: true }}
        aria-label={t["com.myoxus.editor.bpmn.default-title"]()}
        tabIndex={0}
        ariaLabelConfig={ariaLabelConfig}
        // fitBounds uses the store's zoom range, not fitViewOptions. Its native
        // 50% floor clips large accepted sources; bound only at numeric precision.
        minZoom={Number.EPSILON}
        className="myoxus-bpmn-diagram"
        colorMode={colorMode}
        connectionMode={RF.ConnectionMode.Loose} // Allow target handles to be used as source. This is very important for allowing the positional handles to be updated for the base of an edge.
        onKeyDownCapture={handleRfKeyDownCapture} // Override Reactflow's keyboard listeners.
        onEdgeContextMenu={(event, edge) => {
          if (interactive && !readOnly && requestDiagramAction) {
            event.preventDefault();
            event.stopPropagation();
            requestDiagramAction({ edgeId: edge.id });
          }
        }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onBeforeDelete={async ({
          nodes: removedNodes,
          edges: removedEdges,
        }) => {
          if (readOnly || !interactive) return false;
          try {
            // React Flow normally emits edge removals before node removals in
            // separate callbacks. A rejected node deletion must not commit its
            // edges first. Apply the entire semantic group in one Immer command;
            // later RF removal notifications find no remaining model objects.
            xyFlowReactKieDiagramStoreApi.setState((state) => {
              const depth = (node: RF.Node<NData, N>) => {
                const seen = new Set<string>();
                for (
                  let parent = node.data.parentXyFlowNode;
                  parent && !seen.has(parent.id);
                  parent = parent.data.parentXyFlowNode
                )
                  seen.add(parent.id);
                return seen.size;
              };
              // A node command also removes its connected edges. Retire the
              // explicit edge group first: computed diagram data may still be
              // cached inside this draft, so it cannot prove an edge survived
              // a previous node command. Any later node rejection rolls back
              // this same transaction, including these edge removals.
              for (const removed of removedEdges) {
                const edge = state
                  .computed(state)
                  .getDiagramData()
                  .edgesById.get(removed.id);
                if (edge) onEdgeDeleted({ state, edge });
              }
              for (const removed of [...removedNodes].sort(
                (a, b) => depth(a) - depth(b),
              )) {
                const node = state
                  .computed(state)
                  .getDiagramData()
                  .nodesById.get(removed.id);
                if (node) onNodeDeleted({ state, node });
              }
            });
            return true;
          } catch (error) {
            onError?.(error);
            return false;
          }
        }}
        onReconnectStart={onEdgeUpdateStart}
        onReconnectEnd={onEdgeUpdateEnd}
        onReconnect={onEdgeUpdate}
        onlyRenderVisibleElements={true}
        zoomOnDoubleClick={false}
        elementsSelectable={interactive}
        nodesDraggable={interactive && !readOnly}
        nodesConnectable={interactive && !readOnly}
        edgesReconnectable={interactive && !readOnly}
        panOnScroll={true}
        zoomOnScroll={false}
        preventScrolling={true}
        selectionOnDrag={true}
        panOnDrag={PAN_ON_DRAG}
        selectionMode={RF.SelectionMode.Full} // For selections happening inside Containment nodes it's better to leave it as "Full"
        isValidConnection={isValidConnection}
        connectionLineComponent={connectionLineComponent}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        // (begin)
        // 'Starting to drag' and 'dragging' should have the same behavior. Otherwise,
        // clicking a node and letting it go, without moving, won't work properly, and
        // Nodes will be removed from Containment Nodes.
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        // (end)
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeComponents}
        edgeTypes={edgeComponents}
        snapToGrid={true}
        snapGrid={xyFlowSnapGrid}
        defaultViewport={DEFAULT_VIEWPORT}
        fitView={false}
        fitViewOptions={FIT_VIEW_OPTIONS}
        attributionPosition={"bottom-right"}
        onInit={setReactFlowInstance}
        deleteKeyCode={readOnly || !interactive ? null : DELETE_NODE_KEY_CODES}
        // (begin)
        // Used to make the Palette work by dropping nodes on the Reactflow Canvas
        onDrop={onDrop}
        onDragOver={onDragOver}
        // (end)
      >
        {children}
        {!!alignmentGuides.length && (
          <RF.ViewportPortal>
            <svg
              aria-hidden="true"
              width={1}
              height={1}
              style={{
                position: "absolute",
                overflow: "visible",
                pointerEvents: "none",
                zIndex: NODE_LAYERS.GROUP_NODES + 1,
              }}
            >
              {alignmentGuides.map((guide, index) => (
                <line
                  key={index}
                  {...guide}
                  data-bpmn-alignment-guide="true"
                  stroke="var(--mantine-primary-color-filled)"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          </RF.ViewportPortal>
        )}
        {placementElement && (
          <RF.Panel position="top-center">
            <Alert>
              <Group>
                {t["com.myoxus.editor.bpmn.place-element"]()}
                <Button onClick={clearPlacement}>{t.Cancel()}</Button>
              </Group>
            </Alert>
          </RF.Panel>
        )}
        {ongoingConnection && (
          <RF.Panel position="top-center">
            <Alert>{t["com.myoxus.editor.bpmn.drag-connection"]()}</Alert>
          </RF.Panel>
        )}
        <SelectionStatusLabel />
        <RF.Background />
        <RF.Panel position="bottom-right">
          <IconButtonGroup>
            <IconButton
              tooltip={t["Zoom in"]()}
              onClick={() => reactFlowInstance?.zoomIn()}
              disabled={!reactFlowInstance}
            >
              <ZoomUpIcon />
            </IconButton>
            <IconButton
              tooltip={t["Zoom out"]()}
              onClick={() => reactFlowInstance?.zoomOut()}
              disabled={!reactFlowInstance}
            >
              <ZoomDownIcon />
            </IconButton>
            <IconButton
              tooltip={t["com.myoxus.editor.zoom.fit-to-screen"]()}
              onClick={() =>
                onFitToContent
                  ? onFitToContent()
                  : reactFlowInstance?.fitView(FIT_VIEW_OPTIONS)
              }
              disabled={!reactFlowInstance}
            >
              <ExpandIcon />
            </IconButton>
            <IconButton
              tooltip={
                interactive
                  ? t["com.myoxus.editor.toolbar.lock"]()
                  : t["com.myoxus.editor.toolbar.click-to-unlock"]()
              }
              aria-pressed={!interactive}
              disabled={readOnly}
              onClick={() => setInteractive((value) => !value)}
            >
              {interactive ? <UnlockIcon /> : <LockIcon />}
            </IconButton>
          </IconButtonGroup>
        </RF.Panel>
        <SetConnectionToReactFlowStore />
      </RF.ReactFlow>
    </WaypointActionsContextProvider>
  );
}

/** XYFlow owns connection creation/geometry; KIE commands only cancel that gesture. */
export function SetConnectionToReactFlowStore() {
  const ongoingConnection = useXyFlowReactKieDiagramStore(
    (s) => s.xyFlowReactKieDiagram.ongoingConnection,
  );
  const xyFlowStoreApi = RF.useStoreApi();
  useEffect(() => {
    if (!ongoingConnection) xyFlowStoreApi.getState().cancelConnection();
  }, [ongoingConnection, xyFlowStoreApi]);

  return null;
}

export function isAnyParentSelected<
  N extends string,
  NData extends XyFlowReactKieDiagramNodeData<N, NData>,
>(parentNode: RF.Node<NData, N> | undefined): boolean {
  return (
    parentNode?.selected ||
    (parentNode?.data.parentXyFlowNode
      ? isAnyParentSelected(parentNode?.data.parentXyFlowNode)
      : false)
  );
}
