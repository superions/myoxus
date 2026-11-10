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

import { type BpmnLatestModel } from "../../marshaller";
import { ComputedStateCache } from "../../xyflow/store/ComputedStateCache";
import {
  type XyFlowDiagramState,
  type XyFlowReactKieDiagramEdgeStatus,
  type XyFlowReactKieDiagramNodeStatus,
} from "../../xyflow/store/State";
import { computeIsDiagramEditingInProgress } from "../../xyflow/store/computed/computeIsDiagramEditingInProgress";
import { computeBoundaryEventIdsByAttachedBpmnElementId } from "./computeBoundaryEventIdsByAttachedBpmnElementId";
import { setNodeStatus } from "../../xyflow/store/dispatch/setNodeStatus";
import { setEdgeStatus } from "../../xyflow/store/dispatch/setEdgeStatus";
import { enableMapSet, isDraft, original } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { type BpmnDiagramEdgeData } from "../diagram/BpmnDiagramDomain";
import { type BpmnNodeType } from "../diagram/BpmnDiagramDomain";
import { type BpmnDiagramNodeData } from "../diagram/BpmnDiagramDomain";
import { type Normalized, normalize } from "../normalization/normalize";
import { type StoreApiType } from "./StoreContext";
import { computeDiagramData } from "./computeDiagramData";
enableMapSet(); // Necessary because `Computed` has a lot of Maps and Sets.

export enum BpmnDiagramLhsPanel {
  NONE = "NONE",
  VARIABLES = "VARIABLES",
  CORRELATIONS = "CORRELATIONS",
  PROPERTIES_MANAGEMENT = "PROPERTIES_MANAGEMENT",
}
export type BpmnXyFlowDiagramState = XyFlowDiagramState<
  State,
  BpmnNodeType,
  BpmnDiagramNodeData,
  BpmnDiagramEdgeData
>;
export interface State extends BpmnXyFlowDiagramState {
  // Read this to understand why we need computed as part of the store.
  // https://github.com/pmndrs/zustand/issues/132#issuecomment-1120467721
  computed: (s: State) => {
    getDiagramData(): ReturnType<typeof computeDiagramData>;
    getBoundaryEventIdsByAttachedBpmnElementId(): ReturnType<
      typeof computeBoundaryEventIdsByAttachedBpmnElementId
    >;
    isDiagramEditingInProgress(): boolean;
  };
  dispatch: (s: State) => {
    setNodeStatus: (
      nodeId: string,
      status: Partial<XyFlowReactKieDiagramNodeStatus>,
    ) => any;
    setEdgeStatus: (
      edgeId: string,
      status: Partial<XyFlowReactKieDiagramEdgeStatus>,
    ) => any;
    reset(model: Normalized<BpmnLatestModel>): void;
    commitHistory(): void;
    undo(): void;
    redo(): void;
  };
  bpmn: {
    model: Normalized<BpmnLatestModel>;
  };
  /** Session-only immutable snapshots; never serialized with the BPMN model. */
  history: {
    current: Normalized<BpmnLatestModel>;
    past: Normalized<BpmnLatestModel>[];
    future: Normalized<BpmnLatestModel>[];
  };
  settings: {
    isReadOnly: boolean;
  };
  focus: {
    consumableId: string | undefined;
  };
  propertiesPanel: {
    isOpen: boolean;
    isFurtherOpen: boolean;
  };
  diagram: {
    overlaysPanel: {
      isOpen: boolean;
    };
    openLhsPanel: BpmnDiagramLhsPanel;
    overlays: {
      enableCustomNodeStyles: boolean;
    };
    isEditingStyle: boolean;
  };
}
export const getDefaultStaticState = (): Omit<
  State,
  "bpmn" | "history" | "computed" | "dispatch"
