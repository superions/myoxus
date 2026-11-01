// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BPMN_PARSERS,
  getMarshaller,
  type BpmnLatestModel,
} from "./marshaller";
import { ns } from "./schemas/bpmn-2_0/ts-gen/meta";
import { assertSubProcessContext } from "./editor/mutations/activity-context";
import {
  assertConnectionScope,
  associationEndpoints,
} from "./editor/mutations/connection-context";
import { assertEventContext } from "./editor/mutations/event";
import { dataObjectReferenceTarget } from "./editor/mutations/data-context";
import { findProcessIoItem } from "./editor/mutations/process-io-context";
import {
  assertIoSets,
  isEventIoOwner,
  eventIoSpecification,
} from "./editor/mutations/io-context";
import {
  scopeDataAssociations,
  dataAssociationEndpoints,
  dataAssociationRouteEndpoints,
  type DataAssociationLocation,
  type DataAssociationHost,
} from "./editor/mutations/data-association-context";
import {
  isGlobalTask,
  validCalledElement,
} from "./editor/mutations/global-tasks";
import { visitBpmnSourceObjects } from "./editor/mutations/element-visitor";
import { indexBpmnIds } from "./editor/idRandomizer/bpmn-id-randomizer";
import {
  inspectBpmnSemanticFindings,
  type BpmnProfileFinding,
} from "./source-profile";
import {
  decodeBpmnBytes,
  XmlInputError,
  type XmlInputErrorCode,
} from "./xml-parser/preflight";
import type {
  BPMN20__tDefinitions,
  BPMN20__tProcess,
  BPMN20__tSubProcess,
  BPMN20__tLaneSet,
  BPMN20__tResourceRole,
  BPMN20__tInputOutputSpecification,
  BPMNDI__BPMNDiagram,
  BPMNDI__BPMNPlane,
} from "./schemas/bpmn-2_0/ts-gen/types";

const MODEL_NAMESPACE = "http://www.omg.org/spec/BPMN/20100524/MODEL";

export type BpmnSourceErrorCode =
  | XmlInputErrorCode
  | "BPMN_OWNER_CARDINALITY"
  | "BPMN_MISSING_DI"
  | "BPMN_PLANE_OWNER"
  | "BPMN_MISSING_ID"
  | "BPMN_UNSUPPORTED_ELEMENT"
  | "BPMN_UNSUPPORTED_PROPERTY"
  | "BPMN_UNSUPPORTED_EXTENSION"
  | "BPMN_UNSUPPORTED_REFERENCE"
  | "BPMN_INCOMPLETE_DI"
  | "BPMN_DUPLICATE_ID"
  | "BPMN_DANGLING_REFERENCE"
  | "BPMN_UNKNOWN_ROOT"
  | "BPMN_UNKNOWN_NAMESPACE";

/** Stable, payload-free failure; hosts translate the code rather than exposing parser text. */
export class BpmnSourceError extends Error {
  constructor(
    public readonly code: BpmnSourceErrorCode,
    public readonly elementId?: string,
  ) {
    super(code);
    this.name = "BpmnSourceError";
  }
}

export type BpmnProcessOwner = {
  process: BPMN20__tProcess & { __$$element: "process"; "@_id": string };
  diagram: BPMNDI__BPMNDiagram & { "@_id": string };
  plane: BPMNDI__BPMNPlane & { "@_id": string };
};

/** Resolve a local QName without rewriting its lexical spelling or namespace scope. */
export function resolveBpmnReference(
  definitions: BPMN20__tDefinitions,
  reference: string | undefined,
  ...scopes: object[]
): string | undefined {
  if (!reference) return undefined;
  const bindings = new Map<string, string>();
  for (const scope of [definitions, ...scopes])
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value !== "string") continue;
      if (key === "@_xmlns") bindings.set("", value);
      else if (key.startsWith("@_xmlns:"))
        bindings.set(key.slice("@_xmlns:".length), value);
    }
  const parts = reference.split(":");
  if (parts.length === 1) {
    const namespace = bindings.get("");
    return !namespace ||
      namespace === MODEL_NAMESPACE ||
      namespace === definitions["@_targetNamespace"]
      ? reference
      : undefined;
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return bindings.get(parts[0]) === definitions["@_targetNamespace"]
    ? parts[1]
    : undefined;
}

