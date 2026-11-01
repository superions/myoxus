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

import { I18n } from "@myoxus/i18n";
import { bpmnConstructState } from "../../source-profile";

import * as React from "react";
import {
  type ContainmentMap,
  ContainmentMode,
  type GraphStructure,
} from "../../xyflow/graph/graphStructure";
import {
  type BPMN20__tIntermediateCatchEvent,
  type BPMN20__tLane,
  type BPMN20__tProcess,
  type BPMN20__tDataAssociation,
  type BPMN20__tDataInput,
  type BPMN20__tDataOutput,
  type BPMNDI__BPMNEdge,
  type BPMNDI__BPMNShape,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  type XyFlowReactKieDiagramEdgeData,
  type XyFlowReactKieDiagramNodeData,
} from "../../xyflow/store/State";
import { type Normalized } from "../normalization/normalize";
import {
  DataObjectNode,
  EndEventNode,
  GatewayNode,
  GroupNode,
  IntermediateCatchEventNode,
  IntermediateThrowEventNode,
  LaneNode,
  StartEventNode,
  SubProcessNode,
  TaskNode,
  TextAnnotationNode,
  UnknownNode,
} from "./nodes/Nodes";
import {
  type ConnectionLineEdgeMapping,
  type ConnectionLineNodeMapping,
} from "../../xyflow/edges/ConnectionLine";
import {
  SequenceFlowPath,
  AssociationPath,
  DataAssociationPath,
} from "./edges/EdgeSvgs";
import {
  StartEventNodeSvg,
  IntermediateCatchEventNodeSvg,
  IntermediateThrowEventNodeSvg,
  EndEventNodeSvg,
  TaskNodeSvg,
  SubProcessNodeSvg,
  GatewayNodeSvg,
  TextAnnotationNodeSvg,
  LaneNodeSvg,
} from "./nodes/NodeSvgs";
import { SequenceFlowEdge, AssociationEdge } from "./edges/Edges";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import {
  type ElementExclusion,
  type ElementFilter,
} from "../../xml-parser/element-filter";
import {
  type OutgoingStuffNodePanelEdgeMapping,
  type OutgoingStuffNodePanelNodeMapping,
} from "../../xyflow/nodes/OutgoingStuffNodePanel";
import { CONTAINER_NODES_DESIRABLE_PADDING } from "../../xyflow/maths/DcMaths";
import { type NodeSizes } from "../../xyflow/nodes/NodeSizes";
import { type SnapGrid, snapPoint } from "../../xyflow/snapgrid/SnapGrid";
import {
  BOUNDARY_EVENT_CANCEL_ACTIVITY_DEFAULT_VALUE,
  START_EVENT_NODE_ON_EVENT_SUB_PROCESSES_IS_INTERRUPTING_DEFAULT_VALUE,
} from "../../schemas/bpmn-2_0/spec";
import "../i18n";
export const NODE_TYPES = {
  startEvent: "node_startEvent" as const,
  intermediateCatchEvent: "node_intermediateCatchEvent" as const,
  intermediateThrowEvent: "node_intermediateThrowEvent" as const,
  endEvent: "node_endEvent" as const,
  task: "node_task" as const,
  subProcess: "node_subProcess" as const,
  gateway: "node_gateway" as const,
  dataObject: "node_dataObject" as const,
  textAnnotation: "node_textAnnotation" as const,
  unknown: "node_unknown" as const,
  group: "node_group" as const,
  lane: "node_lane" as const,
  // custom: "node_custom" as const,
};
export const EDGE_TYPES = {
  sequenceFlow: "edge_sequenceFlow" as const,
  association: "edge_association" as const,
  dataAssociation: "edge_dataAssociation" as const,
};
export type Values<T> = T[keyof T];
export type BpmnNodeType = Values<typeof NODE_TYPES>;
export type BpmnEdgeType = Values<typeof EDGE_TYPES>;
export enum ActivityNodeMarker {
  Collapsed = "Collapsed",
  MultiInstanceParallel = "MultiInstanceParallel",
  MultiInstanceSequential = "MultiInstanceSequential",
  Loop = "Loop",
  Compensation = "Compensation",
  AdHocSubProcess = "AdHocSubProcess",
}
export const BPMN_GRAPH_STRUCTURE: GraphStructure<BpmnNodeType, BpmnEdgeType> =
  new Map([
    [
      NODE_TYPES.startEvent,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.gateway,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.task,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.gateway,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.subProcess,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.gateway,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.intermediateCatchEvent,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.gateway,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.intermediateThrowEvent,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.gateway,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.gateway,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.sequenceFlow,
          new Set([
            NODE_TYPES.task,
            NODE_TYPES.subProcess,
            NODE_TYPES.gateway,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.endEvent,
          ]),
        ],
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.endEvent,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.dataObject,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.group,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.lane,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [EDGE_TYPES.association, new Set([NODE_TYPES.textAnnotation])],
      ]),
    ],
    [
      NODE_TYPES.textAnnotation,
      new Map<BpmnEdgeType, Set<BpmnNodeType>>([
        [
          EDGE_TYPES.association,
          new Set([
            NODE_TYPES.startEvent,
            NODE_TYPES.task,
            NODE_TYPES.intermediateCatchEvent,
            NODE_TYPES.intermediateThrowEvent,
            NODE_TYPES.gateway,
            NODE_TYPES.endEvent,
            NODE_TYPES.dataObject,
            NODE_TYPES.lane,
          ]),
        ],
      ]),
    ],
  ]);
