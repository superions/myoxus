// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import {
  visitFlowElementsAndArtifacts,
  type ElementVisitorArgs,
} from "./element-visitor";
import {
  assertConnectionScope,
  canOwnDefault,
  isGateway,
  type Gateway,
} from "./connection-context";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { keepIntersection } from "../diagram/nodes/morphing/keepIntersection";
import { generateUuid } from "../../xyflow/uuid/uuid";

export function findConnectionElement(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): ElementVisitorArgs | undefined {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let found: ElementVisitorArgs | undefined;
  visitFlowElementsAndArtifacts(process, (location) => {
    if (location.element["@_id"] !== id) return true;
    found = location;
    return false;
  });
  return found;
}
export function connectionElement(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): ElementVisitorArgs {
  const found = findConnectionElement(definitions, id);
  if (!found) throw new Error("BPMN_INVALID_CONNECTION");
  return found;
}

export function sequenceFlowNotation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): "normal" | "default" | "conditional" {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let notation: "normal" | "default" | "conditional" = "normal";
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (element["@_id"] !== id || element.__$$element !== "sequenceFlow")
      return true;
    const source = owner.flowElement?.find(
      (source) => source["@_id"] === element["@_sourceRef"],
    );
    if (
      source &&
      "@_default" in source &&
      indexBpmnIds(definitions).resolveReference(
        source,
        source["@_default"],
      ) === id
    )
      notation = "default";
    else if (source && element.conditionExpression && !isGateway(source))
      notation = "conditional";
    return false;
  });
  return notation;
}

/** Default reassignment is one source-owned command. Replacing an existing
 * default clears that single pointer; it never removes the old edge/condition.
 * A conditioned new default requires explicit condition removal first. */
export function setDefaultFlow(
  definitions: Normalized<BPMN20__tDefinitions>,
  sourceId: string,
  flowId?: string,
) {
  const { element: source, owner } = connectionElement(definitions, sourceId);
  if (source.__$$element === "association" || !canOwnDefault(source))
    throw new Error("BPMN_INVALID_CONNECTION");
  if (flowId) {
    const flow = owner.flowElement?.find(
      (flow) => flow["@_id"] === flowId && flow.__$$element === "sequenceFlow",
    );
    if (
      flow?.__$$element !== "sequenceFlow" ||
      flow["@_sourceRef"] !== sourceId ||
      flow.conditionExpression
    )
      throw new Error("BPMN_INVALID_CONNECTION");
  }
  if (flowId)
    source["@_default"] = indexBpmnIds(definitions).referenceFor(
      source,
      flowId,
      source["@_default"],
    );
  else delete source["@_default"];
}

/** Text edits retain the expression's identity, formal type, language and
 * extensions. Empty text is the explicit remove-condition command; references
 * to its owned IDs block before removal. DI and other routes never change. */