/**
 * Borrow the one existing process/diagram/plane. This never creates owners or
 * empty DI arrays: import inspection and rendering must remain observational.
 * Graph and definitions mutations share this cardinality boundary; definitions
 * helpers may not create roots to make an incomplete document appear usable.
 * Only createBlankBpmnSource creates the owner. Zero/multiple/excluded owners
 * throw before a mutation can select an array index or change any source field.
 */
export function resolveBpmnProcessOwner(
  definitions: BPMN20__tDefinitions,
): BpmnProcessOwner {
  if (
    definitions.rootElement?.some(
      (root) =>
        root.__$$element === "collaboration" ||
        root.__$$element === "choreography" ||
        root.__$$element === "globalChoreographyTask" ||
        root.__$$element === "globalConversation",
    )
  ) {
    throw new BpmnSourceError("BPMN_UNSUPPORTED_ELEMENT");
  }
  const processes =
    definitions.rootElement?.filter((root) => root.__$$element === "process") ??
    [];
  if (
    processes.length !== 1 ||
    (definitions["bpmndi:BPMNDiagram"]?.length ?? 0) > 1
  )
    throw new BpmnSourceError("BPMN_OWNER_CARDINALITY");
  const [process] = processes;
  const [diagram] = definitions["bpmndi:BPMNDiagram"] ?? [];
  const plane = diagram?.["bpmndi:BPMNPlane"];
  if (!diagram || !plane) throw new BpmnSourceError("BPMN_MISSING_DI");
  // Repeated singleton XML children are surfaced as arrays by the parser. Never
  // reinterpret a second process plane as a missing ID on an arbitrary winner.
  if (Array.isArray(plane))
    throw new BpmnSourceError("BPMN_OWNER_CARDINALITY", diagram["@_id"]);
  if (!process["@_id"] || !diagram["@_id"] || !plane["@_id"])
    throw new BpmnSourceError("BPMN_MISSING_ID");
  if (
    resolveBpmnReference(
      definitions,
      plane["@_bpmnElement"],
      diagram,
      plane,
    ) !== process["@_id"]
  )
    throw new BpmnSourceError("BPMN_PLANE_OWNER");
  return { process, diagram, plane } as BpmnProcessOwner;
}

/** New content only: one unnamed standard process and its empty process-owned DI plane. */
export function createBlankBpmnSource(): string {
  // WebCrypto exists in supported browsers, workers and Node 26. Describe only
  // this capability so the source-only compilation does not require DOM types.
  const crypto = (
    globalThis as typeof globalThis & { crypto: { randomUUID(): string } }
  ).crypto;
  const id = (kind: string) => `${kind}_${crypto.randomUUID()}`;
  const processId = id("Process");
  const model: BpmnLatestModel = {
    definitions: {
      "@_id": id("Definitions"),
      "@_targetNamespace": "urn:myoxus:bpmn",
      "@_xmlns": MODEL_NAMESPACE,
      "@_xmlns:bpmndi": "http://www.omg.org/spec/BPMN/20100524/DI",
      "@_xmlns:dc": "http://www.omg.org/spec/DD/20100524/DC",
      "@_xmlns:di": "http://www.omg.org/spec/DD/20100524/DI",
      rootElement: [
        { __$$element: "process", "@_id": processId, "@_isExecutable": false },
      ],
      "bpmndi:BPMNDiagram": [
        {
          "@_id": id("Diagram"),
          "bpmndi:BPMNPlane": {
            "@_id": id("Plane"),
            "@_bpmnElement": processId,
            "di:DiagramElement": [],
          },
        },
      ],
    },
  };
  return BPMN_PARSERS["2.0"].build({ json: model, instanceNs: new Map(ns) });
}

export type BpmnSourceInspection =
  | {
      status: "accepted";
      source: string;
      model: BpmnLatestModel;
      editability: BpmnEditability;
    }
  | {
      status: "unsafe" | "invalid" | "unsupported" | "incomplete-di" | "error";
      source: string;
      error: { code: BpmnSourceErrorCode; elementId?: string };
    };