// Ordinary associations annotate graphical base elements; they are not
// sequence-flow or implicit I/O substitutes. Semantic scope and QName checks
// remain authoritative in addEdge/source admission, not in this type graph.
for (const outgoing of BPMN_GRAPH_STRUCTURE.values())
  outgoing.set(
    EDGE_TYPES.association,
    new Set(
      Object.values(NODE_TYPES).filter((type) => type !== NODE_TYPES.unknown),
    ),
  );
for (const type of [
  NODE_TYPES.task,
  NODE_TYPES.subProcess,
  NODE_TYPES.startEvent,
  NODE_TYPES.intermediateCatchEvent,
])
  BPMN_GRAPH_STRUCTURE.get(type)?.set(
    EDGE_TYPES.dataAssociation,
    new Set([
      NODE_TYPES.dataObject,
      NODE_TYPES.task,
      NODE_TYPES.subProcess,
      NODE_TYPES.endEvent,
      NODE_TYPES.intermediateThrowEvent,
    ]),
  );
BPMN_GRAPH_STRUCTURE.get(NODE_TYPES.dataObject)?.set(
  EDGE_TYPES.dataAssociation,
  new Set([
    NODE_TYPES.task,
    NODE_TYPES.subProcess,
    NODE_TYPES.endEvent,
    NODE_TYPES.intermediateThrowEvent,
  ]),
);
export const BPMN_CONTAINMENT_MAP: ContainmentMap<BpmnNodeType> = new Map<
  BpmnNodeType,
  Map<ContainmentMode, Set<BpmnNodeType>>
>([
  [
    NODE_TYPES.lane,
    new Map([
      [
        ContainmentMode.INSIDE,
        new Set([
          NODE_TYPES.lane,
          NODE_TYPES.startEvent,
          NODE_TYPES.task,
          NODE_TYPES.intermediateCatchEvent,
          NODE_TYPES.intermediateThrowEvent,
          NODE_TYPES.gateway,
          NODE_TYPES.subProcess,
          NODE_TYPES.endEvent,
          NODE_TYPES.dataObject,
          NODE_TYPES.textAnnotation,
          NODE_TYPES.group,
        ]),
      ],
    ]),
  ],
  [
    NODE_TYPES.subProcess,
    new Map([
      [
        ContainmentMode.INSIDE,
        new Set([
          NODE_TYPES.subProcess,
          NODE_TYPES.lane,
          NODE_TYPES.dataObject,
          NODE_TYPES.startEvent,
          NODE_TYPES.task,
          NODE_TYPES.intermediateCatchEvent,
          NODE_TYPES.intermediateThrowEvent,
          NODE_TYPES.gateway,
          NODE_TYPES.endEvent,
          NODE_TYPES.textAnnotation,
          NODE_TYPES.group,
        ]),
      ],
      [ContainmentMode.BORDER, new Set([NODE_TYPES.intermediateCatchEvent])],
    ]),
  ],
  [
    NODE_TYPES.task,
    new Map([
      [ContainmentMode.BORDER, new Set([NODE_TYPES.intermediateCatchEvent])],
    ]),
  ],
]);
export const CONNECTION_LINE_EDGE_COMPONENTS_MAPPING: ConnectionLineEdgeMapping<BpmnEdgeType> =
  {
    [EDGE_TYPES.sequenceFlow]: SequenceFlowPath,
    [EDGE_TYPES.association]: AssociationPath,
    [EDGE_TYPES.dataAssociation]: DataAssociationPath,
  };
