// SPDX-License-Identifier: AGPL-3.0-or-later
// Modified by Myoxus; see provenance.json for retained activity/mutation owners.

import type {
  BPMN20__tDefinitions,
  BPMN20__tTransaction,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import type { Task } from "./data-mapping";
import { visitFlowElementsAndArtifacts, visitLanes } from "./element-visitor";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { keepIntersection } from "../diagram/nodes/morphing/keepIntersection";
import { assertSubProcessContext } from "./activity-context";
import {
  assertEventContext,
  eventDefinitions,
  eventInterruption,
  eventNotation,
} from "./event";

export type Activity =
  Task | (Normalized<BPMN20__tTransaction> & { __$$element: "transaction" });
export type ActivityLoopMode = "none" | "standard" | "parallel" | "sequential";
export type SubProcess = Extract<
  Activity,
  { __$$element: "subProcess" | "adHocSubProcess" | "transaction" }
>;

/** Explicit subprocess type/mode command. Compatible children, loops, resources
 * and DI retain ownership and identity; event mode's start-trigger conversion
 * is described below. Referenced fields absent from the target block first. */
export function setSubProcessKind(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  kind: "subProcess" | "adHocSubProcess" | "transaction" | "event",
) {
  const activity = activityById(definitions, id);
  if (
    activity.__$$element !== "subProcess" &&
    activity.__$$element !== "adHocSubProcess" &&
    activity.__$$element !== "transaction"
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  const eventMode = kind === "event";
  const schemaKind = eventMode ? "subProcess" : kind;
  if (
    activity.__$$element === schemaKind &&
    !!activity["@_triggeredByEvent"] === eventMode
  )
    return;
  const candidate = { ...activity };
  keepIntersection({
    fromElement: activity.__$$element,
    toElement: schemaKind,
    srcObj: activity,
    targetObj: candidate,
  });
  candidate.__$$element = schemaKind;
  if (eventMode) candidate["@_triggeredByEvent"] = true;
  else delete candidate["@_triggeredByEvent"];
  const references = indexBpmnIds(definitions);
  const starts =
    candidate.flowElement?.filter(
      (element) => element.__$$element === "startEvent",
    ) ?? [];
  // Selecting event mode explicitly supplies a Message trigger to a None start
  // (or a new start for an empty scope). Leaving it explicitly removes only
  // context-inapplicable start triggers, never shared root declarations. Guard
  // referenced inline identities before replacing their owned subtree.
  const removedStartDefinitions =
    !eventMode && activity["@_triggeredByEvent"]
      ? starts.flatMap((start) => start.eventDefinition ?? [])
      : [];
  const rejectReferenced = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(rejectReferenced);
      return;
    }
    const object = value as Record<string, unknown>;
    if (
      typeof object["@_id"] === "string" &&
      references.isReferenced(object["@_id"])
    )
      throw new Error("BPMN_DEFINITION_IN_USE");
    for (const [key, child] of Object.entries(object))
      if (!key.startsWith("@_") && !key.startsWith("__$$"))
        rejectReferenced(child);
  };
  removedStartDefinitions.forEach(rejectReferenced);
  candidate.flowElement = candidate.flowElement?.map((element) => {
    if (element.__$$element !== "startEvent") return element;
    const start = { ...element };
    if (eventMode && !eventDefinitions(definitions, element).length)
      start.eventDefinition = [
        { "@_id": generateUuid(), __$$element: "messageEventDefinition" },
      ];
    if (!eventMode && activity["@_triggeredByEvent"]) {
      delete start.eventDefinition;
      delete start.eventDefinitionRef;
      delete start["@_parallelMultiple"];
      delete start["@_isInterrupting"];
    }
    return start;
  });
  const createdStart =
    eventMode && !starts.length
      ? {
          "@_id": generateUuid(),
          __$$element: "startEvent" as const,
          eventDefinition: [
            {
              "@_id": generateUuid(),
              __$$element: "messageEventDefinition" as const,
            },
          ],
        }
      : undefined;
  if (createdStart)
    candidate.flowElement = [...(candidate.flowElement ?? []), createdStart];
  assertSubProcessContext(candidate);
  // A transaction's cancel ends and attached cancel handlers may not become
  // ordinary-subprocess semantics merely because the concrete schema overlaps.
  for (const element of candidate.flowElement ?? [])
    if (
      element.__$$element === "startEvent" ||
      element.__$$element === "endEvent" ||
      element.__$$element === "intermediateCatchEvent" ||
      element.__$$element === "intermediateThrowEvent" ||
      element.__$$element === "boundaryEvent"
    )
      assertEventContext(definitions, element, candidate);
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (element["@_id"] !== id) return true;
    const prospective = {
      ...owner,
      flowElement: owner.flowElement?.map((element) =>
        element["@_id"] === id ? candidate : element,
      ),
    };
    if (
      eventMode &&
      owner.flowElement?.some(
        (flow) =>
          flow.__$$element === "sequenceFlow" &&
          (flow["@_sourceRef"] === id || flow["@_targetRef"] === id),
      )
    )
      throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
    for (const sibling of prospective.flowElement ?? [])
      if (sibling.__$$element === "boundaryEvent")
        assertEventContext(definitions, sibling, prospective);
    return false;
  });
  for (const [key, value] of Object.entries(activity))
    if (!Object.hasOwn(candidate, key)) rejectReferenced(value);
  keepIntersection({
    fromElement: activity.__$$element,
    toElement: schemaKind,
    srcObj: activity,
    targetObj: activity,
  });
  activity.__$$element = schemaKind;
  if (eventMode) activity["@_triggeredByEvent"] = true;
  else delete activity["@_triggeredByEvent"];
  activity.flowElement = candidate.flowElement;
  if (createdStart) {
    const { diagramElements } = addOrGetProcessAndDiagramElements({
      definitions,
    });
    const shape = diagramElements.find(
      (shape) =>
        shape.__$$element === "bpmndi:BPMNShape" &&
        references.resolveReference(shape, shape["@_bpmnElement"]) === id,
    );
    if (shape?.__$$element !== "bpmndi:BPMNShape" || !shape["dc:Bounds"])
      throw new Error("BPMN_INCOMPLETE_DI");
    const bounds = shape["dc:Bounds"];
    diagramElements.push({
      "@_id": generateUuid(),
      __$$element: "bpmndi:BPMNShape",
      "@_bpmnElement": createdStart["@_id"],
      "dc:Bounds": {
        "@_x": bounds["@_x"] + 40,
        "@_y": bounds["@_y"] + 60,
        "@_width": 36,
        "@_height": 36,
      },
    });
  }
}

