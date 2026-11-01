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

import { BpmnSvgLabel } from "./bpmn-svg-label";
import * as React from "react";
import { useMemo } from "react";
import * as RF from "@xyflow/react";
import {
  type BpmnNodeElement,
  type BpmnNodeType,
  type EventVariant,
  type GatewayVariant,
  type SubProcessVariant,
  type TaskVariant,
} from "../diagram/BpmnDiagramDomain";
import { EdgeMarkers } from "../../xyflow/edges/EdgeMarkers";
import { type BpmnDiagramEdgeData } from "../diagram/BpmnDiagramDomain";
import { EDGE_TYPES } from "../diagram/BpmnDiagramDomain";
import { getCanonicalMultiPointEdgePath } from "../../xyflow/edges/getSnappedMultiPointAnchoredEdgePath";
import { type BpmnDiagramNodeData } from "../diagram/BpmnDiagramDomain";
import {
  getBpmnFontStyle,
  getNodeLabelPosition,
  getNodeStyle,
} from "../diagram/nodes/NodeStyle";
import { assertUnreachable } from "../ts-ext/assertUnreachable";
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
} from "../diagram/nodes/NodeSvgs";
import { NODE_TYPES } from "../diagram/BpmnDiagramDomain";
import { type NodeLabelPosition } from "../../xyflow/nodes/NodeSvgs";
import {
  AssociationPath,
  SequenceFlowPath,
  edgeLabelBounds,
} from "../diagram/edges/EdgeSvgs";
import { type Normalized } from "../normalization/normalize";
import { eventNotation, eventInterruption } from "../mutations/event";
import { eventSubProcessTrigger } from "../mutations/activity";
import { sequenceFlowNotation } from "../mutations/connection";
import { groupCategoryValue } from "../mutations/group";
import { dataObjectLabel, dataObjectIsCollection } from "../mutations/data";
import {
  type BPMN20__tEndEvent,
  type BPMN20__tGateway,
  type BPMN20__tIntermediateCatchEvent,
  type BPMN20__tStartEvent,
  type BPMN20__tSubProcess,
  type BPMN20__tTask,
  type BPMN20__tThrowEvent,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { useActivityIcons } from "../diagram/nodes/Nodes";
import { calledGlobalTaskKind } from "../mutations/global-tasks";
import { globalTaskMarker } from "../diagram/nodes/NodeSvgs";
import type { BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";

const SVG_LABEL_GLYPH_MASK = {
  paintOrder: "stroke fill",
  stroke: "var(--mantine-color-body)",
  strokeWidth: 3,
  strokeLinejoin: "round",
} as const;

// Map node types to variant return types
type NodeVariantReturnMap = {
  [NODE_TYPES.startEvent]: EventVariant | "none";
  [NODE_TYPES.intermediateCatchEvent]: EventVariant | "none";
  [NODE_TYPES.intermediateThrowEvent]: EventVariant | "none";
  [NODE_TYPES.endEvent]: EventVariant | "none";
  [NODE_TYPES.gateway]: GatewayVariant | "none";
  [NODE_TYPES.subProcess]: SubProcessVariant | "other";
  [NODE_TYPES.task]: TaskVariant | "task" | "callActivity" | "none";
};

// Map node types to input types (Normalized BPMN elements)
type NodeElementMap = {
  [NODE_TYPES.startEvent]: Normalized<BPMN20__tStartEvent>;
  [NODE_TYPES.intermediateCatchEvent]: Normalized<BPMN20__tIntermediateCatchEvent>;
  [NODE_TYPES.intermediateThrowEvent]: Normalized<BPMN20__tThrowEvent>;
  [NODE_TYPES.endEvent]: Normalized<BPMN20__tEndEvent>;
  [NODE_TYPES.gateway]: Normalized<BPMN20__tGateway>;
  [NODE_TYPES.subProcess]: Normalized<BPMN20__tSubProcess>;
  [NODE_TYPES.task]: Normalized<BPMN20__tTask>;
};
type TaskNodeSvgWithoutMarkersProps = Omit<
  React.ComponentProps<typeof TaskNodeSvg>,
  "markers"
>;
type SubProcessNodeSvgWithoutIconsProps = Omit<
  React.ComponentProps<typeof SubProcessNodeSvg>,
  "icons"
>;
type BpmnElementActivitytIcons = Parameters<typeof useActivityIcons>[0];
type TaskOrSubProcessNodeSvgWithIconsProps = {
  isGlobalCall?: boolean;
  nodeType: typeof NODE_TYPES.task | typeof NODE_TYPES.subProcess;
  bpmnElement: BpmnElementActivitytIcons;
} & (TaskNodeSvgWithoutMarkersProps | SubProcessNodeSvgWithoutIconsProps);
export function BpmnDiagramSvg({
  nodes,
  edges,
  font,
  definitions,
}: {
  nodes: RF.Node<BpmnDiagramNodeData, BpmnNodeType>[];
  edges: RF.Edge<BpmnDiagramEdgeData>[];
  font: React.CSSProperties;
  definitions: Normalized<BPMN20__tDefinitions>;
}) {
  const sortedNodesByParent = useMemo(
    () => sortNodesByParent(nodes.filter((node) => !node.hidden)),
    [nodes],
  );
  const nodesSvg = useMemo(() => {
    const nodesSvg = sortedNodesByParent.map((node) => {
      const { fontCssProperties: fontStyle } = getNodeStyle({
        bpmnFontStyle: getBpmnFontStyle({
          isEnabled: true,
        }),
      });
      const {
        height: _height,
        width: _width,
        strokeWidth: _strokeWidth,
        strokeDasharray: _strokeDasharray,
        borderRadius: _borderRadius,
        ...style
      } = node.style!;
      const label =
        node.data.bpmnElement.__$$element !== "group"
          ? node.data.bpmnElement.__$$element === "textAnnotation"
            ? (node.data.bpmnElement?.text?.__$$text ?? "")
            : node.data.bpmnElement.__$$element === "dataObject" ||
                node.data.bpmnElement.__$$element === "dataObjectReference" ||
                node.data.bpmnElement.__$$element === "dataStoreReference" ||
                node.data.bpmnElement.__$$element === "dataInput" ||
                node.data.bpmnElement.__$$element === "dataOutput"
              ? dataObjectLabel(definitions, node.id)
              : (node.data.bpmnElement["@_name"] ?? "")
          : (groupCategoryValue(definitions, node.id)?.["@_value"] ?? "");
      return (
        <g id={node.id} data-bpmn-element-id={node.id} key={node.id}>
          {node.type === NODE_TYPES.dataObject && (
            <DataObjectNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              showFoldedPage={true}
              ioKind={
                node.data.bpmnElement.__$$element === "dataInput" ||
                node.data.bpmnElement.__$$element === "dataOutput"
                  ? node.data.bpmnElement.__$$element
                  : undefined
              }
              isCollection={dataObjectIsCollection(definitions, node.id)}
              isStore={
                node.data.bpmnElement.__$$element === "dataStoreReference"
              }
              style={style}
            />
          )}
          {node.type === NODE_TYPES.task && (
            <TaskOrSubProcessNodeSvgWithIcons
              nodeType={NODE_TYPES.task}
              isGlobalCall={
                node.data.bpmnElement.__$$element === "callActivity" &&
                calledGlobalTaskKind(definitions, node.id) !== undefined
              }
              bpmnElement={node.data.bpmnElement as BpmnElementActivitytIcons}
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={
                node.data.bpmnElement.__$$element === "callActivity"
                  ? (globalTaskMarker(
                      calledGlobalTaskKind(definitions, node.id),
                    ) ?? "callActivity")
                  : getBpmnNodeVariant<typeof NODE_TYPES.task>(
                      NODE_TYPES.task,
                      node.data.bpmnElement,
                    )
              }
              strokeWidth={
                node.data.bpmnElement?.__$$element === "callActivity"
                  ? 5
                  : undefined
              }
              style={style}
            />
          )}
          {node.type === NODE_TYPES.group && (
            <GroupNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              strokeWidth={3}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.textAnnotation && (
            <TextAnnotationNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.startEvent && (
            <StartEventNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={eventNotation(definitions, node.id)}
              isInterrupting={eventInterruption(definitions, node.id).value}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.intermediateCatchEvent && (
            <IntermediateCatchEventNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={eventNotation(definitions, node.id)}
              isInterrupting={eventInterruption(definitions, node.id).value}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.intermediateThrowEvent && (
            <IntermediateThrowEventNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={eventNotation(definitions, node.id)}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.gateway && (
            <GatewayNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={getBpmnNodeVariant<typeof NODE_TYPES.gateway>(
                NODE_TYPES.gateway,
                node.data.bpmnElement,
              )}
              instantiate={
                node.data.bpmnElement.__$$element === "eventBasedGateway"
                  ? node.data.bpmnElement["@_instantiate"]
                  : undefined
              }
              eventGatewayType={
                node.data.bpmnElement.__$$element === "eventBasedGateway"
                  ? node.data.bpmnElement["@_eventGatewayType"]
                  : undefined
              }
              isMarkerVisible={node.data.shape["@_isMarkerVisible"]}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.endEvent && (
            <EndEventNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={eventNotation(definitions, node.id)}
              strokeWidth={6}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.subProcess && (
            <TaskOrSubProcessNodeSvgWithIcons
              nodeType={NODE_TYPES.subProcess}
              isExpanded={node.data.shape["@_isExpanded"] === true}
              eventTrigger={eventSubProcessTrigger(definitions, node.id)}
              bpmnElement={node.data.bpmnElement as BpmnElementActivitytIcons}
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              variant={getBpmnNodeVariant<typeof NODE_TYPES.subProcess>(
                NODE_TYPES.subProcess,
                node.data.bpmnElement,
              )}
              interactive={false}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.lane && (
            <LaneNodeSvg
              isHorizontal={node.data.shape["@_isHorizontal"]}
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              style={style}
            />
          )}
          {node.type === NODE_TYPES.unknown && (
            <UnknownNodeSvg
              width={node.width!}
              height={node.height!}
              x={node.position!.x}
              y={node.position!.y}
              style={style}
            />
          )}
          {label.trim() && (
            <BpmnSvgLabel
              text={label}
              font={{
                ...fontStyle,
                ...font,
                ...(node.data.bpmnElement.__$$element === "boundaryEvent" &&
                !node.data.shape["bpmndi:BPMNLabel"]?.["dc:Bounds"]
                  ? SVG_LABEL_GLYPH_MASK
                  : undefined),
              }}
              {...getNodeLabelSvgTextAlignmentProps(
                node,
                getNodeLabelPosition({
                  nodeType: node.type as BpmnNodeType,
                  isHorizontal: node.data.shape["@_isHorizontal"],
                  isExpanded: node.data.shape["@_isExpanded"] === true,
                  boundary:
                    node.data.bpmnElement.__$$element === "boundaryEvent" &&
                    node.data.parentXyFlowNode
                      ? {
                          event: node.data.shape["dc:Bounds"],
                          host: node.data.parentXyFlowNode.data.shape[
                            "dc:Bounds"
                          ],
                        }
                      : undefined,
                }),
              )}
            />
          )}
        </g>
      );
    });
    return nodesSvg;
  }, [definitions, font, sortedNodesByParent]);
  return (
    <>
      <EdgeMarkers />
      {edges
        .filter((edge) => !edge.hidden)
        .map((e) => {
          const { path } = getCanonicalMultiPointEdgePath({
            edge: e.data?.bpmnEdge,
            shapeSource: e.data?.bpmnShapeSource,
            shapeTarget: e.data?.bpmnShapeTarget,
          });
          return (
            <g key={e.id} id={e.id} data-bpmn-element-id={e.id}>
              {e.type === EDGE_TYPES.sequenceFlow && (
                <SequenceFlowPath
                  d={path}
                  flowKind={sequenceFlowNotation(definitions, e.id)}
                />
              )}
              {(e.type === EDGE_TYPES.association ||
                e.type === EDGE_TYPES.dataAssociation) && (
                <AssociationPath
                  d={path}
                  associationDirection={
                    e.data?.bpmnElement.__$$element === "association"
                      ? e.data.bpmnElement["@_associationDirection"]
                      : e.type === EDGE_TYPES.dataAssociation
                        ? "One"
                        : undefined
                  }
                />
              )}
            </g>
          );
        })}
      {nodesSvg}
      {/* Like the canvas label overlay, glyphs mask routed lines and paint last.
          A full DI-box background could erase a nearby source marker. */}
      {edges
        .filter((edge) => !edge.hidden)
        .map((edge) => {
          const label =
            edge.data?.bpmnElement.__$$element === "sequenceFlow"
              ? edge.data.bpmnElement["@_name"]
              : undefined;
          if (!label?.trim()) return null;
          const bounds = edgeLabelBounds(edge.data?.bpmnEdge);
          return (
            <g key={edge.id}>
              <BpmnSvgLabel
                text={label}
                width={bounds["@_width"]}
                textAnchor="middle"
                verticalAnchor="middle"
                transform={`translate(${bounds["@_x"] + bounds["@_width"] / 2},${bounds["@_y"] + bounds["@_height"] / 2})`}
                font={{
                  ...font,
                  ...SVG_LABEL_GLYPH_MASK,
                }}
              />
            </g>
          );
        })}
    </>
  );
}
const SVG_NODE_LABEL_TEXT_PADDING_ALL = 10;
const SVG_NODE_LABEL_TEXT_ADDITIONAL_PADDING_TOP_LEFT = 8;
export function getNodeLabelSvgTextAlignmentProps(
  n: RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
  labelPosition: NodeLabelPosition,
) {
  const authored = n.data.shape["bpmndi:BPMNLabel"]?.["dc:Bounds"];
  if (authored)
    return {
      verticalAnchor: "middle",
      textAnchor: "middle",
      width: authored["@_width"],
      transform: `translate(${authored["@_x"] + authored["@_width"] / 2},${authored["@_y"] + authored["@_height"] / 2})`,
    } as const;
  switch (labelPosition) {
    case "outside-top":
      return {
        verticalAnchor: "end",
        textAnchor: "middle",
        transform: `translate(${n.position.x + n.width! / 2},${n.position.y - 4})`,
        width: n.width!,
      } as const;
    case "outside-left":
      return {
        verticalAnchor: "middle",
        textAnchor: "end",
        transform: `translate(${n.position.x - 4},${n.position.y + n.height! / 2})`,
        width: n.width!,
      } as const;
    case "outside-right":
      return {
        verticalAnchor: "middle",
        textAnchor: "start",
        transform: `translate(${n.position.x + n.width! + 4},${n.position.y + n.height! / 2})`,
        width: n.width!,
      } as const;
    case "center-bottom": {
      const cbTx = n.position.x! + n.width! / 2;
      const cbTy = n.position.y! + n.height! + 4;
      const cbWidth = n.width!;
      return {
        verticalAnchor: "start",
        textAnchor: "middle",
        transform: `translate(${cbTx},${cbTy})`,
        width: cbWidth,
      } as const;
    }
    case "center-center": {
      const ccTx = n.position.x! + n.width! / 2;
      const ccTy = n.position.y! + n.height! / 2;
      const ccWidth = n.width! - 2 * SVG_NODE_LABEL_TEXT_PADDING_ALL;
      return {
        verticalAnchor: "middle",
        textAnchor: "middle",
        transform: `translate(${ccTx},${ccTy})`,
        width: ccWidth,
      } as const;
    }
    case "top-center": {
      const tcTx = n.position.x! + n.width! / 2;
      const tcTy = n.position.y! + SVG_NODE_LABEL_TEXT_PADDING_ALL;
      const tcWidth = n.width! - 2 * SVG_NODE_LABEL_TEXT_PADDING_ALL;
      return {
        verticalAnchor: "start",
        textAnchor: "middle",
        transform: `translate(${tcTx},${tcTy})`,
        width: tcWidth,
      } as const;
    }
    case "center-left": {
      const clTx = n.position.x! + SVG_NODE_LABEL_TEXT_PADDING_ALL;
      const clTy = n.position.y! + n.height! / 2;
      const clWidth = n.width! - 2 * SVG_NODE_LABEL_TEXT_PADDING_ALL;
      return {
        verticalAnchor: "middle",
        textAnchor: "start",
        transform: `translate(${clTx},${clTy})`,
        width: clWidth,
      } as const;
    }
    case "center-left-vertical":
      return {
        verticalAnchor: "middle",
        textAnchor: "middle",
        transform: `translate(${n.position.x + SVG_NODE_LABEL_TEXT_PADDING_ALL},${n.position.y + n.height! / 2}) rotate(-90)`,
        width: n.height! - 2 * SVG_NODE_LABEL_TEXT_PADDING_ALL,
      } as const;
    case "top-left": {
      const tlTx =
        n.position.x! +
        SVG_NODE_LABEL_TEXT_PADDING_ALL +
        SVG_NODE_LABEL_TEXT_ADDITIONAL_PADDING_TOP_LEFT;
      const tlTy =
        n.position.y! +
        SVG_NODE_LABEL_TEXT_PADDING_ALL +
        SVG_NODE_LABEL_TEXT_ADDITIONAL_PADDING_TOP_LEFT;
      const tlWidth =
        n.width! -
        2 * SVG_NODE_LABEL_TEXT_PADDING_ALL -
        2 * SVG_NODE_LABEL_TEXT_ADDITIONAL_PADDING_TOP_LEFT;
      return {
        verticalAnchor: "start",
        textAnchor: "start",
        transform: `translate(${tlTx},${tlTy})`,
        width: tlWidth,
      } as const;
    }
    default:
      assertUnreachable(labelPosition);
  }
}
export function getBpmnNodeVariant<T extends keyof NodeElementMap>(
  nodeType: BpmnNodeType,
  bpmnElement: NodeElementMap[T],
): NodeVariantReturnMap[T] {
  switch (nodeType) {
    case NODE_TYPES.subProcess: {
      const subProcessVariant =
        "__$$element" in bpmnElement &&
        bpmnElement.__$$element === "transaction"
          ? "transaction"
          : (bpmnElement as Normalized<BPMN20__tSubProcess>)?.[
                "@_triggeredByEvent"
              ]
            ? "event"
            : (bpmnElement as any)?.loopCharacteristics?.__$$element ===
                "multiInstanceLoopCharacteristics"
              ? "multi-instance"
              : "other";
      return subProcessVariant as NodeVariantReturnMap[T];
    }
    case NODE_TYPES.gateway:
    case NODE_TYPES.task:
      return (bpmnElement as any)?.__$$element ?? "none";
    default:
      return "none" as NodeVariantReturnMap[T];
  }
}
export function TaskOrSubProcessNodeSvgWithIcons({
  nodeType,
  bpmnElement,
  isGlobalCall,
  ...props
}: TaskOrSubProcessNodeSvgWithIconsProps) {
  const icons = useActivityIcons(bpmnElement, isGlobalCall);
  return nodeType === NODE_TYPES.task ? (
    <TaskNodeSvg
      {...(props as TaskNodeSvgWithoutMarkersProps)}
      markers={icons}
    />
  ) : (
    <SubProcessNodeSvg
      {...(props as SubProcessNodeSvgWithoutIconsProps)}
      icons={icons}
    />
  );
}
export function sortNodesByParent(
  nodes: RF.Node<BpmnDiagramNodeData, BpmnNodeType>[],
): RF.Node<BpmnDiagramNodeData, BpmnNodeType>[] {
  const nodeMap = new Map<string, RF.Node<BpmnDiagramNodeData, BpmnNodeType>>();
  const visited = new Set<string>();
  const sorted: RF.Node<BpmnDiagramNodeData, BpmnNodeType>[] = [];

  // Step 1: Build a map for quick access
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Step 2: DFS to ensure parent before child
  const visit = (
    node: RF.Node<BpmnDiagramNodeData<BpmnNodeElement>, BpmnNodeType>,
  ) => {
    if (visited.has(node.id)) return;
    const parentId = node.data?.parentXyFlowNode?.id;
    if (parentId) {
      const parent = nodeMap.get(parentId);
      if (parent) visit(parent); // Visit parent first
    }
    visited.add(node.id);
    sorted.push(node);
  };

  // Step 3: Visit all nodes
  for (const node of nodes) {
    visit(node);
  }
  return sorted;
}