export const CONNECTION_LINE_NODE_COMPONENT_MAPPING: ConnectionLineNodeMapping<BpmnNodeType> =
  {
    [NODE_TYPES.startEvent]: (props) => (
      <StartEventNodeSvg {...props} variant="none" isInterrupting />
    ),
    [NODE_TYPES.intermediateCatchEvent]: (props) => (
      <IntermediateCatchEventNodeSvg
        isInterrupting={true}
        variant={"timerEventDefinition"}
        {...props}
      />
    ),
    [NODE_TYPES.intermediateThrowEvent]: (props) => (
      <IntermediateThrowEventNodeSvg
        variant={"signalEventDefinition"}
        {...props}
      />
    ),
    [NODE_TYPES.endEvent]: (props) => (
      <EndEventNodeSvg {...props} variant="none" />
    ),
    [NODE_TYPES.task]: TaskNodeSvg,
    [NODE_TYPES.subProcess]: SubProcessNodeSvg,
    [NODE_TYPES.gateway]: (props) => (
      <GatewayNodeSvg variant={"exclusiveGateway"} {...props} />
    ),
    [NODE_TYPES.textAnnotation]: TextAnnotationNodeSvg,
    [NODE_TYPES.lane]: LaneNodeSvg,
    // Ignore
    node_dataObject: undefined as any,
    node_unknown: undefined as any,
    node_group: undefined as any,
  };

// FIXME: Tiago: Properly type React component
export const XY_FLOW_NODE_TYPES: Record<
  BpmnNodeType,
  React.ComponentType<any>
> = {
  [NODE_TYPES.startEvent]: StartEventNode,
  [NODE_TYPES.intermediateCatchEvent]: IntermediateCatchEventNode,
  [NODE_TYPES.intermediateThrowEvent]: IntermediateThrowEventNode,
  [NODE_TYPES.endEvent]: EndEventNode,
  [NODE_TYPES.task]: TaskNode,
  [NODE_TYPES.subProcess]: SubProcessNode,
  [NODE_TYPES.gateway]: GatewayNode,
  [NODE_TYPES.group]: GroupNode,
  [NODE_TYPES.textAnnotation]: TextAnnotationNode,
  [NODE_TYPES.dataObject]: DataObjectNode,
  [NODE_TYPES.lane]: LaneNode,
  [NODE_TYPES.unknown]: UnknownNode,
};

// FIXME: Tiago: Properly type React component
export const XY_FLOW_EDGE_TYPES: Record<
  BpmnEdgeType,
  React.ComponentType<any>
> = {
  [EDGE_TYPES.sequenceFlow]: SequenceFlowEdge,
  [EDGE_TYPES.association]: AssociationEdge,
  [EDGE_TYPES.dataAssociation]: AssociationEdge,
};
export interface BpmnDiagramNodeData<
  T extends BpmnNodeElement = BpmnNodeElement,
