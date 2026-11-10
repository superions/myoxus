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

import * as React from "react";
import * as RF from "@xyflow/react";
import { eventNotation, eventInterruption } from "../../mutations/event";
import {
  type BPMN20__tBoundaryEvent,
  type BPMN20__tEndEvent,
  type BPMN20__tGroup,
  type BPMN20__tIntermediateCatchEvent,
  type BPMN20__tIntermediateThrowEvent,
  type BPMN20__tLane,
  type BPMN20__tProcess,
  type BPMN20__tStartEvent,
  type BPMN20__tTextAnnotation,
} from "../../../schemas/bpmn-2_0/ts-gen/types";
import { getContainmentRelationship } from "../../../xyflow/maths/DcMaths";
import { propsHaveSameValuesDeep } from "../../../xyflow/memoization/memoization";
import {
  EditableNodeLabel,
  type OnEditableNodeLabelChange,
  useEditableNodeLabel,
} from "../../../xyflow/nodes/EditableNodeLabel";
import {
  NodeResizerHandle,
  useConnectionTargetStatus,
  useHoveredNodeAlwaysOnTop,
  useNodeClassName,
  useNodeDimensions,
  useNodeResizing,
} from "../../../xyflow/nodes/Hooks";
import { InfoNodePanel } from "../../../xyflow/nodes/InfoNodePanel";
import { OutgoingStuffNodePanel } from "../../../xyflow/nodes/OutgoingStuffNodePanel";
import { PositionalNodeHandles as BorderHandles } from "../../../xyflow/nodes/PositionalNodeHandles";
import { useIsHovered } from "../../../xyflow/reactExt/useIsHovered";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  updateFlowElement,
  updateLane,
  updateTextAnnotation,
} from "../../mutations/renameNode";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  ActivityNodeMarker,
  BPMN_OUTGOING_STRUCTURE,
  type BpmnDiagramEdgeData,
  type BpmnDiagramNodeData,
  bpmnEdgesOutgoingStuffNodePanelMapping,
  bpmnNodesOutgoingStuffNodePanelMapping,
  type BpmnNodeType,
  type BpmnNodeElement,
  EDGE_TYPES,
  MIN_NODE_SIZES,
  NODE_TYPES,
} from "../BpmnDiagramDomain";
import {
  getNodeLabelBounds,
  getNodeLabelPosition,
  useNodeStyle,
} from "./NodeStyle";
import {
  DataObjectNodeSvg,
  EndEventNodeSvg,
  GatewayNodeSvg,
  GroupNodeSvg,
  IntermediateCatchEventNodeSvg,
  IntermediateThrowEventNodeSvg,
  LaneNodeSvg,
  StartEventNodeSvg,
  SubProcessNodeSvg,
  TaskNodeSvg,
  TextAnnotationNodeSvg,
  UnknownNodeSvg,
} from "./NodeSvgs";
import { NodeMorphingPanel } from "./morphing/NodeMorphingPanel";
import { useEventNodeMorphingActions } from "./morphing/useEventNodeMorphingActions";
import { type Unpacked } from "../../../xyflow/tsExt/tsExt";
import { useGatewayNodeMorphingActions } from "./morphing/useGatewayNodeMorphingActions";
import { type ElementFilter } from "../../../xml-parser/element-filter";
import { useTaskNodeMorphingActions } from "./morphing/useTaskNodeMorphingActions";
import { calledGlobalTaskKind } from "../../mutations/global-tasks";
import type { SubProcess } from "../../mutations/activity";
import { eventSubProcessTrigger } from "../../mutations/activity";
import { dataObjectLabel, dataObjectIsCollection } from "../../mutations/data";
import { findProcessIoItem } from "../../mutations/process-io-context";
import { setProcessIoDetails } from "../../mutations/process-io";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import {
  groupCategoryValue,
  setGroupCategoryText,
} from "../../mutations/group";
import { globalTaskMarker } from "./NodeSvgs";
import { useSubProcessNodeMorphingActions } from "./morphing/useSubProcessNodeMorphingActions";
import { useKeyboardShortcutsForMorphingActions } from "./morphing/useKeyboardShortcutsForMorphingActions";

function PositionalNodeHandles(props: { nodeId: string; isTargeted: boolean }) {
  const node = RF.useInternalNode(props.nodeId);
  const edges =
    node?.type && node.type in BPMN_OUTGOING_STRUCTURE
      ? BPMN_OUTGOING_STRUCTURE[
          node.type as keyof typeof BPMN_OUTGOING_STRUCTURE
        ].edges
      : undefined;
  return (
    <BorderHandles
      {...props}
      sourceEdgeType={
        edges?.includes(EDGE_TYPES.sequenceFlow)
          ? EDGE_TYPES.sequenceFlow
          : edges?.[0]
      }
    />
  );
}

