// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  getMarshaller,
  createBlankBpmnSource,
  inspectBpmnSource,
} from "../source";
import { repositionNode } from "./mutations/repositionNode";
import { deleteNode } from "./mutations/deleteNode";
import { normalize } from "./normalization/normalize";
import { addStandaloneNode } from "./mutations/addStandaloneNode";
import { addConnectedNode } from "./mutations/addConnectedNode";
import { addEdge } from "./mutations/addEdge";
import {
  connectionElement,
  findConnectionElement,
  setDefaultFlow,
  setFlowCondition,
  setFlowImmediate,
  setProcessExecutable,
  setGatewayKind,
  setGatewayProperties,
  setAssociationDirection,
} from "./mutations/connection";
import { EDGE_TYPES } from "./diagram/BpmnDiagramDomain";
import { PositionalNodeHandleId } from "../xyflow/nodes/PositionalNodeHandles";
import { AutoPositionedEdgeMarker } from "../xyflow/edges/AutoPositionedEdgeMarker";
import {
  indexBpmnIds,
  getNewBpmnIdRandomizer,
  changeBpmnTargetNamespace,
} from "./idRandomizer/bpmn-id-randomizer";
import { addOrGetMessages } from "./mutations/addOrGetMessages";
import { addOrGetProcessAndDiagramElements } from "./mutations/addOrGetProcessAndDiagramElements";
import { NODE_TYPES, type BpmnNodeType } from "./diagram/BpmnDiagramDomain";
import { ComputedStateCache } from "../xyflow/store/ComputedStateCache";
import {
  getDataMapping,
  setInputAndOutputDataMapping,
  type WithDataMapping,
} from "./mutations/data-mapping";
import { createBpmnEditorStore, type State } from "./store/Store";
import { INITIAL_COMPUTED_CACHE } from "./store/initialComputedCache";
import { buildClipboardFromDiagram } from "./clipboard/Clipboard";
import { visitLanes } from "./mutations/element-visitor";
import { moveNodesInsideLane } from "./mutations/moveNodesInsideLane";
import { moveNodesOutOfLane } from "./mutations/moveNodesOutOfLane";
import { reassignFlowSelection } from "./mutations/moveNodesInsideSubProcess";
import { addOrGetLanes } from "./mutations/addOrGetLanes";
import { morphTask } from "./mutations/renameNode";
import {
  assertEventContext,
  eventById,
  setEventDefinitions,
  setEventAttachment,
  type BpmnEvent,
  type EventDefinition,
  type EventDefinitionKind,
  type EventScope,
} from "./mutations/event";
import {
  activityById,
  setActivityLoop,
  setActivityCompensation,
  setSubProcessExpanded,
  setSubProcessKind,
} from "./mutations/activity";
import {
  createGlobalTask,
  renameGlobalTask,
  deleteGlobalTask,
  setCalledElement,
  validCalledElement,
  addGlobalTaskData,
  deleteGlobalTaskData,
  setSupportedInterfaces,
  supportedInterfaceChoices,
} from "./mutations/global-tasks";
import { getContainmentRelationship } from "../xyflow/maths/DcMaths";
import { snapToDropTargetsBorder } from "../xyflow/snapgrid/BorderSnapping";

