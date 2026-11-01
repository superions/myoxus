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

import { generateUuid } from "../../xyflow/uuid/uuid";
import { assertEventContext } from "./event";
import {
  assertConnectionScope,
  associationEndpoints,
} from "./connection-context";
import { type Normalized } from "../normalization/normalize";
import {
  type BPMN20__tAssociation,
  type BPMN20__tDefinitions,
  type BPMN20__tDocumentation,
  type BPMN20__tSequenceFlow,
  type BPMNDI__BPMNEdge,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  BPMN_GRAPH_STRUCTURE,
  type BpmnEdgeType,
  type BpmnNodeType,
  EDGE_TYPES,
} from "../diagram/BpmnDiagramDomain";
import { type DC__Bounds } from "../../xyflow/maths/model";
import { PositionalNodeHandleId } from "../../xyflow/nodes/PositionalNodeHandles";
import { AutoPositionedEdgeMarker } from "../../xyflow/edges/AutoPositionedEdgeMarker";
import { _checkIsValidConnection } from "../../xyflow/graph/isValidConnection";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import {
  getDiscreteAutoPositioningEdgeIdMarker,
  getPointForHandle,
} from "../../xyflow/maths/DcMaths";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import {
  visitFlowElementsAndArtifacts,
  type ElementVisitorArgs,
  visitProcessLanes,
} from "./element-visitor";
import {
  upsertDataAssociation,
  dataAssociationById,
  dataAssociationRouteById,
  dataAssociationBindingOptions,
  type DataAssociationBinding,
} from "./data-association";
import { dataAssociationEndpoints } from "./data-association-context";
import { getDiscretelyAutoPositionedEdgeParams } from "../../xyflow/maths/Maths";
import { findProcessIoItem } from "./process-io-context";

type EdgeRequest = Omit<Parameters<typeof addEdge>[0], "definitions">;

/** An uncommitted gesture, not an XML mutation. The caller may ask for payload
 * IDs and retry this exact request only while its original model is current. */