/** Collapsed event-subprocess notation follows its actual sole start, including
 * referenced/multiple triggers and interruption. Read the current ID owner, not
 * a stale React Flow node prop. Expanded scopes already paint the real start. */
export function eventSubProcessTrigger(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  let startId: string | undefined;
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element["@_id"] === id &&
      element.__$$element === "subProcess" &&
      element["@_triggeredByEvent"]
    ) {
      startId = element.flowElement?.find(
        (element) => element.__$$element === "startEvent",
      )?.["@_id"];
      return false;
    }
    return true;
  });
  return startId
    ? {
        notation: eventNotation(definitions, startId),
        interrupting: eventInterruption(definitions, startId).value,
      }
    : undefined;
}

/** Find an activity in its actual nested owner. This does not create a process,
 * move its contents or synthesize an I/O mapping from an iteration field. */
export function activityById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): Activity {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let activity: Activity | undefined;
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element["@_id"] !== id) return true;
    switch (element.__$$element) {
      case "task":
      case "userTask":
      case "manualTask":
      case "serviceTask":
      case "scriptTask":
      case "businessRuleTask":
      case "sendTask":
      case "receiveTask":
      case "callActivity":
      case "subProcess":
      case "adHocSubProcess":
      case "transaction":
        activity = element;
        break;
    }
    return false;
  });
  if (!activity) throw new Error("BPMN_ACTIVITY_NOT_FOUND");
  return activity;
}

/** Explicit standard token quantities. Absence retains BPMN's default of one;
 * clearing a field removes only that attribute, never loops, I/O or routes. */
export function setActivityQuantity(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  field: "@_startQuantity" | "@_completionQuantity",
  value: number | undefined,
) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  const activity = activityById(definitions, id);
  if (value === undefined) delete activity[field];
  else activity[field] = value;
}

/** Switching the loop kind is an explicit standard semantic replacement. Base
 * metadata/identity survives schema intersection; compatible MI details survive
 * sequential/parallel changes. Never rebuild mappings, delete shared roots or
 * rewrite data-item names into process variables. Referenced removed children
 * block the command before any writes so it cannot strand another consumer. */
