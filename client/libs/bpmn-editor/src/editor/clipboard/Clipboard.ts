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
  type BPMN20__tLane,
  type BPMN20__tProcess,
  type BPMN20__tInputOutputSpecification,
  type BPMN20__tDefinitions,
  type BPMNDI__BPMNEdge,
  type BPMNDI__BPMNShape,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import * as RF from "@xyflow/react";
import { type Normalized } from "../normalization/normalize";
import { type State } from "../store/Store";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import {
  type BpmnDiagramEdgeData,
  type BpmnDiagramNodeData,
  type BpmnNodeType,
} from "../diagram/BpmnDiagramDomain";
import { elementToNodeType } from "../diagram/BpmnDiagramDomain";
import { NodeNature, nodeNatures } from "../mutations/node-nature";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { addOrGetProcessAndDiagramElements } from "../mutations/addOrGetProcessAndDiagramElements";
import { findProcessIoItem } from "../mutations/process-io-context";
import { assertIoSets } from "../mutations/io-context";
import { retireExternalDataAssociationSlots } from "../mutations/data-association";
import {
  visitLanes,
  visitProcessLanes,
  visitFlowElementsAndArtifacts,
} from "../mutations/element-visitor";
export const BPMN_EDITOR_DIAGRAM_CLIPBOARD_MIME_TYPE =
  "application/json+kie-bpmn-editor--diagram" as const;