type BpmnEditability =
  | { state: "editable"; findings: readonly BpmnProfileFinding[] }
  | {
      state: "unsupported";
      findings: readonly BpmnProfileFinding[];
      error: BpmnSourceError;
    };

/** One private whole-source decision; controls borrow the same concrete semantic
 * projection, while import and clipboard must also satisfy actual DI ownership. */
export function inspectBpmnEditability(
  definitions: BPMN20__tDefinitions,
): BpmnEditability {
  const findings = inspectBpmnSemanticFindings(definitions);
  const unsupported = findings.find(
    (finding) => finding.state === "unsupported",
  );
  if (unsupported)
    return {
      state: "unsupported",
      findings,
      error: new BpmnSourceError(unsupported.reason, unsupported.elementId),
    };
  try {
    inspectInitialProcess(definitions);
  } catch (error) {
    if (!(error instanceof BpmnSourceError)) throw error;
    findings.push({
      state: "unsupported",
      reason: error.code,
      elementId: error.elementId,
    });
    return { state: "unsupported", findings, error };
  }
  return { state: "editable", findings };
}

/**
 * Inspect a decoded exact source before the first editable mount. Rejected input
 * is returned untouched and is never passed through the writer. The existing
 * XML parser enforces shared structural budgets before model/profile inspection.
 */
export function inspectBpmnSource(source: string): BpmnSourceInspection {
  try {
    const model = getMarshaller(source).parser.parse();
    const editability = inspectBpmnEditability(model.definitions);
    if (editability.state === "unsupported") throw editability.error;
    return { status: "accepted", source, model, editability };
  } catch (error) {
    let failure: BpmnSourceError;
    if (error instanceof BpmnSourceError) failure = error;
    else if (error instanceof XmlInputError)
      failure = new BpmnSourceError(error.code);
    else {
      switch (error instanceof Error ? error.message : undefined) {
        case "BPMN_UNSAFE_XML":
          failure = new BpmnSourceError("BPMN_UNSAFE_XML");
          break;
        case "BPMN_MALFORMED_XML":
          failure = new BpmnSourceError("BPMN_MALFORMED_XML");
          break;
        case "BPMN_UNKNOWN_ROOT":
          failure = new BpmnSourceError("BPMN_UNKNOWN_ROOT");
          break;
        case "BPMN_UNKNOWN_NAMESPACE":
          failure = new BpmnSourceError("BPMN_UNKNOWN_NAMESPACE");
          break;
        case "BPMN_INVALID_BOOLEAN":
        case "BPMN_INVALID_INTEGER":
        case "BPMN_INVALID_NUMBER":
          failure = new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY");
          break;
        case "BPMN_INVALID_QNAME":
          failure = new BpmnSourceError("BPMN_UNSUPPORTED_REFERENCE");
          break;
        default:
          failure = new BpmnSourceError("BPMN_PARSER_FAILURE");
      }
    }
    const status =
      failure.code === "BPMN_UNSAFE_XML"
        ? "unsafe"
        : failure.code === "BPMN_PARSER_FAILURE"
          ? "error"
          : failure.code === "BPMN_MISSING_DI" ||
              failure.code === "BPMN_INCOMPLETE_DI"
            ? "incomplete-di"
            : failure.code === "BPMN_OWNER_CARDINALITY" ||
                failure.code === "BPMN_UNSUPPORTED_XML_VERSION" ||
                failure.code === "BPMN_UNSUPPORTED_ELEMENT" ||
                failure.code === "BPMN_UNSUPPORTED_PROPERTY" ||
                failure.code === "BPMN_UNSUPPORTED_EXTENSION" ||
                failure.code === "BPMN_UNSUPPORTED_REFERENCE"
              ? "unsupported"
              : "invalid";
    return {
      status,
      source,
      error: { code: failure.code, elementId: failure.elementId },
    };
  }
}

/** New-document import may retain safe BPMN outside the editable profile.
 * Replacement and modelling still require accepted source; unsafe/malformed
 * input and parser failures must never become persisted source heads. */
export function canPreserveBpmnSource(inspection: BpmnSourceInspection) {
  return (
    inspection.status === "accepted" ||
    inspection.status === "incomplete-di" ||
    // XML-version rejection happens during lexical preflight, before the rest
    // of the document or its BPMN root has been validated. It cannot certify a
    // safe preserved source, unlike profile/DI rejection after DOM parsing.
    (inspection.status === "unsupported" &&
      inspection.error.code !== "BPMN_UNSUPPORTED_XML_VERSION")
  );
}