> => ({
  focus: {
    consumableId: undefined,
  },
  settings: {
    isReadOnly: false,
  },
  propertiesPanel: {
    isOpen: false,
    isFurtherOpen: false,
  },
  diagram: {
    overlaysPanel: {
      isOpen: false,
    },
    openLhsPanel: BpmnDiagramLhsPanel.NONE,
    overlays: {
      enableCustomNodeStyles: true,
    },
    isEditingStyle: false,
  },
  xyFlowReactKieDiagram: {
    snapGrid: {
      isEnabled: true,
      x: 20,
      y: 20,
    },
    _selectedNodes: [],
    _selectedEdges: [],
    draggingNodes: [],
    resizingNodes: [],
    draggingWaypoints: [],
    edgeIdBeingUpdated: undefined,
    dropTarget: undefined,
    ongoingConnection: undefined,
    newNodeProjection: undefined,
  },
});
export function createBpmnEditorStore(
  model: BpmnLatestModel,
  computedCache: ComputedStateCache<ReturnType<State["computed"]>>,
): StoreApiType {
  const initial = normalize(model);
  const snapshot = (model: Normalized<BpmnLatestModel>) =>
    isDraft(model) ? original(model)! : model;
  const commitHistory = (s: State) => {
    const next = snapshot(s.bpmn.model);
    if (next === snapshot(s.history.current)) return;
    s.history.past.push(snapshot(s.history.current));
    // Bound retained session memory; snapshots share unchanged immutable subtrees.
    if (s.history.past.length > 100) s.history.past.shift();
    s.history.current = next;
    s.history.future = [];
  };
  const retainVisibleSelection = (s: State) => {
    // History restores the model, not a pointer selection. Missing pasted IDs
    // otherwise survive Undo and suppress single-node controls such as resize.
    const data = s.computed(s).getDiagramData();
    s.xyFlowReactKieDiagram._selectedNodes = [...data.selectedNodesById.keys()];
    s.xyFlowReactKieDiagram._selectedEdges = [...data.selectedEdgesById.keys()];
  };
  const { diagram, ...defaultStaticState } = getDefaultStaticState();
  return create(
    immer<State>(() => ({
      ...defaultStaticState,
      bpmn: {
        model: initial,
      },
      history: {
        current: initial,
        past: [],
        future: [],
      },
      diagram,
      dispatch: (s) => ({
        reset: (model) => {
          s.diagram.isEditingStyle = false;
          s.focus.consumableId = undefined;
          s.bpmn.model = model;
          s.history = {
            current: model,
            past: [],
            future: [],
          };
          // Source replacement clears active gestures/selection, not the user's snap preference.
          s.xyFlowReactKieDiagram = {
            ...getDefaultStaticState().xyFlowReactKieDiagram,
            snapGrid: s.xyFlowReactKieDiagram.snapGrid,
          };
        },
        commitHistory: () => commitHistory(s),
        undo: () => {
          if (
            s.settings.isReadOnly ||
            s.computed(s).isDiagramEditingInProgress()
          )
            return;
          commitHistory(s);
          const previous = s.history.past.pop();
          if (!previous) return;
          s.history.future.push(snapshot(s.history.current));
          s.bpmn.model = snapshot(previous);
          s.history.current = s.bpmn.model;
          retainVisibleSelection(s);
        },
        redo: () => {
          if (
            s.settings.isReadOnly ||
            s.computed(s).isDiagramEditingInProgress()
          )
            return;
          if (snapshot(s.bpmn.model) !== snapshot(s.history.current)) {
            commitHistory(s);
            return;
          }
          const next = s.history.future.pop();
          if (!next) return;
          s.history.past.push(snapshot(s.history.current));
          s.bpmn.model = snapshot(next);
          s.history.current = s.bpmn.model;
          retainVisibleSelection(s);
        },
        setNodeStatus: (nodeId, newStatus) =>
          setNodeStatus(nodeId, newStatus, s),
        setEdgeStatus: (edgeId, newStatus) =>
          setEdgeStatus(edgeId, newStatus, s),
      }),
      computed: (s) => ({
        isDiagramEditingInProgress: () =>
          computedCache.cached(
            "isDiagramEditingInProgress",
            (
              draggingNodesCount: number,
              resizingNodesCount: number,
              draggingWaypointsCount: number,
              isisEditingStyle: boolean,
            ) =>
              computeIsDiagramEditingInProgress(
                draggingNodesCount,
                resizingNodesCount,
                draggingWaypointsCount,
              ) || isisEditingStyle,
            [
              s.xyFlowReactKieDiagram.draggingNodes.length,
              s.xyFlowReactKieDiagram.resizingNodes.length,
              s.xyFlowReactKieDiagram.draggingWaypoints.length,
              s.diagram.isEditingStyle,
            ],
          ),
        getDiagramData: () =>
          computedCache.cached("getDiagramData", computeDiagramData, [
            s.bpmn.model.definitions,
            s.xyFlowReactKieDiagram,
            s.xyFlowReactKieDiagram.snapGrid,
            s.xyFlowReactKieDiagram.dropTarget,
            s.xyFlowReactKieDiagram.newNodeProjection,
          ]),
        getBoundaryEventIdsByAttachedBpmnElementId: () =>
          computedCache.cached(
            "getBoundaryEventIdsByAttachedBpmnElementId",
            computeBoundaryEventIdsByAttachedBpmnElementId,
            [s.bpmn.model.definitions],
          ),
      }),
    })),
  );
}
