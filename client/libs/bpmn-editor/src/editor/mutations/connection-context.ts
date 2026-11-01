// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tProcess,
  BPMN20__tSubProcess,
  BPMN20__tAssociation,
  BPMN20__tLaneSet,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { eventDefinitions } from "./event";
import { processIoItems } from "./process-io-context";

export type ConnectionScope = BPMN20__tProcess | BPMN20__tSubProcess;
export type FlowElement = NonNullable<BPMN20__tProcess["flowElement"]>[number];

/** Association endpoints are QNames, unlike sequence-flow IDREFs. This process
 * editor connects graphical base elements in the same semantic flow scope;
 * neither a shared definition nor a nested subprocess child is an endpoint in
 * its parent's scope. DI shape IDs never replace those semantic references. */
export function associationEndpoints(
  definitions: BPMN20__tDefinitions,
  scope: ConnectionScope,
  association: BPMN20__tAssociation,
) {
  if (
    association["@_associationDirection"] !== undefined &&
    !["None", "One", "Both"].includes(association["@_associationDirection"])
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  const references = indexBpmnIds(definitions),
    nodes = new Set([
      ...(scope.flowElement ?? [])
        .filter((e) => e.__$$element !== "sequenceFlow")
        .map((e) => e["@_id"]),
      ...(scope.artifact ?? [])
        .filter((e) => e.__$$element !== "association")
        .map((e) => e["@_id"]),
      ...(definitions.rootElement?.some(
        (root) => root === scope && root.__$$element === "process",
      )
        ? processIoItems(scope).map(({ element }) => element["@_id"])
        : []),
    ]);
  const lanes = (set: BPMN20__tLaneSet) => {
    for (const lane of set.lane ?? []) {
      nodes.add(lane["@_id"]);
      if (lane.childLaneSet) lanes(lane.childLaneSet);
    }
  };
  for (const set of scope.laneSet ?? []) lanes(set);
  const source = references.resolveReference(
      association,
      association["@_sourceRef"],
    ),
    target = references.resolveReference(
      association,
      association["@_targetRef"],
    );
  if (
    !source ||
    !target ||
    source === target ||
    !nodes.has(source) ||
    !nodes.has(target)
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  return { source, target };
}
export type Gateway = Extract<
  FlowElement,
  {
    __$$element:
      | "exclusiveGateway"
      | "inclusiveGateway"
      | "parallelGateway"
      | "complexGateway"
      | "eventBasedGateway";
  }
>;
export const isGateway = (element: {
  __$$element: string;
}): element is Gateway =>
  [
    "exclusiveGateway",
    "inclusiveGateway",
    "parallelGateway",
    "complexGateway",
    "eventBasedGateway",
  ].includes(element.__$$element);
type DefaultOwner = Extract<
  FlowElement,
  {
    __$$element:
      | "task"
      | "userTask"
      | "manualTask"
      | "serviceTask"
      | "scriptTask"
      | "businessRuleTask"
      | "sendTask"
      | "receiveTask"
      | "callActivity"
      | "subProcess"
      | "adHocSubProcess"
      | "transaction"
      | "exclusiveGateway"
      | "inclusiveGateway"
      | "complexGateway";
  }
>;
export const canOwnDefault = (element: {
  __$$element: string;
}): element is DefaultOwner =>
  [
    "task",
    "userTask",
    "manualTask",
    "serviceTask",
    "scriptTask",
    "businessRuleTask",
    "sendTask",
    "receiveTask",
    "callActivity",
    "subProcess",
    "adHocSubProcess",
    "transaction",
    "exclusiveGateway",
    "inclusiveGateway",
    "complexGateway",
  ].includes(element.__$$element);

/** OMG BPMN 2.0.2 §§10.6–10.7. Conditions/defaults belong to the source
 * activity/gateway and its outgoing flow, never a DI path. Event gateways
 * constrain the complete sibling target configuration, not just one endpoint.
 * Isolated/partially wired modelling drafts are allowed; execution minima are
 * not an excuse to prevent drawing the first edge. Unknown node roles fail
 * closed. A prospective command keeps lexical QName owners from the old scope. */
export function assertConnectionScope(
  definitions: BPMN20__tDefinitions,
  scope: ConnectionScope,
  lexicalScope = scope,
) {
  const references = indexBpmnIds(definitions),
    elements = scope.flowElement ?? [];
  const nodes = new Map(
    elements
      .filter((element) => element.__$$element !== "sequenceFlow")
      .map((element) => [element["@_id"], element]),
  );
  const flows = elements.filter(
    (element) => element.__$$element === "sequenceFlow",
  );
  const lexical = (node: FlowElement) =>
    lexicalScope.flowElement?.find(
      (element) => element["@_id"] === node["@_id"],
    ) ?? node;
  const fail = () => {
    throw new Error("BPMN_INVALID_CONNECTION");
  };
  for (const flow of flows) {
    const source = nodes.get(flow["@_sourceRef"]),
      target = nodes.get(flow["@_targetRef"]);
    if (!source || !target) {
      fail();
      continue;
    }
    const flowNode = (node: FlowElement) =>
      isGateway(node) ||
      canOwnDefault(node) ||
      [
        "startEvent",
        "endEvent",
        "intermediateCatchEvent",
        "intermediateThrowEvent",
        "boundaryEvent",
      ].includes(node.__$$element);
    if (
      !flowNode(source) ||
      !flowNode(target) ||
      source.__$$element === "endEvent" ||
      target.__$$element === "startEvent" ||
      target.__$$element === "boundaryEvent"
    )
      fail();
    if (
      [source, target].some(
        (node) =>
          ("@_isForCompensation" in node && node["@_isForCompensation"]) ||
          (node.__$$element === "subProcess" && node["@_triggeredByEvent"]),
      )
    )
      fail();
    if (flow.conditionExpression && !canOwnDefault(source)) fail();
  }
  for (const node of nodes.values()) {
    const incoming = flows.filter(
        (flow) => flow["@_targetRef"] === node["@_id"],
      ),
      outgoing = flows.filter((flow) => flow["@_sourceRef"] === node["@_id"]);
    if ("@_default" in node && node["@_default"]) {
      const id = references.resolveReference(lexical(node), node["@_default"]);
      if (
        !canOwnDefault(node) ||
        !id ||
        !outgoing.some((flow) => flow["@_id"] === id)
      )
        fail();
    }
    if (!isGateway(node)) continue;
    if (
      node["@_gatewayDirection"] !== undefined &&
      !["Unspecified", "Converging", "Diverging", "Mixed"].includes(
        node["@_gatewayDirection"],
      )
    )
      fail();
    if (
      node.__$$element === "eventBasedGateway" &&
      node["@_eventGatewayType"] !== undefined &&
      !["Exclusive", "Parallel"].includes(node["@_eventGatewayType"])
    )
      fail();
    if (
      (node["@_gatewayDirection"] === "Converging" && outgoing.length > 1) ||
      (node["@_gatewayDirection"] === "Diverging" && incoming.length > 1)
    )
      fail();
    if (node.__$$element !== "eventBasedGateway") continue;
    if (
      node["@_gatewayDirection"] === "Converging" ||
      node["@_gatewayDirection"] === "Mixed" ||
      (node["@_instantiate"] && incoming.length) ||
      (node["@_eventGatewayType"] === "Parallel" && !node["@_instantiate"])
    )
      fail();
    let hasReceive = false,
      hasMessage = false;
    for (const flow of outgoing) {
      if (flow.conditionExpression) fail();
      const target = nodes.get(flow["@_targetRef"])!;
      if (
        flows.filter((other) => other["@_targetRef"] === target["@_id"])
          .length > 1
      )
        fail();
      if (target.__$$element === "receiveTask") {
        hasReceive = true;
        if (
          elements.some(
            (element) =>
              element.__$$element === "boundaryEvent" &&
              references.resolveReference(
                lexical(element),
                element["@_attachedToRef"],
              ) === target["@_id"],
          )
        )
          fail();
      } else if (target.__$$element === "intermediateCatchEvent") {
        const triggers = eventDefinitions(
          definitions,
          target,
          lexical(target) as typeof target,
        );
        if (
          !triggers.length ||
          triggers.some(
            (trigger) =>
              ![
                "messageEventDefinition",
                "signalEventDefinition",
                "timerEventDefinition",
                "conditionalEventDefinition",
              ].includes(trigger.__$$element),
          )
        )
          fail();
        hasMessage ||= triggers.some(
          (trigger) => trigger.__$$element === "messageEventDefinition",
        );
      } else fail();
    }
    if (hasReceive && hasMessage) fail();
  }
}