> extends XyFlowReactKieDiagramNodeData<BpmnNodeType, BpmnDiagramNodeData> {
  bpmnElement: T;
  shape: Normalized<BPMNDI__BPMNShape>;
  shapeIndex: number;
}
export interface BpmnDiagramEdgeData extends XyFlowReactKieDiagramEdgeData {
  bpmnEdge: Normalized<BPMNDI__BPMNEdge> | undefined;
  bpmnEdgeIndex: number;
  bpmnElement: BpmnEdgeElement;
  bpmnShapeSource: Normalized<BPMNDI__BPMNShape> | undefined;
  bpmnSourceType: BpmnNodeType;
  bpmnShapeTarget: Normalized<BPMNDI__BPMNShape> | undefined;
  bpmnTargetType: BpmnNodeType;
}
const retainedOutgoingStructure = {
  [NODE_TYPES.startEvent]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.intermediateCatchEvent]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.endEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.intermediateThrowEvent]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.endEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.endEvent]: {
    nodes: [NODE_TYPES.textAnnotation],
    edges: [EDGE_TYPES.association],
  },
  [NODE_TYPES.task]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.endEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.subProcess]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.endEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.gateway]: {
    nodes: [
      NODE_TYPES.task,
      NODE_TYPES.gateway,
      NODE_TYPES.intermediateCatchEvent,
      NODE_TYPES.intermediateThrowEvent,
      NODE_TYPES.endEvent,
      NODE_TYPES.textAnnotation,
    ],
    edges: [EDGE_TYPES.sequenceFlow, EDGE_TYPES.association],
  },
  [NODE_TYPES.dataObject]: {
    nodes: [NODE_TYPES.textAnnotation],
    edges: [EDGE_TYPES.association],
  },
  [NODE_TYPES.group]: {
    nodes: [NODE_TYPES.textAnnotation],
    edges: [EDGE_TYPES.association],
  },
  [NODE_TYPES.lane]: {
    nodes: [NODE_TYPES.textAnnotation],
    edges: [EDGE_TYPES.association],
  },
  [NODE_TYPES.textAnnotation]: {
    nodes: [],
    edges: [EDGE_TYPES.association],
  },
};
export const bpmnEdgesOutgoingStuffNodePanelMapping: OutgoingStuffNodePanelEdgeMapping<BpmnEdgeType> =
  {
    [EDGE_TYPES.dataAssociation]: {
      get actionTitle() {
        return I18n["com.myoxus.editor.bpmn.data-association"]();
      },
      icon: ({ viewboxSize }) => (
        <DataAssociationPath
          d={`M2,${viewboxSize - 2} L${viewboxSize},0`}
          strokeWidth={2}
        />
      ),
    },
    [EDGE_TYPES.sequenceFlow]: {
      get actionTitle() {
        return I18n["com.myoxus.editor.bpmn.sequence-flow"]();
      },
      icon: ({ viewboxSize }) => (
        <SequenceFlowPath d={`M2,${viewboxSize - 2} L${viewboxSize - 2},0`} />
      ),
    },
    [EDGE_TYPES.association]: {
      get actionTitle() {
        return I18n["com.myoxus.editor.bpmn.association"]();
      },
      icon: ({ viewboxSize }) => (
        <AssociationPath
          d={`M2,${viewboxSize - 2} L${viewboxSize},0`}
          strokeWidth={2}
        />
      ),
    },
  };
export const bpmnNodesOutgoingStuffNodePanelMapping: OutgoingStuffNodePanelNodeMapping<
  Exclude<
    BpmnNodeType,
    | typeof NODE_TYPES.dataObject
    | typeof NODE_TYPES.unknown
    | typeof NODE_TYPES.group
    | typeof NODE_TYPES.lane
  >