export type BpmnByteInspection =
  | (BpmnSourceInspection & { bytes: Uint8Array })
  | {
      status: "invalid";
      bytes: Uint8Array;
      source?: undefined;
      error: { code: "BPMN_INVALID_UTF8" };
    };

/** File entry uses the same inspector as persisted reopen/recovery. Even an
 * undecodable file retains its exact bytes; it must never become a string head. */
export function inspectBpmnBytes(input: Uint8Array): BpmnByteInspection {
  const bytes = input.slice();
  let source: string;
  try {
    source = decodeBpmnBytes(bytes);
  } catch {
    return { status: "invalid", bytes, error: { code: "BPMN_INVALID_UTF8" } };
  }
  return { ...inspectBpmnSource(source), bytes };
}

function inspectInitialProcess(definitions: BPMN20__tDefinitions) {
  const { process, diagram, plane } = resolveBpmnProcessOwner(definitions);
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const ids = new Set<string>();
  const labelStyles = new Set(
    (diagram["bpmndi:BPMNLabelStyle"] ?? [])
      .map((style) => style["@_id"])
      .filter((id) => id !== undefined),
  );
  const finiteBounds = (
    bounds:
      | { "@_x": number; "@_y": number; "@_width": number; "@_height": number }
      | undefined,
  ) =>
    !!bounds &&
    [bounds["@_x"], bounds["@_y"], bounds["@_width"], bounds["@_height"]].every(
      Number.isFinite,
    ) &&
    bounds["@_width"] > 0 &&
    bounds["@_height"] > 0;
  // Optional documentation/label identities are still XML IDs. Check all active
  // source objects, not only the graphical arrays; opaque vendor attributes are
  // not schema IDs and are deliberately not reinterpreted here.
  visitBpmnSourceObjects(definitions, ({ value, property, elementId }) => {
    const id = value["@_id"];
    if (typeof id === "string") {
      if (!id) throw new BpmnSourceError("BPMN_MISSING_ID");
      if (ids.has(id)) throw new BpmnSourceError("BPMN_DUPLICATE_ID", id);
      ids.add(id);
    }
    // Labels may omit optional bounds, but supplied geometry cannot poison Fit
    // or SVG measurement. They never require a semantic shape of their own.
    if (
      (property === "bpmndi:BPMNLabel" &&
        value["dc:Bounds"] !== undefined &&
        !finiteBounds(
          value["dc:Bounds"] as Parameters<typeof finiteBounds>[0],
        )) ||
      (property === "dc:Font" &&
        value["@_size"] !== undefined &&
        (typeof value["@_size"] !== "number" ||
          !Number.isFinite(value["@_size"]) ||
          value["@_size"] <= 0))
    )
      throw new BpmnSourceError("BPMN_INCOMPLETE_DI", elementId);
  });
  const requiredId = (id: string | undefined) => {
    if (!id) throw new BpmnSourceError("BPMN_MISSING_ID");
    return id;
  };
  for (const root of definitions.rootElement ?? []) {
    if (root.__$$element === "dataStore") {
      requiredId(root["@_id"]);
      if (
        root["@_capacity"] !== undefined &&
        (!Number.isSafeInteger(root["@_capacity"]) || root["@_capacity"] < 0)
      )
        throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", root["@_id"]);
      if (root["@_itemSubjectRef"]) {
        const target = resolveBpmnReference(
          definitions,
          root["@_itemSubjectRef"],
          root,
        );
        if (
          !definitions.rootElement?.some(
            (item) =>
              item.__$$element === "itemDefinition" && item["@_id"] === target,
          )
        )
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", root["@_id"]);
      }
    }
    if (isGlobalTask(root as Parameters<typeof isGlobalTask>[0]))
      requiredId(root["@_id"]);
  }
  type FlowScope = BPMN20__tProcess | BPMN20__tSubProcess;
  visitBpmnSourceObjects(
    definitions,
    ({ value, elementId, property, schemaType }) => {
      if (
        property === "ioSpecification" &&
        schemaType === "BPMN20__tInputOutputSpecification"
      ) {
        try {
          assertIoSets(value as unknown as BPMN20__tInputOutputSpecification);
        } catch {
          throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", elementId);
        }
      }
      if (isEventIoOwner(value)) {
        try {
          assertIoSets(
            eventIoSpecification(value as unknown as DataAssociationHost),
            false,
          );
        } catch {
          throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", elementId);
        }
      }
    },
  );
  // Resource roles are non-graphical, but their QName targets still have concrete
  // kinds and ownership. A parameter in another resource is not a valid binding
  // merely because its ID exists. Imported external QNames remain external.
  const inspectRoles = (
    roles: BPMN20__tResourceRole[] | undefined,
    ancestors: object[],
  ) => {
    for (const role of roles ?? []) {
      const id = role["@_id"],
        resourceId = resolveBpmnReference(
          definitions,
          role.resourceRef?.__$$text,
          ...ancestors,
          role,
          role.resourceRef ?? {},
        );
      const resource = definitions.rootElement?.find(
        (root) =>
          root.__$$element === "resource" && root["@_id"] === resourceId,
      );
      if (resourceId && !resource)
        throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
      for (const binding of role.resourceParameterBinding ?? []) {
        const parameterId = resolveBpmnReference(
          definitions,
          binding["@_parameterRef"],
          ...ancestors,
          role,
          binding,
        );
        if (
          parameterId &&
          (resource?.__$$element !== "resource" ||
            !resource.resourceParameter?.some(
              (parameter) => parameter["@_id"] === parameterId,
            ))
        )
          throw new BpmnSourceError(
            "BPMN_DANGLING_REFERENCE",
            binding["@_id"] ?? id,
          );
      }
    }
  };
  for (const root of definitions.rootElement ?? []) {
    if (root.__$$element === "resource")
      for (const parameter of root.resourceParameter ?? []) {
        const typeId = resolveBpmnReference(
          definitions,
          parameter["@_type"],
          root,
          parameter,
        );
        if (
          typeId &&
          !definitions.rootElement?.some(
            (root) =>
              root.__$$element === "itemDefinition" && root["@_id"] === typeId,
          )
        )
          throw new BpmnSourceError(
            "BPMN_DANGLING_REFERENCE",
            parameter["@_id"] ?? root["@_id"],
          );
      }
    if (
      root.__$$element === "process" ||
      isGlobalTask(root as Parameters<typeof isGlobalTask>[0])
    )
      inspectRoles(
        (root as { resourceRole?: BPMN20__tResourceRole[] }).resourceRole,
        [root],
      );
  }
  const backingObjects = new Set<string>();
  const graphicalEndpoints = new Set<string>();
  const dataLocations = new Map<string, DataAssociationLocation>();
  const dataRouteSources = new Map<string, Set<string>>();
  const authoredDataRoutes = new Set(
    (plane["di:DiagramElement"] ?? [])
      .filter((element) => element.__$$element === "bpmndi:BPMNEdge")
      .map((element) =>
        resolveBpmnReference(
          definitions,
          element["@_bpmnElement"],
          diagram,
          plane,
          element,
        ),
      ),
  );
  const categoryReferences = indexBpmnIds(definitions);
  const categoryValueIds = new Set(
    definitions.rootElement
      ?.filter((root) => root.__$$element === "category")
      .flatMap((root) => root.categoryValue ?? [])
      .map((value) => value["@_id"]),
  );
  // Every expanded or expandable descendant needs its original DI. A valid
  // collapsed import without child geometry is incomplete for this release,
  // never permission to invent a layout or silently omit those semantics.
  const inspectScope = (scope: FlowScope, ancestors: object[]) => {
    for (const element of scope.flowElement ?? []) {
      if ("resourceRole" in element)
        inspectRoles(element.resourceRole, [...ancestors, scope, element]);
      // These references add no route geometry. Local IDs must name category
      // values, while a genuinely external QName is retained, not reinterpreted.
      for (const reference of element.categoryValueRef ?? []) {
        try {
          const target = categoryReferences.resolveReference(
            reference,
            reference.__$$text,
          );
          if (target && !categoryValueIds.has(target))
            throw new BpmnSourceError(
              "BPMN_DANGLING_REFERENCE",
              element["@_id"],
            );
        } catch (error) {
          if (error instanceof BpmnSourceError) throw error;
          throw new BpmnSourceError(
            error instanceof Error && error.message === "BPMN_UNKNOWN_NAMESPACE"
              ? "BPMN_UNKNOWN_NAMESPACE"
              : error instanceof Error && error.message === "BPMN_INVALID_QNAME"
                ? "BPMN_UNSUPPORTED_REFERENCE"
                : "BPMN_DANGLING_REFERENCE",
            element["@_id"],
          );
        }
      }
    }
    for (const location of scopeDataAssociations(scope)) {
      const id = location.association["@_id"];
      // Without transformation or assignments BPMN defines a direct copy,
      // which has exactly one source even when no route is depicted.
      if (
        (location.association.sourceRef?.length ?? 0) > 1 &&
        !location.association.transformation &&
        !location.association.assignment?.length
      )
        throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
      if (!id || !authoredDataRoutes.has(id)) continue;
      try {
        const endpoints = dataAssociationEndpoints(location);
        edges.add(id);
        dataLocations.set(id, location);
        for (const source of endpoints.sourceIds)
          graphicalEndpoints.add(source);
        graphicalEndpoints.add(endpoints.targetId);
      } catch {
        throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
      }
    }
    const localNodes = new Set(
      (scope.flowElement ?? [])
        .filter((element) => element.__$$element !== "sequenceFlow")
        .map((element) => requiredId(element["@_id"])),
    );
    const localEdges = new Set(
      (scope.flowElement ?? [])
        .filter((element) => element.__$$element === "sequenceFlow")
        .map((element) => requiredId(element["@_id"])),
    );
    const laneNodes = new Set(
      (scope.flowElement ?? [])
        .filter(
          (element) =>
            ![
              "sequenceFlow",
              "dataObject",
              "dataObjectReference",
              "dataStoreReference",
            ].includes(element.__$$element),
        )
        .map((element) => element["@_id"]),
    );
    for (const id of localNodes) nodes.add(id);
    for (const id of localEdges) edges.add(id);
    for (const artifact of scope.artifact ?? []) {
      const id = requiredId(artifact["@_id"]);
      if (artifact.__$$element === "association") {
        try {
          const endpoints = associationEndpoints(definitions, scope, artifact);
          graphicalEndpoints.add(endpoints.source);
          graphicalEndpoints.add(endpoints.target);
        } catch {
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
        }
        edges.add(id);
      } else if (artifact.__$$element === "textAnnotation") nodes.add(id);
      else if (artifact.__$$element === "group") {
        nodes.add(id);
        if (artifact["@_categoryValueRef"]) {
          const target = resolveBpmnReference(
            definitions,
            artifact["@_categoryValueRef"],
            ...ancestors,
            scope,
            artifact,
          );
          if (
            !definitions.rootElement?.some(
              (root) =>
                root.__$$element === "category" &&
                root.categoryValue?.some((value) => value["@_id"] === target),
            )
          )
            throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
        }
      } else throw new BpmnSourceError("BPMN_UNSUPPORTED_ELEMENT", id);
    }
    if ((scope.laneSet?.length ?? 0) > 1)
      throw new BpmnSourceError(
        "BPMN_UNSUPPORTED_ELEMENT",
        scope.laneSet?.[1]["@_id"],
      );
    const laneMembership = new Map<string, Set<string>>();
    const inspectLanes = (
      laneSet: BPMN20__tLaneSet,
      ancestorLanes: ReadonlySet<string>,
    ) => {
      requiredId(laneSet["@_id"]);
      for (const lane of laneSet.lane ?? []) {
        const id = requiredId(lane["@_id"]);
        for (const reference of lane.flowNodeRef ?? []) {
          const target = reference.__$$text.trim(); // IDREF, independent of namespace scope.
          const previous = laneMembership.get(target) ?? new Set<string>();
          if (
            !laneNodes.has(target) ||
            [...previous].some((owner) => !ancestorLanes.has(owner))
          )
            throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
          previous.add(id);
          laneMembership.set(target, previous);
        }
        nodes.add(id);
        if (lane.childLaneSet)
          inspectLanes(lane.childLaneSet, new Set([...ancestorLanes, id]));
      }
    };
    for (const set of scope.laneSet ?? []) inspectLanes(set, new Set());
    for (const element of scope.flowElement ?? []) {
      const id = requiredId(element["@_id"]);
      if (element.__$$element === "dataObjectReference") {
        try {
          const target = dataObjectReferenceTarget(scope, element);
          if (target) backingObjects.add(requiredId(target["@_id"]));
        } catch {
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
        }
      }
      if (
        element.__$$element === "dataStoreReference" &&
        element["@_dataStoreRef"]
      ) {
        const target = resolveBpmnReference(
          definitions,
          element["@_dataStoreRef"],
          ...ancestors,
          scope,
          element,
        );
        if (
          !definitions.rootElement?.some(
            (root) =>
              root.__$$element === "dataStore" && root["@_id"] === target,
          )
        )
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
      }
      if (
        (element.__$$element === "dataObject" ||
          element.__$$element === "dataObjectReference" ||
          element.__$$element === "dataStoreReference") &&
        element["@_itemSubjectRef"]
      ) {
        const item = resolveBpmnReference(
          definitions,
          element["@_itemSubjectRef"],
          ...ancestors,
          scope,
          element,
        );
        const type = definitions.rootElement?.find(
          (root) =>
            root.__$$element === "itemDefinition" && root["@_id"] === item,
        );
        if (type?.__$$element !== "itemDefinition")
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
        if (
          element.__$$element === "dataObject" &&
          (type["@_isCollection"] ?? false) !==
            (element["@_isCollection"] ?? false)
        )
          throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
      }
      if (element.__$$element === "sequenceFlow") {
        if (
          !localNodes.has(element["@_sourceRef"]) ||
          !localNodes.has(element["@_targetRef"])
        )
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
        if (
          (scope.flowElement ?? []).some(
            (node) =>
              node.__$$element === "subProcess" &&
              node["@_triggeredByEvent"] &&
              (node["@_id"] === element["@_sourceRef"] ||
                node["@_id"] === element["@_targetRef"]),
          )
        )
          throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
        continue;
      }
      if (
        element.__$$element === "startEvent" ||
        element.__$$element === "endEvent" ||
        element.__$$element === "boundaryEvent" ||
        element.__$$element === "intermediateCatchEvent" ||
        element.__$$element === "intermediateThrowEvent"
      ) {
        try {
          assertEventContext(definitions, element, scope);
        } catch (error) {
          throw new BpmnSourceError(
            error instanceof Error &&
              error.message === "BPMN_UNSUPPORTED_REFERENCE"
              ? "BPMN_UNSUPPORTED_REFERENCE"
              : "BPMN_UNSUPPORTED_PROPERTY",
            id,
          );
        }
      }
      if (
        element.__$$element === "callActivity" &&
        !validCalledElement(
          definitions,
          element,
          element["@_calledElement"] ?? "",
        )
      )
        throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
      if (
        "@_isForCompensation" in element &&
        element["@_isForCompensation"] &&
        (("incoming" in element && !!element.incoming?.length) ||
          ("outgoing" in element && !!element.outgoing?.length) ||
          (scope.flowElement ?? []).some(
            (flow) =>
              flow.__$$element === "sequenceFlow" &&
              (flow["@_sourceRef"] === id || flow["@_targetRef"] === id),
          ))
      )
        throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
      for (const reference of [
        ...("incoming" in element ? (element.incoming ?? []) : []),
        ...("outgoing" in element ? (element.outgoing ?? []) : []),
      ]) {
        if (
          !localEdges.has(
            resolveBpmnReference(
              definitions,
              reference.__$$text,
              ...ancestors,
              scope,
              element,
              reference,
            ) ?? "",
          )
        )
          throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
      }
      if (
        element.__$$element === "subProcess" ||
        element.__$$element === "adHocSubProcess" ||
        element.__$$element === "transaction"
      ) {
        try {
          assertSubProcessContext(element);
          if (
            element.__$$element === "subProcess" &&
            element["@_triggeredByEvent"] &&
            scope.flowElement?.some(
              (flow) =>
                flow.__$$element === "sequenceFlow" &&
                (flow["@_sourceRef"] === id || flow["@_targetRef"] === id),
            )
          )
            throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
        } catch {
          throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", id);
        }
        inspectScope(element, [...ancestors, scope]);
      }
    }
    try {
      assertConnectionScope(definitions, scope);
    } catch {
      throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", scope["@_id"]);
    }
  };
  inspectScope(process, []);
  const shapes = new Set<string>();
  const routes = new Set<string>();
  for (const element of plane["di:DiagramElement"] ?? []) {
    const id = requiredId(element["@_id"]);
    if (
      element.__$$element !== "bpmndi:BPMNShape" &&
      element.__$$element !== "bpmndi:BPMNEdge"
    )
      throw new BpmnSourceError("BPMN_UNSUPPORTED_ELEMENT", id);
    const reference = element["@_bpmnElement"];
    const local = resolveBpmnReference(
      definitions,
      reference,
      diagram,
      plane,
      element,
    );
    if (!local) throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", id);
    const label = element["bpmndi:BPMNLabel"];
    if (
      label?.["@_labelStyle"] !== undefined &&
      !labelStyles.has(
        resolveBpmnReference(
          definitions,
          label["@_labelStyle"],
          diagram,
          plane,
          element,
          label,
        ) ?? "",
      )
    )
      throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", label["@_id"] ?? id);
    if (element.__$$element === "bpmndi:BPMNShape") {
      const io = findProcessIoItem(process, local);
      if (io) {
        nodes.add(requiredId(io.element["@_id"]));
        const reference = io.element["@_itemSubjectRef"],
          typeId = resolveBpmnReference(
            definitions,
            reference,
            process,
            process.ioSpecification!,
            io.element,
          );
        if (typeId) {
          const type = definitions.rootElement?.find(
            (root) =>
              root.__$$element === "itemDefinition" && root["@_id"] === typeId,
          );
          if (type?.__$$element !== "itemDefinition")
            throw new BpmnSourceError("BPMN_DANGLING_REFERENCE", local);
          if (
            (type["@_isCollection"] ?? false) !==
            (io.element["@_isCollection"] ?? false)
          )
            throw new BpmnSourceError("BPMN_UNSUPPORTED_PROPERTY", local);
        }
      }
      if (!nodes.has(local) || shapes.has(local))
        throw new BpmnSourceError("BPMN_INCOMPLETE_DI", id);
      if (!finiteBounds(element["dc:Bounds"]))
        throw new BpmnSourceError("BPMN_INCOMPLETE_DI", id);
      shapes.add(local);
    } else {
      const location = dataLocations.get(local);
      if (!edges.has(local) || (routes.has(local) && !location))
        throw new BpmnSourceError("BPMN_INCOMPLETE_DI", id);
      if (location) {
        try {
          const endpoint = dataAssociationRouteEndpoints(
              definitions,
              location,
              element,
            ),
            sources = dataRouteSources.get(local) ?? new Set<string>();
          if (sources.has(endpoint.sourceId))
            throw new Error("BPMN_INVALID_CONNECTION");
          sources.add(endpoint.sourceId);
          dataRouteSources.set(local, sources);
        } catch {
          throw new BpmnSourceError("BPMN_INCOMPLETE_DI", id);
        }
      }
      const points = element["di:waypoint"];
      if (
        !points ||
        points.length < 2 ||
        points.some(
          (point) =>
            !Number.isFinite(point["@_x"]) || !Number.isFinite(point["@_y"]),
        )
      )
        throw new BpmnSourceError("BPMN_INCOMPLETE_DI", id);
      routes.add(local);
    }
  }
  // Only a reference-backed declaration may be non-graphical. A route still
  // needs real endpoint shapes; do not broadly forgive missing data-object DI.
  if (
    [...nodes].some(
      (id) =>
        !shapes.has(id) &&
        (!backingObjects.has(id) || graphicalEndpoints.has(id)),
    ) ||
    [...graphicalEndpoints].some((id) => !shapes.has(id)) ||
    [...dataLocations].some(([id, location]) =>
      dataAssociationEndpoints(location).sourceIds.some(
        (source) => !dataRouteSources.get(id)?.has(source),
      ),
    ) ||
    routes.size !== edges.size
  )
    throw new BpmnSourceError("BPMN_INCOMPLETE_DI");
}