export function setActivityLoop(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  mode: ActivityLoopMode,
) {
  const activity = activityById(definitions, id);
  if (
    activity.__$$element === "subProcess" &&
    activity["@_triggeredByEvent"] &&
    mode !== "none"
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  const previous = activity.loopCharacteristics;
  const nextKind =
    mode === "standard"
      ? "standardLoopCharacteristics"
      : "multiInstanceLoopCharacteristics";
  if (previous && (mode === "none" || previous.__$$element !== nextKind)) {
    const index = indexBpmnIds(definitions);
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = value as Record<string, unknown>;
      if (
        typeof object["@_id"] === "string" &&
        (value !== previous || mode === "none") &&
        index.isReferenced(object["@_id"])
      )
        throw new Error("BPMN_DEFINITION_IN_USE");
      for (const [key, child] of Object.entries(object))
        if (!key.startsWith("@_") && !key.startsWith("__$$")) visit(child);
    };
    visit(previous);
  }
  if (mode === "none") {
    delete activity.loopCharacteristics;
    return;
  }
  if (!previous)
    activity.loopCharacteristics = {
      "@_id": generateUuid(),
      __$$element: nextKind,
    };
  else if (previous.__$$element !== nextKind) {
    keepIntersection({
      fromElement: previous.__$$element,
      toElement: nextKind,
      srcObj: previous,
      targetObj: previous,
    });
    previous.__$$element = nextKind;
  }
  if (
    activity.loopCharacteristics?.__$$element ===
    "multiInstanceLoopCharacteristics"
  )
    activity.loopCharacteristics["@_isSequential"] = mode === "sequential";
}

/** A compensation handler cannot participate in the ordinary sequence-flow
 * graph. Reject before setting the flag rather than silently removing flows. */
export function setActivityCompensation(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  enabled: boolean,
) {
  const activity = activityById(definitions, id);
  if (enabled) {
    const { process } = addOrGetProcessAndDiagramElements({ definitions });
    if (activity.incoming?.length || activity.outgoing?.length)
      throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
    visitFlowElementsAndArtifacts(process, ({ element }) => {
      if (
        element.__$$element === "sequenceFlow" &&
        (element["@_sourceRef"] === id || element["@_targetRef"] === id)
      )
        throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
    });
  }
  activity["@_isForCompensation"] = enabled;
}

/** Expansion is one DI flag change, not layout or semantic reconstruction.
 * Even collapsed imports need complete descendant geometry for this release's
 * promised expansion. Reference-backed data declarations are non-graphical;
 * every graphical child still needs DI before writes. Never synthesize geometry
 * or confuse a boundary attachment with containment. */
export function setSubProcessExpanded(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  expanded: boolean,
) {
  const subProcess = activityById(definitions, id);
  if (
    subProcess.__$$element !== "subProcess" &&
    subProcess.__$$element !== "adHocSubProcess" &&
    subProcess.__$$element !== "transaction"
  )
    throw new Error("BPMN_ACTIVITY_NOT_SUBPROCESS");
  const { diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const references = indexBpmnIds(definitions);
  const bySemanticId = new Map(
    diagramElements.map((shape) => [
      references.resolveReference(shape, shape["@_bpmnElement"]),
      shape,
    ]),
  );
  const shape = bySemanticId.get(id);
  if (shape?.__$$element !== "bpmndi:BPMNShape")
    throw new Error("BPMN_INCOMPLETE_DI");
  const checkLaneGeometry = (owner: Parameters<typeof visitLanes>[0]) =>
    visitLanes(owner, ({ lane }) => {
      if (bySemanticId.get(lane["@_id"])?.__$$element !== "bpmndi:BPMNShape")
        throw new Error("BPMN_INCOMPLETE_DI");
    });
  if (expanded) {
    checkLaneGeometry(subProcess);
    visitFlowElementsAndArtifacts(subProcess, ({ element, owner }) => {
      if (element.__$$element === "implicitThrowEvent") return;
      if (
        element.__$$element === "dataObject" &&
        !bySemanticId.has(element["@_id"]) &&
        owner.flowElement?.some(
          (reference) =>
            reference.__$$element === "dataObjectReference" &&
            reference["@_dataObjectRef"]?.trim() === element["@_id"],
        )
      )
        return;
      const isEdge =
        element.__$$element === "sequenceFlow" ||
        element.__$$element === "association";
      if (
        bySemanticId.get(element["@_id"])?.__$$element !==
        (isEdge ? "bpmndi:BPMNEdge" : "bpmndi:BPMNShape")
      )
        throw new Error("BPMN_INCOMPLETE_DI");
      if (
        element.__$$element === "subProcess" ||
        element.__$$element === "adHocSubProcess" ||
        element.__$$element === "transaction"
      )
        checkLaneGeometry(element);
    });
  }
  shape["@_isExpanded"] = expanded;
}
