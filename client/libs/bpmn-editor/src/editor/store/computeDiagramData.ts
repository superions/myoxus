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
  type GraphStructureAdjacencyList,
  type GraphStructureEdge,
} from "../../xyflow/graph/graph";
import { type XyFlowDiagramData } from "../../xyflow/store/State";
import * as RF from "@xyflow/react";
import {
  BPMN_CONTAINMENT_MAP,
  type BpmnDiagramEdgeData,
  type BpmnDiagramNodeData,
  type BpmnEdgeElement,
  type BpmnNodeElement,
  type BpmnNodeType,
  elementToEdgeType,
  elementToNodeType,
  NODE_TYPES,
} from "../diagram/BpmnDiagramDomain";
import { type BpmnXyFlowDiagramState, type State } from "./Store";
import {
  NODE_LAYERS,
  SELECTED_EDGE_LAYER,
  SELECTED_EDGE_INTERACTION_WIDTH,
} from "../../xyflow/nodes/Hooks";
import { ContainmentMode } from "../../xyflow/graph/graphStructure";
import { addOrGetProcessAndDiagramElements } from "../mutations/addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import {
  scopeDataAssociations,
  dataAssociationRouteEndpoints,
  type DataAssociationLocation,
} from "../mutations/data-association-context";
import {
  visitLanes,
  visitFlowElementsAndArtifacts,
} from "../mutations/element-visitor";
import { BpmnSourceError } from "../../process-source";
import { processIoItems } from "../mutations/process-io-context";
export function computeDiagramData(
  definitions: State["bpmn"]["model"]["definitions"],
  xyFlowReactKieDiagram: BpmnXyFlowDiagramState["xyFlowReactKieDiagram"],
  _snapGrid: BpmnXyFlowDiagramState["xyFlowReactKieDiagram"]["snapGrid"],
  _dropTarget: State["xyFlowReactKieDiagram"]["dropTarget"],
  newNodeProjection: State["xyFlowReactKieDiagram"]["newNodeProjection"],
): XyFlowDiagramData<BpmnNodeType, BpmnDiagramNodeData, BpmnDiagramEdgeData> {
  const nodeBpmnElementsById = new Map<string, BpmnNodeElement>();
  const edgeBpmnElementsById = new Map<string, BpmnEdgeElement>();
  const parentIdsById = new Map<string, string>();
  const containerIdsById = new Map<string, string>();
  const { process, plane } = addOrGetProcessAndDiagramElements({ definitions });
  const references = indexBpmnIds(definitions);
  const dataRouteIds = new Set(
    (plane["di:DiagramElement"] ?? [])
      .filter((element) => element.__$$element === "bpmndi:BPMNEdge")
      .map((element) =>
        references.resolveReference(element, element["@_bpmnElement"]),
      ),
  );
  const dataEndpoints = new Map<string, DataAssociationLocation>();
  const shapedIds = new Set(
    (plane["di:DiagramElement"] ?? [])
      .filter((element) => element.__$$element === "bpmndi:BPMNShape")
      .map((element) =>
        references.resolveReference(element, element["@_bpmnElement"]),
      ),
  );
  const scopes = new Set<Parameters<typeof visitLanes>[0]>([process]);
  for (const { element, kind } of processIoItems(process))
    if (element["@_id"] && shapedIds.has(element["@_id"]))
      nodeBpmnElementsById.set(element["@_id"], {
        ...element,
        __$$element: kind,
      } as BpmnNodeElement);
  // Traverse actual ownership at every depth. Implicit throw events belong to
  // loop semantics, never this graphical flow-node/DI map.
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (element.__$$element === "implicitThrowEvent") return;
    if (
      element.__$$element === "dataObject" &&
      !shapedIds.has(element["@_id"])
    ) {
      if (
        !owner.flowElement?.some(
          (reference) =>
            reference.__$$element === "dataObjectReference" &&
            reference["@_dataObjectRef"]?.trim() === element["@_id"],
        )
      )
        throw new BpmnSourceError("BPMN_INCOMPLETE_DI", element["@_id"]);
      return;
    }
    if (owner !== process) {
      containerIdsById.set(element["@_id"], owner["@_id"]);
      parentIdsById.set(element["@_id"], owner["@_id"]);
    }
    if (
      element.__$$element === "sequenceFlow" ||
      element.__$$element === "association"
    ) {
      edgeBpmnElementsById.set(element["@_id"], element);
      return;
    }
    if (!(element.__$$element in elementToNodeType))
      throw new BpmnSourceError("BPMN_UNSUPPORTED_ELEMENT", element["@_id"]);
    nodeBpmnElementsById.set(element["@_id"], element as BpmnNodeElement);
    if (
      element.__$$element === "subProcess" ||
      element.__$$element === "adHocSubProcess" ||
      element.__$$element === "transaction"
    )
      scopes.add(element);
    if (element.__$$element === "boundaryEvent")
      parentIdsById.set(
        element["@_id"],
        references.resolveReference(element, element["@_attachedToRef"])!,
      );
  });
  // Lane DI remains absolute. Only display containment selects the deepest
  // member of an ancestor chain; loading never normalizes valid ancestor refs.
  for (const scope of scopes)
    visitLanes(scope, ({ lane, parentLane }) => {
      nodeBpmnElementsById.set(lane["@_id"], { ...lane, __$$element: "lane" });
      if (scope !== process) {
        containerIdsById.set(lane["@_id"], scope["@_id"]);
        parentIdsById.set(lane["@_id"], scope["@_id"]);
      }
      if (parentLane) parentIdsById.set(lane["@_id"], parentLane["@_id"]);
      for (const reference of lane.flowNodeRef ?? []) {
        // Lane.flowNodeRef is an IDREF, not a QName; its meaning is independent
        // of default XML namespaces used by the lane or its containing process.
        const member = reference.__$$text.trim();
        if (nodeBpmnElementsById.get(member)?.__$$element !== "boundaryEvent")
          parentIdsById.set(member, lane["@_id"]);
      }
    });
  for (const scope of scopes)
    for (const location of scopeDataAssociations(scope)) {
      const id = location.association["@_id"];
      if (!id || !dataRouteIds.has(id)) continue;
      dataEndpoints.set(id, location);
      edgeBpmnElementsById.set(id, {
        ...location.association,
        __$$element: location.kind,
      } as BpmnEdgeElement);
      if (scope !== process) containerIdsById.set(id, scope["@_id"]);
    }
  const collapsed = new Set<string>();
  for (const shape of plane["di:DiagramElement"] ?? []) {
    if (
      shape.__$$element !== "bpmndi:BPMNShape" ||
      shape["@_isExpanded"] === true
    )
      continue;
    const id = references.resolveReference(shape, shape["@_bpmnElement"]);
    const element = id && nodeBpmnElementsById.get(id);
    if (
      element &&
      (element.__$$element === "subProcess" ||
        element.__$$element === "adHocSubProcess" ||
        element.__$$element === "transaction")
    )
      collapsed.add(id!);
  }
  const hidden = (id: string) => {
    const seen = new Set<string>();
    for (
      let parent = containerIdsById.get(id);
      parent;
      parent = containerIdsById.get(parent)
    ) {
      if (seen.has(parent))
        throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
      seen.add(parent);
      if (collapsed.has(parent)) return true;
    }
    return false;
  };
  const { selectedNodes, draggingNodes, resizingNodes, selectedEdges } = {
    selectedNodes: new Set(xyFlowReactKieDiagram._selectedNodes),
    draggingNodes: new Set(xyFlowReactKieDiagram.draggingNodes),
    resizingNodes: new Set(xyFlowReactKieDiagram.resizingNodes),
    selectedEdges: new Set(xyFlowReactKieDiagram._selectedEdges),
  };
  const nodes: RF.Node<BpmnDiagramNodeData, BpmnNodeType>[] = (
    plane["di:DiagramElement"] ?? []
  ).flatMap((bpmnShape, i) => {
    if (bpmnShape?.__$$element !== "bpmndi:BPMNShape") {
      return [];
    }
    const bpmnElement = nodeBpmnElementsById.get(
      references.resolveReference(bpmnShape, bpmnShape["@_bpmnElement"])!,
    );
    if (!bpmnElement) {
      throw new BpmnSourceError("BPMN_INCOMPLETE_DI", bpmnShape["@_id"]);
    }
    const nodeType = elementToNodeType[bpmnElement.__$$element];
    if (!nodeType)
      throw new BpmnSourceError(
        "BPMN_UNSUPPORTED_ELEMENT",
        bpmnElement["@_id"],
      );
    const id = bpmnElement["@_id"];
    // Imported geometry is not a layout suggestion. Grid/minimum constraints
    // belong to explicit creation, move and resize commands, never reads.
    const shapeDimensions = {
      width: bpmnShape["dc:Bounds"]["@_width"],
      height: bpmnShape["dc:Bounds"]["@_height"],
    };
    const n: RF.Node<BpmnDiagramNodeData, BpmnNodeType> = {
      id,
      position: {
        x: bpmnShape["dc:Bounds"]["@_x"],
        y: bpmnShape["dc:Bounds"]["@_y"],
      },
      data: {
        bpmnElement,
        shape: bpmnShape,
        shapeIndex: i,
        parentXyFlowNode: undefined,
      },
      className:
        BPMN_CONTAINMENT_MAP.get(nodeType)?.has(ContainmentMode.INSIDE) ||
        nodeType === NODE_TYPES.group
          ? "xyflow-react-kie-diagram--containerNode--inside"
          : "",
      zIndex:
        nodeType === NODE_TYPES.lane
          ? NODE_LAYERS.GROUP_NODES
          : nodeType === NODE_TYPES.subProcess
            ? NODE_LAYERS.CONTAINER_NODES
            : bpmnElement.__$$element === "boundaryEvent"
              ? NODE_LAYERS.ATTACHED_NODES
              : NODE_LAYERS.NODES,
      selected: selectedNodes.has(id) && !hidden(id),
      resizing: resizingNodes.has(id),
      dragging: draggingNodes.has(id),
      width: shapeDimensions.width,
      height: shapeDimensions.height,
      type: nodeType,
      // Collapse changes projection only, retaining all semantic/DI objects and
      // absolute child geometry for expand/Undo. Attachment is not containment:
      // a boundary event outside its collapsed host stays visible.
      hidden: hidden(id),
      style: {
        ...shapeDimensions,
      },
    };
    return n;
  });
  // Source inspection rejects incomplete imports before mount. Keep this
  // invariant at projection too: a broken mutation must not show a smaller,
  // deceptively successful canvas by omitting the semantic object it lost.
  if (nodes.length !== nodeBpmnElementsById.size)
    throw new BpmnSourceError("BPMN_INCOMPLETE_DI");
  const nodesById = nodes.reduce(
    (acc, n) => acc.set(n.id, n),
    new Map<string, RF.Node<BpmnDiagramNodeData, BpmnNodeType>>(),
  );

  // Assign parents
  for (const node of nodes) {
    const parentId = parentIdsById.get(node.id);
    if (parentId) {
      node.data.parentXyFlowNode = nodesById.get(parentId);
    }
  }
  const selectedNodesById = xyFlowReactKieDiagram._selectedNodes.reduce(
    (acc, s) =>
      nodesById.has(s) && !nodesById.get(s)?.hidden
        ? acc.set(s, nodesById.get(s)!)
        : acc,
    new Map<string, RF.Node<BpmnDiagramNodeData, BpmnNodeType>>(),
  );
  const selectedNodeTypes = xyFlowReactKieDiagram._selectedNodes.reduce(
    (acc, s) => {
      if (nodesById.has(s) && !nodesById.get(s)?.hidden) {
        acc.add(nodesById.get(s)?.type as BpmnNodeType);
      }
      return acc;
    },
    new Set<BpmnNodeType>(),
  );
  const edges: RF.Edge<BpmnDiagramEdgeData>[] = (
    plane["di:DiagramElement"] ?? []
  ).flatMap((bpmnEdge, i) => {
    if (bpmnEdge?.__$$element !== "bpmndi:BPMNEdge") {
      return [];
    }
    const bpmnElement = edgeBpmnElementsById.get(
      references.resolveReference(bpmnEdge, bpmnEdge["@_bpmnElement"])!,
    );
    if (
      bpmnElement?.__$$element !== "sequenceFlow" &&
      bpmnElement?.__$$element !== "association" &&
      bpmnElement?.__$$element !== "dataInputAssociation" &&
      bpmnElement?.__$$element !== "dataOutputAssociation"
    ) {
      throw new BpmnSourceError("BPMN_INCOMPLETE_DI", bpmnEdge["@_id"]);
    }
    const dataEndpoint = dataEndpoints.has(bpmnElement["@_id"])
      ? dataAssociationRouteEndpoints(
          definitions,
          dataEndpoints.get(bpmnElement["@_id"])!,
          bpmnEdge,
        )
      : undefined;
    const sourceId =
      bpmnElement.__$$element === "association"
        ? references.resolveReference(bpmnElement, bpmnElement["@_sourceRef"])!
        : bpmnElement.__$$element === "sequenceFlow"
          ? bpmnElement["@_sourceRef"]
          : dataEndpoint!.sourceId;
    const targetId =
      bpmnElement.__$$element === "association"
        ? references.resolveReference(bpmnElement, bpmnElement["@_targetRef"])!
        : bpmnElement.__$$element === "sequenceFlow"
          ? bpmnElement["@_targetRef"]
          : dataEndpoint!.targetId;
    const shapeSource = nodesById.get(sourceId)?.data?.shape;
    const shapeTarget = nodesById.get(targetId)?.data?.shape;
    if (shapeSource === undefined || shapeTarget === undefined) {
      throw new BpmnSourceError("BPMN_INCOMPLETE_DI", bpmnEdge["@_id"]);
    }
    const id =
      dataEndpoint && dataEndpoint.sourceId !== dataEndpoint.sourceIds[0]
        ? bpmnEdge["@_id"]
        : bpmnElement["@_id"];
    const e: RF.Edge<BpmnDiagramEdgeData> = {
      id,
      // Native XYFlow elevation alone leaves edges below our retained node
      // bands. Lift the selected edge's real SVG controls, not a CSS z-index
      // on circles inside an already lower stacking context.
      zIndex: selectedEdges.has(id) ? SELECTED_EDGE_LAYER : undefined,
      interactionWidth: selectedEdges.has(id)
        ? SELECTED_EDGE_INTERACTION_WIDTH
        : undefined,
      source: sourceId,
      target: targetId,
      data: {
        "@_id": id,
        "di:waypoint": bpmnEdge["di:waypoint"],
        shapeSource,
        shapeTarget,
        edgeInfo: {
          id,
          sourceId,
          targetId,
        },
        //
        bpmnEdge: bpmnEdge,
        bpmnEdgeIndex: i,
        bpmnElement,
        bpmnShapeSource: shapeSource,
        bpmnSourceType: nodesById.get(sourceId)!.type!,
        bpmnShapeTarget: shapeTarget,
        bpmnTargetType: nodesById.get(targetId)!.type!,
      },
      selected:
        selectedEdges.has(id) &&
        !hidden(id) &&
        !hidden(sourceId) &&
        !hidden(targetId),
      hidden: hidden(id) || hidden(sourceId) || hidden(targetId),
      type: elementToEdgeType[bpmnElement.__$$element],
    };
    return e;
  });
  if (
    new Set(edges.map((edge) => edge.data!.bpmnElement["@_id"])).size !==
      edgeBpmnElementsById.size ||
    new Set(edges.map((edge) => edge.id)).size !== edges.length
  )
    throw new BpmnSourceError("BPMN_INCOMPLETE_DI");
  const graphStructureEdges: GraphStructureEdge[] = edges.map((s) => ({
    id: s.id,
    sourceId: s.source,
    targetId: s.target,
  }));
  const graphStructureAdjacencyList: GraphStructureAdjacencyList =
    graphStructureEdges.reduce(
      (acc, e) => {
        const targetAdjancyList = acc.get(e.targetId);
        if (!targetAdjancyList) {
          return acc.set(e.targetId, {
            dependencies: new Set([e.sourceId]),
          });
        } else {
          targetAdjancyList.dependencies.add(e.sourceId);
          return acc;
        }
      },
      new Map<
        string,
        {
          dependencies: Set<string>;
        }
      >(),
    );
  const edgesById = edges.reduce(
    (acc, e) => acc.set(e.id, e),
    new Map<string, RF.Edge<BpmnDiagramEdgeData>>(),
  );
  const selectedEdgesById = xyFlowReactKieDiagram._selectedEdges.reduce(
    (acc, s) =>
      edgesById.has(s) && !edgesById.get(s)?.hidden
        ? acc.set(s, edgesById.get(s)!)
        : acc,
    new Map<string, RF.Edge<BpmnDiagramEdgeData>>(),
  );
  const sortedNodes = [...nodes]
    .sort(
      (a, b) =>
        Number(b.type === NODE_TYPES.subProcess) -
        Number(a.type === NODE_TYPES.subProcess),
    )
    .sort(
      (a, b) =>
        Number(b.type === NODE_TYPES.lane) - Number(a.type === NODE_TYPES.lane),
    )
    .sort(
      (a, b) =>
        Number(b.type === NODE_TYPES.group) -
        Number(a.type === NODE_TYPES.group),
    );
  const finalNodes = newNodeProjection
    ? [...sortedNodes, newNodeProjection]
    : sortedNodes;
  return {
    graphStructureEdges,
    graphStructureAdjacencyList,
    nodes: finalNodes,
    edges,
    edgesById,
    nodesById,
    selectedNodeTypes,
    selectedNodesById,
    selectedEdgesById,
  };
}
