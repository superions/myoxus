// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BPMN20__tDefinitions } from "./schemas/bpmn-2_0/ts-gen/types";
import { meta } from "./schemas/bpmn-2_0/ts-gen/meta";
import type { Meta } from "./xml-parser";
import { visitBpmnSourceObjects } from "./editor/mutations/element-visitor";
import type { BpmnSourceErrorCode } from "./process-source";

export type BpmnProfileFinding = { elementId?: string } & (
  | { state: "editable"; reason: "BPMN_EDITABLE" }
  | {
      state: "preserved-opaque";
      reason: "BPMN_PRESERVED_EXTENSION" | "BPMN_PRESERVED_DEFINITION";
    }
  | { state: "unsupported"; reason: BpmnSourceErrorCode }
);

/** One private concrete process profile, shared by inspection and authoring.
 * The complete mandatory release target is enumerated here, not inferred from
 * schema presence or retained KIE controls. Advance a case only with its actual
 * command/DI/properties/clipboard/history/reopen chain; unknowns fail closed. */
export function bpmnConstructState(kind: string): BpmnProfileFinding["state"] {
  switch (kind) {
    case "startEvent":
    case "task":
    case "userTask":
    case "manualTask":
    case "serviceTask":
    case "scriptTask":
    case "businessRuleTask":
    case "sendTask":
    case "receiveTask":
    case "script":
    case "callActivity":
    case "subProcess":
    case "adHocSubProcess":
    case "transaction":
    case "cancelEventDefinition":
    case "completionCondition":
    case "globalTask":
    case "globalUserTask":
    case "globalManualTask":
    case "globalScriptTask":
    case "globalBusinessRuleTask":
    case "supportedInterfaceRef":
    case "standardLoopCharacteristics":
    case "multiInstanceLoopCharacteristics":
    case "endEvent":
    case "intermediateCatchEvent":
    case "intermediateThrowEvent":
    case "boundaryEvent":
    case "messageEventDefinition":
    case "timerEventDefinition":
    case "signalEventDefinition":
    case "conditionalEventDefinition":
    case "linkEventDefinition":
    case "escalationEventDefinition":
    case "errorEventDefinition":
    case "compensateEventDefinition":
    case "terminateEventDefinition":
    case "eventDefinitionRef":
    case "source":
    case "target":
    case "sequenceFlow":
    case "conditionExpression":
    case "exclusiveGateway":
    case "inclusiveGateway":
    case "parallelGateway":
    case "complexGateway":
    case "eventBasedGateway":
    case "activationCondition":
    case "association":
    case "textAnnotation":
    case "text":
    case "group":
    case "category":
    case "categoryValue":
    case "categoryValueRef":
    case "dataObject":
    case "dataObjectReference":
    case "dataStoreReference":
    case "dataStore":
    case "dataState":
    case "dataInputAssociation":
    case "dataOutputAssociation":
    case "dataInput":
    case "dataOutput":
    case "inputSet":
    case "outputSet":
    case "dataInputRefs":
    case "dataOutputRefs":
    case "optionalInputRefs":
    case "whileExecutingInputRefs":
    case "optionalOutputRefs":
    case "whileExecutingOutputRefs":
    case "inputSetRefs":
    case "outputSetRefs":
    case "ioSpecification":
    case "property":
    case "resourceRole":
    case "implicitThrowEvent": // Owned MI semantics, never a graphical node.
    case "definitions":
    case "process":
    case "documentation":
    case "incoming":
    case "outgoing":
    case "laneSet":
    case "lane":
    case "childLaneSet":
    case "flowNodeRef":
    case "bpmndi:BPMNDiagram":
    case "bpmndi:BPMNPlane":
    case "bpmndi:BPMNShape":
    case "bpmndi:BPMNEdge":
    case "bpmndi:BPMNLabel":
    case "bpmndi:BPMNLabelStyle":
    case "dc:Bounds":
    case "dc:Font":
    case "di:waypoint":
      return "editable";
    case "extensionElements":
    case "itemDefinition":
      return "preserved-opaque";
    case "correlationSubscription":
      return "unsupported";
    // Deliberately outside the process-only release; never promote these merely
    // because their schema or some upstream renderer exists.
    case "participant":
    case "messageFlow":
    case "collaboration":
    case "conversation":
    case "choreography":
    case "globalConversation":
    case "globalChoreographyTask":
    default:
      return "unsupported";
  }
}

/** Semantic findings feed the one whole-source decision alongside DI checks.
 * Opaque boundaries are not another editable mode or an authoring promise. */