export function setFlowCondition(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  text: string,
) {
  const { element: flow, owner } = connectionElement(definitions, id);
  if (flow.__$$element !== "sequenceFlow")
    throw new Error("BPMN_INVALID_CONNECTION");
  const source = owner.flowElement?.find(
    (node) => node["@_id"] === flow["@_sourceRef"],
  );
  if (!source || !canOwnDefault(source))
    throw new Error("BPMN_INVALID_CONNECTION");
  if (
    text &&
    "@_default" in source &&
    indexBpmnIds(definitions).resolveReference(source, source["@_default"]) ===
      id
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (!text) {
    if (flow.conditionExpression)
      assertUnreferenced(definitions, flow.conditionExpression);
    delete flow.conditionExpression;
  } else {
    flow.conditionExpression ??= { "@_id": generateUuid() };
    flow.conditionExpression.__$$text = text;
  }
}

/** Standard SequenceFlow metadata, not a scheduler/execution command. Preserve
 * explicit false versus absence; clearing changes no condition, identity or DI. */
export function setFlowImmediate(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  value: boolean | undefined,
) {
  const { element } = connectionElement(definitions, id);
  if (
    element.__$$element !== "sequenceFlow" ||
    (value !== undefined && typeof value !== "boolean") ||
    (value === false &&
      addOrGetProcessAndDiagramElements({ definitions }).process[
        "@_isExecutable"
      ] === true)
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (value === undefined) delete element["@_isImmediate"];
  else element["@_isImmediate"] = value;
}

export function hasNonImmediateFlow(
  definitions: Normalized<BPMN20__tDefinitions>,
) {
  const process = definitions.rootElement?.find(
    (element) => element.__$$element === "process",
  );
  if (!process) return false;
  let found = false;
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "sequenceFlow" &&
      element["@_isImmediate"] === false
    ) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

/** BPMN 2.0.2 SequenceFlow attributes forbid explicit isImmediate=false in an
 * executable process. Check every nested flow before changing the process flag;
 * never repair imported flow metadata as a side effect of this command. */
export function setProcessExecutable(
  definitions: Normalized<BPMN20__tDefinitions>,
  value: boolean | undefined,
) {
  if (
    (value !== undefined && typeof value !== "boolean") ||
    (value === true && hasNonImmediateFlow(definitions))
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  if (value === undefined) delete process["@_isExecutable"];
  else process["@_isExecutable"] = value;
}

function assertUnreferenced(
  definitions: Normalized<BPMN20__tDefinitions>,
  value: unknown,
) {
  const references = indexBpmnIds(definitions);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      typeof object["@_id"] === "string" &&
      references.isReferenced(object["@_id"])
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
    for (const [key, child] of Object.entries(object))
      if (!key.startsWith("@_") && !key.startsWith("__$$")) visit(child);
  };
  visit(value);
}

/** Morph only after checking the whole prospective source configuration.
 * Defaults/activation expressions absent from the target are never silently
 * discarded; callers explicitly clear incompatible semantics first. */
export function setGatewayKind(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  kind: Gateway["__$$element"],
) {
  const { element, owner } = connectionElement(definitions, id);
  if (element.__$$element === "association" || !isGateway(element))
    throw new Error("BPMN_INVALID_CONNECTION");
  if (element.__$$element === kind) return;
  const candidate = { ...element };
  keepIntersection({
    fromElement: element.__$$element,
    toElement: kind,
    srcObj: element,
    targetObj: candidate,
  });
  candidate.__$$element = kind;
  if (
    ("@_default" in element &&
      element["@_default"] &&
      !canOwnDefault(candidate)) ||
    ("activationCondition" in element &&
      element.activationCondition &&
      kind !== "complexGateway")
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  for (const [key, value] of Object.entries(element))
    if (!Object.hasOwn(candidate, key)) assertUnreferenced(definitions, value);
  assertConnectionScope(
    definitions,
    {
      ...owner,
      flowElement: owner.flowElement?.map((node) =>
        node["@_id"] === id ? candidate : node,
      ),
    },
    owner,
  );
  keepIntersection({
    fromElement: element.__$$element,
    toElement: kind,
    srcObj: element,
    targetObj: element,
  });
  element.__$$element = kind;
}

export function setGatewayProperties(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  change: {
    direction?: Gateway["@_gatewayDirection"];
    instantiate?: boolean;
    eventGatewayType?: "Exclusive" | "Parallel";
    activationCondition?: string;
  },
) {
  const { element, owner } = connectionElement(definitions, id);
  if (element.__$$element === "association" || !isGateway(element))
    throw new Error("BPMN_INVALID_CONNECTION");
  if (change.direction !== undefined)
    element["@_gatewayDirection"] = change.direction;
  if (
    change.instantiate !== undefined ||
    change.eventGatewayType !== undefined
  ) {
    if (element.__$$element !== "eventBasedGateway")
      throw new Error("BPMN_INVALID_CONNECTION");
    if (change.instantiate !== undefined)
      element["@_instantiate"] = change.instantiate;
    if (change.eventGatewayType !== undefined)
      element["@_eventGatewayType"] = change.eventGatewayType;
  }
  if (change.activationCondition !== undefined) {
    if (element.__$$element !== "complexGateway")
      throw new Error("BPMN_INVALID_CONNECTION");
    if (change.activationCondition) {
      element.activationCondition ??= { "@_id": generateUuid() };
      element.activationCondition.__$$text = change.activationCondition;
    } else {
      if (element.activationCondition)
        assertUnreferenced(definitions, element.activationCondition);
      delete element.activationCondition;
    }
  }
  assertConnectionScope(definitions, owner);
}

export function setAssociationDirection(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  direction: "None" | "One" | "Both",
) {
  const { element } = connectionElement(definitions, id);
  if (element.__$$element !== "association")
    throw new Error("BPMN_INVALID_CONNECTION");
  element["@_associationDirection"] = direction;
}

export function setGatewayMarkerVisible(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  visible: boolean,
) {
  const { element } = connectionElement(definitions, id);
  if (element.__$$element !== "exclusiveGateway")
    throw new Error("BPMN_INVALID_CONNECTION");
  const { diagramElements } = addOrGetProcessAndDiagramElements({
      definitions,
    }),
    references = indexBpmnIds(definitions);
  const shape = diagramElements.find(
    (shape) =>
      shape.__$$element === "bpmndi:BPMNShape" &&
      references.resolveReference(shape, shape["@_bpmnElement"]) === id,
  );
  if (shape?.__$$element !== "bpmndi:BPMNShape")
    throw new Error("BPMN_INCOMPLETE_DI");
  shape["@_isMarkerVisible"] = visible;
}