> = {
  [NODE_TYPES.startEvent]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.shape.bpmn.start-event"]();
    },
    icon: (nodeSvgProps) => (
      <StartEventNodeSvg
        {...nodeSvgProps}
        variant={"none"}
        isInterrupting={
          START_EVENT_NODE_ON_EVENT_SUB_PROCESSES_IS_INTERRUPTING_DEFAULT_VALUE
        }
      />
    ),
  },
  [NODE_TYPES.intermediateCatchEvent]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.bpmn.catch-event"]();
    },
    icon: (nodeSvgProps) => (
      <IntermediateCatchEventNodeSvg
        {...nodeSvgProps}
        variant={"none"}
        isInterrupting={BOUNDARY_EVENT_CANCEL_ACTIVITY_DEFAULT_VALUE}
      />
    ),
  },
  [NODE_TYPES.intermediateThrowEvent]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.bpmn.throw-event"]();
    },
    icon: (nodeSvgProps) => (
      <IntermediateThrowEventNodeSvg {...nodeSvgProps} variant={"none"} />
    ),
  },
  [NODE_TYPES.endEvent]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.shape.bpmn.end-event"]();
    },
    icon: (nodeSvgProps) => (
      <EndEventNodeSvg {...nodeSvgProps} variant={"none"} />
    ),
  },
  [NODE_TYPES.task]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.shape.bpmn.task"]();
    },
    icon: (nodeSvgProps) => <TaskNodeSvg {...nodeSvgProps} />,
  },
  [NODE_TYPES.subProcess]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.shape.bpmn.sub-process"]();
    },
    icon: (nodeSvgProps) => (
      <SubProcessNodeSvg
        {...nodeSvgProps}
        isExpanded={false}
        interactive={false}
      />
    ),
  },
  [NODE_TYPES.gateway]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.bpmn.gateways"]();
    },
    icon: (nodeSvgProps) => (
      <GatewayNodeSvg
        {...nodeSvgProps}
        height={nodeSvgProps.width}
        variant={"none"}
        x={nodeSvgProps.x}
        y={nodeSvgProps.y - 8}
      />
    ),
  },
  [NODE_TYPES.textAnnotation]: {
    get actionTitle() {
      return I18n["com.myoxus.editor.shape.bpmn.annotation"]();
    },
    icon: (nodeSvgProps) => <TextAnnotationNodeSvg {...nodeSvgProps} />,
  },
};
export const MIN_NODE_SIZES: NodeSizes<BpmnNodeType> = {
  [NODE_TYPES.startEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.intermediateCatchEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.intermediateThrowEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.endEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.task]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.subProcess]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.gateway]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.dataObject]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(
      snapGrid,
      NODE_MIN_WIDTH / 2,
      NODE_MIN_HEIGHT - 20,
    );
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.group]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(
      snapGrid,
      NODE_MIN_WIDTH + CONTAINER_NODES_DESIRABLE_PADDING * 2,
      NODE_MIN_HEIGHT + CONTAINER_NODES_DESIRABLE_PADDING * 2,
    );
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.textAnnotation]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 200, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.lane]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.unknown]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
};
export const DEFAULT_NODE_SIZES: NodeSizes<BpmnNodeType> = {
  [NODE_TYPES.startEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.intermediateCatchEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.intermediateThrowEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.endEvent]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.task]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 180, 100);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.subProcess]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 500, 300);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.gateway]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 60, 60);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.dataObject]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(
      snapGrid,
      NODE_MIN_WIDTH / 2,
      NODE_MIN_HEIGHT - 20,
    );
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.group]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(
      snapGrid,
      NODE_MIN_WIDTH * 2,
      NODE_MIN_WIDTH * 2,
    ); // This is not a mistake, we want the Group node to be a bigger square.
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.textAnnotation]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 200, 200);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.lane]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid, 720, 420);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
  [NODE_TYPES.unknown]: ({ snapGrid }) => {
    const snappedMinSize = MIN_SIZE_FOR_NODES(snapGrid);
    return {
      "@_width": snappedMinSize.width,
      "@_height": snappedMinSize.height,
    };
  },
};
export const NODE_MIN_WIDTH = 120;
export const NODE_MIN_HEIGHT = 100;
export const MIN_SIZE_FOR_NODES = (
  grid: SnapGrid,
  width = NODE_MIN_WIDTH,
  height = NODE_MIN_HEIGHT,
) => {
  const snapped = snapPoint(
    grid,
    {
      "@_x": width,
      "@_y": height,
    },
    "ceil",
  );
  return {
    width: snapped["@_x"],
    height: snapped["@_y"],
  };
};

////

export type BpmnEdgeElement = Normalized<
  | ElementFilter<
      Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
      "sequenceFlow"
    >
  | ElementFilter<
      Unpacked<NonNullable<BPMN20__tProcess["artifact"]>>,
      "association"
    >
  | (BPMN20__tDataAssociation & {
      __$$element: "dataInputAssociation" | "dataOutputAssociation";
    })
>;
export type BpmnNodeElement = Normalized<
  | (BPMN20__tDataInput & { __$$element: "dataInput" })
  | (BPMN20__tDataOutput & { __$$element: "dataOutput" })
  | ElementExclusion<
      Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
      | "sequenceFlow"
      | "callChoreography"
      | "choreographyTask"
      | "implicitThrowEvent"
      | "subChoreography"
    >
  | ElementExclusion<
      Unpacked<NonNullable<BPMN20__tProcess["artifact"]>>,
      "association"
    >
  | (BPMN20__tLane & {
      __$$element: "lane";
    })
>;
export function getNodeTypeFromBpmnElement(bpmnElement: BpmnNodeElement) {
  return bpmnElement
    ? elementToNodeType[bpmnElement.__$$element]
    : NODE_TYPES.unknown;
}
export type GatewayVariant = ElementFilter<
  Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
  | "complexGateway"
  | "eventBasedGateway"
  | "exclusiveGateway"
  | "inclusiveGateway"
  | "parallelGateway"