export function inspectBpmnSemanticFindings(
  definitions: BPMN20__tDefinitions,
): BpmnProfileFinding[] {
  const findings: BpmnProfileFinding[] = [];
  visitBpmnSourceObjects(
    definitions,
    ({ value, property, elementId, schemaType }) => {
      const kind =
        typeof value.__$$element === "string" ? value.__$$element : property;
      const finding = (entry: BpmnProfileFinding) =>
        findings.push({ ...entry, elementId });
      // Standard non-graphical context belongs to definitions/process/task data,
      // not new graphical palette families. Dedicated standard controls edit
      // their supported fields while preserving the unrepresented remainder;
      // mere XML retention never enables an engine authoring dialect.
      if (
        (property === "import" && schemaType === "BPMN20__tImport") ||
        (property === "rootElement" && kind === "resource") ||
        (property === "rootElement" &&
          (kind === "message" ||
            kind === "interface" ||
            kind === "signal" ||
            kind === "error" ||
            kind === "escalation")) ||
        ([
          "condition",
          "conditionExpression",
          "activationCondition",
          "timeDuration",
          "timeDate",
          "timeCycle",
        ].includes(property) &&
          (schemaType === "BPMN20__tExpression" ||
            schemaType === "BPMN20__tFormalExpression")) ||
        (property === "ioSpecification" &&
          schemaType === "BPMN20__tInputOutputSpecification") ||
        (property === "dataInputAssociation" &&
          schemaType === "BPMN20__tDataInputAssociation") ||
        (property === "dataOutputAssociation" &&
          schemaType === "BPMN20__tDataOutputAssociation") ||
        (property === "loopCharacteristics" &&
          (kind === "standardLoopCharacteristics" ||
            kind === "multiInstanceLoopCharacteristics")) ||
        (property === "completionCondition" &&
          (schemaType === "BPMN20__tExpression" ||
            schemaType === "BPMN20__tFormalExpression")) ||
        (property === "rendering" && schemaType === "BPMN20__tRendering") ||
        (property === "ioBinding" &&
          schemaType === "BPMN20__tInputOutputBinding") ||
        (property === "property" && schemaType === "BPMN20__tProperty") ||
        (property === "auditing" && schemaType === "BPMN20__tAuditing") ||
        (property === "monitoring" && schemaType === "BPMN20__tMonitoring") ||
        (property === "resourceRole" &&
          [
            "resourceRole",
            "performer",
            "humanPerformer",
            "potentialOwner",
          ].includes(kind))
      ) {
        finding({
          state: "preserved-opaque",
          reason: "BPMN_PRESERVED_DEFINITION",
        });
        return false;
      }
      if (typeof value.__$$xml === "string") {
        if (property === "extensionElements")
          finding({
            state: "preserved-opaque",
            reason: "BPMN_PRESERVED_EXTENSION",
          });
        else
          finding({
            state: "unsupported",
            reason: "BPMN_UNSUPPORTED_EXTENSION",
          });
        return false;
      }
      // Item definitions remain non-graphical declarations. Their focused
      // manager edits scalar metadata without advertising them as canvas nodes.
      if (
        property === "rootElement" &&
        kind === "itemDefinition" &&
        Object.values(value).every(
          (field) => field === null || typeof field !== "object",
        )
      ) {
        finding({
          state: "preserved-opaque",
          reason: "BPMN_PRESERVED_DEFINITION",
        });
        return false;
      }
      const state = bpmnConstructState(kind);
      if (state === "editable")
        finding({ state: "editable", reason: "BPMN_EDITABLE" });
      else
        finding({ state: "unsupported", reason: "BPMN_UNSUPPORTED_ELEMENT" });
      if (state !== "editable") return false;
      for (const name of Object.keys(value)) {
        if (
          name.startsWith("@_") &&
          !name.startsWith("@_xmlns") &&
          !name.includes(":") &&
          !(meta as Meta)[schemaType ?? ""]?.[name]
        )
          finding({
            state: "unsupported",
            reason: "BPMN_UNSUPPORTED_PROPERTY",
          });
        if (name === "@_xsi:type" || name === "@_definitionalCollaborationRef")
          finding({
            state: "unsupported",
            reason: "BPMN_UNSUPPORTED_PROPERTY",
          });
        if (
          name.startsWith("@_") &&
          name.includes(":") &&
          !name.startsWith("@_xmlns:")
        )
          finding({
            state: "preserved-opaque",
            reason: "BPMN_PRESERVED_EXTENSION",
          });
        // Unrepresented standard semantics are not silently accepted as a plain
        // task/event. Namespace-qualified extension attributes remain opaque;
        // their spelling and value are retained by focused model mutations.
      }
      return true;
    },
  );
  return findings;
}
