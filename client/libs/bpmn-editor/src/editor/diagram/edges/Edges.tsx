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

import { useEdgeClassName } from "../../../xyflow/edges/Hooks";
import {
  PotentialWaypoint,
  Waypoints,
} from "../../../xyflow/waypoints/Waypoints";
import { useAlwaysVisibleEdgeUpdatersAtNodeBorders } from "../../../xyflow/edges/useAlwaysVisibleEdgeUpdatersAtNodeBorders";
import { usePathForEdgeWithWaypoints } from "../../../xyflow/edges/usePathForEdgeWithWaypoints";
import { usePotentialWaypointControls } from "../../../xyflow/waypoints/usePotentialWaypointControls";
import { DEFAULT_INTRACTION_WIDTH } from "../../../xyflow/maths/DcMaths";
import { propsHaveSameValuesDeep } from "../../../xyflow/memoization/memoization";
import { useIsHovered } from "../../../xyflow/reactExt/useIsHovered";
import * as React from "react";
import { useCallback, useMemo, useRef } from "react";
import * as RF from "@xyflow/react";
import { AssociationPath, SequenceFlowPath, edgeLabelBounds } from "./EdgeSvgs";
import { type BpmnDiagramEdgeData } from "../BpmnDiagramDomain";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  EditableNodeLabel,
  useEditableNodeLabel,
} from "../../../xyflow/nodes/EditableNodeLabel";
import { updateFlowElement } from "../../mutations/renameNode";
import { sequenceFlowNotation } from "../../mutations/connection";
import "./Edges.css";
import { useBpmnEditorI18n } from "../../i18n";
import { SELECTED_EDGE_LAYER } from "../../../xyflow/nodes/Hooks";
const interactionStrokeProps: Partial<React.SVGAttributes<SVGPathElement>> = {
  strokeOpacity: 1,
  markerEnd: undefined,
  style: undefined,
  className: "react-flow__edge-interaction",
  stroke: "transparent",
  strokeLinecap: "round",
};
export const SequenceFlowEdge = React.memo(
  (props: RF.EdgeProps<RF.Edge<BpmnDiagramEdgeData>>) => {
    const { i18n } = useBpmnEditorI18n();
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const { path, points: waypoints } = usePathForEdgeWithWaypoints(
      props.data?.bpmnEdge,
      props.data?.bpmnShapeSource,
      props.data?.bpmnShapeTarget,
    );
    const interactionPathRef = React.useRef<SVGPathElement>(null);
    const isHovered = useIsHovered(interactionPathRef);
    const {
      onMouseMove: onMouseMoveOnEdge,
      onDoubleClick: onDoubleClickEdgeWaypoints,
      potentialWaypoint,
      isDraggingWaypoint,
    } = usePotentialWaypointControls(
      waypoints,
      props.selected,
      props.id,
      props.data?.bpmnEdgeIndex,
      interactionPathRef,
    );
    const isConnecting = !!RF.useStore((s) => s.connection.fromHandle?.nodeId);
    const className = useEdgeClassName(isConnecting, isDraggingWaypoint);
    useAlwaysVisibleEdgeUpdatersAtNodeBorders(
      interactionPathRef,
      props.source,
      props.target,
      waypoints,
    );
    const labelPosition = useMemo(
      () => edgeLabelBounds(props.data?.bpmnEdge),
      [props.data?.bpmnEdge],
    );
    const labelStyle = useMemo(() => {
      return {
        transform: `translate(${labelPosition["@_x"]}px,${labelPosition["@_y"]}px)`,
        width: labelPosition["@_width"],
        height: labelPosition["@_height"],
        zIndex: SELECTED_EDGE_LAYER + 1,
      };
    }, [labelPosition]);
    const bpmnEditorStoreApi = useBpmnEditorStoreApi();
    const id = props.id;
    const flowKind = useBpmnEditorStore((state) =>
      sequenceFlowNotation(state.bpmn.model.definitions, id),
    );
    const onChangeLabel = useCallback(
      (newName: string = "") => {
        bpmnEditorStoreApi.setState((s) => {
          updateFlowElement({
            definitions: s.bpmn.model.definitions,
            id: id,
            newFlowElement: {
              "@_name": newName,
            },
          });
        });
      },
      [bpmnEditorStoreApi, id],
    );
    const {
      isEditingLabel,
      setEditingLabel,
      triggerEditing: triggerEditingLabel,
    } = useEditableNodeLabel(
      props.id,
      useBpmnEditorStore((s) => s.settings.isReadOnly),
    );
    const onDoubleClickEdge = useCallback(
      (e: React.MouseEvent) => {
        if (e.metaKey) {
          triggerEditingLabel(e);
        } else {
          onDoubleClickEdgeWaypoints(e);
        }
      },
      [onDoubleClickEdgeWaypoints, triggerEditingLabel],
    );
    return (
      <>
        <SequenceFlowPath
          svgRef={interactionPathRef}
          d={path}
          {...interactionStrokeProps}
          className={`${interactionStrokeProps.className} ${className}`}
          strokeWidth={props.interactionWidth ?? DEFAULT_INTRACTION_WIDTH}
          onMouseMove={onMouseMoveOnEdge}
          onDoubleClick={onDoubleClickEdge}
          data-edgetype={"information-requirement"}
        />
        <SequenceFlowPath
          d={path}
          flowKind={flowKind}
          className={`xyflow-react-kie-diagram--edge ${className}`}
        />

        {props.data?.bpmnElement.__$$element === "sequenceFlow" &&
          (!!props.data.bpmnElement["@_name"] || isEditingLabel) && (
            <RF.EdgeLabelRenderer>
              <div
                style={labelStyle}
                onClick={() =>
                  bpmnEditorStoreApi.setState((state) => {
                    state.xyFlowReactKieDiagram._selectedNodes = [];
                    state.xyFlowReactKieDiagram._selectedEdges = [id];
                  })
                }
                onDoubleClick={triggerEditingLabel}
                className={`kie-bpmn-editor--floating-edge-label edge-label-renderer__custom-edge nodrag nopan ${props.selected ? "selected" : ""}`}
              >
                <EditableNodeLabel
                  id={props.id}
                  name={props.data.bpmnElement["@_name"]}
                  value={props.data.bpmnElement["@_name"]}
                  onChange={onChangeLabel}
                  placeholder={i18n.nodeLabel.placeHolder}
                  position={"center-center"}
                  isEditing={isEditingLabel}
                  setEditing={setEditingLabel}
                  validate={NO_VALIDATION}
                />
              </div>
            </RF.EdgeLabelRenderer>
          )}

        {props.selected && !isConnecting && props.data?.bpmnEdge && (
          <Waypoints
            edgeRef={interactionPathRef}
            edgeId={props.id}
            edgeIndex={props.data.bpmnEdgeIndex}
            waypoints={waypoints}
            onDragStop={onMouseMoveOnEdge}
          />
        )}
        {isHovered && potentialWaypoint && (
          <PotentialWaypoint point={potentialWaypoint.point} />
        )}
      </>
    );
  },
  propsHaveSameValuesDeep,
);
export const AssociationEdge = React.memo(
  (props: RF.EdgeProps<RF.Edge<BpmnDiagramEdgeData>>) => {
    const renderCount = useRef<number>(0);
    renderCount.current++;
    const { path, points: waypoints } = usePathForEdgeWithWaypoints(
      props.data?.bpmnEdge,
      props.data?.bpmnShapeSource,
      props.data?.bpmnShapeTarget,
    );
    const interactionPathRef = React.useRef<SVGPathElement>(null);
    const isHovered = useIsHovered(interactionPathRef);
    const {
      onMouseMove: onMouseMoveOnEdge,
      onDoubleClick: onDoubleClickEdge,
      potentialWaypoint,
      isDraggingWaypoint,
    } = usePotentialWaypointControls(
      waypoints,
      props.selected,
      props.id,
      props.data?.bpmnEdgeIndex,
      interactionPathRef,
    );
    const isConnecting = !!RF.useStore((s) => s.connection.fromHandle?.nodeId);
    const className = useEdgeClassName(isConnecting, isDraggingWaypoint);
    useAlwaysVisibleEdgeUpdatersAtNodeBorders(
      interactionPathRef,
      props.source,
      props.target,
      waypoints,
    );
    return (
      <>
        <AssociationPath
          svgRef={interactionPathRef}
          d={path}
          {...interactionStrokeProps}
          className={`${interactionStrokeProps.className} ${className}`}
          strokeWidth={props.interactionWidth ?? DEFAULT_INTRACTION_WIDTH}
          onMouseMove={onMouseMoveOnEdge}
          onDoubleClick={onDoubleClickEdge}
          data-edgetype={"association"}
        />
        <AssociationPath
          d={path}
          associationDirection={
            props.data?.bpmnElement.__$$element === "association"
              ? props.data.bpmnElement["@_associationDirection"]
              : props.data?.bpmnElement.__$$element ===
                    "dataInputAssociation" ||
                  props.data?.bpmnElement.__$$element ===
                    "dataOutputAssociation"
                ? "One"
                : undefined
          }
          className={`kie-bpmn-editor--edge ${className}`}
        />

        {props.selected && !isConnecting && props.data?.bpmnEdge && (
          <Waypoints
            edgeRef={interactionPathRef}
            edgeId={props.id}
            edgeIndex={props.data.bpmnEdgeIndex}
            waypoints={waypoints}
            onDragStop={onMouseMoveOnEdge}
          />
        )}
        {isHovered && potentialWaypoint && (
          <PotentialWaypoint point={potentialWaypoint.point} />
        )}
      </>
    );
  },
  propsHaveSameValuesDeep,
);
const NO_VALIDATION = () => true;