>["__$$element"];
export type EventVariant =
  | ElementFilter<
      Unpacked<NonNullable<BPMN20__tIntermediateCatchEvent["eventDefinition"]>>,
      | "cancelEventDefinition"
      | "compensateEventDefinition"
      | "conditionalEventDefinition"
      | "errorEventDefinition"
      | "escalationEventDefinition"
      | "linkEventDefinition"
      | "messageEventDefinition"
      | "signalEventDefinition"
      | "terminateEventDefinition"
      | "timerEventDefinition"
    >["__$$element"]
  | "multiple"
  | "parallelMultiple";
export type TaskVariant = ElementFilter<
  Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
  | "businessRuleTask"
  | "scriptTask"
  | "serviceTask"
  | "userTask"
  | "manualTask"
  | "sendTask"
  | "receiveTask"
>["__$$element"];
export type SubProcessVariant =
  "transaction" | "event" | "multi-instance" | "other";
export const elementToNodeType: Record<
  NonNullable<BpmnNodeElement>["__$$element"],
  BpmnNodeType
> = {
  // lane
  lane: NODE_TYPES.lane,
  dataInput: NODE_TYPES.dataObject,
  dataOutput: NODE_TYPES.dataObject,
  // events
  startEvent: NODE_TYPES.startEvent,
  boundaryEvent: NODE_TYPES.intermediateCatchEvent,
  intermediateCatchEvent: NODE_TYPES.intermediateCatchEvent,
  intermediateThrowEvent: NODE_TYPES.intermediateThrowEvent,
  endEvent: NODE_TYPES.endEvent,
  // tasks
  callActivity: NODE_TYPES.task,
  task: NODE_TYPES.task,
  businessRuleTask: NODE_TYPES.task,
  userTask: NODE_TYPES.task,
  scriptTask: NODE_TYPES.task,
  serviceTask: NODE_TYPES.task,
  manualTask: NODE_TYPES.task,
  sendTask: NODE_TYPES.task,
  receiveTask: NODE_TYPES.task,
  // subprocess
  subProcess: NODE_TYPES.subProcess,
  adHocSubProcess: NODE_TYPES.subProcess,
  transaction: NODE_TYPES.subProcess,
  // gateway
  complexGateway: NODE_TYPES.gateway,
  eventBasedGateway: NODE_TYPES.gateway,
  exclusiveGateway: NODE_TYPES.gateway,
  inclusiveGateway: NODE_TYPES.gateway,
  parallelGateway: NODE_TYPES.gateway,
  // misc
  dataObject: NODE_TYPES.dataObject,
  // artifacts
  group: NODE_TYPES.group,
  textAnnotation: NODE_TYPES.textAnnotation,
  //
  // unknown
  //
  event: NODE_TYPES.unknown,
  // callChoreography: NODE_TYPES.unknown,
  // choreographyTask: NODE_TYPES.unknown,
  // implicitThrowEvent: NODE_TYPES.unknown,
  // subChoreography: NODE_TYPES.unknown,
  // edges (ignore)
  dataObjectReference: NODE_TYPES.dataObject,
  dataStoreReference: NODE_TYPES.dataObject,
} as const;
export const elementToEdgeType: Record<
  NonNullable<BpmnEdgeElement>["__$$element"],
  BpmnEdgeType
> = {
  association: EDGE_TYPES.association,
  dataInputAssociation: EDGE_TYPES.dataAssociation,
  dataOutputAssociation: EDGE_TYPES.dataAssociation,
  sequenceFlow: EDGE_TYPES.sequenceFlow,
};

// Project retained connection choices from the same concrete source profile as
// palette/import. Keeping upstream choices is not a promise of working support.
export const BPMN_OUTGOING_STRUCTURE = Object.fromEntries(
  Object.entries(retainedOutgoingStructure).map(([kind, value]) => [
    kind,
    {
      nodes: value.nodes.filter((type) =>
        Object.entries(elementToNodeType).some(
          ([element, nodeType]) =>
            nodeType === type && bpmnConstructState(element) === "editable",
        ),
      ),
      edges: [
        ...value.edges,
        ...(BPMN_GRAPH_STRUCTURE.get(kind as BpmnNodeType)?.has(
          EDGE_TYPES.dataAssociation,
        )
          ? [EDGE_TYPES.dataAssociation]
          : []),
      ].filter((type) =>
        Object.entries(elementToEdgeType).some(
          ([element, edgeType]) =>
            edgeType === type && bpmnConstructState(element) === "editable",
        ),
      ),
    },
  ]),
) as typeof retainedOutgoingStructure;