export class DataAssociationBindingRequired extends Error {
  constructor(
    readonly request: EdgeRequest,
    readonly options: ReturnType<typeof dataAssociationBindingOptions>,
  ) {
    super("BPMN_DATA_BINDING_REQUIRED");
  }
}
export function addEdge({
  definitions,
  __readonly_sourceNode,
  __readonly_targetNode,
  __readonly_edge,
  __readonly_keepWaypoints,
  __readonly_binding,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_sourceNode: {
    type: BpmnNodeType;
    href: string;
    bounds: DC__Bounds;
    shapeId: string | undefined;
  };
  __readonly_targetNode: {
    type: BpmnNodeType;
    href: string;
    bounds: DC__Bounds;
    shapeId: string | undefined;
  };
  __readonly_edge: {
    id?: string;
    associationDirection?: "None" | "One" | "Both";
    type: BpmnEdgeType;
    name: string | undefined;
    documentation: Normalized<BPMN20__tDocumentation[]> | undefined;
    targetHandle: PositionalNodeHandleId;
    sourceHandle: PositionalNodeHandleId;
    autoPositionedEdgeMarker: AutoPositionedEdgeMarker | undefined;
  };
  __readonly_keepWaypoints: boolean;
  __readonly_binding?: DataAssociationBinding;
}) {
  if (
    !_checkIsValidConnection(
      BPMN_GRAPH_STRUCTURE,
      __readonly_sourceNode,
      __readonly_targetNode,
      __readonly_edge.type,
    )
  ) {
    throw new Error(
      `BPMN MUTATION: Invalid structure: (${__readonly_sourceNode.type}) --${__readonly_edge.type}--> (${__readonly_targetNode.type}) `,
    );
  }
  const newEdgeId = __readonly_edge.id ?? generateUuid();
  const { process: rootProcess, plane } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  type EndpointLocation =
    | Pick<ElementVisitorArgs, "element" | "owner">
    | {
        element: {
          "@_id": string;
          __$$element: "lane" | "dataInput" | "dataOutput";
        };
        owner: ElementVisitorArgs["owner"];
      };
  let source: EndpointLocation | undefined;
  let target: EndpointLocation | undefined;
  for (const [id, assign] of [
    [
      __readonly_sourceNode.href,
      (location: EndpointLocation) => {
        source = location;
      },
    ],
    [
      __readonly_targetNode.href,
      (location: EndpointLocation) => {
        target = location;
      },
    ],
  ] as const) {
    const io = findProcessIoItem(rootProcess, id);
    if (io && __readonly_edge.type !== EDGE_TYPES.sequenceFlow)
      assign({
        owner: rootProcess,
        element: { "@_id": id, __$$element: io.kind },
      });
  }
  visitFlowElementsAndArtifacts(rootProcess, (location) => {
    if (location.element["@_id"] === __readonly_sourceNode.href)
      source = location;
    if (location.element["@_id"] === __readonly_targetNode.href)
      target = location;
  });
  if (__readonly_edge.type === EDGE_TYPES.association)
    visitProcessLanes(rootProcess, ({ lane, scope }) => {
      if (lane["@_id"] === __readonly_sourceNode.href)
        source = {
          element: { "@_id": lane["@_id"], __$$element: "lane" },
          owner: scope,
        };
      if (lane["@_id"] === __readonly_targetNode.href)
        target = {
          element: { "@_id": lane["@_id"], __$$element: "lane" },
          owner: scope,
        };
    });
  // A process/subprocess owns its sequence flows. Geometric overlap or a lane
  // does not authorize an edge crossing semantic scope boundaries.
  if (!source || !target || source.owner !== target.owner)
    throw new Error("BPMN_ACTIVITY_SCOPE");
  if (
    __readonly_edge.type === EDGE_TYPES.sequenceFlow &&
    [source.element, target.element].some(
      (element) =>
        ("@_isForCompensation" in element && element["@_isForCompensation"]) ||
        (element.__$$element === "subProcess" && element["@_triggeredByEvent"]),
    )
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  const process = source.owner;
  const reconnecting = [
    ...(process.flowElement ?? []),
    ...(process.artifact ?? []),
  ].find((element) => element["@_id"] === __readonly_edge.id);
  if (
    __readonly_edge.id &&
    __readonly_edge.type !== EDGE_TYPES.dataAssociation &&
    (!reconnecting ||
      (reconnecting.__$$element !== "sequenceFlow" &&
        reconnecting.__$$element !== "association"))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (__readonly_edge.type === EDGE_TYPES.sequenceFlow) {
    const prospective = {
      ...process,
      flowElement: [
        ...(process.flowElement ?? []).filter(
          (element) => element["@_id"] !== __readonly_edge.id,
        ),
        {
          ...(reconnecting?.__$$element === "sequenceFlow" ? reconnecting : {}),
          __$$element: "sequenceFlow" as const,
          "@_id": newEdgeId,
          "@_sourceRef": source.element["@_id"],
          "@_targetRef": target.element["@_id"],
        },
      ],
    };
    const oldSource =
      reconnecting?.__$$element === "sequenceFlow" &&
      reconnecting["@_sourceRef"] !== source.element["@_id"]
        ? process.flowElement?.find(
            (element) => element["@_id"] === reconnecting["@_sourceRef"],
          )
        : undefined;
    const checked =
      oldSource &&
      "@_default" in oldSource &&
      indexBpmnIds(definitions).resolveReference(
        oldSource,
        oldSource["@_default"],
      ) === newEdgeId
        ? {
            ...prospective,
            flowElement: prospective.flowElement.map((element) =>
              element["@_id"] === oldSource["@_id"]
                ? { ...element, "@_default": undefined }
                : element,
            ),
          }
        : prospective;
    assertConnectionScope(definitions, checked, process);
    for (const event of [source.element, target.element])
      if (
        event.__$$element === "startEvent" ||
        event.__$$element === "endEvent" ||
        event.__$$element === "intermediateCatchEvent" ||
        event.__$$element === "intermediateThrowEvent" ||
        event.__$$element === "boundaryEvent"
      )
        assertEventContext(definitions, event, prospective);
  }
  const diagramElements = (plane["di:DiagramElement"] ??= []);
  let existingEdgeId: string | undefined = undefined;
  const existingDataRoute =
    __readonly_edge.type === EDGE_TYPES.dataAssociation && __readonly_edge.id
      ? dataAssociationRouteById(definitions, __readonly_edge.id)
      : undefined;
  let rehomeDataTarget = false;
  if (__readonly_edge.type === EDGE_TYPES.dataAssociation) {
    const options = dataAssociationBindingOptions(
      definitions,
      __readonly_sourceNode.href,
      __readonly_targetNode.href,
      __readonly_edge.id,
    );
    if (
      (options.source.length && !__readonly_binding?.source) ||
      (options.target.length && !__readonly_binding?.target)
    )
      throw new DataAssociationBindingRequired(
        structuredClone({
          // Reconnect computes nodes inside Immer. Detach their scalar endpoint
          // data before the failed transaction revokes its draft proxies.
          __readonly_sourceNode: {
            ...__readonly_sourceNode,
            bounds: { ...__readonly_sourceNode.bounds },
          },
          __readonly_targetNode: {
            ...__readonly_targetNode,
            bounds: { ...__readonly_targetNode.bounds },
          },
          __readonly_edge: { ...__readonly_edge, documentation: undefined },
          __readonly_keepWaypoints,
        }),
        options,
      );
    const before = __readonly_edge.id
      ? dataAssociationById(definitions, __readonly_edge.id)
      : undefined;
    rehomeDataTarget =
      !!before &&
      dataAssociationEndpoints(before).targetId !== __readonly_targetNode.href;
    if (
      __readonly_edge.id &&
      !dataAssociationById(definitions, __readonly_edge.id)
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    existingEdgeId = upsertDataAssociation(
      definitions,
      __readonly_sourceNode.href,
      __readonly_targetNode.href,
      __readonly_edge.id ?? newEdgeId,
      __readonly_binding,
    );
  }

  // Associations
  if (__readonly_edge.type === EDGE_TYPES.association) {
    if (source.element["@_id"] === target.element["@_id"])
      throw new Error("BPMN_INVALID_CONNECTION");
    process.artifact ??= [];
    const direction =
      __readonly_edge.associationDirection ??
      (reconnecting?.__$$element === "association"
        ? reconnecting["@_associationDirection"]
        : "None");
    const newAssociation: Normalized<BPMN20__tAssociation> = {
      "@_id": newEdgeId,
      ...(direction !== undefined
        ? { "@_associationDirection": direction }
        : {}),
      "@_sourceRef": __readonly_sourceNode.href,
      "@_targetRef": __readonly_targetNode.href,
    };
    const references = indexBpmnIds(definitions);
    const equivalent = (association: Normalized<BPMN20__tAssociation>) => {
      const a = references.resolveReference(
          association,
          association["@_sourceRef"],
        ),
        b = references.resolveReference(
          association,
          association["@_targetRef"],
        );
      return (
        (a === __readonly_sourceNode.href &&
          b === __readonly_targetNode.href) ||
        (newAssociation["@_associationDirection"] !== "One" &&
          association["@_associationDirection"] !== "One" &&
          a === __readonly_targetNode.href &&
          b === __readonly_sourceNode.href)
      );
    };

    // Reuse the same association, never an unrelated artifact at index -1.
    const existingIndex = process.artifact.findIndex(
      (a) =>
        a.__$$element === "association" &&
        (a["@_id"] === __readonly_edge.id ||
          (!__readonly_edge.id && equivalent(a))),
    );
    if (
      __readonly_edge.id &&
      process.artifact.some(
        (a) =>
          a.__$$element === "association" &&
          a["@_id"] !== __readonly_edge.id &&
          equivalent(a),
      )
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    const existingArtifact = process.artifact[existingIndex];
    const removed =
      existingArtifact?.__$$element === "association"
        ? existingArtifact
        : undefined;
    existingEdgeId = removed?.["@_id"];

    // Replace with the new one.
    const next = {
      ...removed,
      __$$element: "association" as const,
      ...newAssociation,
      "@_id": tryKeepingEdgeId(existingEdgeId, newEdgeId),
    };
    if (existingIndex >= 0) process.artifact[existingIndex] = next;
    else process.artifact.push(next);
    const current = indexBpmnIds(definitions);
    next["@_sourceRef"] = current.referenceFor(
      next,
      __readonly_sourceNode.href,
      removed?.["@_sourceRef"],
    )!;
    next["@_targetRef"] = current.referenceFor(
      next,
      __readonly_targetNode.href,
      removed?.["@_targetRef"],
    )!;
    associationEndpoints(definitions, process, next);
  }

  // Sequence Flows
  else if (__readonly_edge.type === EDGE_TYPES.sequenceFlow) {
    process.flowElement ??= [];
    const newSequenceFlow: Normalized<BPMN20__tSequenceFlow> = {
      "@_id": newEdgeId,
      "@_sourceRef": __readonly_sourceNode.href,
      "@_targetRef": __readonly_targetNode.href,
      ...(__readonly_edge.name !== undefined
        ? { "@_name": __readonly_edge.name }
        : {}),
      ...(__readonly_edge.documentation !== undefined
        ? { documentation: __readonly_edge.documentation }
        : {}),
    };

    // Directed endpoint order is identity: the reverse sequence flow is distinct.
    const existingIndex = process.flowElement.findIndex(
      (a) =>
        a.__$$element === "sequenceFlow" &&
        (a["@_id"] === __readonly_edge.id ||
          (!__readonly_edge.id && areEdgesEquivalent(a, newSequenceFlow))),
    );
    if (
      __readonly_edge.id &&
      process.flowElement.some(
        (a) =>
          a.__$$element === "sequenceFlow" &&
          a["@_id"] !== __readonly_edge.id &&
          areEdgesEquivalent(a, newSequenceFlow),
      )
    )
      throw new Error("BPMN_INVALID_CONNECTION");
    const removed = process.flowElement[existingIndex];
    existingEdgeId = removed?.["@_id"];

    // Replace with the new one.
    const next = {
      ...removed,
      __$$element: "sequenceFlow",
      ...newSequenceFlow,
      "@_id": tryKeepingEdgeId(existingEdgeId, newEdgeId),
    } as const;
    if (existingIndex >= 0) process.flowElement[existingIndex] = next;
    else process.flowElement.push(next);
    const references = indexBpmnIds(definitions);
    const flowId = existingEdgeId ?? newEdgeId;
    if (reconnecting?.__$$element === "sequenceFlow")
      for (const element of process.flowElement) {
        if (
          element["@_id"] === reconnecting["@_sourceRef"] &&
          element["@_id"] !== newSequenceFlow["@_sourceRef"]
        ) {
          if ("outgoing" in element) {
            element.outgoing = element.outgoing?.filter(
              (ref) =>
                references.resolveReference(ref, ref.__$$text) !== flowId,
            );
            if (!element.outgoing?.length) delete element.outgoing;
          }
          if (
            "@_default" in element &&
            references.resolveReference(element, element["@_default"]) ===
              flowId
          )
            delete element["@_default"];
        }
        if (
          element["@_id"] === reconnecting["@_targetRef"] &&
          element["@_id"] !== newSequenceFlow["@_targetRef"] &&
          "incoming" in element
        ) {
          element.incoming = element.incoming?.filter(
            (ref) => references.resolveReference(ref, ref.__$$text) !== flowId,
          );
          if (!element.incoming?.length) delete element.incoming;
        }
      }

    // <incoming> and <outgoing> elements of Flow Elements
    visitFlowElementsAndArtifacts(process, ({ element }) => {
      if (
        element.__$$element !== "association" &&
        element.__$$element !== "group" &&
        element.__$$element !== "textAnnotation" &&
        element.__$$element !== "sequenceFlow" &&
        element.__$$element !== "dataStoreReference" &&
        element.__$$element !== "dataObject" &&
        element.__$$element !== "dataObjectReference"
      ) {
        // outgoing
        if (element["@_id"] === newSequenceFlow["@_sourceRef"]) {
          element.outgoing ??= [];
          if (
            !element.outgoing.some(
              (ref) =>
                references.resolveReference(ref, ref.__$$text) === flowId,
            )
          )
            element.outgoing.push({
              __$$text: references.referenceFor(element, flowId)!,
            });
        }

        // incoming
        if (element["@_id"] === newSequenceFlow["@_targetRef"]) {
          element.incoming ??= [];
          if (
            !element.incoming.some(
              (ref) =>
                references.resolveReference(ref, ref.__$$text) === flowId,
            )
          )
            element.incoming.push({
              __$$text: references.referenceFor(element, flowId)!,
            });
        }
      }
      return true;
    });
  }

  // Remove existing
  const references = indexBpmnIds(definitions);
  const existingDiagramIndex = existingDataRoute
    ? diagramElements.indexOf(existingDataRoute)
    : diagramElements.findIndex(
        (e) =>
          e.__$$element === "bpmndi:BPMNEdge" &&
          existingEdgeId !== undefined &&
          (e["@_id"] === __readonly_edge.id ||
            (references.resolveReference(e, e["@_bpmnElement"]) ===
              existingEdgeId &&
              (!__readonly_edge.id || __readonly_edge.id === existingEdgeId))),
      );
  const removedBpmnEdge = diagramElements[existingDiagramIndex] as
    Normalized<BPMNDI__BPMNEdge> | undefined;
  const asBounds = (bounds: DC__Bounds) => ({
    x: bounds["@_x"],
    y: bounds["@_y"],
    width: bounds["@_width"],
    height: bounds["@_height"],
  });
  const anchors = getDiscretelyAutoPositionedEdgeParams(
    asBounds(__readonly_sourceNode.bounds),
    asBounds(__readonly_targetNode.bounds),
    undefined,
  );
  // Context controls start a connection at Center, but authored manual DI must
  // terminate on the outline. Resolve that creation convenience once; never
  // re-anchor an imported/reconnected manual route during rendering.
  const sourcePoint =
    !__readonly_edge.id &&
    __readonly_edge.autoPositionedEdgeMarker === undefined &&
    __readonly_edge.sourceHandle === PositionalNodeHandleId.Center
      ? { "@_x": anchors.sx, "@_y": anchors.sy }
      : getPointForHandle({
          bounds: __readonly_sourceNode.bounds,
          handle: __readonly_edge.sourceHandle,
        });
  const targetPoint =
    !__readonly_edge.id &&
    __readonly_edge.autoPositionedEdgeMarker === undefined &&
    __readonly_edge.targetHandle === PositionalNodeHandleId.Center
      ? { "@_x": anchors.tx, "@_y": anchors.ty }
      : getPointForHandle({
          bounds: __readonly_targetNode.bounds,
          handle: __readonly_edge.targetHandle,
        });
  // A multi-source mapping has one semantic target and several retained DI
  // branches. Moving its host rehomes every branch, not only the dragged one.
  if (rehomeDataTarget && existingEdgeId)
    for (const route of diagramElements) {
      if (
        route.__$$element !== "bpmndi:BPMNEdge" ||
        route === removedBpmnEdge ||
        references.resolveReference(route, route["@_bpmnElement"]) !==
          existingEdgeId
      )
        continue;
      route["@_targetElement"] = __readonly_targetNode.shapeId
        ? references.referenceFor(
            route,
            __readonly_targetNode.shapeId,
            route["@_targetElement"],
          )
        : undefined;
      if (route["di:waypoint"]?.length)
        route["di:waypoint"][route["di:waypoint"].length - 1] =
          getPointForHandle({
            bounds: __readonly_targetNode.bounds,
            handle: __readonly_edge.targetHandle,
          });
    }
  const newWaypoints =
    __readonly_keepWaypoints && !__readonly_edge.id && removedBpmnEdge
      ? removedBpmnEdge["di:waypoint"]
      : __readonly_keepWaypoints
        ? [
            getPointForHandle({
              bounds: __readonly_sourceNode.bounds,
              handle: __readonly_edge.sourceHandle,
            }),
            ...(removedBpmnEdge?.["di:waypoint"] ?? []).slice(1, -1),
            // Slicing an empty array will always return an empty array, so it's ok.
            getPointForHandle({
              bounds: __readonly_targetNode.bounds,
              handle: __readonly_edge.targetHandle,
            }),
          ]
        : [sourcePoint, targetPoint];
  const newBpmnEdge: Unpacked<typeof diagramElements> = {
    ...removedBpmnEdge,
    __$$element: "bpmndi:BPMNEdge",
    "@_id":
      withoutDiscreteAutoPosinitioningMarker(
        removedBpmnEdge?.["@_id"] ?? generateUuid(),
      ) + (__readonly_edge.autoPositionedEdgeMarker ?? ""),
    "@_bpmnElement": existingEdgeId ?? newEdgeId,
    "@_sourceElement": __readonly_sourceNode.shapeId,
    "@_targetElement": __readonly_targetNode.shapeId,
    "di:waypoint": newWaypoints,
  };

  // Replace with the new one.
  if (existingDiagramIndex >= 0)
    diagramElements[existingDiagramIndex] = newBpmnEdge;
  else diagramElements.push(newBpmnEdge);
  const finalReferences = indexBpmnIds(definitions);
  // New references borrow this edge's real scope, including a foreign default
  // left intact by a target-namespace edit. Shape identities remain IDs.
  newBpmnEdge["@_bpmnElement"] = finalReferences.referenceFor(
    newBpmnEdge,
    existingEdgeId ?? newEdgeId,
    removedBpmnEdge?.["@_bpmnElement"],
  )!;
  if (__readonly_sourceNode.shapeId)
    newBpmnEdge["@_sourceElement"] = finalReferences.referenceFor(
      newBpmnEdge,
      __readonly_sourceNode.shapeId,
      removedBpmnEdge?.["@_sourceElement"],
    );
  if (__readonly_targetNode.shapeId)
    newBpmnEdge["@_targetElement"] = finalReferences.referenceFor(
      newBpmnEdge,
      __readonly_targetNode.shapeId,
      removedBpmnEdge?.["@_targetElement"],
    );
  return {
    newBpmnEdge,
  };
}
function areEdgesEquivalent(
  a: Normalized<BPMN20__tAssociation | BPMN20__tSequenceFlow>,
  b: Normalized<BPMN20__tAssociation | BPMN20__tSequenceFlow>,
  undirected = false,
) {
  return (
    (a["@_sourceRef"] === b["@_sourceRef"] &&
      a["@_targetRef"] === b["@_targetRef"]) ||
    (undirected &&
      a["@_sourceRef"] === b["@_targetRef"] &&
      a["@_targetRef"] === b["@_sourceRef"])
  );
}
function tryKeepingEdgeId(
  existingEdgeId: string | undefined,
  newEdgeId: string,
) {
  return existingEdgeId ?? newEdgeId;
}
function withoutDiscreteAutoPosinitioningMarker(edgeId: string) {
  const marker = getDiscreteAutoPositioningEdgeIdMarker(edgeId);
  return marker ? edgeId.replace(`${marker}`, "") : edgeId;
}