export const StartEventNode = React.memo(
  ({
    data: { bpmnElement: startEvent, shape },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tStartEvent> & {
          __$$element: "startEvent";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useEventNodeMorphingActions(startEvent);
    const interrupting = useBpmnEditorStore(
      (state) => eventInterruption(state.bpmn.model.definitions, id).value,
    );
    const notation = useBpmnEditorStore((state) =>
      eventNotation(state.bpmn.model.definitions, id),
    );
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <StartEventNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            variant={notation}
            isInterrupting={interrupting}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--task-node ${className} kie-bpmn-editor--selected-task-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={startEvent["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.startEvent].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.startEvent].edges}
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={
                morphingActions.find((action) => action.id === notation)?.id
              }
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(startEvent["@_name"] || isEditingLabel) &&
            !isMorphingPanelExpanded && (
              <NodeLabelAtTheBottom>
                <EditableNodeLabel
                  id={id}
                  name={startEvent["@_name"]}
                  bounds={getNodeLabelBounds(shape)}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  position={getNodeLabelPosition({
                    nodeType: type as BpmnNodeType,
                  })}
                  value={startEvent["@_name"]}
                  onChange={setName}
                  validate={() => true} // FIXME: Tiago
                  shouldCommitOnBlur={true}
                  // Keeps the text on top of the selected layer
                  fontCssProperties={{
                    zIndex: 2000,
                  }}
                />
              </NodeLabelAtTheBottom>
            )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const IntermediateCatchEventNode = React.memo(
  ({
    data: { bpmnElement: intermediateCatchEvent, shape, parentXyFlowNode },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        | (Normalized<BPMN20__tIntermediateCatchEvent> & {
            __$$element: "intermediateCatchEvent";
          })
        | (Normalized<BPMN20__tBoundaryEvent> & {
            __$$element: "boundaryEvent";
          })
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useEventNodeMorphingActions(intermediateCatchEvent);
    const authoredLabel =
      intermediateCatchEvent.__$$element === "boundaryEvent"
        ? shape["bpmndi:BPMNLabel"]?.["dc:Bounds"]
        : undefined;
    // Default external captions mask routed/container lines at their glyphs,
    // without a large label-box background that could erase nearby notation.
    const captionMask =
      intermediateCatchEvent.__$$element === "boundaryEvent" && !authoredLabel
        ? "-1px -1px 0 var(--mantine-color-body), 1px -1px 0 var(--mantine-color-body), -1px 1px 0 var(--mantine-color-body), 1px 1px 0 var(--mantine-color-body)"
        : undefined;
    const interrupting = useBpmnEditorStore(
      (state) => eventInterruption(state.bpmn.model.definitions, id).value,
    );
    const notation = useBpmnEditorStore((state) =>
      eventNotation(state.bpmn.model.definitions, id),
    );
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <IntermediateCatchEventNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            variant={notation}
            isInterrupting={interrupting}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--intermediate-catch-event-node ${className} kie-bpmn-editor--selected-intermediate-catch-event-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={id}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={
                BPMN_OUTGOING_STRUCTURE[NODE_TYPES.intermediateCatchEvent].nodes
              }
              edgeTypes={
                BPMN_OUTGOING_STRUCTURE[NODE_TYPES.intermediateCatchEvent].edges
              }
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={
                morphingActions.find((action) => action.id === notation)?.id
              }
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(intermediateCatchEvent["@_name"] || isEditingLabel) &&
            !isMorphingPanelExpanded && (
              <NodeLabelAtTheBottom>
                <EditableNodeLabel
                  id={id}
                  name={intermediateCatchEvent["@_name"]}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  position={
                    authoredLabel
                      ? "center-center"
                      : getNodeLabelPosition({
                          nodeType: type as BpmnNodeType,
                          boundary:
                            intermediateCatchEvent.__$$element ===
                              "boundaryEvent" && parentXyFlowNode
                              ? {
                                  event: shape["dc:Bounds"],
                                  host: parentXyFlowNode.data.shape[
                                    "dc:Bounds"
                                  ],
                                }
                              : undefined,
                        })
                  }
                  bounds={getNodeLabelBounds(shape)}
                  value={intermediateCatchEvent["@_name"]}
                  onChange={setName}
                  validate={() => true} // FIXME: Tiago
                  shouldCommitOnBlur={true}
                  // Keeps the text on top of the selected layer
                  fontCssProperties={{
                    zIndex: 2000,
                    textShadow: captionMask,
                  }}
                />
              </NodeLabelAtTheBottom>
            )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const IntermediateThrowEventNode = React.memo(
  ({
    data: { bpmnElement: intermediateThrowEvent, shape },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tIntermediateThrowEvent> & {
          __$$element: "intermediateThrowEvent";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useEventNodeMorphingActions(intermediateThrowEvent);
    const notation = useBpmnEditorStore((state) =>
      eventNotation(state.bpmn.model.definitions, id),
    );
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <IntermediateThrowEventNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            variant={notation}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--intermediate-throw-event-node ${className} kie-bpmn-editor--selected-intermediate-throw-event-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={id}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={
                BPMN_OUTGOING_STRUCTURE[NODE_TYPES.intermediateThrowEvent].nodes
              }
              edgeTypes={
                BPMN_OUTGOING_STRUCTURE[NODE_TYPES.intermediateThrowEvent].edges
              }
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={
                morphingActions.find((action) => action.id === notation)?.id
              }
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(intermediateThrowEvent["@_name"] || isEditingLabel) &&
            !isMorphingPanelExpanded && (
              <NodeLabelAtTheBottom>
                <EditableNodeLabel
                  id={id}
                  name={intermediateThrowEvent["@_name"]}
                  bounds={getNodeLabelBounds(shape)}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  position={getNodeLabelPosition({
                    nodeType: type as BpmnNodeType,
                  })}
                  value={intermediateThrowEvent["@_name"]}
                  onChange={setName}
                  validate={() => true} // FIXME: Tiago
                  shouldCommitOnBlur={true}
                  // Keeps the text on top of the selected layer
                  fontCssProperties={{
                    zIndex: 2000,
                  }}
                />
              </NodeLabelAtTheBottom>
            )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const EndEventNode = React.memo(
  ({
    data: { bpmnElement: endEvent, shape },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tEndEvent> & {
          __$$element: "endEvent";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useEventNodeMorphingActions(endEvent);
    const notation = useBpmnEditorStore((state) =>
      eventNotation(state.bpmn.model.definitions, id),
    );
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <EndEventNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            variant={notation}
            strokeWidth={6}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--end-event-node ${className} kie-bpmn-editor--selected-end-event-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={id}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.endEvent].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.endEvent].edges}
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={
                morphingActions.find((action) => action.id === notation)?.id
              }
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(endEvent["@_name"] || isEditingLabel) &&
            !isMorphingPanelExpanded && (
              <NodeLabelAtTheBottom>
                <EditableNodeLabel
                  id={id}
                  name={endEvent["@_name"]}
                  bounds={getNodeLabelBounds(shape)}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  position={getNodeLabelPosition({
                    nodeType: type as BpmnNodeType,
                  })}
                  value={endEvent["@_name"]}
                  onChange={setName}
                  validate={() => true} // FIXME: Tiago
                  shouldCommitOnBlur={true}
                  // Keeps the text on top of the selected layer
                  fontCssProperties={{
                    zIndex: 2000,
                  }}
                />
              </NodeLabelAtTheBottom>
            )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const TaskNode = React.memo(
  ({
    data: { bpmnElement: task, shape, shapeIndex },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<
          ElementFilter<
            Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
            | "task"
            | "scriptTask"
            | "serviceTask"
            | "businessRuleTask"
            | "userTask"
            | "manualTask"
            | "sendTask"
            | "receiveTask"
            | "callActivity"
          >
        >
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const enableCustomNodeStyles = useBpmnEditorStore(
      (s) => s.diagram.overlays.enableCustomNodeStyles,
    );
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const { fontCssProperties } = useNodeStyle({
      nodeType: type as BpmnNodeType,
      isEnabled: enableCustomNodeStyles,
    });
    const calledKind = useBpmnEditorStore((state) =>
      task.__$$element === "callActivity"
        ? calledGlobalTaskKind(state.bpmn.model.definitions, id)
        : undefined,
    );
    const icons = useActivityIcons(task, calledKind !== undefined);
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useTaskNodeMorphingActions(task);
    const calledMarker = globalTaskMarker(calledKind);
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <TaskNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            strokeWidth={task.__$$element === "callActivity" ? 5 : undefined}
            markers={icons}
            variant={
              task.__$$element === "callActivity"
                ? (calledMarker ?? "callActivity")
                : task.__$$element
            }
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--task-node ${className} kie-bpmn-editor--selected-task-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={task["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <EditableNodeLabel
              id={id}
              name={task["@_name"]}
              bounds={getNodeLabelBounds(shape)}
              isEditing={isEditingLabel}
              setEditing={setEditingLabel}
              position={getNodeLabelPosition({
                nodeType: type as BpmnNodeType,
              })}
              value={task["@_name"]}
              onChange={setName}
              validate={() => true} // FIXME: Tiago
              shouldCommitOnBlur={true}
              // Keeps the text on top of the selected layer
              fontCssProperties={{
                ...fontCssProperties,
                zIndex: 2000,
              }}
            />

            {shouldActLikeHovered && (
              <NodeResizerHandle
                nodeType={type as typeof NODE_TYPES.task}
                nodeId={id}
                nodeShapeIndex={shapeIndex}
                MIN_NODE_SIZES={MIN_NODE_SIZES}
              />
            )}

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.task].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.task].edges}
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={task.__$$element}
            />
          </div>
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const SubProcessNode = React.memo(
  ({
    data: { bpmnElement: subProcess, shape, shapeIndex },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<RF.Node<BpmnDiagramNodeData<SubProcess>, BpmnNodeType>>) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const interactionRectRef = useRef<SVGRectElement>(null);
    const enableCustomNodeStyles = useBpmnEditorStore(
      (s) => s.diagram.overlays.enableCustomNodeStyles,
    );
    const isOnlySelectedNode = useBpmnEditorStore(
      (s) => s.xyFlowReactKieDiagram._selectedNodes.length === 1 && selected,
    );
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const { fontCssProperties } = useNodeStyle({
      nodeType: type as BpmnNodeType,
      isEnabled: enableCustomNodeStyles,
    });
    const icons = useActivityIcons(subProcess);
    const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    );
    const eventTrigger = eventSubProcessTrigger(definitions, id);
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useSubProcessNodeMorphingActions(subProcess);
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    useEffect(() => {
      // Defer focus from interactionRect on
      // `SubProcesNodeSvg` to the
      // `.xyflow-react-kie-diagram--node` div.
      const s = interactionRectRef.current;
      const r = ref.current;
      const f = () => {
        r?.focus();
      };
      s?.addEventListener("focus", f);
      return () => {
        s?.removeEventListener("focus", f);
      };
    }, []);
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <SubProcessNodeSvg
            {...nodeDimensions}
            ref={interactionRectRef}
            x={0}
            y={0}
            icons={icons}
            eventTrigger={eventTrigger}
            isExpanded={shape["@_isExpanded"] === true}
            variant={
              subProcess.__$$element === "transaction"
                ? "transaction"
                : subProcess["@_triggeredByEvent"]
                  ? "event"
                  : subProcess.loopCharacteristics?.__$$element ===
                      "multiInstanceLoopCharacteristics"
                    ? "multi-instance"
                    : "other"
            }
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--sub-process-node ${className} kie-bpmn-editor--selected-sub-process-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={subProcess["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded &&
                !isTargeted &&
                isOnlySelectedNode &&
                !dragging
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <EditableNodeLabel
              id={id}
              name={subProcess["@_name"]}
              bounds={getNodeLabelBounds(shape)}
              isEditing={isEditingLabel}
              setEditing={setEditingLabel}
              position={getNodeLabelPosition({
                nodeType: type as BpmnNodeType,
                isExpanded: shape["@_isExpanded"] === true,
              })}
              value={subProcess["@_name"]}
              onChange={setName}
              validate={() => true} // FIXME: Tiago
              shouldCommitOnBlur={true}
              // Keeps the text on top of the selected layer
              fontCssProperties={{
                ...fontCssProperties,
                zIndex: 2000,
              }}
            />

            {isOnlySelectedNode && !dragging && (
              <NodeResizerHandle
                nodeType={type as typeof NODE_TYPES.subProcess}
                nodeId={id}
                nodeShapeIndex={shapeIndex}
                MIN_NODE_SIZES={MIN_NODE_SIZES}
              />
            )}

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded &&
                !isTargeted &&
                isOnlySelectedNode &&
                !dragging &&
                !subProcess["@_triggeredByEvent"]
              }
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.subProcess].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.subProcess].edges}
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && isOnlySelectedNode && !dragging}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={
                subProcess["@_triggeredByEvent"]
                  ? "event"
                  : subProcess.__$$element
              }
            />
          </div>
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const GatewayNode = React.memo(
  ({
    data: { bpmnElement: gateway, shape },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<
          ElementFilter<
            Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
            | "exclusiveGateway"
            | "inclusiveGateway"
            | "parallelGateway"
            | "eventBasedGateway"
            | "complexGateway"
          >
        >
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const [isMorphingPanelExpanded, setMorphingPanelExpanded] = useState(false);
    const morphingActions = useGatewayNodeMorphingActions(gateway);
    const disabledMorphingActionIds = useMemo<
      Set<Unpacked<typeof morphingActions>["id"]>
    >(() => new Set(), []);
    useKeyboardShortcutsForMorphingActions(
      ref,
      morphingActions,
      disabledMorphingActionIds,
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <GatewayNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            variant={gateway.__$$element}
            instantiate={
              gateway.__$$element === "eventBasedGateway"
                ? gateway["@_instantiate"]
                : undefined
            }
            eventGatewayType={
              gateway.__$$element === "eventBasedGateway"
                ? gateway["@_eventGatewayType"]
                : undefined
            }
            isMarkerVisible={shape["@_isMarkerVisible"]}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--gateway-node ${className} kie-bpmn-editor--selected-gateway-node`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={gateway["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={
                !isMorphingPanelExpanded && !isTargeted && shouldActLikeHovered
              }
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.gateway].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.gateway].edges}
            />

            <NodeMorphingPanel
              disabledActionIds={disabledMorphingActionIds}
              isToggleVisible={!isTargeted && shouldActLikeHovered}
              isExpanded={isMorphingPanelExpanded}
              setExpanded={setMorphingPanelExpanded}
              actions={morphingActions}
              selectedActionId={gateway.__$$element}
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(gateway["@_name"] || isEditingLabel) &&
            !isMorphingPanelExpanded && (
              <NodeLabelAtTheBottom>
                <EditableNodeLabel
                  id={id}
                  name={gateway["@_name"]}
                  bounds={getNodeLabelBounds(shape)}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  position={getNodeLabelPosition({
                    nodeType: type as BpmnNodeType,
                  })}
                  value={gateway["@_name"]}
                  onChange={setName}
                  validate={() => true} // FIXME: Tiago
                  shouldCommitOnBlur={true}
                  // Keeps the text on top of the selected layer
                  fontCssProperties={{
                    zIndex: 2000,
                  }}
                />
              </NodeLabelAtTheBottom>
            )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const DataObjectNode = React.memo(
  ({
    data: { bpmnElement: dataObject, shape, shapeIndex },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Extract<
          BpmnNodeElement,
          {
            __$$element:
              | "dataObject"
              | "dataObjectReference"
              | "dataStoreReference"
              | "dataInput"
              | "dataOutput";
          }
        >
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const label = useBpmnEditorStore((state) =>
      dataObjectLabel(state.bpmn.model.definitions, id),
    );
    const collection = useBpmnEditorStore((state) =>
      dataObjectIsCollection(state.bpmn.model.definitions, id),
    );
    const current =
      useBpmnEditorStore(
        (state) =>
          findProcessIoItem(
            addOrGetProcessAndDiagramElements({
              definitions: state.bpmn.model.definitions,
            }).process,
            id,
          )?.element,
      ) ?? dataObject;
    const ioKind = useBpmnEditorStore(
      (state) =>
        findProcessIoItem(
          addOrGetProcessAndDiagramElements({
            definitions: state.bpmn.model.definitions,
          }).process,
          id,
        )?.kind,
    );
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          if (state.settings.isReadOnly) return;
          if (
            findProcessIoItem(
              addOrGetProcessAndDiagramElements({
                definitions: state.bpmn.model.definitions,
              }).process,
              id,
            )
          ) {
            setProcessIoDetails(state.bpmn.model.definitions, id, {
              name: newName.trim(),
            });
            return;
          }
          updateFlowElement({
            definitions: state.bpmn.model.definitions,
            newFlowElement: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );

    // This is used to modify a css from a :before element.
    // The --height is a css var which is used by when this node is selected class
    const [nodeHeight, setNodeHeight] = React.useState<number>(0);
    const style = useMemo<React.CSSProperties>(
      () => ({
        display: "flex",
        flexDirection: "column",
        outline: "none",
        "--selected-data-object-node-shape--height": `${nodeDimensions.height + 20 + 26 + (isEditingLabel ? 20 : (nodeHeight ?? 0))}px`,
      }),
      [nodeDimensions, isEditingLabel, nodeHeight],
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <DataObjectNodeSvg
            {...nodeDimensions}
            x={0}
            y={0}
            ioKind={ioKind}
            showFoldedPage={true}
            isCollection={collection}
            isStore={dataObject.__$$element === "dataStoreReference"}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          style={style}
          className={`kie-bpmn-editor--data-object-node-content ${className} ${selected ? "selected" : ""}`}
          ref={ref}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={current["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={!isTargeted && shouldActLikeHovered}
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            {shouldActLikeHovered && (
              <NodeResizerHandle
                nodeType={type as typeof NODE_TYPES.dataObject}
                nodeId={id}
                nodeShapeIndex={shapeIndex}
                MIN_NODE_SIZES={MIN_NODE_SIZES}
              />
            )}

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={!isTargeted && shouldActLikeHovered}
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.dataObject].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.dataObject].edges}
            />
          </div>
          {/* Creates a div element with the node size to push down the <EditableNodeLabel /> */}
          {
            <div
              style={{
                height: nodeDimensions.height,
                flexShrink: 0,
              }}
            />
          }
          {(label || isEditingLabel) && (
            <NodeLabelAtTheBottom>
              <EditableNodeLabel
                id={id}
                name={current["@_name"]}
                bounds={getNodeLabelBounds(shape)}
                isEditing={isEditingLabel}
                setEditing={setEditingLabel}
                position={getNodeLabelPosition({
                  nodeType: type as BpmnNodeType,
                })}
                value={current["@_name"]}
                displayText={label}
                onChange={setName}
                validate={() => true} // FIXME: Tiago
                shouldCommitOnBlur={true}
                // Keeps the text on top of the selected layer
                fontCssProperties={{
                  zIndex: 2000,
                }}
                setLabelHeight={setNodeHeight}
              />
            </NodeLabelAtTheBottom>
          )}
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const GroupNode = React.memo(
  ({
    data: { shape, shapeIndex },
    selected,
    dragging,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tGroup> & {
          __$$element: "group";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<SVGRectElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const label = useBpmnEditorStore(
      (state) =>
        groupCategoryValue(state.bpmn.model.definitions, id)?.["@_value"] ?? "",
    );
    const { isEditingLabel, setEditingLabel, triggerEditingIfEnter } =
      useEditableNodeLabel(
        id,
        useBpmnEditorStore((state) => state.settings.isReadOnly),
      );
    const reactFlow = RF.useReactFlow<
      RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
      RF.Edge<BpmnDiagramEdgeData>
    >();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
      true,
    );
    const nodeDimensions = useNodeDimensions({ shape });

    // Select nodes that are visually entirely inside the group.
    useEffect(() => {
      const onDoubleClick = () => {
        bpmnEditorStoreApi.setState((state) => {
          state.xyFlowReactKieDiagram._selectedNodes = reactFlow
            .getNodes()
            .flatMap((n) =>
              getContainmentRelationship({
                bounds: n.data.shape["dc:Bounds"]!,
                container: shape["dc:Bounds"]!,
                borderAllowanceInPx: 0, // We only care about nodes that are completelyInside the Group node.
              }).isCompletelyInside
                ? [n.id]
                : [],
            );
        });
      };
      const r = ref.current;
      r?.addEventListener("dblclick", onDoubleClick);
      return () => {
        r?.removeEventListener("dblclick", onDoubleClick);
      };
    }, [bpmnEditorStoreApi, reactFlow, shape]);
    return (
      <>
        <svg className={`xyflow-react-kie-diagram--node-shape ${className}`}>
          <GroupNodeSvg
            ref={ref}
            {...nodeDimensions}
            x={0}
            y={0}
            strokeWidth={3}
          />
        </svg>

        <div
          className={`xyflow-react-kie-diagram--node kie-bpmn-editor--group-node ${className}`}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={label}
          onKeyDown={triggerEditingIfEnter}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}

          {(label || isEditingLabel) && (
            <EditableNodeLabel
              id={id}
              name={label}
              bounds={getNodeLabelBounds(shape)}
              value={label}
              position="top-left"
              isEditing={isEditingLabel}
              setEditing={setEditingLabel}
              shouldCommitOnBlur={true}
              validate={() => true}
              onChange={(text) =>
                bpmnEditorStoreApi.setState((state) => {
                  if (!state.settings.isReadOnly)
                    setGroupCategoryText(
                      state.bpmn.model.definitions,
                      id,
                      text,
                    );
                })
              }
            />
          )}
          {selected && !dragging && (
            <NodeResizerHandle
              nodeType={type as typeof NODE_TYPES.group}
              nodeId={id}
              nodeShapeIndex={shapeIndex}
              MIN_NODE_SIZES={MIN_NODE_SIZES}
            />
          )}

          <OutgoingStuffNodePanel
            nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
            edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
            nodeHref={id}
            isVisible={!isTargeted && selected && !dragging}
            nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.group].nodes}
            edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.group].edges}
          />
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const LaneNode = React.memo(
  ({
    data: { bpmnElement: lane, shape, shapeIndex },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tLane> & {
          __$$element: "lane";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<SVGRectElement>(null);
    const isOnlySelectedNode = useBpmnEditorStore(
      (s) => s.xyFlowReactKieDiagram._selectedNodes.length === 1 && selected,
    );
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setName = useCallback<OnEditableNodeLabelChange>(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateLane({
            definitions: state.bpmn.model.definitions,
            newLane: {
              "@_name": newName.trim(),
            },
            id,
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    return (
      <>
        <svg
          className={`xyflow-react-kie-diagram--node-shape ${className} ${selected ? "selected" : ""}`}
        >
          <LaneNodeSvg
            {...nodeDimensions}
            isHorizontal={shape["@_isHorizontal"]}
            x={0}
            y={0}
            ref={ref}
          />
        </svg>
        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />
        <div
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          className={`kie-bpmn-editor--lane-node ${className} kie-bpmn-editor--selected-lane-node`}
          tabIndex={-1}
          data-nodehref={id}
          data-nodelabel={lane["@_name"]}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <div className={"xyflow-react-kie-diagram--node"}>
            <InfoNodePanel
              isVisible={!isTargeted && isOnlySelectedNode && !dragging}
              onClick={useCallback(() => {
                bpmnEditorStoreApi.setState((state) => {
                  state.propertiesPanel.isOpen = true;
                });
              }, [bpmnEditorStoreApi])}
            />

            <EditableNodeLabel
              id={id}
              name={lane["@_name"]}
              bounds={getNodeLabelBounds(shape)}
              isEditing={isEditingLabel}
              setEditing={setEditingLabel}
              position={getNodeLabelPosition({
                nodeType: type as BpmnNodeType,
                isHorizontal: shape["@_isHorizontal"],
              })}
              value={lane["@_name"]}
              onChange={setName}
              validate={() => true} // FIXME: Tiago
              shouldCommitOnBlur={true}
              // Keeps the text on top of the selected layer
              fontCssProperties={{
                zIndex: 2000,
              }}
            />

            {isOnlySelectedNode && !dragging && (
              <NodeResizerHandle
                nodeType={type as typeof NODE_TYPES.lane}
                nodeId={id}
                nodeShapeIndex={shapeIndex}
                MIN_NODE_SIZES={MIN_NODE_SIZES}
              />
            )}

            <OutgoingStuffNodePanel
              nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
              edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
              nodeHref={id}
              isVisible={!isTargeted && isOnlySelectedNode && !dragging}
              nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.lane].nodes}
              edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.lane].edges}
            />
          </div>
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const TextAnnotationNode = React.memo(
  ({
    data: { bpmnElement: textAnnotation, shape, shapeIndex },
    selected,
    dragging,
    zIndex,
    type,
    id,
  }: RF.NodeProps<
    RF.Node<
      BpmnDiagramNodeData<
        Normalized<BPMN20__tTextAnnotation> & {
          __$$element: "textAnnotation";
        }
      >,
      BpmnNodeType
    >
  >) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const enableCustomNodeStyles = useBpmnEditorStore(
      (s) => s.diagram.overlays.enableCustomNodeStyles,
    );
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing,
      triggerEditingIfEnter,
    } = useEditableNodeLabel(
      id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    useHoveredNodeAlwaysOnTop(
      ref,
      zIndex,
      shouldActLikeHovered,
      dragging,
      selected,
      isEditingLabel,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    const setText = useCallback(
      (newText: string = "") => {
        bpmnEditorStoreApi.setState((state) => {
          updateTextAnnotation({
            definitions: state.bpmn.model.definitions,
            id,
            newTextAnnotation: {
              text: {
                __$$text: newText,
              },
            },
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const { fontCssProperties } = useNodeStyle({
      nodeType: type as BpmnNodeType,
      isEnabled: enableCustomNodeStyles,
    });
    const content = useMemo(
      () => String(textAnnotation.text?.__$$text ?? ""),
      [textAnnotation],
    );
    return (
      <>
        <svg className={`xyflow-react-kie-diagram--node-shape ${className}`}>
          <TextAnnotationNodeSvg {...nodeDimensions} x={0} y={0} />
        </svg>

        <PositionalNodeHandles
          isTargeted={isTargeted && isValidConnectionTarget}
          nodeId={id}
        />

        <div
          ref={ref}
          className={`xyflow-react-kie-diagram--node kie-bpmn-editor--text-annotation-node ${className}`}
          tabIndex={-1}
          onDoubleClick={triggerEditing}
          onKeyDown={triggerEditingIfEnter}
          data-nodehref={id}
          data-nodelabel={String(textAnnotation.text)}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <InfoNodePanel
            isVisible={!isTargeted && shouldActLikeHovered}
            onClick={useCallback(() => {
              bpmnEditorStoreApi.setState((state) => {
                state.propertiesPanel.isOpen = true;
              });
            }, [bpmnEditorStoreApi])}
          />

          <EditableNodeLabel
            id={id}
            name={content}
            bounds={getNodeLabelBounds(shape)}
            isEditing={isEditingLabel}
            setEditing={setEditingLabel}
            position={getNodeLabelPosition({
              nodeType: type as BpmnNodeType,
            })}
            value={content}
            onChange={setText}
            validate={() => true} // FIXME: Tiago
            shouldCommitOnBlur={true}
            // Keeps the text on top of the selected layer
            fontCssProperties={{
              ...fontCssProperties,
              zIndex: 2000,
            }}
          />

          {shouldActLikeHovered && (
            <NodeResizerHandle
              nodeType={type as typeof NODE_TYPES.textAnnotation}
              nodeId={id}
              nodeShapeIndex={shapeIndex}
              MIN_NODE_SIZES={MIN_NODE_SIZES}
            />
          )}

          <OutgoingStuffNodePanel
            nodeMapping={bpmnNodesOutgoingStuffNodePanelMapping}
            edgeMapping={bpmnEdgesOutgoingStuffNodePanelMapping}
            nodeHref={id}
            isVisible={!isTargeted && shouldActLikeHovered}
            nodeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.textAnnotation].nodes}
            edgeTypes={BPMN_OUTGOING_STRUCTURE[NODE_TYPES.textAnnotation].edges}
          />
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const UnknownNode = React.memo(
  ({
    data: { shape },
    type,
    id,
  }: RF.NodeProps<RF.Node<BpmnDiagramNodeData<any>, BpmnNodeType>>) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useIsHovered(ref);
    const isResizing = useNodeResizing(id);
    const shouldActLikeHovered = useBpmnEditorStore(
      (s) =>
        (isHovered || isResizing) &&
        s.xyFlowReactKieDiagram.draggingNodes.length === 0,
    );
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const { isTargeted, isValidConnectionTarget } = useConnectionTargetStatus(
      id,
      shouldActLikeHovered,
    );
    const className = useNodeClassName(
      isValidConnectionTarget,
      id,
      NODE_TYPES,
      EDGE_TYPES,
    );
    const nodeDimensions = useNodeDimensions({ shape });
    return (
      <>
        <svg className={`xyflow-react-kie-diagram--node-shape ${className}`}>
          <UnknownNodeSvg {...nodeDimensions} x={0} y={0} />
        </svg>

        <RF.Handle
          key={"unknown"}
          id={"unknown"}
          type={"source"}
          style={{
            opacity: 0,
          }}
          position={RF.Position.Top}
        />

        <div
          ref={ref}
          className={`xyflow-react-kie-diagram--node kie-bpmn-editor--unknown-node ${className}`}
          tabIndex={-1}
          data-nodehref={id}
        >
          {/* {`render count: ${renderCount.current}`}
           <br /> */}
          <InfoNodePanel
            isVisible={!isTargeted && shouldActLikeHovered}
            onClick={useCallback(() => {
              bpmnEditorStoreApi.setState((state) => {
                state.propertiesPanel.isOpen = true;
              });
            }, [bpmnEditorStoreApi])}
          />

          <EditableNodeLabel
            id={id}
            name={undefined}
            position={getNodeLabelPosition({
              nodeType: type as typeof NODE_TYPES.unknown,
            })}
            isEditing={false}
            setEditing={() => {}}
            value={`? `}
            onChange={() => {}}
            skipValidation={false}
            validate={useCallback((_value) => true, [])}
            shouldCommitOnBlur={true}
          />
        </div>
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export function useActivityIcons(
  activity: ElementFilter<
    Unpacked<Normalized<BPMN20__tProcess>["flowElement"]>,
    | "adHocSubProcess"
    | "transaction"
    | "subProcess"
    | "task"
    | "serviceTask"
    | "userTask"
    | "businessRuleTask"
    | "scriptTask"
    | "manualTask"
    | "sendTask"
    | "receiveTask"
    | "callActivity"
  >,
  isGlobalCall = false,
) {
  return useMemo(() => {
    const icons: ActivityNodeMarker[] = [];
    if (activity.__$$element === "adHocSubProcess") {
      icons.push(ActivityNodeMarker.AdHocSubProcess);
    }
    if (activity["@_isForCompensation"]) {
      icons.push(ActivityNodeMarker.Compensation);
    }
    if (
      activity.loopCharacteristics?.__$$element ===
      "multiInstanceLoopCharacteristics"
    ) {
      icons.push(
        activity.loopCharacteristics["@_isSequential"]
          ? ActivityNodeMarker.MultiInstanceSequential
          : ActivityNodeMarker.MultiInstanceParallel,
      );
    }
    if (
      activity.loopCharacteristics?.__$$element ===
      "standardLoopCharacteristics"
    ) {
      icons.push(ActivityNodeMarker.Loop);
    }
    if (activity.__$$element === "callActivity" && !isGlobalCall) {
      icons.push(ActivityNodeMarker.Collapsed);
    }
    return icons;
  }, [activity, isGlobalCall]);
}
export function NodeLabelAtTheBottom({
  children,
}: React.PropsWithChildren<{}>) {
  return (
    <div className={"kie-bpmn-editor--floating-node-label"}>{children}</div>
  );
}