export type BpmnEditorDiagramClipboard = {
  mimeType: typeof BPMN_EDITOR_DIAGRAM_CLIPBOARD_MIME_TYPE;
  namespaceWhereClipboardWasCreatedFrom: string;
  namespaceDeclarations: Record<string, string>;
  processFlowElements: NonNullable<
    Unpacked<Normalized<BPMN20__tProcess>["flowElement"]>
  >[];
  artifacts: NonNullable<Unpacked<Normalized<BPMN20__tProcess>["artifact"]>>[];
  shapes: Normalized<BPMNDI__BPMNShape>[];
  edges: Normalized<BPMNDI__BPMNEdge>[];
  lanes: Normalized<BPMN20__tLane>[];
  processIo?: Normalized<BPMN20__tInputOutputSpecification>;
};
export function buildClipboardFromDiagram(
  xyFlowState: Pick<
    RF.ReactFlowState<
      RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
      RF.Edge<BpmnDiagramEdgeData>
    >,
    "nodes" | "edges"
  >,
  bpmnEditorState: State,
) {
  const copiedEdgesById = new Map<string, RF.Edge<BpmnDiagramEdgeData>>();
  const copiedNodesById = new Map<string, RF.Node<BpmnDiagramNodeData>>();
  const danglingEdgesById = new Map<string, RF.Edge<BpmnDiagramEdgeData>>();
  const { process } = addOrGetProcessAndDiagramElements({
    definitions: bpmnEditorState.bpmn.model.definitions,
  });
  const sourceReferences = indexBpmnIds(bpmnEditorState.bpmn.model.definitions);
  const sourceLanes = new Map<string, Normalized<BPMN20__tLane>>();
  const laneScopes = new Map<string, string>();
  visitProcessLanes(process, ({ lane, scope }) => {
    sourceLanes.set(lane["@_id"], lane);
    laneScopes.set(lane["@_id"], scope["@_id"]);
  });
  const nestedCopiedLanes = new Set<string>();
  // React Flow may virtualize/collapse children. A selected semantic container
  // still owns their complete XML and geometry, even when none is painted.
  const nodesById = bpmnEditorState
    .computed(bpmnEditorState)
    .getDiagramData()
    .nodes.reduce(
      (acc, n) => acc.set(n.id, n),
      new Map<string, RF.Node<BpmnDiagramNodeData>>(),
    );
  const selectedNodesById = xyFlowState.nodes.reduce(
    (acc, n) => (n.selected && !n.hidden ? acc.set(n.id, n) : acc),
    new Map<string, RF.Node<BpmnDiagramNodeData>>(),
  );
  const processFlowElements = new Map<
    string,
    NonNullable<Unpacked<Normalized<BPMN20__tProcess>["flowElement"]>>
  >();
  const shapes = new Map<string, Normalized<BPMNDI__BPMNShape>>();
  const subProcessNodes = new Map<string, Set<string>>();
  const clipboard = [
    ...selectedNodesById.values(),
  ].reduce<BpmnEditorDiagramClipboard>(
    (acc, _node: RF.Node<BpmnDiagramNodeData>) => {
      function accNode(node: RF.Node<BpmnDiagramNodeData>) {
        if (copiedNodesById.has(node.id)) return;
        copiedNodesById.set(node.id, node);
        const nodeNature = nodeNatures[node.type as BpmnNodeType];

        // Artifacts: Groups, Text Annotation, Unknown
        if (findProcessIoItem(process, node.id)) {
          // The tagged diagram view is not XML. Capture the real specification
          // below and prune only unselected interface members on a private copy.
        } else if (nodeNature === NodeNature.ARTIFACT) {
          acc.artifacts.unshift(node.data.bpmnElement as any);
        }
        // Container: Sub process
        else if (nodeNature === NodeNature.CONTAINER) {
          const bpmnSubProcess = node.data.bpmnElement as Normalized<
            Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>
          >;
          if (
            bpmnSubProcess.__$$element === "subProcess" ||
            bpmnSubProcess.__$$element === "adHocSubProcess" ||
            bpmnSubProcess.__$$element === "transaction"
          ) {
            for (const flowElement of [
              ...(bpmnSubProcess.flowElement ?? []),
              ...(bpmnSubProcess.artifact ?? []),
            ]) {
              subProcessNodes.set(
                bpmnSubProcess["@_id"],
                (subProcessNodes.get(bpmnSubProcess["@_id"]) ?? new Set()).add(
                  flowElement["@_id"],
                ),
              );
              const bpmnNode = nodesById.get(flowElement["@_id"]);
              if (!bpmnNode) {
                continue;
              }

              // Save nested Flow Elements id and shape
              subProcessNodes.set(
                bpmnSubProcess["@_id"],
                (subProcessNodes.get(bpmnSubProcess["@_id"]) ?? new Set()).add(
                  flowElement["@_id"],
                ),
              );
              const bpmnShape = bpmnNode.data.shape;
              shapes.set(bpmnShape["@_id"], bpmnShape);
              accNode(bpmnNode);
            }
            visitLanes(bpmnSubProcess, ({ lane }) => {
              const child = nodesById.get(lane["@_id"]);
              if (!child) throw new Error("BPMN_INCOMPLETE_DI");
              accNode(child);
            });
          }
          processFlowElements.set(bpmnSubProcess["@_id"], bpmnSubProcess);
        }
        // Lane
        else if (nodeNature === NodeNature.LANE) {
          // Projection adds a lane marker to a display copy. Scope capture and
          // subtree cloning must borrow the actual XML owner, not that wrapper.
          const lane = sourceLanes.get(node.id);
          if (!lane) throw new Error("BPMN_LANE_NOT_FOUND");
          const laneNode = nodesById.get(lane["@_id"]!);
          if (!laneNode) {
            return;
          }
          for (const flowNodeRef of lane.flowNodeRef ?? []) {
            const bpmnNode = nodesById.get(flowNodeRef.__$$text.trim());
            if (!bpmnNode) {
              continue;
            }
            accNode(bpmnNode);
          }
          for (const child of lane.childLaneSet?.lane ?? []) {
            const childNode = nodesById.get(child["@_id"]);
            if (!childNode) throw new Error("BPMN_INCOMPLETE_DI");
            nestedCopiedLanes.add(child["@_id"]);
            accNode(childNode);
          }
          acc.lanes.push(lane as any);
        }
        // Process Flow Element: Start Event, End Event, Itermediate Event, Task, Gateway, Data Object
        else if (nodeNature === NodeNature.PROCESS_FLOW_ELEMENT) {
          // Casting to `BPMN20__tProcess` because it has all requirement types.
          const bpmnProcessFlow = node.data.bpmnElement as Normalized<
            Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>
          >;
          if (bpmnProcessFlow.__$$element === "adHocSubProcess") {
            for (const flowElement of bpmnProcessFlow.flowElement ?? []) {
              const bpmnNode = nodesById.get(flowElement["@_id"]);
              if (!bpmnNode) {
                continue;
              }

              // Save nested Flow Elements id and shape
              subProcessNodes.set(
                bpmnProcessFlow["@_id"],
                (subProcessNodes.get(bpmnProcessFlow["@_id"]) ?? new Set()).add(
                  flowElement["@_id"],
                ),
              );
              const bpmnShape = bpmnNode.data.shape;
              shapes.set(bpmnShape["@_id"], bpmnShape);
              accNode(bpmnNode);
            }
          }
          processFlowElements.set(bpmnProcessFlow["@_id"], bpmnProcessFlow);
        } else if (nodeNature === NodeNature.UNKNOWN) {
          // Ignore.
        } else {
          throw new Error(`Unknwon node nature '${nodeNature}'`);
        }
        copiedNodesById.set(node.id, node);
        const bpmnShape = node.data.shape;
        shapes.set(bpmnShape["@_id"], bpmnShape);
        for (const boundary of nodesById.values()) {
          if (
            boundary.data.bpmnElement.__$$element === "boundaryEvent" &&
            sourceReferences.resolveReference(
              boundary.data.bpmnElement,
              boundary.data.bpmnElement["@_attachedToRef"],
            ) === node.id
          )
            accNode(boundary);
        }
      }
      if (!_node.selected) {
        return acc;
      }
      accNode(_node);
      return acc;
    },
    {
      mimeType: BPMN_EDITOR_DIAGRAM_CLIPBOARD_MIME_TYPE,
      namespaceWhereClipboardWasCreatedFrom:
        bpmnEditorState.bpmn.model.definitions["@_targetNamespace"],
      namespaceDeclarations: Object.fromEntries(
        Object.entries(bpmnEditorState.bpmn.model.definitions).filter(
          ([key, value]) =>
            (key === "@_xmlns" || key.startsWith("@_xmlns:")) &&
            typeof value === "string",
        ),
      ) as Record<string, string>,
      processFlowElements: [],
      artifacts: [],
      shapes: [],
      edges: [],
      lanes: [],
    },
  );
  clipboard.edges = bpmnEditorState
    .computed(bpmnEditorState)
    .getDiagramData()
    .edges.flatMap((edge: RF.Edge<BpmnDiagramEdgeData>) => {
      if (
        (copiedNodesById.has(edge.source) &&
          !copiedNodesById.has(edge.target)) ||
        (!copiedNodesById.has(edge.source) && copiedNodesById.has(edge.target))
      ) {
        danglingEdgesById.set(edge.id, edge); // Edges that point to nodes that are not part of the clipboard need to be removed when 'cut' is executed.
      }
      if (
        copiedNodesById.has(edge.source) &&
        copiedNodesById.has(edge.target)
      ) {
        if (
          (edge.data?.bpmnElement.__$$element === "dataInputAssociation" ||
            edge.data?.bpmnElement.__$$element === "dataOutputAssociation") &&
          bpmnEditorState
            .computed(bpmnEditorState)
            .getDiagramData()
            .edges.some(
              (other) =>
                other.data?.bpmnElement["@_id"] ===
                  edge.data!.bpmnElement["@_id"] &&
                (!copiedNodesById.has(other.source) ||
                  !copiedNodesById.has(other.target)),
            )
        )
          return [];
        if (!edge.data?.bpmnEdge) {
          return [];
        }
        copiedEdgesById.set(edge.id, edge);
        const bpmnEdge = edge.data!.bpmnEdge!;
        if (edge.data.bpmnElement.__$$element === "association")
          clipboard.artifacts.push(edge.data.bpmnElement);
        else if (edge.data.bpmnElement.__$$element === "sequenceFlow")
          processFlowElements.set(
            edge.data.bpmnElement["@_id"],
            edge.data.bpmnElement as Normalized<
              Extract<
                Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
                { __$$element: "sequenceFlow" }
              >
            >,
          );
        return bpmnEdge ?? [];
      } else {
        return [];
      }
    });

  // Filter Flow Elements that are part of Sub Processes
  // References carry one private backing declaration into the copied scope,
  // even when its source object has no shape (or its shape was not selected).
  // A copied container already owns that declaration; the root-pruning below
  // prevents double emission. The shared ID remapper binds every copied alias.
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (
      element.__$$element !== "dataObjectReference" ||
      !processFlowElements.has(element["@_id"]) ||
      !element["@_dataObjectRef"]
    )
      return;
    const target = owner.flowElement?.find(
      (child) =>
        child.__$$element === "dataObject" &&
        child["@_id"] === element["@_dataObjectRef"]!.trim(),
    );
    if (!target) throw new Error("BPMN_INVALID_CLIPBOARD");
    processFlowElements.set(target["@_id"], target);
  });
  subProcessNodes.forEach((flowElements) => {
    flowElements.forEach((flowElement) => {
      processFlowElements.delete(flowElement);
    });
  });
  const nestedElementIds = new Set(
    [...subProcessNodes.values()].flatMap((ids) => [...ids]),
  );
  clipboard.artifacts = clipboard.artifacts.filter(
    (element) => !nestedElementIds.has(element["@_id"]),
  );
  clipboard.processFlowElements = [...processFlowElements.values()];
  clipboard.shapes = [...shapes.values()];
  // A copied parent already owns its descendant declarations. Keep only roots
  // in the paste envelope while retaining every descendant shape and flow node.
  clipboard.lanes = clipboard.lanes.filter(
    (lane) =>
      !nestedCopiedLanes.has(lane["@_id"]) &&
      !copiedNodesById.has(laneScopes.get(lane["@_id"])!),
  );
  // Node selection does not own its outside sequence flows. Work on a private
  // fragment so pruning those references never changes the source document.
  const fragment: BpmnEditorDiagramClipboard = structuredClone(clipboard);
  const interfaceIds = new Set(
    [...copiedNodesById.keys()].filter(
      (id) => !!findProcessIoItem(process, id),
    ),
  );
  if (interfaceIds.size) {
    fragment.processIo = structuredClone(process.ioSpecification!);
    const spec = fragment.processIo;
    for (const key of ["dataInput", "dataOutput"] as const) {
      spec[key] = spec[key]?.filter((item) => interfaceIds.has(item["@_id"]));
      if (!spec[key]?.length) delete spec[key];
    }
    for (const set of [...spec.inputSet, ...spec.outputSet])
      for (const key of [
        "dataInputRefs",
        "optionalInputRefs",
        "whileExecutingInputRefs",
        "dataOutputRefs",
        "optionalOutputRefs",
        "whileExecutingOutputRefs",
      ] as const) {
        const refs = (set as Record<string, unknown>)[key] as
          { __$$text: string }[] | undefined;
        if (refs) {
          const retained = refs.filter((ref) =>
            interfaceIds.has(ref.__$$text.trim()),
          );
          if (retained.length) (set as Record<string, unknown>)[key] = retained;
          else delete (set as Record<string, unknown>)[key];
        }
      }
    Object.assign(
      spec,
      sourceReferences.namespaceDeclarationsFor(process.ioSpecification!),
    );
  }
  const references = indexBpmnIds(bpmnEditorState.bpmn.model.definitions);
  const graphicalEdgeIds = new Set(
    bpmnEditorState
      .computed(bpmnEditorState)
      .getDiagramData()
      .edges.map((edge) => edge.data!.bpmnElement["@_id"]),
  );
  const retiredPortIds = new Set<string>();
  const rememberPorts = (association: {
    sourceRef?: { __$$text: string }[];
    targetRef?: { __$$text: string };
  }) => {
    for (const id of [
      ...(association.sourceRef?.map((ref) => ref.__$$text.trim()) ?? []),
      association.targetRef?.__$$text.trim(),
    ])
      if (id) retiredPortIds.add(id);
  };
  for (const edge of danglingEdgesById.values())
    if (
      edge.data?.bpmnElement.__$$element === "dataInputAssociation" ||
      edge.data?.bpmnElement.__$$element === "dataOutputAssociation"
    )
      rememberPorts(edge.data.bpmnElement);
  const prune = (
    original: Record<string, any>,
    element: Record<string, any>,
  ) => {
    // The copied activity owns its non-graphical mappings, but selection does
    // not own routes to external unselected nodes. Keep those graphical
    // associations only when their complete endpoints and DI were copied.
    for (const kind of ["dataInputAssociation", "dataOutputAssociation"]) {
      if (Array.isArray(element[kind]))
        element[kind] = element[kind].filter(
          (association: Record<string, unknown>) => {
            const retained =
              !graphicalEdgeIds.has(association["@_id"] as string) ||
              copiedEdgesById.has(association["@_id"] as string);
            if (!retained) rememberPorts(association);
            return retained;
          },
        );
      if (Array.isArray(element[kind]) && !element[kind].length)
        delete element[kind];
    }
    // A copied source cannot retain a default pointing to an outside flow
    // which the fragment does not own. Internal defaults keep their QName and
    // are remapped together with the included flow at paste time.
    if (
      element["@_default"] &&
      !copiedEdgesById.has(
        references.resolveReference(original, original["@_default"])!,
      )
    )
      delete element["@_default"];
    for (const key of ["incoming", "outgoing"] as const) {
      if (Array.isArray(element[key])) {
        element[key] = element[key].filter(
          (_reference: unknown, index: number) =>
            copiedEdgesById.has(
              references.resolveReference(
                original[key][index],
                original[key][index].__$$text,
              )!,
            ),
        );
        if (!element[key].length) delete element[key];
      }
    }
    for (const key of ["flowElement", "artifact"] as const) {
      if (Array.isArray(element[key]))
        for (let index = 0; index < element[key].length; index++)
          prune(original[key][index], element[key][index]);
    }
  };
  for (const key of [
    "processFlowElements",
    "artifacts",
    "shapes",
    "edges",
    "lanes",
  ] as const) {
    for (let index = 0; index < fragment[key].length; index++) {
      const original = clipboard[key][index];
      const copy = fragment[key][index];
      Object.assign(copy, references.namespaceDeclarationsFor(original));
      if (key === "processFlowElements") prune(original, copy);
    }
  }
  if (retiredPortIds.size) {
    // Apply the ordinary slot-lifetime owner to the private fragment, not to
    // the source document. This temporary standard owner supplies scope/index
    // context only; it is never serialized, normalized or given fresh IDs.
    // Shared definition objects are borrowed read-only; only cloned flow roots
    // and their I/O arrays can be visited by the cleanup command.
    const definitions = bpmnEditorState.bpmn.model.definitions,
      diagram = definitions["bpmndi:BPMNDiagram"]![0],
      plane = diagram["bpmndi:BPMNPlane"]!;
    const privateDefinitions = {
      ...definitions,
      rootElement: [
        ...(definitions.rootElement ?? []).filter((root) => root !== process),
        {
          __$$element: "process",
          "@_id": process["@_id"],
          flowElement: fragment.processFlowElements,
          artifact: fragment.artifacts,
          ioSpecification: fragment.processIo,
          laneSet: fragment.lanes.length
            ? [{ lane: fragment.lanes }]
            : undefined,
        },
      ],
      "bpmndi:BPMNDiagram": [
        {
          ...diagram,
          "bpmndi:BPMNPlane": {
            ...plane,
            "di:DiagramElement": [
              ...fragment.shapes.map((shape) => ({
                ...shape,
                __$$element: "bpmndi:BPMNShape",
              })),
              ...fragment.edges.map((edge) => ({
                ...edge,
                __$$element: "bpmndi:BPMNEdge",
              })),
            ],
          },
        },
      ],
    } as Normalized<BPMN20__tDefinitions>;
    retireExternalDataAssociationSlots(privateDefinitions, [...retiredPortIds]);
  }
  return {
    clipboard: fragment,
    copiedEdgesById,
    copiedNodesById,
    danglingEdgesById,
  };
}
/** Clipboard JSON is untrusted; reject a malformed fragment before any mutation. */
export function getClipboard(
  text: string,
): BpmnEditorDiagramClipboard | undefined {
  let potentialClipboard: BpmnEditorDiagramClipboard;
  try {
    potentialClipboard = JSON.parse(text, (key, value) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        throw new Error("BPMN_INVALID_CLIPBOARD");
      return value;
    });
  } catch {
    return undefined;
  }
  if (
    !potentialClipboard ||
    potentialClipboard.mimeType !== BPMN_EDITOR_DIAGRAM_CLIPBOARD_MIME_TYPE ||
    typeof potentialClipboard.namespaceWhereClipboardWasCreatedFrom !== "string"
  ) {
    return undefined;
  }
  const arrays = [
    potentialClipboard.processFlowElements,
    potentialClipboard.artifacts,
    potentialClipboard.shapes,
    potentialClipboard.edges,
    potentialClipboard.lanes,
    ...(potentialClipboard.processIo
      ? [
          potentialClipboard.processIo.dataInput ?? [],
          potentialClipboard.processIo.dataOutput ?? [],
          potentialClipboard.processIo.inputSet,
          potentialClipboard.processIo.outputSet,
        ]
      : []),
  ];
  if (
    arrays.some(
      (array) =>
        !Array.isArray(array) ||
        array.some(
          (element) =>
            !element ||
            typeof element !== "object" ||
            typeof element["@_id"] !== "string",
        ),
    )
  )
    return undefined;
  if (
    !potentialClipboard.namespaceDeclarations ||
    Object.entries(potentialClipboard.namespaceDeclarations).some(
      ([key, value]) =>
        !(key === "@_xmlns" || key.startsWith("@_xmlns:")) ||
        typeof value !== "string",
    )
  )
    return undefined;
  for (const element of potentialClipboard.processFlowElements) {
    if (
      (element.__$$element as string) === "dataInput" ||
      (element.__$$element as string) === "dataOutput"
    )
      return undefined;
    if (element.__$$element === "sequenceFlow") continue;
    if (!Object.hasOwn(elementToNodeType, element.__$$element))
      return undefined;
    const kind =
      elementToNodeType[element.__$$element as keyof typeof elementToNodeType];
    if (
      nodeNatures[kind] !== NodeNature.PROCESS_FLOW_ELEMENT &&
      nodeNatures[kind] !== NodeNature.CONTAINER
    )
      return undefined;
  }
  if (
    potentialClipboard.artifacts.some(
      (element) =>
        element.__$$element !== "association" &&
        element.__$$element !== "group" &&
        element.__$$element !== "textAnnotation",
    )
  )
    return undefined;
  if (
    potentialClipboard.shapes.some(
      (shape) =>
        !shape["dc:Bounds"] ||
        typeof shape["@_bpmnElement"] !== "string" ||
        ["@_x", "@_y", "@_width", "@_height"].some(
          (key) =>
            !Number.isFinite(
              shape["dc:Bounds"][key as keyof (typeof shape)["dc:Bounds"]],
            ),
        ),
    )
  )
    return undefined;
  if (
    potentialClipboard.edges.some(
      (edge) =>
        typeof edge["@_bpmnElement"] !== "string" ||
        !Array.isArray(edge["di:waypoint"]) ||
        edge["di:waypoint"].length < 2 ||
        edge["di:waypoint"].some(
          (point) =>
            !point ||
            !Number.isFinite(point["@_x"]) ||
            !Number.isFinite(point["@_y"]),
        ),
    )
  )
    return undefined;
  if (potentialClipboard.processIo) {
    try {
      assertIoSets(potentialClipboard.processIo);
    } catch {
      return undefined;
    }
  }
  return potentialClipboard;
}