describe("retained BPMN working state", () => {
  it("binds direct host connections to real I/O on both ends and retires only private implicit slots", async () => {
    const xml = await readFile(
        new URL("../fixtures/data-associations-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      ),
      before = store.getState().bpmn.model,
      {
        dataAssociationById,
        reverseDataAssociation,
        setDataAssociationTarget,
      } = await import("./mutations/data-association"),
      { deleteEdge } = await import("./mutations/deleteEdge");
    const diagram = () =>
      store.getState().computed(store.getState()).getDiagramData();
    const connect = (
      sourceId: string,
      targetId: string,
      id?: string,
      binding?: { source?: string; target?: string },
      targetStore = store,
    ) =>
      targetStore.setState((state) => {
        const view = state.computed(state).getDiagramData();
        const source = view.nodesById.get(sourceId)!,
          target = view.nodesById.get(targetId)!;
        addEdge({
          definitions: state.bpmn.model.definitions,
          __readonly_edge: {
            id,
            type: EDGE_TYPES.dataAssociation,
            name: undefined,
            documentation: undefined,
            sourceHandle: PositionalNodeHandleId.Right,
            targetHandle: PositionalNodeHandleId.Left,
            autoPositionedEdgeMarker: undefined,
          },
          __readonly_sourceNode: {
            href: sourceId,
            type: source.type!,
            bounds: source.data.shape["dc:Bounds"],
            shapeId: source.data.shape["@_id"],
          },
          __readonly_targetNode: {
            href: targetId,
            type: target.type!,
            bounds: target.data.shape["dc:Bounds"],
            shapeId: target.data.shape["@_id"],
          },
          __readonly_keepWaypoints: !!id,
          __readonly_binding: binding,
        });
      });
    connect("Other", "Review");
    const created = store.getState().bpmn.model,
      bridge = diagram().edges.find(
        (edge) => edge.source === "Other" && edge.target === "Review",
      )!,
      location = dataAssociationById(created.definitions, bridge.id)!;
    expect(location.kind).toBe("dataInputAssociation");
    expect(location.host["@_id"]).toBe("Review");
    const source = connectionElement(created.definitions, "Other").element;
    if (source.__$$element !== "task") throw new Error("Missing source host");
    expect(location.association.sourceRef).toEqual([
      { __$$text: source.ioSpecification!.dataOutput![0]["@_id"] },
    ]);
    expect(location.association.targetRef.__$$text).not.toBe("Review");
    expect(
      location.host.ioSpecification!.dataInput!.some(
        (item) => item["@_id"] === location.association.targetRef.__$$text,
      ),
    ).toBe(true);
    for (const selected of ["Other", "Review"]) {
      const clipboard = buildClipboardFromDiagram(
          {
            nodes: diagram().nodes.map((node) => ({
              ...node,
              selected: node.id === selected,
            })),
            edges: diagram().edges,
          },
          store.getState(),
        ).clipboard,
        copy = clipboard.processFlowElements.find(
          (element) => element["@_id"] === selected,
        );
      if (copy?.__$$element !== "task") throw new Error("Missing copied host");
      const original = connectionElement(before.definitions, selected).element;
      if (original.__$$element !== "task")
        throw new Error("Missing original host");
      expect(copy.ioSpecification).toEqual(original.ioSpecification);
      expect(store.getState().bpmn.model).toBe(created);
    }
    const full = buildClipboardFromDiagram(
      {
        nodes: diagram().nodes.map((node) => ({
          ...node,
          selected: ["Other", "Review"].includes(node.id),
        })),
        edges: diagram().edges,
      },
      store.getState(),
    ).clipboard;
    expect(full.edges.some((edge) => edge["@_bpmnElement"] === bridge.id)).toBe(
      true,
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(created)).status,
    ).toBe("accepted");
    const slotBound = produce(created, (model) =>
      setDataAssociationTarget(model.definitions, bridge.id, "Contract"),
    );
    expect(
      dataAssociationById(slotBound.definitions, bridge.id)!.association,
    ).toEqual({ ...location.association, targetRef: { __$$text: "Contract" } });
    const originalTarget = connectionElement(
      before.definitions,
      "Review",
    ).element;
    if (originalTarget.__$$element !== "task")
      throw new Error("Missing original target");
    expect(
      dataAssociationById(slotBound.definitions, bridge.id)!.host
        .ioSpecification,
    ).toEqual(originalTarget.ioSpecification);
    expect(slotBound.definitions["bpmndi:BPMNDiagram"]).toEqual(
      created.definitions["bpmndi:BPMNDiagram"],
    );
    expect(() =>
      produce(created, (model) =>
        setDataAssociationTarget(model.definitions, bridge.id, "StartOut"),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    const { getDataMapping, setDataMappingForElement } =
      await import("./mutations/data-mapping");
    const removeSourcePort = (model: typeof created) => {
      const source = connectionElement(model.definitions, "Other").element;
      if (source.__$$element !== "task")
        throw new Error("Missing source owner");
      const rows = getDataMapping(source);
      setDataMappingForElement({
        definitions: model.definitions,
        elementId: "Other",
        element: "task",
        inputDataMapping: rows.inputDataMapping,
        outputDataMapping: rows.outputDataMapping.filter(
          (row) => row.id !== location.association.sourceRef![0].__$$text,
        ),
      });
    };
    expect(() =>
      store.setState((state) => removeSourcePort(state.bpmn.model)),
    ).toThrow("BPMN_GRAPHICAL_DATA_MAPPING");
    expect(store.getState().bpmn.model).toBe(created);
    const nonGraphical = produce(created, (model) => {
      const plane =
        model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]!;
      plane["di:DiagramElement"] = plane["di:DiagramElement"]!.filter(
        (edge) => edge["@_bpmnElement"] !== bridge.id,
      );
    });
    expect(() => produce(nonGraphical, removeSourcePort)).toThrow(
      "BPMN_DEFINITION_IN_USE",
    );
    connect("Start", "Review", bridge.id);
    const rebound = store.getState().bpmn.model,
      ref = dataAssociationById(rebound.definitions, bridge.id)!;
    expect(connectionElement(rebound.definitions, "Other").element).toEqual(
      connectionElement(before.definitions, "Other").element,
    );
    expect(ref.association.targetRef).toEqual(location.association.targetRef);
    connect("Start", "End", bridge.id);
    const moved = store.getState().bpmn.model;
    expect(
      dataAssociationById(moved.definitions, bridge.id)!.host["@_id"],
    ).toBe("End");
    expect(() =>
      store.setState((state) =>
        reverseDataAssociation(state.bpmn.model.definitions, bridge.id),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(moved);
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(moved)).status,
    ).toBe("accepted");
    store.setState((state) => {
      deleteEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edgeId: bridge.id,
      });
    });
    expect(store.getState().bpmn.model).toEqual(before);
    const definedPayload = produce(before, (model) => {
      model.definitions.rootElement!.push({
        __$$element: "message",
        "@_id": "PayloadMessage",
      });
      const event = connectionElement(model.definitions, "Start").element;
      if (event.__$$element !== "startEvent") throw new Error("Missing event");
      event.eventDefinition = [
        {
          __$$element: "messageEventDefinition",
          "@_id": "PayloadDefinition",
          "@_messageRef": "tns:PayloadMessage",
        },
      ];
      delete event.outputSet;
      deleteEdge({
        definitions: model.definitions,
        __readonly_edgeId: "EventWrite",
      });
    });
    expect(
      connectionElement(definedPayload.definitions, "Start").element,
    ).toMatchObject({
      dataOutput: [{ "@_id": "StartOut" }],
    });
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(definedPayload))
        .status,
    ).toBe("accepted");
    expect(() =>
      produce(definedPayload, (model) =>
        setDataMappingForElement({
          definitions: model.definitions,
          elementId: "Start",
          element: "startEvent",
          inputDataMapping: [],
          outputDataMapping: [],
        }),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    const ambiguous = produce(before, (model) => {
        const start = connectionElement(model.definitions, "Start").element,
          end = connectionElement(model.definitions, "End").element;
        if (
          start.__$$element !== "startEvent" ||
          end.__$$element !== "endEvent"
        )
          throw new Error("Missing payload owners");
        start.dataOutput!.push({
          "@_id": "SecondOutput",
          "@_name": "Alternate output",
        });
        start.outputSet!.dataOutputRefs!.push({ __$$text: "SecondOutput" });
        end.dataInput!.push({
          "@_id": "SecondInput",
          "@_name": "Alternate input",
        });
        end.inputSet!.dataInputRefs!.push({ __$$text: "SecondInput" });
      }),
      ambiguousStore = createBpmnEditorStore(
        ambiguous,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const ambiguousBefore = ambiguousStore.getState().bpmn.model;
    const { DataAssociationBindingRequired } =
      await import("./mutations/addEdge");
    expect(() =>
      connect("Start", "End", undefined, undefined, ambiguousStore),
    ).toThrow(DataAssociationBindingRequired);
    expect(ambiguousStore.getState().bpmn.model).toBe(ambiguousBefore);
    expect(() =>
      connect(
        "Start",
        "End",
        undefined,
        { source: "OtherData", target: "SecondInput" },
        ambiguousStore,
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(ambiguousStore.getState().bpmn.model).toBe(ambiguousBefore);
    connect(
      "Start",
      "End",
      undefined,
      { source: "SecondOutput", target: "SecondInput" },
      ambiguousStore,
    );
    const bound = ambiguousStore.getState().bpmn.model,
      boundEdge = ambiguousStore
        .getState()
        .computed(ambiguousStore.getState())
        .getDiagramData()
        .edges.find(
          (edge) => edge.source === "Start" && edge.target === "End",
        )!,
      boundMapping = dataAssociationById(
        bound.definitions,
        boundEdge.id,
      )!.association;
    expect(boundMapping).toMatchObject({
      sourceRef: [{ __$$text: "SecondOutput" }],
      targetRef: { __$$text: "SecondInput" },
    });
    expect(connectionElement(bound.definitions, "Start").element).toEqual(
      connectionElement(ambiguous.definitions, "Start").element,
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(bound)).status,
    ).toBe("accepted");
    connect("Start", "End", boundEdge.id, undefined, ambiguousStore);
    expect(
      dataAssociationById(
        ambiguousStore.getState().bpmn.model.definitions,
        boundEdge.id,
      )!.association,
    ).toEqual(boundMapping);
    const singleMapping = ambiguousStore.getState().bpmn.model;
    connect(
      "Start",
      "End",
      undefined,
      { source: "StartOut", target: "EndIn" },
      ambiguousStore,
    );
    const multipleMappings = ambiguousStore.getState().bpmn.model,
      parallel = ambiguousStore
        .getState()
        .computed(ambiguousStore.getState())
        .getDiagramData()
        .edges.filter(
          (edge) => edge.source === "Start" && edge.target === "End",
        );
    expect(parallel).toHaveLength(2);
    expect(
      connectionElement(multipleMappings.definitions, "Start").element,
    ).toEqual(connectionElement(singleMapping.definitions, "Start").element);
    const separate = parallel.find((edge) => edge.id !== boundEdge.id)!;
    expect(
      dataAssociationById(multipleMappings.definitions, separate.id)!
        .association,
    ).toMatchObject({
      sourceRef: [{ __$$text: "StartOut" }],
      targetRef: { __$$text: "EndIn" },
    });
    ambiguousStore.setState((state) => {
      deleteEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edgeId: separate.id,
      });
    });
    expect(ambiguousStore.getState().bpmn.model).toEqual(singleMapping);
  });
  it("retains every fan-in route through source selection, secondary reconnect, clipboard and shared-host deletion", async () => {
    const xml = await readFile(
        new URL("../fixtures/data-associations-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      ),
      {
        setDataAssociationSources,
        dataAssociationById,
        setDataAssociationTransformation,
        removeDataAssignment,
      } = await import("./mutations/data-association"),
      { deleteEdge } = await import("./mutations/deleteEdge");
    const before = store.getState().bpmn.model,
      di = (model: typeof before) =>
        model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
          "di:DiagramElement"
        ]!,
      diagram = () =>
        store.getState().computed(store.getState()).getDiagramData();
    store.setState((state) =>
      setDataAssociationSources(state.bpmn.model.definitions, "Read", [
        "Data",
        "OtherData",
      ]),
    );
    const fanIn = store.getState().bpmn.model,
      branches = diagram().edges.filter(
        (edge) => edge.data?.bpmnElement["@_id"] === "Read",
      ),
      secondary = branches.find((edge) => edge.source === "OtherData")!;
    expect(branches).toHaveLength(2);
    const sourceNode = diagram().nodesById.get("OtherData")!;
    const routeMove = produce(fanIn, (model) => {
      const route = di(model).find((edge) => edge["@_id"] === secondary.id);
      if (route?.__$$element !== "bpmndi:BPMNEdge")
        throw new Error("Missing secondary route");
      route["di:waypoint"].splice(1, 0, { "@_x": 300, "@_y": 400 });
      repositionNode({
        definitions: model.definitions,
        controlWaypointsByEdge: new Map(),
        __readonly_change: {
          type: "offset",
          nodeType: NODE_TYPES.dataObject,
          shapeIndex: sourceNode.data.shapeIndex,
          sourceEdgeIndexes: [secondary.data!.bpmnEdgeIndex],
          targetEdgeIndexes: [],
          selectedEdges: [secondary.id],
          offset: { deltaX: 20, deltaY: 0 },
        },
      });
    });
    expect(
      di(routeMove).find((edge) => edge["@_id"] === secondary.id),
    ).toMatchObject({
      "di:waypoint": [
        expect.anything(),
        { "@_x": 320, "@_y": 400 },
        secondary.data!.bpmnEdge!["di:waypoint"].at(-1),
      ],
    });
    expect(di(fanIn).find((edge) => edge["@_id"] === "ReadDI")).toEqual(
      di(before).find((edge) => edge["@_id"] === "ReadDI"),
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(fanIn)).status,
    ).toBe("accepted");
    const assignmentOnly = produce(fanIn, (model) =>
      setDataAssociationTransformation(model.definitions, "Read", ""),
    );
    expect(
      dataAssociationById(assignmentOnly.definitions, "Read")!.association
        .transformation,
    ).toBeUndefined();
    expect(() =>
      produce(assignmentOnly, (model) =>
        removeDataAssignment(model.definitions, "Read", "Assign"),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(fanIn);
    const all = buildClipboardFromDiagram(
      {
        nodes: diagram().nodes.map((node) => ({ ...node, selected: true })),
        edges: diagram().edges,
      },
      store.getState(),
    ).clipboard;
    expect(
      all.edges.filter((edge) => edge["@_bpmnElement"] === "Read"),
    ).toHaveLength(2);
    const partial = buildClipboardFromDiagram(
      {
        nodes: diagram().nodes.map((node) => ({
          ...node,
          selected: ["Data", "Review"].includes(node.id),
        })),
        edges: diagram().edges,
      },
      store.getState(),
    ).clipboard;
    expect(partial.edges.some((edge) => edge["@_bpmnElement"] === "Read")).toBe(
      false,
    );
    const partialTask = partial.processFlowElements.find(
      (element) => element["@_id"] === "Review",
    );
    if (partialTask?.__$$element !== "task")
      throw new Error("Missing copied task");
    expect(
      partialTask.dataInputAssociation?.some(
        (association) => association["@_id"] === "Read",
      ),
    ).toBe(false);
    const reconnect = (
      sourceId: string,
      targetId: string,
      routeId = secondary.id,
      targetStore = store,
    ) =>
      targetStore.setState((state) => {
        const source = diagram().nodesById.get(sourceId)!,
          target = diagram().nodesById.get(targetId)!;
        addEdge({
          definitions: state.bpmn.model.definitions,
          __readonly_edge: {
            id: routeId,
            type: EDGE_TYPES.dataAssociation,
            name: undefined,
            documentation: undefined,
            sourceHandle: PositionalNodeHandleId.Right,
            targetHandle: PositionalNodeHandleId.Left,
            autoPositionedEdgeMarker: undefined,
          },
          __readonly_sourceNode: {
            href: sourceId,
            type: source.type!,
            bounds: source.data.shape["dc:Bounds"],
            shapeId: source.data.shape["@_id"],
          },
          __readonly_targetNode: {
            href: targetId,
            type: target.type!,
            bounds: target.data.shape["dc:Bounds"],
            shapeId: target.data.shape["@_id"],
          },
          __readonly_keepWaypoints: true,
        });
      });
    const reordered = produce(fanIn, (model) => {
      const elements = di(model),
        i = elements.findIndex((edge) => edge["@_id"] === secondary.id);
      elements.unshift(...elements.splice(i, 1));
    });
    const reorderedStore = createBpmnEditorStore(
      reordered,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    reconnect("Result", "Review", "Read", reorderedStore);
    expect(
      di(reorderedStore.getState().bpmn.model).find(
        (edge) => edge["@_id"] === "ReadDI",
      ),
    ).toMatchObject({ "@_sourceElement": "ResultDI" });
    expect(
      di(reorderedStore.getState().bpmn.model).find(
        (edge) => edge["@_id"] === secondary.id,
      ),
    ).toEqual(di(fanIn).find((edge) => edge["@_id"] === secondary.id));
    reconnect("Result", "Review");
    expect(
      dataAssociationById(store.getState().bpmn.model.definitions, "Read")!
        .association.sourceRef,
    ).toEqual([{ __$$text: "Data" }, { __$$text: "Result" }]);
    expect(
      di(store.getState().bpmn.model).find((edge) => edge["@_id"] === "ReadDI"),
    ).toEqual(di(before).find((edge) => edge["@_id"] === "ReadDI"));
    reconnect("Result", "Other");
    const moved = store.getState().bpmn.model,
      location = dataAssociationById(moved.definitions, "Read")!;
    expect(location.host["@_id"]).toBe("Other");
    expect(location.association.transformation).toEqual(
      dataAssociationById(before.definitions, "Read")!.association
        .transformation,
    );
    expect(
      diagram()
        .edges.filter((edge) => edge.data?.bpmnElement["@_id"] === "Read")
        .every((edge) => edge.target === "Other"),
    ).toBe(true);
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(moved)).status,
    ).toBe("accepted");
    store.setState((state) => {
      deleteEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edgeId: secondary.id,
      });
    });
    const deleted = store.getState().bpmn.model;
    expect(dataAssociationById(deleted.definitions, "Read")).toBeUndefined();
    expect(di(deleted).some((edge) => edge["@_bpmnElement"] === "Read")).toBe(
      false,
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(deleted)).status,
    ).toBe("accepted");
  });
  it("keeps graphical process I/O in its specification through clipboard and semantic deletion", async () => {
    const xml = await readFile(
        new URL("../fixtures/process-io-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const before = store.getState().bpmn.model,
      diagram = store.getState().computed(store.getState()).getDiagramData();
    expect(diagram.nodesById.get("Input")?.data.bpmnElement).toMatchObject({
      __$$element: "dataInput",
      "@_id": "Input",
    });
    expect(diagram.edgesById.get("Read")).toMatchObject({
      source: "Input",
      target: "Task",
    });
    const clipboard = buildClipboardFromDiagram(
      {
        nodes: diagram.nodes.map((node) => ({ ...node, selected: true })),
        edges: diagram.edges,
      },
      store.getState(),
    ).clipboard;
    expect(
      clipboard.processFlowElements.some(
        (element) => element["@_id"] === "Input",
      ),
    ).toBe(false);
    const spec = addOrGetProcessAndDiagramElements({
      definitions: before.definitions,
    }).process.ioSpecification!;
    expect(clipboard.processIo).toEqual({
      ...spec,
      ...indexBpmnIds(before.definitions).namespaceDeclarationsFor(spec),
    });
    const remapper = getNewBpmnIdRandomizer(before.definitions)
      .ack({
        json: clipboard.processIo,
        type: "BPMN20__tProcess",
        attr: "ioSpecification",
      })
      .ack({
        json: clipboard.processFlowElements,
        type: "BPMN20__tProcess",
        attr: "flowElement",
      })
      .ack({
        json: clipboard.shapes,
        type: "BPMNDI__BPMNPlane",
        attr: "di:DiagramElement",
        __$$element: "bpmndi:BPMNShape",
      });
    remapper.randomize({ skipAlreadyAttributedIds: false });
    const inputId = clipboard.processIo!.dataInput![0]["@_id"];
    expect(inputId).not.toBe("Input");
    expect(
      clipboard.processIo!.inputSet[0].optionalInputRefs![0].__$$text,
    ).toBe(inputId);
    expect(clipboard.processIo!.inputSet[0].outputSetRefs![0].__$$text).toBe(
      clipboard.processIo!.outputSet[0]["@_id"],
    );
    const { setProcessIoDetails } = await import("./mutations/process-io");
    expect(() =>
      store.setState((state) => {
        setProcessIoDetails(state.bpmn.model.definitions, "Input", {
          collection: false,
        });
      }),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(before);
    const annotated = produce(before, (model) => {
      addConnectedNode({
        definitions: model.definitions,
        __readonly_sourceNode: {
          id: "Input",
          type: NODE_TYPES.dataObject,
          shapeId: "InputDI",
          bounds: { "@_x": 100, "@_y": 100, "@_width": 60, "@_height": 80 },
        },
        __readonly_newNode: {
          type: NODE_TYPES.textAnnotation,
          bounds: { "@_x": 500, "@_y": 300, "@_width": 160, "@_height": 80 },
        },
      });
    });
    const annotatedProcess = addOrGetProcessAndDiagramElements({
      definitions: annotated.definitions,
    }).process;
    expect(annotatedProcess.artifact).toHaveLength(4);
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(annotated)).status,
    ).toBe("accepted");
    store.setState((state) => {
      deleteNode({
        definitions: state.bpmn.model.definitions,
        __readonly_bpmnElementId: "Input",
        __readonly_bpmnEdgeData: [],
      });
    });
    const deleted = store.getState().bpmn.model,
      { process } = addOrGetProcessAndDiagramElements({
        definitions: deleted.definitions,
      });
    expect(process.ioSpecification!.dataInput).toBeUndefined();
    expect(process.ioSpecification!.inputSet[0].dataInputRefs).toBeUndefined();
    expect(
      process.ioSpecification!.inputSet[0].optionalInputRefs,
    ).toBeUndefined();
    expect(process.ioSpecification!.dataOutput).toEqual(
      addOrGetProcessAndDiagramElements({ definitions: before.definitions })
        .process.ioSpecification!.dataOutput,
    );
    expect(process.flowElement![0]).toMatchObject({
      dataOutputAssociation: [{ "@_id": "Write" }],
    });
    expect(process.flowElement![0]).not.toHaveProperty("dataInputAssociation");
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(deleted)).status,
    ).toBe("accepted");
  });
  it("keeps data-association I/O IDREFs separate from visual FlowNodes and retires only exclusive anonymous slots", async () => {
    const xml = (
        await readFile(
          new URL(
            "../fixtures/data-associations-standard.bpmn",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .replace('task id="Other"', 'task id="Other" xmlns:tns="urn:foreign"')
        .replace(
          'id="Transform" language=',
          'id="Transform" evaluatesToTypeRef="tns:Item" language=',
        ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const { deleteEdge } = await import("./mutations/deleteEdge"),
      { dataAssociationById, reverseDataAssociation } =
        await import("./mutations/data-association");
    const before = store.getState().bpmn.model,
      diagram = store.getState().computed(store.getState()).getDiagramData();
    expect(diagram.edgesById.get("Read")).toMatchObject({
      source: "Data",
      target: "Review",
      type: EDGE_TYPES.dataAssociation,
    });
    expect(diagram.edgesById.has("Passive")).toBe(false);
    const connect = (sourceId: string, targetId: string, id?: string) =>
      store.setState((state) => {
        const diagram = state.computed(state).getDiagramData(),
          source = diagram.nodesById.get(sourceId)!,
          target = diagram.nodesById.get(targetId)!;
        addEdge({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            href: sourceId,
            type: source.type!,
            bounds: source.data.shape["dc:Bounds"],
            shapeId: source.data.shape["@_id"],
          },
          __readonly_targetNode: {
            href: targetId,
            type: target.type!,
            bounds: target.data.shape["dc:Bounds"],
            shapeId: target.data.shape["@_id"],
          },
          __readonly_edge: {
            id,
            type: EDGE_TYPES.dataAssociation,
            name: undefined,
            documentation: undefined,
            sourceHandle: PositionalNodeHandleId.Center,
            targetHandle: PositionalNodeHandleId.Left,
            autoPositionedEdgeMarker: undefined,
          },
          __readonly_keepWaypoints: !!id,
        });
      });
    connect("Data", "Other");
    const created = store.getState().bpmn.model,
      other = connectionElement(created.definitions, "Other").element;
    if (other.__$$element !== "task") throw new Error("Missing activity");
    const association = other.dataInputAssociation![0],
      slot = other.ioSpecification!.dataInput![0];
    expect(association.targetRef.__$$text).toBe(slot["@_id"]);
    expect(association.targetRef.__$$text).not.toBe("Other");
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(created)).status,
    ).toBe("accepted");
    const createdRoute = created.definitions["bpmndi:BPMNDiagram"]![0][
      "bpmndi:BPMNPlane"
    ]!["di:DiagramElement"]!.find(
      (edge) => edge["@_bpmnElement"] === association["@_id"],
    );
    if (createdRoute?.__$$element !== "bpmndi:BPMNEdge")
      throw new Error("Missing route");
    expect(createdRoute["di:waypoint"]![0]).not.toEqual({
      "@_x": 160,
      "@_y": 170,
    });
    store.setState((state) => {
      deleteEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edgeId: association["@_id"],
      });
    });
    expect(store.getState().bpmn.model).toEqual(before);
    const { getDataMapping, setDataMappingForElement } =
        await import("./mutations/data-mapping"),
      mappingBefore = store.getState().bpmn.model,
      review = connectionElement(mappingBefore.definitions, "Review").element;
    if (review.__$$element !== "task") throw new Error("Missing mapped task");
    const rows = getDataMapping(review);
    expect(() =>
      store.setState((state) => {
        setDataMappingForElement({
          definitions: state.bpmn.model.definitions,
          elementId: "Review",
          element: "task",
          inputDataMapping: rows.inputDataMapping.filter(
            (row) => row.id !== "In",
          ),
          outputDataMapping: rows.outputDataMapping,
        });
      }),
    ).toThrow("BPMN_GRAPHICAL_DATA_MAPPING");
    expect(store.getState().bpmn.model).toBe(mappingBefore);
    connect("OtherData", "Review", "Read");
    const reconnected = store.getState().bpmn.model,
      current = dataAssociationById(
        reconnected.definitions,
        "Read",
      )!.association;
    expect(current).toMatchObject({
      sourceRef: [{ __$$text: "OtherData" }],
      targetRef: { __$$text: "In" },
      transformation: {
        "@_id": "Transform",
        "@_language": "urn:map",
        __$$text: "normalize(source)",
      },
      assignment: [
        { "@_id": "Assign", from: { "@_id": "From" }, to: { "@_id": "To" } },
      ],
    });
    connect("OtherData", "Other", "Read");
    const moved = store.getState().bpmn.model,
      location = dataAssociationById(moved.definitions, "Read")!;
    expect(location.host["@_id"]).toBe("Other");
    expect(location.association.targetRef.__$$text).not.toBe("Other");
    expect(location.host.ioSpecification!.dataInput![0]["@_id"]).toBe(
      location.association.targetRef.__$$text,
    );
    expect(location.association.transformation).toEqual(current.transformation);
    expect(
      indexBpmnIds(moved.definitions).resolveReference(
        location.association.transformation!,
        location.association.transformation!["@_evaluatesToTypeRef"],
      ),
    ).toBe("Item");
    expect(location.association.assignment).toEqual(current.assignment);
    const oldHost = connectionElement(moved.definitions, "Review").element;
    if (oldHost.__$$element !== "task") throw new Error("Missing old host");
    expect(oldHost.ioSpecification).toEqual(review.ioSpecification);
    store.setState((state) => {
      reverseDataAssociation(state.bpmn.model.definitions, "Read");
    });
    const reversed = store.getState().bpmn.model,
      outputLocation = dataAssociationById(reversed.definitions, "Read")!;
    expect(outputLocation.kind).toBe("dataOutputAssociation");
    expect(outputLocation.association.targetRef.__$$text).toBe("OtherData");
    expect(outputLocation.host.ioSpecification!.dataInput).toBeUndefined();
    expect(outputLocation.host.ioSpecification!.dataOutput![0]["@_id"]).toBe(
      outputLocation.association.sourceRef![0].__$$text,
    );
    expect(() =>
      store.setState((state) => {
        reverseDataAssociation(state.bpmn.model.definitions, "EventRead");
      }),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(reversed);
    store.setState((state) => {
      deleteEdge({
        definitions: state.bpmn.model.definitions,
        __readonly_edgeId: "Read",
      });
    });
    const retained = connectionElement(
      store.getState().bpmn.model.definitions,
      "Review",
    ).element;
    if (retained.__$$element !== "task") throw new Error("Missing task");
    expect(
      retained.ioSpecification!.dataInput!.map((item) => item["@_id"]),
    ).toContain("In");
    expect(
      retained.dataInputAssociation!.find((item) => item["@_id"] === "Passive"),
    ).toEqual(dataAssociationById(before.definitions, "Passive")!.association);
    expect(
      inspectBpmnSource(
        getMarshaller(xml).builder.build(store.getState().bpmn.model),
      ).status,
    ).toBe("accepted");
    expect(
      connectionElement(store.getState().bpmn.model.definitions, "Other")
        .element,
    ).toEqual(connectionElement(before.definitions, "Other").element);
  });
  it("carries reference-backed declarations in clipboard and guards dangling reparent/delete commands", async () => {
    const xml = await readFile(
        new URL("../fixtures/data-references-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const { setDataObjectReference } = await import("./mutations/data");
    const original = store.getState().bpmn.model;
    store.setState((state) => {
      state.xyFlowReactKieDiagram._selectedNodes = ["First", "Second"];
    });
    const state = store.getState(),
      diagram = state.computed(state).getDiagramData();
    expect(diagram.nodesById.has("Backing")).toBe(false);
    const { clipboard } = buildClipboardFromDiagram(
      { nodes: diagram.nodes, edges: diagram.edges } as Parameters<
        typeof buildClipboardFromDiagram
      >[0],
      state,
    );
    expect(
      clipboard.processFlowElements.filter(
        (element) => element.__$$element === "dataObject",
      ),
    ).toHaveLength(1);
    expect(clipboard.shapes).toHaveLength(2);
    getNewBpmnIdRandomizer({
      ...clipboard.namespaceDeclarations,
      "@_targetNamespace": clipboard.namespaceWhereClipboardWasCreatedFrom,
    })
      .ack({
        json: clipboard.processFlowElements,
        type: "BPMN20__tProcess",
        attr: "flowElement",
      })
      .randomize({ skipAlreadyAttributedIds: false });
    const backing = clipboard.processFlowElements.find(
      (element) => element.__$$element === "dataObject",
    )!;
    expect(backing["@_id"]).not.toBe("Backing");
    expect(
      clipboard.processFlowElements
        .filter((element) => element.__$$element === "dataObjectReference")
        .map((element) => element["@_dataObjectRef"]),
    ).toEqual([backing["@_id"], backing["@_id"]]);
    expect(() =>
      store.setState((state) =>
        deleteNode({
          definitions: state.bpmn.model.definitions,
          __readonly_bpmnElementId: "Backing",
          __readonly_bpmnEdgeData: [],
        }),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(() =>
      store.setState((state) =>
        reassignFlowSelection({
          definitions: state.bpmn.model.definitions,
          targetOwnerId: "Sub",
          nodeIds: ["First"],
        }),
      ),
    ).toThrow("BPMN_ACTIVITY_SCOPE");
    expect(store.getState().bpmn.model).toBe(original);
    store.setState((state) =>
      setDataObjectReference(state.bpmn.model.definitions, "First", "Visible"),
    );
    expect(
      connectionElement(store.getState().bpmn.model.definitions, "Backing")
        .element,
    ).toMatchObject({ "@_id": "Backing" });
    store.setState((state) =>
      setDataObjectReference(state.bpmn.model.definitions, "Second", "Visible"),
    );
    expect(
      findConnectionElement(store.getState().bpmn.model.definitions, "Backing"),
    ).toBeUndefined();
    expect(
      inspectBpmnSource(
        getMarshaller(xml).builder.build(store.getState().bpmn.model),
      ).status,
    ).toBe("accepted");
  });
  it("keeps association QNames, direction and DI ownership during creation and reconnect", async () => {
    const xml = await readFile(
        new URL("../fixtures/associations-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const before = store.getState().bpmn.model,
      data = store.getState().computed(store.getState()).getDiagramData();
    store.setState((state) =>
      moveNodesInsideLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "Lane",
        __readonly_nodeIds: ["Note1"],
      }),
    );
    expect(store.getState().bpmn.model).toBe(before);
    expect(data.edgesById.get("Undirected")).toMatchObject({
      source: "A",
      target: "Note1",
    });
    expect(data.edgesById.get("NestedAssociation")).toMatchObject({
      source: "Child",
      target: "ChildNote",
    });
    const connect = (sourceId: string, targetId: string, id?: string) =>
      store.setState((state) => {
        const diagram = state.computed(state).getDiagramData(),
          source = diagram.nodesById.get(sourceId)!,
          target = diagram.nodesById.get(targetId)!;
        addEdge({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            href: sourceId,
            type: source.type!,
            bounds: source.data.shape["dc:Bounds"]!,
            shapeId: source.data.shape["@_id"],
          },
          __readonly_targetNode: {
            href: targetId,
            type: target.type!,
            bounds: target.data.shape["dc:Bounds"]!,
            shapeId: target.data.shape["@_id"],
          },
          __readonly_edge: {
            id,
            type: EDGE_TYPES.association,
            sourceHandle: PositionalNodeHandleId.Bottom,
            targetHandle: PositionalNodeHandleId.Top,
            name: undefined,
            documentation: undefined,
            autoPositionedEdgeMarker: undefined,
          },
          __readonly_keepWaypoints: !!id,
        });
      });
    expect(() => connect("A", "ChildNote")).toThrow("BPMN_ACTIVITY_SCOPE");
    expect(store.getState().bpmn.model).toBe(before);
    connect("A", "Note2", "Undirected");
    const reconnected = store.getState().bpmn.model,
      association = connectionElement(
        reconnected.definitions,
        "Undirected",
      ).element;
    expect(association).toMatchObject({
      "@_sourceRef": "tns:A",
      "@_targetRef": "tns:Note2",
      documentation: [
        { "@_id": "AssociationDoc", __$$text: "Keep lexical endpoints and DI" },
      ],
    });
    expect(association).not.toHaveProperty("@_associationDirection");
    const route = (model: typeof before) =>
      model.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
        "di:DiagramElement"
      ]!.find((e) => e["@_bpmnElement"] === "Undirected");
    const previous = route(before),
      after = route(reconnected);
    if (
      previous?.__$$element !== "bpmndi:BPMNEdge" ||
      after?.__$$element !== "bpmndi:BPMNEdge"
    )
      throw new Error("Missing route");
    expect(after["@_id"]).toBe(previous["@_id"]);
    expect(after["di:waypoint"]!.slice(1, -1)).toEqual(
      previous["di:waypoint"]!.slice(1, -1),
    );
    store.setState((state) =>
      setAssociationDirection(
        state.bpmn.model.definitions,
        "Undirected",
        "Both",
      ),
    );
    connect("A", "Note3");
    const added = store.getState().bpmn.model;
    expect(connectionElement(added.definitions, "Reverse").element).toEqual(
      connectionElement(before.definitions, "Reverse").element,
    );
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(added)).status,
    ).toBe("accepted");
  });
  it("guards complete gateway configurations and preserves activation metadata and authored Mixed direction", async () => {
    const xml = await readFile(
        new URL("../fixtures/gateways-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const baseline = store.getState().bpmn.model;
    store.setState((state) => {
      state.xyFlowReactKieDiagram._selectedNodes = ["Exclusive"];
    });
    const data = store.getState().computed(store.getState()).getDiagramData();
    const { clipboard } = buildClipboardFromDiagram(
      { nodes: data.nodes, edges: data.edges } as Parameters<
        typeof buildClipboardFromDiagram
      >[0],
      store.getState(),
    );
    expect(clipboard.processFlowElements).toHaveLength(1);
    expect(clipboard.processFlowElements[0]).not.toHaveProperty("@_default");
    expect(
      connectionElement(baseline.definitions, "Exclusive").element,
    ).toHaveProperty("@_default", "tns:ChooseD");
    for (const command of [
      (definitions: typeof baseline.definitions) =>
        setGatewayProperties(definitions, "Exclusive", {
          direction: "Diverging",
        }),
      (definitions: typeof baseline.definitions) =>
        setGatewayKind(definitions, "Exclusive", "parallelGateway"),
      (definitions: typeof baseline.definitions) =>
        setGatewayKind(definitions, "Complex", "inclusiveGateway"),
      (definitions: typeof baseline.definitions) =>
        setGatewayProperties(definitions, "Event", {
          eventGatewayType: "Parallel",
        }),
    ]) {
      expect(() =>
        store.setState((state) => command(state.bpmn.model.definitions)),
      ).toThrow("BPMN_INVALID_CONNECTION");
      expect(store.getState().bpmn.model).toBe(baseline);
    }
    store.setState((state) =>
      setGatewayProperties(state.bpmn.model.definitions, "Complex", {
        activationCondition: "readyCount > 2",
      }),
    );
    expect(
      connectionElement(store.getState().bpmn.model.definitions, "Complex")
        .element,
    ).toMatchObject({
      activationCondition: {
        "@_id": "Activation",
        "@_xsi:type": "tFormalExpression",
        "@_language": "urn:gateway",
        __$$text: "readyCount > 2",
      },
      "@_gatewayDirection": "Mixed",
    });
    store.setState((state) => {
      setGatewayProperties(state.bpmn.model.definitions, "Event", {
        instantiate: true,
      });
      setGatewayProperties(state.bpmn.model.definitions, "Event", {
        eventGatewayType: "Parallel",
      });
    });
    const valid = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setGatewayProperties(state.bpmn.model.definitions, "Event", {
          instantiate: false,
        }),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(valid);
    const built = getMarshaller(xml).builder.build(valid);
    expect(inspectBpmnSource(built).status).toBe("accepted");
    expect(valid.definitions["bpmndi:BPMNDiagram"]).toEqual(
      baseline.definitions["bpmndi:BPMNDiagram"],
    );
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toEqual(baseline);
  });
  it("reconnects the existing conditioned flow without replacing identity, metadata, reverse edge or manual route", async () => {
    const xml = await readFile(
        new URL("../fixtures/flows-standard.bpmn", import.meta.url),
        "utf8",
      ),
      store = createBpmnEditorStore(
        getMarshaller(xml).parser.parse(),
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const initialFlow = store.getState().bpmn.model;
    store.setState((state) =>
      setFlowImmediate(state.bpmn.model.definitions, "Forward", false),
    );
    const nonImmediate = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setProcessExecutable(state.bpmn.model.definitions, true),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(nonImmediate);
    store.setState((state) => {
      setFlowImmediate(state.bpmn.model.definitions, "Forward", true);
      setProcessExecutable(state.bpmn.model.definitions, true);
    });
    const executable = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setFlowImmediate(state.bpmn.model.definitions, "Forward", false),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(executable);
    store.setState((state) => {
      setProcessExecutable(state.bpmn.model.definitions, undefined);
      setFlowImmediate(state.bpmn.model.definitions, "Forward", undefined);
    });
    expect(store.getState().bpmn.model).toEqual(initialFlow);
    const before = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setDefaultFlow(state.bpmn.model.definitions, "A", "Conditional"),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(before);
    store.setState((state) => {
      setFlowCondition(state.bpmn.model.definitions, "Forward", "reviewed");
    });
    const baseline = store.getState().bpmn.model,
      expected = structuredClone(baseline);
    const reconnect = (sourceId: string, targetId: string) =>
      store.setState((state) => {
        const data = state.computed(state).getDiagramData(),
          source = data.nodesById.get(sourceId)!,
          target = data.nodesById.get(targetId)!;
        addEdge({
          definitions: state.bpmn.model.definitions,
          __readonly_edge: {
            id: "Forward",
            type: EDGE_TYPES.sequenceFlow,
            name: undefined,
            documentation: undefined,
            sourceHandle: PositionalNodeHandleId.Right,
            targetHandle: PositionalNodeHandleId.Left,
            autoPositionedEdgeMarker: undefined,
          },
          __readonly_sourceNode: {
            href: sourceId,
            type: source.type!,
            bounds: source.data.shape["dc:Bounds"]!,
            shapeId: source.data.shape["@_id"],
          },
          __readonly_targetNode: {
            href: targetId,
            type: target.type!,
            bounds: target.data.shape["dc:Bounds"]!,
            shapeId: target.data.shape["@_id"],
          },
          __readonly_keepWaypoints: true,
        });
      });
    reconnect("B", "D");
    const location = connectionElement(expected.definitions, "Forward"),
      target = connectionElement(expected.definitions, "D").element,
      oldTarget = connectionElement(expected.definitions, "C").element;
    if (
      location.element.__$$element !== "sequenceFlow" ||
      target.__$$element !== "task" ||
      oldTarget.__$$element !== "serviceTask"
    )
      throw new Error("Missing flow");
    location.element["@_targetRef"] = "D";
    target.incoming = [{ __$$text: "Forward" }];
    oldTarget.incoming = oldTarget.incoming!.filter(
      (ref) => ref.__$$text !== "Forward",
    );
    const di = expected.definitions["bpmndi:BPMNDiagram"]![0][
      "bpmndi:BPMNPlane"
    ]!["di:DiagramElement"]!.find(
      (element) => element["@_bpmnElement"] === "Forward",
    );
    if (di?.__$$element !== "bpmndi:BPMNEdge") throw new Error("Missing edge");
    di["@_targetElement"] = "DDI";
    di["di:waypoint"]!.at(-1)!["@_x"] = 400;
    di["di:waypoint"]!.at(-1)!["@_y"] = 480;
    expect(store.getState().bpmn.model).toEqual(expected);
    expect(
      inspectBpmnSource(getMarshaller(xml).builder.build(expected)).status,
    ).toBe("accepted");
    const reconnected = store.getState().bpmn.model;
    expect(() => reconnect("C", "B")).toThrow("BPMN_INVALID_CONNECTION");
    expect(store.getState().bpmn.model).toBe(reconnected);
    store.setState((state) => {
      setFlowCondition(state.bpmn.model.definitions, "Conditional", "");
      setDefaultFlow(state.bpmn.model.definitions, "A", "Conditional");
    });
    expect(
      connectionElement(store.getState().bpmn.model.definitions, "A").element,
    ).toMatchObject({ "@_default": "tns:Conditional" });
    expect(() =>
      store.setState((state) =>
        setFlowCondition(
          state.bpmn.model.definitions,
          "Conditional",
          "ignored",
        ),
      ),
    ).toThrow("BPMN_INVALID_CONNECTION");
  });
  it("keeps QName-bound attachments and imported geometry coherent across host clipboard, detachment and undo", async () => {
    const xml = await readFile(
      new URL("../fixtures/events-standard.bpmn", import.meta.url),
      "utf8",
    );
    const store = createBpmnEditorStore(
      getMarshaller(xml).parser.parse(),
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    store.setState((state) => {
      state.xyFlowReactKieDiagram._selectedNodes = ["Host"];
    });
    const before = store.getState().bpmn.model;
    const data = store.getState().computed(store.getState()).getDiagramData();
    const { clipboard } = buildClipboardFromDiagram(
      { nodes: data.nodes, edges: data.edges } as Parameters<
        typeof buildClipboardFromDiagram
      >[0],
      store.getState(),
    );
    expect(
      clipboard.processFlowElements.map((element) => element["@_id"]),
    ).toEqual(["Host", "Boundary"]);
    expect(clipboard.shapes.map((shape) => shape["@_bpmnElement"])).toEqual([
      "Host",
      "Boundary",
    ]);
    const host = data.nodesById.get("NestedTask")!.data.shape["dc:Bounds"]!;
    const boundary =
      data.nodesById.get("NestedBoundary")!.data.shape["dc:Bounds"]!;
    expect(
      getContainmentRelationship({
        bounds: boundary,
        container: host,
        borderAllowanceInPx: 10,
      }).isAtBorder,
    ).toBe(true);
    const snapped = snapToDropTargetsBorder(host, boundary, 14);
    expect(snapped.y + boundary["@_height"] / 2).toBe(
      host["@_y"] + host["@_height"],
    );
    store.setState((state) =>
      setEventAttachment(state.bpmn.model.definitions, "Boundary"),
    );
    const detached = store.getState().bpmn.model;
    const event = eventById(detached.definitions, "Boundary").event;
    expect(event.__$$element).toBe("intermediateCatchEvent");
    expect(event).not.toHaveProperty("@_attachedToRef");
    expect(event).not.toHaveProperty("@_cancelActivity");
    const previous = eventById(before.definitions, "Boundary").event;
    expect(event.documentation).toEqual(previous.documentation);
    expect(event.eventDefinitionRef).toEqual(previous.eventDefinitionRef);
    expect(detached.definitions["bpmndi:BPMNDiagram"]).toEqual(
      before.definitions["bpmndi:BPMNDiagram"],
    );
    expect(() =>
      store.setState((state) =>
        setEventAttachment(
          state.bpmn.model.definitions,
          "Boundary",
          "NestedTask",
        ),
      ),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    expect(store.getState().bpmn.model).toBe(detached);
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(before);
  });
  it("enforces event trigger/attachment contexts and preserves referenced definitions across atomic trigger edits", async () => {
    const xml = await readFile(
      new URL("../fixtures/globals-standard.bpmn", import.meta.url),
      "utf8",
    );
    const model = normalize(getMarshaller(xml).parser.parse());
    const process = model.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    );
    if (process?.__$$element !== "process") throw new Error("Missing process");
    const error = {
      "@_id": "ErrorDefinition",
      __$$element: "errorEventDefinition" as const,
    };
    const cancel = {
      "@_id": "CancelDefinition",
      __$$element: "cancelEventDefinition" as const,
    };
    const rootError = {
      "@_id": "NewStart",
      __$$element: "startEvent" as const,
      eventDefinition: [error],
    };
    expect(() =>
      assertEventContext(model.definitions, rootError, process),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    const embedded = { "@_id": "Embedded", __$$element: "subProcess" as const };
    expect(() =>
      assertEventContext(
        model.definitions,
        { ...rootError, eventDefinition: [] },
        embedded,
      ),
    ).not.toThrow();
    expect(() =>
      assertEventContext(model.definitions, rootError, {
        ...embedded,
        "@_triggeredByEvent": true,
      }),
    ).not.toThrow();
    expect(() =>
      assertEventContext(
        model.definitions,
        { ...rootError, "@_isInterrupting": false },
        { ...embedded, "@_triggeredByEvent": true },
      ),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    const transaction = {
      "@_id": "Transaction",
      __$$element: "transaction" as const,
    };
    process.flowElement!.push(transaction);
    const boundary = {
      "@_id": "Boundary",
      __$$element: "boundaryEvent" as const,
      "@_attachedToRef": "tns:Task",
      eventDefinition: [cancel],
    };
    process.flowElement!.push(boundary);
    expect(() =>
      assertEventContext(model.definitions, boundary, process),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    boundary["@_attachedToRef"] = "tns:Transaction";
    expect(() =>
      assertEventContext(model.definitions, boundary, process),
    ).not.toThrow();
    expect(() =>
      assertEventContext(
        model.definitions,
        { ...boundary, "@_cancelActivity": false },
        process,
        boundary,
      ),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    const end = {
      "@_id": "CancelEnd",
      __$$element: "endEvent" as const,
      eventDefinition: [cancel],
    };
    expect(() => assertEventContext(model.definitions, end, process)).toThrow(
      "BPMN_INVALID_EVENT_CONTEXT",
    );
    expect(() =>
      assertEventContext(model.definitions, end, transaction),
    ).not.toThrow();
    const contexts: {
      role: BpmnEvent["__$$element"];
      scope: EventScope;
      attached?: string;
      allowed: readonly EventDefinitionKind[];
    }[] = [
      {
        role: "startEvent",
        scope: process,
        allowed: [
          "messageEventDefinition",
          "timerEventDefinition",
          "conditionalEventDefinition",
          "signalEventDefinition",
        ],
      },
      { role: "startEvent", scope: embedded, allowed: [] },
      {
        role: "startEvent",
        scope: { ...embedded, "@_triggeredByEvent": true },
        allowed: [
          "messageEventDefinition",
          "timerEventDefinition",
          "conditionalEventDefinition",
          "signalEventDefinition",
          "errorEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
        ],
      },
      {
        role: "intermediateCatchEvent",
        scope: process,
        allowed: [
          "messageEventDefinition",
          "timerEventDefinition",
          "conditionalEventDefinition",
          "signalEventDefinition",
          "linkEventDefinition",
        ],
      },
      {
        role: "intermediateThrowEvent",
        scope: process,
        allowed: [
          "messageEventDefinition",
          "signalEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
          "linkEventDefinition",
        ],
      },
      {
        role: "boundaryEvent",
        scope: process,
        attached: "tns:Task",
        allowed: [
          "messageEventDefinition",
          "timerEventDefinition",
          "conditionalEventDefinition",
          "signalEventDefinition",
          "errorEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
        ],
      },
      {
        role: "boundaryEvent",
        scope: process,
        attached: "tns:Transaction",
        allowed: [
          "messageEventDefinition",
          "timerEventDefinition",
          "conditionalEventDefinition",
          "signalEventDefinition",
          "errorEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
          "cancelEventDefinition",
        ],
      },
      {
        role: "endEvent",
        scope: process,
        allowed: [
          "messageEventDefinition",
          "signalEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
          "errorEventDefinition",
          "terminateEventDefinition",
        ],
      },
      {
        role: "endEvent",
        scope: transaction,
        allowed: [
          "messageEventDefinition",
          "signalEventDefinition",
          "escalationEventDefinition",
          "compensateEventDefinition",
          "errorEventDefinition",
          "terminateEventDefinition",
          "cancelEventDefinition",
        ],
      },
    ];
    const kinds: readonly EventDefinitionKind[] = [
      "messageEventDefinition",
      "timerEventDefinition",
      "conditionalEventDefinition",
      "signalEventDefinition",
      "linkEventDefinition",
      "escalationEventDefinition",
      "errorEventDefinition",
      "cancelEventDefinition",
      "compensateEventDefinition",
      "terminateEventDefinition",
    ];
    for (const context of contexts)
      for (const kind of kinds) {
        const definition = {
          "@_id": "PolicyDefinition",
          __$$element: kind,
          ...(kind === "conditionalEventDefinition"
            ? { condition: { __$$text: "ready" } }
            : {}),
          ...(kind === "linkEventDefinition" ? { "@_name": "PolicyLink" } : {}),
        } as EventDefinition;
        const candidate = {
          "@_id": "PolicyEvent",
          __$$element: context.role,
          eventDefinition: [definition],
          ...(context.attached ? { "@_attachedToRef": context.attached } : {}),
        } as BpmnEvent;
        const validate = () =>
          assertEventContext(
            model.definitions,
            candidate,
            context.scope,
            context.role === "boundaryEvent" ? boundary : candidate,
          );
        if (context.allowed.includes(kind))
          expect(
            validate,
            `${context.role}/${context.attached ?? context.scope["@_id"]}/${kind}`,
          ).not.toThrow();
        else
          expect(
            validate,
            `${context.role}/${context.attached ?? context.scope["@_id"]}/${kind}`,
          ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
      }
    // Commands below exercise the real XML owner, not a DTO mirroring a kind.
    model.definitions.rootElement!.unshift({
      "@_id": "SharedMessage",
      __$$element: "messageEventDefinition",
    });
    eventById(model.definitions, "Start").event.eventDefinitionRef = [
      { __$$text: "tns:SharedMessage" },
    ];
    const store = createBpmnEditorStore(
      model,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const original = store.getState().bpmn.model;
    store.setState((state) =>
      setEventDefinitions(
        state.bpmn.model.definitions,
        "Start",
        ["messageEventDefinition", "timerEventDefinition"],
        true,
      ),
    );
    const changed = store.getState().bpmn.model;
    const start = eventById(changed.definitions, "Start").event;
    expect(start.eventDefinitionRef).toEqual([
      { __$$text: "tns:SharedMessage" },
    ]);
    expect(start.eventDefinition).toMatchObject([
      {
        __$$element: "timerEventDefinition",
        timeDuration: { __$$text: "PT1M" },
      },
    ]);
    expect("@_parallelMultiple" in start && start["@_parallelMultiple"]).toBe(
      true,
    );
    expect(changed.definitions.rootElement![0]).toEqual(
      original.definitions.rootElement![0],
    );
    expect(changed.definitions["bpmndi:BPMNDiagram"]).toEqual(
      original.definitions["bpmndi:BPMNDiagram"],
    );
    store.setState((state) =>
      setEventDefinitions(
        state.bpmn.model.definitions,
        "Start",
        ["messageEventDefinition", "timerEventDefinition"],
        true,
      ),
    );
    expect(store.getState().bpmn.model).toBe(changed);
    expect(() =>
      store.setState((state) =>
        setEventDefinitions(state.bpmn.model.definitions, "Start", [
          "linkEventDefinition",
        ]),
      ),
    ).toThrow("BPMN_INVALID_EVENT_CONTEXT");
    expect(store.getState().bpmn.model).toBe(changed);
    expect(
      getMarshaller(getMarshaller(xml).builder.build(changed)).parser.parse(),
    ).toEqual(changed);
    const paired = produce(changed, (model) => {
      const event = eventById(model.definitions, "Start").event;
      if (event.__$$element !== "startEvent")
        throw new Error("Missing payload start");
      event.dataOutput = [
        { "@_id": "TimerPayload", "@_name": "Timer payload" },
        { "@_id": "MessagePayload", "@_name": "Message payload" },
      ];
    });
    const { editEventDefinition, shareEventDefinition } =
      await import("./mutations/event");
    const shared = produce(paired, (model) =>
      shareEventDefinition(model.definitions, "Start", 0),
    );
    const sharedStart = eventById(shared.definitions, "Start").event;
    expect(
      "dataOutput" in sharedStart &&
        sharedStart.dataOutput?.map((output) => output["@_id"]),
    ).toEqual(["MessagePayload", "TimerPayload"]);
    expect(() =>
      produce(paired, (model) =>
        editEventDefinition(model.definitions, "Start", 0),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(() =>
      produce(paired, (model) =>
        editEventDefinition(model.definitions, "Start", 2, {
          kind: "signalEventDefinition",
        }),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
  });
  it("resizes an activity with connected boundary events without leaving their manual route endpoints behind", async () => {
    const xml = await readFile(
      new URL("../fixtures/subprocesses-standard.bpmn", import.meta.url),
      "utf8",
    );
    const marshaller = getMarshaller(xml);
    const baseline = produce(normalize(marshaller.parser.parse()), (model) => {
      const outer = connectionElement(model.definitions, "Outer").element,
        boundary = eventById(model.definitions, "Timeout").event,
        end = eventById(model.definitions, "OuterEnd").event;
      if (outer.__$$element !== "subProcess")
        throw new Error("Missing boundary scope");
      boundary.outgoing = [{ __$$text: "TimeoutFlow" }];
      end.incoming!.push({ __$$text: "TimeoutFlow" });
      outer.flowElement!.push({
        __$$element: "sequenceFlow",
        "@_id": "TimeoutFlow",
        "@_sourceRef": "Timeout",
        "@_targetRef": "OuterEnd",
      });
      addOrGetProcessAndDiagramElements({
        definitions: model.definitions,
      }).diagramElements.push({
        __$$element: "bpmndi:BPMNEdge",
        "@_id": "TimeoutFlowDI",
        "@_bpmnElement": "TimeoutFlow",
        "di:waypoint": [
          { "@_x": 778, "@_y": 488 },
          { "@_x": 850, "@_y": 488 },
          { "@_x": 920, "@_y": 278 },
        ],
      });
    });
    const { resizeNode } = await import("./mutations/resizeNode");
    const resized = produce(baseline, (model) => {
      const { diagramElements } = addOrGetProcessAndDiagramElements({
        definitions: model.definitions,
      });
      const inner = connectionElement(model.definitions, "Inner").element;
      if (inner.__$$element !== "subProcess")
        throw new Error("Missing resized activity");
      resizeNode({
        definitions: model.definitions,
        __readonly_snapGrid: { isEnabled: false, x: 20, y: 20 },
        __readonly_change: {
          bpmnElement: inner,
          nodeType: NODE_TYPES.subProcess,
          shapeIndex: diagramElements.findIndex(
            (shape) => shape["@_bpmnElement"] === "Inner",
          ),
          dimension: { "@_width": 680, "@_height": 350 },
          sourceEdgeIndexes: [
            diagramElements.findIndex(
              (edge) => edge["@_bpmnElement"] === "LeaveInner",
            ),
          ],
          targetEdgeIndexes: [
            diagramElements.findIndex(
              (edge) => edge["@_bpmnElement"] === "EnterInner",
            ),
          ],
        },
      });
    });
    const { diagramElements } = addOrGetProcessAndDiagramElements({
      definitions: resized.definitions,
    });
    expect(
      diagramElements.find((shape) => shape["@_bpmnElement"] === "Timeout"),
    ).toMatchObject({
      "dc:Bounds": { "@_x": 860, "@_y": 502, "@_width": 36, "@_height": 36 },
    });
    expect(
      diagramElements.find((edge) => edge["@_bpmnElement"] === "TimeoutFlow"),
    ).toMatchObject({
      "di:waypoint": [
        { "@_x": 878, "@_y": 538 },
        { "@_x": 850, "@_y": 488 },
        { "@_x": 920, "@_y": 278 },
      ],
    });
    expect(resized.definitions.rootElement).toEqual(
      baseline.definitions.rootElement,
    );
    expect(inspectBpmnSource(marshaller.builder.build(resized)).status).toBe(
      "accepted",
    );
  });
  it("projects nested subprocess ownership and collapses only visibility without removing child XML, DI, routes or outer boundary events", async () => {
    const xml = await readFile(
      new URL("../fixtures/subprocesses-standard.bpmn", import.meta.url),
      "utf8",
    );
    const initial = normalize(getMarshaller(xml).parser.parse());
    const store = createBpmnEditorStore(
      initial,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const diagram = () =>
      store.getState().computed(store.getState()).getDiagramData();
    expect(diagram().nodes).toHaveLength(10);
    expect(diagram().edges).toHaveLength(4);
    expect(diagram().nodesById.get("Manual")?.data.parentXyFlowNode?.id).toBe(
      "Inner",
    );
    expect(diagram().nodesById.get("Inner")?.data.parentXyFlowNode?.id).toBe(
      "OuterLane",
    );
    expect(diagram().nodesById.get("Timeout")?.data.parentXyFlowNode?.id).toBe(
      "Inner",
    );
    store.setState((state) => {
      state.xyFlowReactKieDiagram._selectedNodes = ["Manual"];
      setSubProcessExpanded(state.bpmn.model.definitions, "Inner", false);
    });
    const expected = structuredClone(initial);
    const plane =
      expected.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]!;
    const innerShape = plane["di:DiagramElement"]!.find(
      (shape) => shape["@_id"] === "InnerDI",
    );
    if (innerShape?.__$$element !== "bpmndi:BPMNShape")
      throw new Error("Missing inner shape");
    innerShape["@_isExpanded"] = false;
    expect(store.getState().bpmn.model).toEqual(expected);
    expect(diagram().nodesById.get("Manual")).toMatchObject({
      hidden: true,
      selected: false,
    });
    expect(diagram().selectedNodesById.size).toBe(0);
    expect(diagram().nodesById.get("Inner")?.hidden).toBe(false);
    expect(diagram().nodesById.get("Timeout")?.hidden).toBe(false);
    expect(diagram().edgesById.get("ToManual")?.hidden).toBe(true);
    expect(diagram().edgesById.get("EnterInner")?.hidden).toBe(false);
    store.setState((state) => state.dispatch(state).commitHistory());
    const innerCollapsed = store.getState().bpmn.model;
    store.setState((state) =>
      setSubProcessExpanded(state.bpmn.model.definitions, "Outer", false),
    );
    expect(diagram().nodesById.get("Timeout")?.hidden).toBe(true);
    expect(diagram().nodesById.get("OuterLane")?.hidden).toBe(true);
    expect(diagram().nodesById.get("Outer")?.hidden).toBe(false);
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(innerCollapsed);
    store.setState((state) =>
      setSubProcessExpanded(state.bpmn.model.definitions, "Inner", true),
    );
    expect(store.getState().bpmn.model).toEqual(initial);
    expect(
      getMarshaller(
        getMarshaller(xml).builder.build(store.getState().bpmn.model),
      ).parser.parse(),
    ).toEqual(initial);
    const missing = structuredClone(expected);
    missing.definitions["bpmndi:BPMNDiagram"]![0]["bpmndi:BPMNPlane"]![
      "di:DiagramElement"
    ] = plane["di:DiagramElement"]!.filter(
      (shape) => shape["@_id"] !== "ManualDI",
    );
    const unchanged = structuredClone(missing);
    expect(() =>
      setSubProcessExpanded(missing.definitions, "Inner", true),
    ).toThrow("BPMN_INCOMPLETE_DI");
    expect(missing).toEqual(unchanged);
    store.setState((state) => {
      setSubProcessExpanded(state.bpmn.model.definitions, "Inner", false);
      state.xyFlowReactKieDiagram._selectedNodes = ["Inner"];
    });
    const beforeCopy = store.getState().bpmn.model;
    const { clipboard } = buildClipboardFromDiagram(
      { nodes: diagram().nodes, edges: diagram().edges } as Parameters<
        typeof buildClipboardFromDiagram
      >[0],
      store.getState(),
    );
    expect(
      clipboard.processFlowElements.map((element) => element["@_id"]),
    ).toEqual(["Inner", "Timeout"]);
    expect(clipboard.shapes).toHaveLength(5);
    expect(clipboard.edges).toHaveLength(2);
    expect(clipboard.lanes).toHaveLength(0);
    const fragment = structuredClone(beforeCopy);
    const owner = addOrGetProcessAndDiagramElements({
      definitions: fragment.definitions,
    });
    owner.process.flowElement = clipboard.processFlowElements;
    delete owner.process.laneSet;
    owner.plane["di:DiagramElement"] = [
      ...clipboard.shapes.map((shape) => ({
        ...shape,
        __$$element: "bpmndi:BPMNShape" as const,
      })),
      ...clipboard.edges.map((edge) => ({
        ...edge,
        __$$element: "bpmndi:BPMNEdge" as const,
      })),
    ];
    expect(
      getMarshaller(getMarshaller(xml).builder.build(fragment)).parser.parse(),
    ).toEqual(fragment);
    expect(
      indexBpmnIds(fragment.definitions).getOriginalIds().size,
    ).toBeGreaterThan(10);
    expect(store.getState().bpmn.model).toBe(beforeCopy);
    expect(() =>
      store.setState((state) =>
        reassignFlowSelection({
          definitions: state.bpmn.model.definitions,
          targetOwnerId: "Inner",
          nodeIds: ["Outer"],
        }),
      ),
    ).toThrow("BPMN_ACTIVITY_CYCLE");
    expect(() =>
      store.setState((state) =>
        reassignFlowSelection({
          definitions: state.bpmn.model.definitions,
          targetOwnerId: "Outer",
          nodeIds: ["Manual"],
        }),
      ),
    ).toThrow("BPMN_ACTIVITY_SCOPE");
    expect(store.getState().bpmn.model).toBe(beforeCopy);
    store.setState((state) => state.dispatch(state).commitHistory());
    store.setState((state) => {
      deleteNode({
        definitions: state.bpmn.model.definitions,
        __readonly_bpmnElementId: "Inner",
        __readonly_bpmnEdgeData: [],
      });
    });
    expect(diagram().nodes.map((node) => node.id)).toEqual([
      "RootLane",
      "OuterLane",
      "Outer",
      "OuterStart",
      "OuterEnd",
    ]);
    expect(diagram().edges).toHaveLength(0);
    const deleted = store.getState().bpmn.model;
    expect(
      getMarshaller(getMarshaller(xml).builder.build(deleted)).parser.parse(),
    ).toEqual(deleted);
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(beforeCopy);
    store.setState((state) => {
      state.xyFlowReactKieDiagram._selectedNodes = [
        "Inner",
        "MissingPastedRoot",
      ];
      state.dispatch(state).redo();
    });
    expect(store.getState().xyFlowReactKieDiagram._selectedNodes).toEqual([]);
    store.setState((state) => state.dispatch(state).undo());
    store.setState((state) =>
      reassignFlowSelection({
        definitions: state.bpmn.model.definitions,
        targetOwnerId: "Outer",
        nodeIds: ["InnerStart", "Manual", "InnerEnd"],
      }),
    );
    const moved = activityById(
      store.getState().bpmn.model.definitions,
      "Outer",
    );
    expect(
      "flowElement" in moved &&
        moved.flowElement?.filter((element) =>
          [
            "InnerStart",
            "Manual",
            "InnerEnd",
            "ToManual",
            "FromManual",
          ].includes(element["@_id"]),
        ),
    ).toHaveLength(5);
    expect(
      store.getState().bpmn.model.definitions["bpmndi:BPMNDiagram"],
    ).toEqual(beforeCopy.definitions["bpmndi:BPMNDiagram"]);
    let laneId = "";
    store.setState((state) => {
      laneId = addStandaloneNode({
        definitions: state.bpmn.model.definitions,
        __readonly_element: "lane",
        __readonly_newNode: {
          type: NODE_TYPES.lane,
          data: undefined,
          bounds: { "@_x": 120, "@_y": 120, "@_width": 720, "@_height": 420 },
        },
      }).id;
      moveNodesInsideLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "OuterLane",
        __readonly_nodeIds: [laneId],
      });
    });
    const outer = activityById(
      store.getState().bpmn.model.definitions,
      "Outer",
    );
    expect(
      "laneSet" in outer &&
        outer.laneSet?.[0].lane?.[0].childLaneSet?.lane?.[0]["@_id"],
    ).toBe(laneId);
    const beforeMorph = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setSubProcessKind(
          state.bpmn.model.definitions,
          "Outer",
          "adHocSubProcess",
        ),
      ),
    ).toThrow("BPMN_INVALID_ACTIVITY_CONTEXT");
    expect(store.getState().bpmn.model).toBe(beforeMorph);
    store.setState((state) => {
      setActivityLoop(state.bpmn.model.definitions, "Inner", "sequential");
    });
    const compatible = store.getState().bpmn.model;
    store.setState((state) =>
      setSubProcessKind(
        state.bpmn.model.definitions,
        "Inner",
        "adHocSubProcess",
      ),
    );
    const expectedAdHoc = structuredClone(compatible);
    activityById(expectedAdHoc.definitions, "Inner").__$$element =
      "adHocSubProcess";
    expect(store.getState().bpmn.model).toEqual(expectedAdHoc);
    store.setState((state) =>
      setSubProcessKind(state.bpmn.model.definitions, "Inner", "subProcess"),
    );
    expect(store.getState().bpmn.model).toEqual(compatible);
  });
  it("changes activity loop modes without remapping I/O, recreating compatible MI data or admitting connected compensation handlers", async () => {
    const source = await readFile(
      new URL("../fixtures/tasks-standard.bpmn", import.meta.url),
      "utf8",
    );
    const initial = normalize(getMarshaller(source).parser.parse());
    const store = createBpmnEditorStore(
      initial,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const before = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        setActivityCompensation(state.bpmn.model.definitions, "Task", true),
      ),
    ).toThrow("BPMN_INVALID_ACTIVITY_CONTEXT");
    expect(store.getState().bpmn.model).toBe(before);
    store.setState((state) =>
      setActivityLoop(state.bpmn.model.definitions, "Task", "parallel"),
    );
    const parallel = store.getState().bpmn.model;
    const originalTask = activityById(initial.definitions, "Task");
    const expected = structuredClone(initial);
    activityById(expected.definitions, "Task").loopCharacteristics = {
      "@_id": "Loop",
      __$$element: "multiInstanceLoopCharacteristics",
      "@_isSequential": false,
    };
    expect(parallel).toEqual(expected);
    store.setState((state) => {
      const loop = activityById(
        state.bpmn.model.definitions,
        "Task",
      ).loopCharacteristics;
      if (loop?.__$$element !== "multiInstanceLoopCharacteristics")
        throw new Error("Missing loop");
      loop.loopCardinality = {
        "@_id": "Cardinality",
        __$$text: "items.length",
      };
      loop.inputDataItem = {
        "@_id": "IterationInput",
        "@_name": "iteration input",
        "@_itemSubjectRef": "tns:Payload",
      };
      loop.outputDataItem = {
        "@_id": "IterationOutput",
        "@_name": "iteration result",
        "@_itemSubjectRef": "tns:Payload",
      };
      loop.loopDataInputRef = { __$$text: "Input" };
      loop.loopDataOutputRef = { __$$text: "Output" };
      loop.complexBehaviorDefinition = [
        {
          "@_id": "Behavior",
          condition: {
            "@_id": "Condition",
            "@_language": "urn:condition",
            __$$text: "done",
          },
          event: {
            "@_id": "Implicit",
            "@_name": "Internal completion",
            documentation: [
              {
                "@_id": "ImplicitDocumentation",
                __$$text: "No graphical node",
              },
            ],
          },
        },
      ];
    });
    const rich = store.getState().bpmn.model;
    store.setState((state) =>
      setActivityLoop(state.bpmn.model.definitions, "Task", "sequential"),
    );
    const sequential = store.getState().bpmn.model;
    const richExpected = structuredClone(rich);
    const expectedLoop = activityById(
      richExpected.definitions,
      "Task",
    ).loopCharacteristics;
    if (expectedLoop?.__$$element !== "multiInstanceLoopCharacteristics")
      throw new Error("Missing loop");
    expectedLoop["@_isSequential"] = true;
    expect(sequential).toEqual(richExpected);
    expect(
      store
        .getState()
        .computed(store.getState())
        .getDiagramData()
        .nodesById.has("Implicit"),
    ).toBe(false);
    const written = getMarshaller(source).builder.build(sequential);
    expect(getMarshaller(written).parser.parse()).toEqual(sequential);
    expect(inspectBpmnSource(written).status).toBe("accepted");
    const referenced = structuredClone(sequential);
    referenced.definitions.relationship = [
      {
        "@_id": "Consumer",
        "@_type": "test",
        source: [{ __$$text: "tns:IterationInput" }],
        target: [{ __$$text: "tns:Payload" }],
      },
    ];
    const unchanged = structuredClone(referenced);
    expect(() =>
      setActivityLoop(referenced.definitions, "Task", "standard"),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(referenced).toEqual(unchanged);
    store.setState((state) =>
      setActivityLoop(state.bpmn.model.definitions, "Task", "none"),
    );
    expect(
      activityById(store.getState().bpmn.model.definitions, "Task")
        .ioSpecification,
    ).toEqual(originalTask.ioSpecification);
    expect(
      activityById(store.getState().bpmn.model.definitions, "Task")
        .loopCharacteristics,
    ).toBeUndefined();
  });
  it("owns global tasks only in definitions and atomically repairs scoped call references without touching external names or DI", async () => {
    const source = await readFile(
      new URL("../fixtures/global-tasks-standard.bpmn", import.meta.url),
      "utf8",
    );
    const marshaller = getMarshaller(source);
    const initial = normalize(marshaller.parser.parse());
    expect(inspectBpmnSource(source).status).toBe("accepted");
    expect(
      inspectBpmnSource(
        source.replace(
          'calledElement="tns:GlobalGeneric"',
          'calledElement="tns:Missing"',
        ),
      ),
    ).toMatchObject({
      status: "invalid",
      error: { code: "BPMN_DANGLING_REFERENCE", elementId: "LocalA" },
    });
    const ioModel = structuredClone(initial);
    addGlobalTaskData(ioModel.definitions, "GlobalManual", "input");
    addGlobalTaskData(ioModel.definitions, "GlobalManual", "output");
    const manual = ioModel.definitions.rootElement!.find(
      (root) => root.__$$element === "globalManualTask",
    )!;
    expect(manual.ioSpecification).toMatchObject({
      inputSet: [
        {
          dataInputRefs: [
            { __$$text: manual.ioSpecification!.dataInput![0]["@_id"] },
          ],
        },
      ],
      outputSet: [
        {
          dataOutputRefs: [
            { __$$text: manual.ioSpecification!.dataOutput![0]["@_id"] },
          ],
        },
      ],
    });
    deleteGlobalTaskData(ioModel.definitions, "GlobalManual", "input", 0);
    expect(manual.ioSpecification!.inputSet[0].dataInputRefs).toBeUndefined();
    expect(
      getMarshaller(marshaller.builder.build(ioModel)).parser.parse(),
    ).toEqual(ioModel);
    const interfaceModel = structuredClone(initial);
    const interfaceProcess = addOrGetProcessAndDiagramElements({
      definitions: interfaceModel.definitions,
    }).process;
    interfaceProcess.supportedInterfaceRef = [{ __$$text: "ext:Interface" }];
    Object.assign(interfaceProcess, {
      "@_xmlns": "urn:outside",
      "@_xmlns:tns": "urn:shadow",
    });
    const interfaceExpected = structuredClone(interfaceModel);
    expect(() =>
      setSupportedInterfaces(interfaceModel.definitions, "Process", [
        "internal:Interface",
        "internal:Missing",
      ]),
    ).toThrow("BPMN_INVALID_CALLED_INTERFACE");
    expect(interfaceModel).toEqual(interfaceExpected);
    setSupportedInterfaces(interfaceModel.definitions, "Process", [
      supportedInterfaceChoices(interfaceModel.definitions, interfaceProcess)
        .selected[0],
      "internal:Interface",
    ]);
    const expectedCallable = addOrGetProcessAndDiagramElements({
      definitions: interfaceExpected.definitions,
    }).process;
    Object.assign(expectedCallable, {
      "@_xmlns:tns1": "urn:myoxus:global-tasks",
    });
    expectedCallable.supportedInterfaceRef!.push({
      __$$text: "tns1:Interface",
    });
    expect(interfaceModel).toEqual(interfaceExpected);
    setSupportedInterfaces(interfaceModel.definitions, "GlobalGeneric", []);
    delete interfaceExpected.definitions.rootElement!.find(
      (root) => root.__$$element === "globalTask",
    )!.supportedInterfaceRef;
    expect(interfaceModel).toEqual(interfaceExpected);
    const store = createBpmnEditorStore(
      initial,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const expected = structuredClone(initial);
    const process = addOrGetProcessAndDiagramElements({
      definitions: expected.definitions,
    }).process;
    const call = (id: string) =>
      process.flowElement!.find((element) => element["@_id"] === id)!;
    const originalIndex = indexBpmnIds(expected.definitions);
    expect(originalIndex.referenceCount("GlobalGeneric")).toBe(3);
    expect(
      validCalledElement(expected.definitions, call("LocalA"), "b:Missing"),
    ).toBe(false);
    expect(
      validCalledElement(expected.definitions, call("LocalA"), "tns:Missing"),
    ).toBe(false);
    expect(
      validCalledElement(
        expected.definitions,
        call("External"),
        "ext:GlobalGeneric",
      ),
    ).toBe(true);
    expect(
      validCalledElement(
        expected.definitions,
        call("ForeignDefault"),
        "GlobalGeneric",
      ),
    ).toBe(true);
    expect(
      validCalledElement(
        expected.definitions,
        call("NoDefault"),
        "GlobalGeneric",
      ),
    ).toBe(true);
    expect(
      validCalledElement(expected.definitions, call("NoDefault"), "Missing"),
    ).toBe(false);
    const explicitSelection = structuredClone(initial);
    setCalledElement(explicitSelection.definitions, "ForeignDefault", {
      kind: "internal",
      id: "GlobalGeneric",
    });
    const selected = addOrGetProcessAndDiagramElements({
      definitions: explicitSelection.definitions,
    }).process.flowElement!.find(
      (element) => element["@_id"] === "ForeignDefault",
    );
    if (selected?.__$$element !== "callActivity")
      throw new Error("Missing call activity");
    expect(
      indexBpmnIds(explicitSelection.definitions).resolveReference(
        selected,
        selected["@_calledElement"],
      ),
    ).toBe("GlobalGeneric");
    expect(selected["@_calledElement"]).not.toBe("GlobalGeneric");
    const roots = expected.definitions.rootElement!;
    roots.find((root) => root["@_id"] === "GlobalGeneric")!["@_id"] = "Renamed";
    Object.assign(call("LocalA"), { "@_calledElement": "tns:Renamed" });
    Object.assign(call("LocalB"), { "@_calledElement": "local:Renamed" });
    Object.assign(call("NoDefault"), { "@_calledElement": "Renamed" });
    store.setState((state) =>
      renameGlobalTask(
        state.bpmn.model.definitions,
        "GlobalGeneric",
        "Renamed",
      ),
    );
    expect(store.getState().bpmn.model).toEqual(expected);
    const renamed = store.getState().bpmn.model;
    expect(() =>
      store.setState((state) =>
        renameGlobalTask(state.bpmn.model.definitions, "Renamed", "GlobalUser"),
      ),
    ).toThrow("BPMN_INVALID_ID_RENAME");
    expect(() =>
      store.setState((state) =>
        deleteGlobalTask(state.bpmn.model.definitions, "Renamed"),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(store.getState().bpmn.model).toBe(renamed);
    // A known non-call consumer cannot be silently bypassed by clear-all-calls.
    const withRelationship = structuredClone(expected);
    withRelationship.definitions.relationship = [
      {
        "@_id": "Relationship",
        "@_type": "test",
        source: [{ __$$text: "tns:Renamed" }],
        target: [{ __$$text: "tns:GlobalUser" }],
      },
    ];
    const untouched = structuredClone(withRelationship);
    expect(() =>
      deleteGlobalTask(withRelationship.definitions, "Renamed", {
        kind: "clear",
      }),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    expect(withRelationship).toEqual(untouched);
    store.setState((state) => state.dispatch(state).commitHistory());
    store.setState((state) =>
      deleteGlobalTask(state.bpmn.model.definitions, "Renamed", {
        kind: "replace",
        id: "GlobalManual",
      }),
    );
    const after = store.getState().bpmn.model;
    const afterProcess = addOrGetProcessAndDiagramElements({
      definitions: after.definitions,
    }).process;
    const references = indexBpmnIds(after.definitions);
    for (const id of ["LocalA", "LocalB", "NoDefault"]) {
      const value = afterProcess.flowElement!.find(
        (element) => element["@_id"] === id,
      )!;
      expect(
        value.__$$element === "callActivity" &&
          references.resolveReference(value, value["@_calledElement"]),
      ).toBe("GlobalManual");
    }
    expect(
      afterProcess.flowElement!.find(
        (element) => element["@_id"] === "External",
      ),
    ).toEqual(call("External"));
    expect(
      afterProcess.flowElement!.find(
        (element) => element["@_id"] === "ForeignDefault",
      ),
    ).toEqual(call("ForeignDefault"));
    expect(after.definitions["bpmndi:BPMNDiagram"]).toEqual(
      initial.definitions["bpmndi:BPMNDiagram"],
    );
    expect(
      getMarshaller(marshaller.builder.build(after)).parser.parse(),
    ).toEqual(after);
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(renamed);
    store.setState((state) => state.dispatch(state).redo());
    expect(store.getState().bpmn.model).toBe(after);
    for (const kind of [
      "globalTask",
      "globalUserTask",
      "globalManualTask",
      "globalScriptTask",
      "globalBusinessRuleTask",
    ] as const) {
      const model = structuredClone(initial);
      const created = createGlobalTask(
        model.definitions,
        kind,
        "Created callable",
      );
      if (created.__$$element === "globalScriptTask") {
        created["@_scriptLanguage"] = "urn:created:script";
        created.script = { __$$text: "return created;" };
      }
      if (
        created.__$$element === "globalUserTask" ||
        created.__$$element === "globalBusinessRuleTask"
      )
        created["@_implementation"] = "urn:created:implementation";
      setCalledElement(model.definitions, "LocalA", {
        kind: "internal",
        id: created["@_id"],
      });
      expect(created.__$$element).toBe(kind);
      expect(model.definitions["bpmndi:BPMNDiagram"]).toEqual(
        initial.definitions["bpmndi:BPMNDiagram"],
      );
      expect(
        getMarshaller(marshaller.builder.build(model)).parser.parse(),
      ).toEqual(model);
      deleteGlobalTask(model.definitions, created["@_id"], { kind: "clear" });
      const cleared = structuredClone(initial);
      const clearedCall = addOrGetProcessAndDiagramElements({
        definitions: cleared.definitions,
      }).process.flowElement!.find((element) => element["@_id"] === "LocalA");
      if (clearedCall?.__$$element !== "callActivity")
        throw new Error("Missing call activity");
      delete clearedCall["@_calledElement"];
      expect(model).toEqual(cleared);
    }
  });
  it("morphs every standard task without rebuilding compatible I/O, resources, loops, references or DI", async () => {
    const xml = await readFile(
      new URL("../fixtures/tasks-standard.bpmn", import.meta.url),
      "utf8",
    );
    const initial = normalize(getMarshaller(xml).parser.parse());
    for (const to of [
      "task",
      "userTask",
      "manualTask",
      "businessRuleTask",
      "serviceTask",
      "scriptTask",
      "sendTask",
      "receiveTask",
    ] as const) {
      const expected = structuredClone(initial);
      const expectedTask = addOrGetProcessAndDiagramElements({
        definitions: expected.definitions,
      }).process.flowElement!.find((element) => element["@_id"] === "Task")!;
      if (expectedTask.__$$element !== "receiveTask")
        throw new Error("Missing receive task");
      // Independent schema expectations: only receive keeps instantiate, only
      // send/receive keep message, only service/send/receive keep operation, and
      // generic/manual/script do not permit implementation. All inherited XML stays.
      if (to !== "receiveTask") delete expectedTask["@_instantiate"];
      if (to !== "receiveTask" && to !== "sendTask")
        delete expectedTask["@_messageRef"];
      if (to !== "receiveTask" && to !== "sendTask" && to !== "serviceTask")
        delete expectedTask["@_operationRef"];
      if (to === "task" || to === "manualTask" || to === "scriptTask")
        delete expectedTask["@_implementation"];
      Object.assign(expectedTask, { __$$element: to });
      const store = createBpmnEditorStore(
        initial,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
      store.setState((state) =>
        morphTask({
          definitions: state.bpmn.model.definitions,
          id: "Task",
          from: "receiveTask",
          to,
        }),
      );
      const current = store.getState();
      expect(current.bpmn.model).toEqual(expected);
      const projected = current
        .computed(current)
        .getDiagramData()
        .nodesById.get("Task");
      expect(projected?.type).toBe(NODE_TYPES.task);
      expect(projected?.data.parentXyFlowNode?.id).toBe("Lane");
      const { clipboard } = buildClipboardFromDiagram(
        {
          nodes: current
            .computed(current)
            .getDiagramData()
            .nodes.map((node) => ({ ...node, selected: node.id === "Task" })),
          edges: [],
        } as Parameters<typeof buildClipboardFromDiagram>[0],
        current,
      );
      expect(clipboard.processFlowElements[0].__$$element).toBe(to);
      const written = getMarshaller(xml).builder.build(current.bpmn.model);
      expect(inspectBpmnSource(written).status).toBe("accepted");
      expect(getMarshaller(written).parser.parse()).toEqual(expected);
      store.setState((state) => state.dispatch(state).undo());
      expect(store.getState().bpmn.model).toEqual(initial);
      store.setState((state) => state.dispatch(state).redo());
      expect(store.getState().bpmn.model).toEqual(expected);
    }
  });
  it("relocates, copies and deletes an actual lane subtree without reowning its process tasks or changing DI", async () => {
    const xml = await readFile(
      new URL("../fixtures/lanes-standard.bpmn", import.meta.url),
      "utf8",
    );
    const marshaller = getMarshaller(xml);
    const store = createBpmnEditorStore(
      marshaller.parser.parse(),
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const initial = store.getState().bpmn.model;
    const { setLanePartitionReference, lanePartitionOwner } =
      await import("./mutations/lane-partition");
    const partition = structuredClone(initial);
    for (const id of ["Definitions", "OuterDI"])
      expect(() =>
        setLanePartitionReference(partition.definitions, "Deep", {
          kind: "internal",
          id,
        }),
      ).toThrow("BPMN_INVALID_LANE_PARTITION");
    expect(partition).toEqual(initial);
    setLanePartitionReference(partition.definitions, "Deep", {
      kind: "reference",
      qname: "TaskA",
    });
    const partitionExpected = structuredClone(initial);
    lanePartitionOwner(partitionExpected.definitions, "Deep")![
      "@_partitionElementRef"
    ] = "TaskA";
    expect(partition).toEqual(partitionExpected);
    setLanePartitionReference(partition.definitions, "Deep", {
      kind: "internal",
      id: "TaskA",
    });
    lanePartitionOwner(partitionExpected.definitions, "Deep")![
      "@_partitionElementRef"
    ] = "tns:TaskA";
    expect(partition).toEqual(partitionExpected);
    setLanePartitionReference(partition.definitions, "Deep", undefined);
    expect(partition).toEqual(initial);
    const data = () => {
      const state = store.getState();
      return state.computed(state).getDiagramData();
    };
    const parent = (id: string) =>
      data().nodesById.get(id)?.data.parentXyFlowNode?.id;
    store.setState((state) =>
      moveNodesInsideLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "Sibling",
        __readonly_nodeIds: ["Middle", "Deep", "TaskA"],
      }),
    );
    expect([parent("Middle"), parent("Deep"), parent("TaskA")]).toEqual([
      "Sibling",
      "Middle",
      "Deep",
    ]);
    const nested = store.getState().bpmn.model;
    expect(nested.definitions["bpmndi:BPMNDiagram"]).toEqual(
      initial.definitions["bpmndi:BPMNDiagram"],
    );
    expect(() =>
      store.setState((state) =>
        moveNodesInsideLane({
          definitions: state.bpmn.model.definitions,
          __readonly_laneId: "Deep",
          __readonly_nodeIds: ["Sibling"],
        }),
      ),
    ).toThrow("BPMN_LANE_CYCLE");
    expect(store.getState().bpmn.model).toBe(nested);
    store.setState((state) =>
      moveNodesOutOfLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "Sibling",
        __readonly_nodeIds: ["Middle", "TaskA"],
      }),
    );
    expect([parent("Middle"), parent("Deep"), parent("TaskA")]).toEqual([
      undefined,
      "Middle",
      "Deep",
    ]);
    const beforeCopy = store.getState().bpmn.model;
    const current = store.getState();
    const diagram = data();
    const { clipboard, copiedNodesById } = buildClipboardFromDiagram(
      {
        nodes: diagram.nodes.map((node) => ({
          ...node,
          selected: node.id === "Middle",
        })),
        edges: diagram.edges,
      } as Parameters<typeof buildClipboardFromDiagram>[0],
      current,
    );
    expect(new Set(copiedNodesById.keys())).toEqual(
      new Set(["Middle", "Deep", "TaskA"]),
    );
    expect(clipboard.lanes).toHaveLength(1);
    expect(clipboard.lanes[0]["@_id"]).toBe("Middle");
    expect(clipboard.lanes[0].childLaneSet?.lane?.[0]["@_id"]).toBe("Deep");
    expect(
      clipboard.processFlowElements.map((element) => element["@_id"]),
    ).toEqual(["TaskA"]);
    const copied = structuredClone(beforeCopy);
    const owner = addOrGetProcessAndDiagramElements({
      definitions: copied.definitions,
    });
    owner.process.laneSet = [{ "@_id": "CopiedLanes", lane: clipboard.lanes }];
    owner.process.flowElement = clipboard.processFlowElements;
    owner.plane["di:DiagramElement"] = clipboard.shapes.map((shape) => ({
      ...shape,
      __$$element: "bpmndi:BPMNShape" as const,
    }));
    const copiedIndex = indexBpmnIds(copied.definitions);
    expect(
      new Set(
        clipboard.shapes.map((shape) =>
          copiedIndex.resolveReference(
            owner.plane["di:DiagramElement"]!.find(
              (element) => element["@_id"] === shape["@_id"],
            )!,
            shape["@_bpmnElement"],
          ),
        ),
      ),
    ).toEqual(new Set(["Middle", "Deep", "TaskA"]));
    const written = marshaller.builder.build(copied);
    expect(getMarshaller(written).parser.parse()).toEqual(copied);
    expect(store.getState().bpmn.model).toBe(beforeCopy);
    // The mounted editor commits completed gestures synchronously. This pure
    // store harness uses that same history command before the next operation.
    store.setState((state) => state.dispatch(state).commitHistory());
    store.setState((state) => {
      deleteNode({
        definitions: state.bpmn.model.definitions,
        __readonly_bpmnElementId: "Middle",
        __readonly_bpmnEdgeData: [],
      });
    });
    expect(data().nodes).toHaveLength(6);
    expect(parent("TaskA")).toBeUndefined();
    expect(data().nodesById.get("TaskA")?.data.shape).toEqual(
      diagram.nodesById.get("TaskA")?.data.shape,
    );
    const deletedOwner = addOrGetProcessAndDiagramElements({
      definitions: store.getState().bpmn.model.definitions,
    });
    expect(deletedOwner.process.flowElement).toEqual(
      addOrGetProcessAndDiagramElements({ definitions: initial.definitions })
        .process.flowElement,
    );
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(beforeCopy);
    expect(parent("TaskA")).toBe("Deep");
  });
  it("projects every lane depth observationally and changes only explicitly reassigned memberships", async () => {
    const xml = await readFile(
      new URL("../fixtures/lanes-standard.bpmn", import.meta.url),
      "utf8",
    );
    const marshaller = getMarshaller(xml);
    const initial = marshaller.parser.parse();
    const store = createBpmnEditorStore(
      initial,
      new ComputedStateCache<ReturnType<State["computed"]>>(
        INITIAL_COMPUTED_CACHE,
      ),
    );
    const data = () => {
      const state = store.getState();
      return state.computed(state).getDiagramData();
    };
    expect(data().nodes).toHaveLength(8);
    const parent = (id: string) =>
      data().nodesById.get(id)?.data.parentXyFlowNode?.id;
    expect([
      parent("Middle"),
      parent("Deep"),
      parent("TaskA"),
      parent("TaskB"),
      parent("TaskC"),
    ]).toEqual(["Outer", "Middle", "Deep", "Sibling", "Other"]);
    expect(store.getState().bpmn.model).toEqual(initial);
    const before = store.getState().bpmn.model;
    const expected = structuredClone(before);
    const { process } = addOrGetProcessAndDiagramElements({
      definitions: expected.definitions,
    });
    visitLanes(process, ({ lane }) => {
      if (lane["@_id"] === "Middle" || lane["@_id"] === "Deep")
        delete lane.flowNodeRef;
      if (lane["@_id"] === "Sibling")
        lane.flowNodeRef!.push({ __$$text: "TaskA" });
    });
    store.setState((state) =>
      moveNodesInsideLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "Sibling",
        __readonly_nodeIds: ["TaskA", "TaskA"],
      }),
    );
    expect(store.getState().bpmn.model).toEqual(expected);
    expect(parent("TaskA")).toBe("Sibling");
    store.setState((state) => state.dispatch(state).undo());
    expect(store.getState().bpmn.model).toBe(before);
    expect(parent("TaskA")).toBe("Deep");
    store.setState((state) => state.dispatch(state).redo());
    const moved = store.getState().bpmn.model;
    const reopened = getMarshaller(
      marshaller.builder.build(moved),
    ).parser.parse();
    expect(reopened).toEqual(expected);
    store.setState((state) =>
      moveNodesOutOfLane({
        definitions: state.bpmn.model.definitions,
        __readonly_laneId: "Sibling",
        __readonly_nodeIds: ["TaskA", "TaskB"],
      }),
    );
    expect(parent("TaskA")).toBeUndefined();
    expect(parent("TaskB")).toBeUndefined();
    expect(parent("TaskC")).toBe("Other");
    expect(
      store.getState().bpmn.model.definitions["bpmndi:BPMNDiagram"],
    ).toEqual(before.definitions["bpmndi:BPMNDiagram"]);
    const ambiguous = normalize(initial);
    const owner = addOrGetProcessAndDiagramElements({
      definitions: ambiguous.definitions,
    });
    owner.process.laneSet!.push({ "@_id": "Independent" });
    const untouched = structuredClone(ambiguous);
    expect(() => addOrGetLanes({ definitions: ambiguous.definitions })).toThrow(
      "BPMN_UNSUPPORTED_ELEMENT",
    );
    expect(ambiguous).toEqual(untouched);
  });
  it("rejects ambiguous or absent owners before graph and definitions mutations", async () => {
    const source = await readFile(
      new URL("../fixtures/profile-initial.bpmn", import.meta.url),
      "utf8",
    );
    for (const [xml, code] of [
      [
        source.replace(/<process\b[\s\S]*?<\/process>/, ""),
        "BPMN_OWNER_CARDINALITY",
      ],
      [
        source.replace("</process>", '</process><process id="OtherProcess"/>'),
        "BPMN_OWNER_CARDINALITY",
      ],
      [
        source.replace(
          "</definitions>",
          '<bpmndi:BPMNDiagram id="OtherDiagram"><bpmndi:BPMNPlane id="OtherPlane" bpmnElement="Process"/></bpmndi:BPMNDiagram></definitions>',
        ),
        "BPMN_OWNER_CARDINALITY",
      ],
      [
        source.replace(
          "</bpmndi:BPMNDiagram>",
          '<bpmndi:BPMNPlane id="OtherPlane" bpmnElement="Process"/></bpmndi:BPMNDiagram>',
        ),
        "BPMN_OWNER_CARDINALITY",
      ],
      [
        source.replace(
          'id="Plane" bpmnElement="Process"',
          'id="Plane" bpmnElement="OtherProcess"',
        ),
        "BPMN_PLANE_OWNER",
      ],
      [
        source.replace(
          "</definitions>",
          '<collaboration id="Excluded"/></definitions>',
        ),
        "BPMN_UNSUPPORTED_ELEMENT",
      ],
    ]) {
      // Deliberately bypass normalized-source admission to protect each private
      // mutation entry itself, not merely the public import control above it.
      const model = getMarshaller(xml).parser.parse() as ReturnType<
        typeof normalize
      >;
      const before = structuredClone(model);
      expect(() =>
        addOrGetMessages({
          definitions: model.definitions,
          messageName: "Must not be inserted",
        }),
      ).toThrow(code);
      expect(() =>
        addStandaloneNode({
          definitions: model.definitions,
          __readonly_element: "task",
          __readonly_newNode: {
            type: NODE_TYPES.task,
            bounds: { "@_x": 0, "@_y": 0, "@_width": 100, "@_height": 80 },
            data: undefined,
          },
        }),
      ).toThrow(code);
      expect(model).toEqual(before);
    }
  });
  it.each(["model-default", "target-default"])(
    "keeps complete DI through namespace change, creation, movement, deletion and reopen (%s)",
    (namespaceMode) => {
      let xml = createBlankBpmnSource();
      if (namespaceMode === "target-default")
        xml = xml
          .replace(
            'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"',
            'xmlns="urn:fixture:old" xmlns:b="http://www.omg.org/spec/BPMN/20100524/MODEL"',
          )
          .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g, "<$1b:$2");
      const marshaller = getMarshaller(xml);
      const model = normalize(marshaller.parser.parse());
      model.definitions["@_targetNamespace"] = "urn:fixture:old";
      changeBpmnTargetNamespace(model.definitions, "urn:fixture:new");
      const first = addStandaloneNode({
        definitions: model.definitions,
        __readonly_element: "startEvent",
        __readonly_newNode: {
          type: NODE_TYPES.startEvent,
          bounds: { "@_x": 60, "@_y": 60, "@_width": 60, "@_height": 60 },
          data: undefined,
        },
      });
      const append = (
        sourceId: string,
        sourceType: BpmnNodeType,
        type: BpmnNodeType,
        x: number,
      ) => {
        const source = addOrGetProcessAndDiagramElements({
          definitions: model.definitions,
        }).diagramElements.find(
          (element) =>
            element.__$$element === "bpmndi:BPMNShape" &&
            indexBpmnIds(model.definitions).resolveReference(
              element,
              element["@_bpmnElement"],
            ) === sourceId,
        );
        if (source?.__$$element !== "bpmndi:BPMNShape")
          throw new Error("Missing source shape");
        return addConnectedNode({
          definitions: model.definitions,
          __readonly_sourceNode: {
            id: sourceId,
            type: sourceType,
            shapeId: source["@_id"],
            bounds: source["dc:Bounds"],
          },
          __readonly_newNode: {
            type,
            bounds: { "@_x": x, "@_y": 60, "@_width": 100, "@_height": 80 },
          },
        });
      };
      const task = append(
        first.id,
        NODE_TYPES.startEvent,
        NODE_TYPES.task,
        200,
      );
      append(task.id, NODE_TYPES.task, NODE_TYPES.endEvent, 400);
      const { process, diagramElements } = addOrGetProcessAndDiagramElements({
        definitions: model.definitions,
      });
      expect(
        process.flowElement?.map((element) => element.__$$element),
      ).toEqual([
        "startEvent",
        "task",
        "sequenceFlow",
        "endEvent",
        "sequenceFlow",
      ]);
      expect(diagramElements).toHaveLength(5);
      expect(
        new Set(
          diagramElements.map((element) =>
            indexBpmnIds(model.definitions).resolveReference(
              element,
              element["@_bpmnElement"],
            ),
          ),
        ),
      ).toEqual(
        new Set(process.flowElement?.map((element) => element["@_id"])),
      );
      const references = indexBpmnIds(model.definitions);
      const sourceShape = diagramElements.find(
        (element) =>
          element.__$$element === "bpmndi:BPMNShape" &&
          references.resolveReference(element, element["@_bpmnElement"]) ===
            first.id,
      );
      const taskShape = diagramElements.find(
        (element) =>
          element.__$$element === "bpmndi:BPMNShape" &&
          references.resolveReference(element, element["@_bpmnElement"]) ===
            task.id,
      );
      const flow = process.flowElement!.find(
        (element) =>
          element.__$$element === "sequenceFlow" &&
          element["@_sourceRef"] === first.id,
      );
      if (
        sourceShape?.__$$element !== "bpmndi:BPMNShape" ||
        taskShape?.__$$element !== "bpmndi:BPMNShape" ||
        flow?.__$$element !== "sequenceFlow"
      )
        throw new Error("Missing connection");
      const edge = diagramElements.find(
        (element) =>
          element.__$$element === "bpmndi:BPMNEdge" &&
          references.resolveReference(element, element["@_bpmnElement"]) ===
            flow["@_id"],
      );
      if (edge?.__$$element !== "bpmndi:BPMNEdge")
        throw new Error("Missing route");
      flow["@_name"] = "Retained flow";
      flow.documentation = [
        { "@_id": "FlowDocs", __$$text: "Keep this documentation" },
      ];
      edge["bpmndi:BPMNLabel"] = {
        "@_id": "FlowLabel",
        "dc:Bounds": { "@_x": 100, "@_y": 120, "@_width": 100, "@_height": 20 },
      };
      taskShape["bpmndi:BPMNLabel"] = {
        "@_id": "TaskLabel",
        "dc:Bounds": { "@_x": 180, "@_y": 80, "@_width": 160, "@_height": 30 },
      };
      const beforeReconnect = structuredClone(model);
      addEdge({
        definitions: model.definitions,
        __readonly_edge: {
          type: EDGE_TYPES.sequenceFlow,
          sourceHandle: PositionalNodeHandleId.Center,
          targetHandle: PositionalNodeHandleId.Center,
          autoPositionedEdgeMarker: AutoPositionedEdgeMarker.BOTH,
          name: undefined,
          documentation: undefined,
        },
        __readonly_keepWaypoints: true,
        __readonly_sourceNode: {
          href: first.id,
          type: NODE_TYPES.startEvent,
          bounds: sourceShape["dc:Bounds"],
          shapeId: sourceShape["@_id"],
        },
        __readonly_targetNode: {
          href: task.id,
          type: NODE_TYPES.task,
          bounds: taskShape["dc:Bounds"],
          shapeId: taskShape["@_id"],
        },
      });
      expect(model).toEqual(beforeReconnect);
      const copyState = createBpmnEditorStore(
        model,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      ).getState();
      const diagram = copyState.computed(copyState).getDiagramData();
      const { clipboard } = buildClipboardFromDiagram(
        {
          nodes: diagram.nodes.map((node) => ({ ...node, selected: true })),
          edges: diagram.edges,
        } as Parameters<typeof buildClipboardFromDiagram>[0],
        copyState,
      );
      const copiedModel = structuredClone(model);
      const copiedOwner = addOrGetProcessAndDiagramElements({
        definitions: copiedModel.definitions,
      });
      copiedOwner.process.flowElement = clipboard.processFlowElements;
      copiedOwner.plane["di:DiagramElement"] = [
        ...clipboard.shapes.map((shape) => ({
          ...shape,
          __$$element: "bpmndi:BPMNShape" as const,
        })),
        ...clipboard.edges.map((edge) => ({
          ...edge,
          __$$element: "bpmndi:BPMNEdge" as const,
        })),
      ];
      expect(
        inspectBpmnSource(marshaller.builder.build(copiedModel)).status,
      ).toBe("accepted");
      const copiedTask = clipboard.processFlowElements.find(
        (element) => element["@_id"] === task.id,
      );
      if (copiedTask?.__$$element !== "task")
        throw new Error("Missing copied task");
      expect(copiedTask.incoming).toHaveLength(1);
      expect(copiedTask.outgoing).toHaveLength(1);
      expect(model).toEqual(beforeReconnect);
      const written = marshaller.builder.build(model);
      expect(getMarshaller(written).parser.parse()).toEqual(model);
      expect(inspectBpmnSource(written).status).toBe("accepted");
      const taskIndex = diagramElements.findIndex(
        (element) =>
          indexBpmnIds(model.definitions).resolveReference(
            element,
            element["@_bpmnElement"],
          ) === task.id,
      );
      const edgeIndexes = (reference: "@_sourceRef" | "@_targetRef") =>
        diagramElements.flatMap((element, index) =>
          element.__$$element === "bpmndi:BPMNEdge" &&
          process.flowElement?.some(
            (flow) =>
              flow.__$$element === "sequenceFlow" &&
              flow[reference] === task.id &&
              flow["@_id"] ===
                indexBpmnIds(model.definitions).resolveReference(
                  element,
                  element["@_bpmnElement"],
                ),
          )
            ? [index]
            : [],
        );
      repositionNode({
        definitions: model.definitions,
        controlWaypointsByEdge: new Map(),
        __readonly_change: {
          type: "offset",
          nodeType: NODE_TYPES.task,
          shapeIndex: taskIndex,
          sourceEdgeIndexes: edgeIndexes("@_sourceRef"),
          targetEdgeIndexes: edgeIndexes("@_targetRef"),
          selectedEdges: [],
          offset: { deltaX: 20, deltaY: 40 },
        },
      });
      expect(taskShape["bpmndi:BPMNLabel"]).toEqual({
        "@_id": "TaskLabel",
        "dc:Bounds": { "@_x": 200, "@_y": 120, "@_width": 160, "@_height": 30 },
      });
      expect(edge["bpmndi:BPMNLabel"]?.["dc:Bounds"]).toEqual({
        "@_x": 100,
        "@_y": 120,
        "@_width": 100,
        "@_height": 20,
      });
      const grouped = produce(beforeReconnect, (draft) => {
        const control = new Map<number, Set<number>>(),
          refs = indexBpmnIds(draft.definitions);
        const { diagramElements } = addOrGetProcessAndDiagramElements({
          definitions: draft.definitions,
        });
        for (const id of [first.id, task.id])
          repositionNode({
            definitions: draft.definitions,
            controlWaypointsByEdge: control,
            __readonly_change: {
              type: "offset",
              nodeType:
                id === first.id ? NODE_TYPES.startEvent : NODE_TYPES.task,
              shapeIndex: diagramElements.findIndex(
                (shape) =>
                  refs.resolveReference(shape, shape["@_bpmnElement"]) === id,
              ),
              sourceEdgeIndexes:
                id === first.id
                  ? [
                      diagramElements.indexOf(
                        diagramElements.find(
                          (shape) =>
                            refs.resolveReference(
                              shape,
                              shape["@_bpmnElement"],
                            ) === flow["@_id"],
                        )!,
                      ),
                    ]
                  : edgeIndexes("@_sourceRef"),
              targetEdgeIndexes:
                id === task.id ? edgeIndexes("@_targetRef") : [],
              selectedEdges: [flow["@_id"]],
              offset: { deltaX: 20, deltaY: 40 },
            },
          });
      });
      const groupEdge = addOrGetProcessAndDiagramElements({
        definitions: grouped.definitions,
      }).diagramElements.find(
        (element) =>
          indexBpmnIds(grouped.definitions).resolveReference(
            element,
            element["@_bpmnElement"],
          ) === flow["@_id"],
      );
      if (groupEdge?.__$$element !== "bpmndi:BPMNEdge")
        throw new Error("Missing moved route");
      expect(groupEdge["bpmndi:BPMNLabel"]).toEqual({
        "@_id": "FlowLabel",
        "dc:Bounds": { "@_x": 120, "@_y": 160, "@_width": 100, "@_height": 20 },
      });
      expect(inspectBpmnSource(marshaller.builder.build(model)).status).toBe(
        "accepted",
      );
      const store = createBpmnEditorStore(
        model,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
      const state = store.getState();
      const data = state.computed(state).getDiagramData();
      const deleted = produce(model, (draft) => {
        deleteNode({
          definitions: draft.definitions,
          __readonly_bpmnElementId: task.id,
          __readonly_bpmnEdgeData: data.edges.map((edge) => edge.data!),
        });
      });
      const afterDelete = inspectBpmnSource(marshaller.builder.build(deleted));
      expect(afterDelete.status).toBe("accepted");
      expect(
        deleted.definitions.rootElement
          ?.find((element) => element.__$$element === "process")
          ?.flowElement?.map((element) => element.__$$element),
      ).toEqual(["startEvent", "endEvent"]);
    },
  );
  it("creates untyped standard properties without empty QNames and preserves referenced property contracts on deletion", async () => {
    const xml = await readFile(
      new URL("../fixtures/data-associations-standard.bpmn", import.meta.url),
      "utf8",
    );
    const marshaller = getMarshaller(xml),
      initial = normalize(marshaller.parser.parse());
    const {
      addVariable,
      deleteVariable,
      propertyOwnerById,
      findOwnedProperty,
    } = await import("./mutations/addVariable");
    const created = produce(initial, (model) => {
      for (const pId of ["Process", "Sub", "Review", "Start"])
        addVariable({ definitions: model.definitions, pId });
    });
    const { process } = addOrGetProcessAndDiagramElements({
      definitions: created.definitions,
    });
    const sub = connectionElement(created.definitions, "Sub").element;
    if (sub.__$$element !== "subProcess")
      throw new Error("Missing nested property owner");
    const outer = process.property![0],
      inner = sub.property![0];
    expect(outer).not.toHaveProperty("@_itemSubjectRef");
    expect(inner).not.toHaveProperty("@_itemSubjectRef");
    expect(inspectBpmnSource(marshaller.builder.build(created)).status).toBe(
      "accepted",
    );
    const consumed = produce(created, (model) => {
      const review = connectionElement(model.definitions, "Review").element;
      if (review.__$$element !== "task")
        throw new Error("Missing property consumer");
      review.dataOutputAssociation!.push({
        "@_id": "PropertyConsumer",
        sourceRef: [{ __$$text: "Out" }],
        targetRef: { __$$text: outer["@_id"] },
      });
    });
    expect(inspectBpmnSource(marshaller.builder.build(consumed)).status).toBe(
      "accepted",
    );
    expect(() =>
      produce(consumed, (model) =>
        deleteVariable(model.definitions, "Process", outer["@_id"]),
      ),
    ).toThrow("BPMN_DEFINITION_IN_USE");
    const deleted = produce(created, (model) => {
      for (const id of ["Process", "Sub", "Review", "Start"])
        deleteVariable(
          model.definitions,
          id,
          propertyOwnerById(model.definitions, id).property![0]["@_id"],
        );
    });
    expect(deleted).toEqual(initial);
    const anonymousModel = marshaller.parser.parse();
    const anonymousProcess = anonymousModel.definitions.rootElement!.find(
      (root) => root.__$$element === "process",
    )!;
    const review = anonymousProcess.flowElement!.find(
      (element) => element["@_id"] === "Review",
    )!;
    if (review.__$$element !== "task")
      throw new Error("Missing anonymous property owner");
    review.property = [{ "@_name": "first" }, { "@_name": "second" }];
    const anonymous = normalize(anonymousModel);
    const renamed = produce(anonymous, (model) => {
      findOwnedProperty(
        propertyOwnerById(model.definitions, "Review"),
        undefined,
        1,
      )!["@_name"] = "second edited";
    });
    expect(propertyOwnerById(renamed.definitions, "Review").property).toEqual([
      { "@_name": "first" },
      { "@_name": "second edited" },
    ]);
    const removed = produce(renamed, (model) =>
      deleteVariable(model.definitions, "Review", undefined, 1),
    );
    expect(propertyOwnerById(removed.definitions, "Review").property).toEqual([
      { "@_name": "first" },
    ]);
    expect(inspectBpmnSource(marshaller.builder.build(removed)).status).toBe(
      "accepted",
    );
  });
  it("edits one mapping without rebuilding unaffected standard I/O, sets or assignment identities", async () => {
    const task: WithDataMapping = {
      __$$element: "task",
      "@_id": "Task",
      ioSpecification: {
        "@_id": "IO",
        documentation: [{ "@_id": "Documentation", __$$text: "Preserve" }],
        dataInput: [
          {
            "@_id": "Input",
            "@_name": "before",
            "@_itemSubjectRef": "tns:Type",
            "@_isCollection": true,
          },
        ],
        dataOutput: [{ "@_id": "Output", "@_name": "result" }],
        inputSet: [
          {
            "@_id": "Inputs",
            dataInputRefs: [{ __$$text: "Input" }],
            optionalInputRefs: [{ __$$text: "Input" }],
          },
        ],
        outputSet: [
          { "@_id": "Outputs", dataOutputRefs: [{ __$$text: "Output" }] },
        ],
      },
      dataInputAssociation: [
        {
          "@_id": "Association",
          sourceRef: [{ __$$text: "Variable" }],
          targetRef: { __$$text: "Input" },
          transformation: {
            "@_id": "Transform",
            __$$text: "richer standard content",
          },
        },
      ],
      dataOutputAssociation: [
        {
          "@_id": "ResultAssociation",
          sourceRef: [{ __$$text: "Output" }],
          targetRef: { __$$text: "Result" },
        },
      ],
    };
    const rows = getDataMapping(task);
    const noChange = produce(task, (draft) =>
      setInputAndOutputDataMapping(
        rows.inputDataMapping,
        rows.outputDataMapping,
        draft,
      ),
    );
    expect(noChange).toBe(task);
    rows.inputDataMapping[0].name = "after";
    const next = produce(task, (draft) =>
      setInputAndOutputDataMapping(
        rows.inputDataMapping,
        rows.outputDataMapping,
        draft,
      ),
    );
    const expected = structuredClone(task);
    expected.ioSpecification!.dataInput![0]["@_name"] = "after";
    expect(next).toEqual(expected);
    const removed = produce(next, (draft) =>
      setInputAndOutputDataMapping([], rows.outputDataMapping, draft),
    );
    expect(removed.ioSpecification?.inputSet).toEqual([{ "@_id": "Inputs" }]);
    expect(removed.ioSpecification?.dataInput).toBeUndefined();
    expect(removed.dataInputAssociation).toBeUndefined();
    expect(removed.dataOutputAssociation).toEqual(task.dataOutputAssociation);
    const expression = {
      ...rows.outputDataMapping[0],
      isExpression: true as const,
      value: "source + 1",
      targetRef: "Result",
    };
    const assigned = produce(task, (draft) =>
      setInputAndOutputDataMapping(
        getDataMapping(task).inputDataMapping,
        [expression],
        draft,
      ),
    );
    expect(assigned.dataOutputAssociation?.[0].targetRef.__$$text).toBe(
      "Result",
    );
    expect(() =>
      produce(task, (draft) =>
        setInputAndOutputDataMapping(
          [],
          [{ ...expression, targetRef: undefined }],
          draft,
        ),
      ),
    ).toThrow("BPMN_OUTPUT_TARGET_REQUIRED");
    const marshaller = getMarshaller(createBlankBpmnSource());
    const authored = produce(normalize(marshaller.parser.parse()), (model) => {
      const { id } = addStandaloneNode({
        definitions: model.definitions,
        __readonly_element: "task",
        __readonly_newNode: {
          type: NODE_TYPES.task,
          data: undefined,
          bounds: { "@_x": 100, "@_y": 100, "@_width": 120, "@_height": 80 },
        },
      });
      const owner = connectionElement(model.definitions, id).element;
      if (owner.__$$element !== "task") throw new Error("Missing fresh task");
      setInputAndOutputDataMapping(
        [{ name: "Request", dtype: "", isExpression: true, value: "1" }],
        [],
        owner,
      );
    });
    const firstWrite = marshaller.builder.build(authored);
    expect(inspectBpmnSource(firstWrite).status).toBe("accepted");
    expect(
      getMarshaller(firstWrite).builder.build(
        getMarshaller(firstWrite).parser.parse(),
      ),
    ).toBe(firstWrite);
    const optionalSource = marshaller.parser.parse(),
      optionalProcess = optionalSource.definitions.rootElement!.find(
        (root) => root.__$$element === "process",
      )!;
    if (optionalProcess.__$$element !== "process")
      throw new Error("Missing process");
    const secondPayload = {
      "@_name": "Second payload",
      "@_xmlns:local": "urn:external:item",
      "@_itemSubjectRef": "local:Type",
    };
    optionalProcess.flowElement = [
      {
        __$$element: "startEvent",
        "@_id": "PayloadEvent",
        dataOutput: [{ "@_name": "First payload" }, secondPayload],
      },
    ];
    optionalProcess.property = [{ "@_id": "Variable" }];
    const optionalModel = normalize(optionalSource),
      optionalEvent = connectionElement(
        optionalModel.definitions,
        "PayloadEvent",
      ).element;
    if (optionalEvent.__$$element !== "startEvent")
      throw new Error("Missing optional payload owner");
    const { setDataMappingForElement, dataMappingTypeOwner } =
        await import("./mutations/data-mapping"),
      optionalRows = getDataMapping(optionalEvent);
    expect(
      dataMappingTypeOwner(
        optionalEvent,
        optionalRows.outputDataMapping[1],
        "output",
      ),
    ).toBe(optionalEvent.dataOutput![1]);
    const edit = (
      model: typeof optionalModel,
      rows = optionalRows.outputDataMapping,
    ) =>
      setDataMappingForElement({
        definitions: model.definitions,
        elementId: "PayloadEvent",
        element: "startEvent",
        inputDataMapping: [],
        outputDataMapping: rows,
      });
    expect(produce(optionalModel, (model) => edit(model))).toBe(optionalModel);
    const optionalEdited = produce(optionalModel, (model) =>
      edit(
        model,
        optionalRows.outputDataMapping.map((row, i) =>
          i === 1 ? { ...row, name: "Renamed second" } : row,
        ),
      ),
    );
    expect(
      connectionElement(optionalEdited.definitions, "PayloadEvent").element,
    ).toEqual({
      ...optionalEvent,
      dataOutput: [
        optionalEvent.dataOutput![0],
        { ...optionalEvent.dataOutput![1], "@_name": "Renamed second" },
      ],
    });
    expect(() =>
      produce(optionalModel, (model) =>
        edit(model, [
          optionalRows.outputDataMapping[0],
          optionalRows.outputDataMapping[0],
        ]),
      ),
    ).toThrow("BPMN_STALE_DATA_MAPPING");
    const removedOptional = produce(optionalModel, (model) =>
      edit(model, [optionalRows.outputDataMapping[1]]),
    );
    expect(
      connectionElement(removedOptional.definitions, "PayloadEvent").element,
    ).toEqual({ ...optionalEvent, dataOutput: [optionalEvent.dataOutput![1]] });
    const boundOptional = produce(optionalModel, (model) =>
        edit(
          model,
          optionalRows.outputDataMapping.map((row, i) =>
            i === 1
              ? { ...row, isExpression: false, variableRef: "Variable" }
              : row,
          ),
        ),
      ),
      boundEvent = connectionElement(
        boundOptional.definitions,
        "PayloadEvent",
      ).element;
    if (boundEvent.__$$element !== "startEvent")
      throw new Error("Missing bound Event");
    expect(boundEvent.dataOutput![0]).toEqual(optionalEvent.dataOutput![0]);
    expect(typeof boundEvent.dataOutput![1]["@_id"]).toBe("string");
    expect(boundEvent.dataOutputAssociation).toMatchObject([
      {
        sourceRef: [{ __$$text: boundEvent.dataOutput![1]["@_id"] }],
        targetRef: { __$$text: "Variable" },
      },
    ]);
  });

  it("keeps undo/redo instance-local, blocks read-only mutation and clears history only on accepted source reset", async () => {
    const xml = await readFile(
      new URL("../fixtures/blank.bpmn", import.meta.url),
      "utf8",
    );
    const model = getMarshaller(xml).parser.parse();
    const create = () =>
      createBpmnEditorStore(
        model,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
    const store = create();
    const other = create();
    const initial = store.getState().bpmn.model;
    store.setState((s) => {
      s.bpmn.model.definitions["@_name"] = "Edited";
    });
    const edited = store.getState().bpmn.model;
    store.setState((s) => s.dispatch(s).undo());
    expect(store.getState().bpmn.model).toBe(initial);
    store.setState((s) => s.dispatch(s).redo());
    expect(store.getState().bpmn.model).toBe(edited);
    store.setState((s) => {
      s.settings.isReadOnly = true;
      s.dispatch(s).undo();
    });
    expect(store.getState().bpmn.model).toBe(edited);
    expect(other.getState().history.past).toEqual([]);
    store.setState((s) => {
      s.dispatch(s).reset(initial);
    });
    expect(store.getState().history).toEqual({
      current: initial,
      past: [],
      future: [],
    });
    store.setState((s) => {
      s.settings.isReadOnly = false;
      s.dispatch(s).undo();
    });
    expect(store.getState().bpmn.model).toBe(initial);
  });
});
