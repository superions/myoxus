// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tProcess,
  BPMN20__tSubProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import {
  getNewBpmnIdRandomizer,
  indexBpmnIds,
} from "../idRandomizer/bpmn-id-randomizer";
import { current as currentDraft, isDraft } from "immer";
import type { Normalized } from "../normalization/normalize";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { keepIntersection } from "../diagram/nodes/morphing/keepIntersection";
import { assertConnectionScope } from "./connection-context";

export type BpmnEvent = Extract<
  NonNullable<BPMN20__tProcess["flowElement"]>[number],
  {
    __$$element:
      | "startEvent"
      | "endEvent"
      | "intermediateCatchEvent"
      | "intermediateThrowEvent"
      | "boundaryEvent";
  }
>;
export type EventDefinition = NonNullable<BpmnEvent["eventDefinition"]>[number];
export type EventDefinitionKind = EventDefinition["__$$element"];
export type EventNotation =
  EventDefinitionKind | "none" | "multiple" | "parallelMultiple";
export type EventScope = BPMN20__tProcess | BPMN20__tSubProcess;
export type EventDefinitionTarget = {
  id?: string;
  index: number;
  kind: EventDefinitionKind;
};

/** Imported nested definitions may omit IDs. Keep their lexical slot until an
 * explicit structural edit rerenders the list; never allocate IDs just to read
 * a form. Existing IDs take precedence and prevent duplicate-kind edits from
 * falling back to the first definition of that kind. */
export function eventDefinitionTarget(
  definition: EventDefinition,
  index: number,
): EventDefinitionTarget {
  return { id: definition["@_id"], index, kind: definition.__$$element };
}

export function eventDefinitionFor(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  target: EventDefinitionTarget,
) {
  const found = findEventById(definitions, eventId);
  if (!found) return;
  const resolved = eventDefinitions(definitions, found.event);
  const definition = target.id
    ? resolved.find((definition) => definition["@_id"] === target.id)
    : resolved[target.index];
  return definition?.__$$element === target.kind
    ? (definition as Normalized<EventDefinition>)
    : undefined;
}

const CATCH_TRIGGERS = [
  "messageEventDefinition",
  "timerEventDefinition",
  "conditionalEventDefinition",
  "signalEventDefinition",
] as const;
const THROW_TRIGGERS = [
  "messageEventDefinition",
  "escalationEventDefinition",
  "signalEventDefinition",
  "compensateEventDefinition",
] as const;
const HANDLER_TRIGGERS = [
  ...CATCH_TRIGGERS,
  "errorEventDefinition",
  "escalationEventDefinition",
  "compensateEventDefinition",
] as const;

/** OMG BPMN 2.0.2 §§10.5.2–10.5.4, Tables 10.84–10.91. Multiple events
 * are arrays of these real definitions (including referenced definitions), not
 * pseudo-definition kinds; parallelMultiple is a catch-event flag. Ordinary
 * embedded scopes have only none starts. Cancel catches attach to transactions,
 * and cancel ends belong to a transaction's own flow scope.
 *
 * Isolated nodes are legal modelling drafts: we reject forbidden connections,
 * not absent ones. This is a modeller contract, never an execution guarantee. */
export function allowedEventDefinitionKinds(
  event: BpmnEvent,
  owner: EventScope,
  attachedToTransaction = false,
): readonly EventDefinitionKind[] {
  switch (event.__$$element) {
    case "startEvent":
      return "__$$element" in owner && owner.__$$element !== "process"
        ? "@_triggeredByEvent" in owner && owner["@_triggeredByEvent"]
          ? HANDLER_TRIGGERS
          : []
        : CATCH_TRIGGERS;
    case "intermediateCatchEvent":
      return [...CATCH_TRIGGERS, "linkEventDefinition"];
    case "intermediateThrowEvent":
      return [...THROW_TRIGGERS, "linkEventDefinition"];
    case "boundaryEvent":
      return attachedToTransaction
        ? [...HANDLER_TRIGGERS, "cancelEventDefinition"]
        : HANDLER_TRIGGERS;
    case "endEvent":
      return "__$$element" in owner && owner.__$$element === "transaction"
        ? [
            ...THROW_TRIGGERS,
            "errorEventDefinition",
            "cancelEventDefinition",
            "terminateEventDefinition",
          ]
        : [
            ...THROW_TRIGGERS,
            "errorEventDefinition",
            "terminateEventDefinition",
          ];
  }
}

/** Resolve at the actual lexical owner. An unresolved event-definition QName
 * cannot truthfully supply a marker/context, unlike an explicitly external
 * callable label. Keep that source unsupported rather than guessing its kind. */
export function eventDefinitions(
  definitions: BPMN20__tDefinitions,
  event: BpmnEvent,
  lexicalOwner = event,
): readonly EventDefinition[] {
  const resolved: EventDefinition[] = [...(event.eventDefinition ?? [])];
  if (!event.eventDefinitionRef?.length) return resolved;
  const index = indexBpmnIds(definitions);
  for (const reference of event.eventDefinitionRef) {
    const owner = lexicalOwner.eventDefinitionRef?.includes(reference)
      ? reference
      : lexicalOwner;
    const id = index.resolveReference(owner, reference.__$$text);
    const root = definitions.rootElement?.find((root) => root["@_id"] === id);
    if (!root || !root.__$$element.endsWith("EventDefinition"))
      throw new Error("BPMN_UNSUPPORTED_REFERENCE");
    resolved.push(root as EventDefinition);
  }
  return resolved;
}

/** Visual notation is derived, never serialized as an eventDefinition kind.
 * Use the current ID owner so old React Flow props cannot rebind a reference
 * against a newer definitions snapshot. Standalone SVG uses the same rule. */
export function eventNotation(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
): EventNotation {
  const found = findEventById(definitions, eventId);
  if (!found) return "none";
  const triggers = eventDefinitions(definitions, found.event);
  if (triggers.length > 1)
    return "@_parallelMultiple" in found.event &&
      found.event["@_parallelMultiple"]
      ? "parallelMultiple"
      : "multiple";
  return triggers[0]?.__$$element ?? "none";
}

export function eventInterruption(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
) {
  const found = findEventById(definitions, eventId);
  if (!found) return { applicable: false, fixed: false, value: true };
  const { event, owner } = found;
  const kinds = eventDefinitions(definitions, event).map(
    (definition) => definition.__$$element,
  );
  const applicable =
    (event.__$$element === "boundaryEvent" ||
      (event.__$$element === "startEvent" &&
        "@_triggeredByEvent" in owner &&
        owner["@_triggeredByEvent"] === true)) &&
    !kinds.every((kind) => kind === "compensateEventDefinition");
  const fixed = kinds.some(
    (kind) =>
      kind === "errorEventDefinition" || kind === "cancelEventDefinition",
  );
  const value =
    !applicable || fixed
      ? true
      : event.__$$element === "boundaryEvent"
        ? (event["@_cancelActivity"] ?? true)
        : event.__$$element === "startEvent"
          ? (event["@_isInterrupting"] ?? true)
          : true;
  return { applicable, fixed, value };
}

export function setEventInterrupting(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  value: boolean,
) {
  const { event, owner } = eventById(definitions, eventId);
  if (!eventInterruption(definitions, eventId).applicable)
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (event.__$$element === "boundaryEvent") {
    assertEventContext(
      definitions,
      { ...event, "@_cancelActivity": value },
      owner,
      event,
    );
    event["@_cancelActivity"] = value;
  } else if (event.__$$element === "startEvent") {
    assertEventContext(
      definitions,
      { ...event, "@_isInterrupting": value },
      owner,
      event,
    );
    event["@_isInterrupting"] = value;
  }
}

/** Attachment changes the event schema, not its flow owner or stable ID.
 * Never rebuild the event from a few projected fields: documentation, I/O,
 * references, extensions and sibling order belong to the existing event. */
export function setEventAttachment(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  activityId?: string,
) {
  const { event, owner } = eventById(definitions, eventId);
  if (
    event.__$$element !== "intermediateCatchEvent" &&
    event.__$$element !== "boundaryEvent"
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  const kind = activityId ? "boundaryEvent" : "intermediateCatchEvent";
  const reference = activityId
    ? indexBpmnIds(definitions).referenceFor(
        event,
        activityId,
        "@_attachedToRef" in event ? event["@_attachedToRef"] : undefined,
      )
    : undefined;
  const candidate = {
    ...event,
    __$$element: kind,
    "@_attachedToRef": reference,
  };
  keepIntersection({
    fromElement: event.__$$element,
    toElement: kind,
    srcObj: event,
    targetObj: candidate,
  });
  candidate.__$$element = kind;
  if (activityId) candidate["@_attachedToRef"] = reference;
  assertEventContext(definitions, candidate as BpmnEvent, owner, event);
  keepIntersection({
    fromElement: event.__$$element,
    toElement: kind,
    srcObj: event,
    targetObj: event,
  });
  event.__$$element = kind;
  if (event.__$$element === "boundaryEvent")
    event["@_attachedToRef"] = reference!;
  assertConnectionScope(definitions, owner);
}

/** Validate the same concrete event before import or a semantic command writes.
 * Attachment is a same-scope activity reference, not XML nesting in the host.
 * Error/cancel handlers are interrupting; compensation's flag is inapplicable
 * (Table 10.91), not a reason to synthesize cancelActivity/isInterrupting. */
export function assertEventContext(
  definitions: BPMN20__tDefinitions,
  event: BpmnEvent,
  owner: EventScope,
  lexicalOwner = event,
  definitionOwners: ReadonlyMap<EventDefinition, EventDefinition> = new Map(),
) {
  if (
    "__$$element" in owner &&
    owner.__$$element === "adHocSubProcess" &&
    (event.__$$element === "startEvent" || event.__$$element === "endEvent")
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  const id = event["@_id"];
  const index = indexBpmnIds(definitions);
  const hasIncoming =
    !!event.incoming?.length ||
    owner.flowElement?.some(
      (flow) =>
        flow.__$$element === "sequenceFlow" && flow["@_targetRef"] === id,
    );
  const hasOutgoing =
    !!event.outgoing?.length ||
    owner.flowElement?.some(
      (flow) =>
        flow.__$$element === "sequenceFlow" && flow["@_sourceRef"] === id,
    );
  let transactionHost = false;
  if (event.__$$element === "boundaryEvent") {
    const hostId = index.resolveReference(
      lexicalOwner,
      event["@_attachedToRef"],
    );
    const host = owner.flowElement?.find(
      (element) => element["@_id"] === hostId,
    );
    if (
      !host ||
      ![
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
      ].includes(host.__$$element) ||
      (host.__$$element === "subProcess" && host["@_triggeredByEvent"])
    )
      throw new Error("BPMN_INVALID_EVENT_CONTEXT");
    transactionHost = host.__$$element === "transaction";
  }
  const actual = eventDefinitions(definitions, event, lexicalOwner);
  for (const definition of actual) {
    const lexicalDefinition = definitionOwners.get(definition) ?? definition;
    const typedReference =
      definition.__$$element === "messageEventDefinition"
        ? [definition["@_messageRef"], "message"]
        : definition.__$$element === "signalEventDefinition"
          ? [definition["@_signalRef"], "signal"]
          : definition.__$$element === "errorEventDefinition"
            ? [definition["@_errorRef"], "error"]
            : definition.__$$element === "escalationEventDefinition"
              ? [definition["@_escalationRef"], "escalation"]
              : undefined;
    if (typedReference?.[0]) {
      const targetId = index.resolveReference(
        lexicalDefinition,
        typedReference[0],
      );
      if (
        targetId &&
        !definitions.rootElement?.some(
          (root) =>
            root["@_id"] === targetId && root.__$$element === typedReference[1],
        )
      )
        throw new Error("BPMN_INVALID_EVENT_CONTEXT");
    }
    if (
      (definition.__$$element === "timerEventDefinition" &&
        [
          definition.timeDate,
          definition.timeDuration,
          definition.timeCycle,
        ].filter(Boolean).length > 1) ||
      (definition.__$$element === "conditionalEventDefinition" &&
        !definition.condition)
    )
      throw new Error("BPMN_INVALID_EVENT_CONTEXT");
    if (definition.__$$element === "linkEventDefinition") {
      const peers =
        owner.flowElement?.flatMap((element) =>
          element.__$$element === "intermediateCatchEvent" ||
          element.__$$element === "intermediateThrowEvent"
            ? eventDefinitions(definitions, element).flatMap((definition) =>
                definition.__$$element === "linkEventDefinition"
                  ? [{ definition, event: element }]
                  : [],
              )
            : [],
        ) ?? [];
      if (
        definition["@_name"] &&
        event.__$$element === "intermediateCatchEvent" &&
        peers.some(
          (peer) =>
            peer.event["@_id"] !== event["@_id"] &&
            peer.event.__$$element === "intermediateCatchEvent" &&
            peer.definition["@_name"] === definition["@_name"],
        )
      )
        throw new Error("BPMN_INVALID_EVENT_CONTEXT");
      for (const [reference, role] of [
        ...(definition.source ?? []).map(
          (reference) => [reference, "intermediateThrowEvent"] as const,
        ),
        ...(definition.target
          ? [[definition.target, "intermediateCatchEvent"] as const]
          : []),
      ]) {
        const lexicalReference =
          lexicalDefinition.__$$element === "linkEventDefinition"
            ? reference === definition.target
              ? lexicalDefinition.target
              : lexicalDefinition.source?.[
                  definition.source!.indexOf(reference)
                ]
            : undefined;
        const targetId = index.resolveReference(
          lexicalReference ?? reference,
          reference.__$$text,
        );
        if (
          !targetId ||
          !peers.some(
            (peer) =>
              peer.definition["@_id"] === targetId &&
              peer.event.__$$element === role &&
              peer.definition["@_name"] === definition["@_name"],
          )
        )
          throw new Error("BPMN_INVALID_EVENT_CONTEXT");
      }
    }
  }
  const kinds = actual.map((definition) => definition.__$$element);
  const allowed = allowedEventDefinitionKinds(event, owner, transactionHost);
  if (kinds.some((kind) => !allowed.includes(kind)))
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  const eventSubProcessStart =
    event.__$$element === "startEvent" &&
    "@_triggeredByEvent" in owner &&
    owner["@_triggeredByEvent"];
  if (
    !kinds.length &&
    (eventSubProcessStart ||
      event.__$$element === "intermediateCatchEvent" ||
      event.__$$element === "boundaryEvent")
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (
    ((event.__$$element === "startEvent" ||
      event.__$$element === "boundaryEvent") &&
      hasIncoming) ||
    (event.__$$element === "endEvent" && hasOutgoing)
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (
    event.__$$element === "startEvent" &&
    eventSubProcessStart &&
    kinds.includes("errorEventDefinition") &&
    event["@_isInterrupting"] === false
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (
    event.__$$element === "boundaryEvent" &&
    kinds.some(
      (kind) =>
        kind === "errorEventDefinition" || kind === "cancelEventDefinition",
    ) &&
    event["@_cancelActivity"] === false
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (
    event.__$$element === "boundaryEvent" &&
    kinds.includes("compensateEventDefinition") &&
    hasOutgoing
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  if (
    kinds.includes("linkEventDefinition") &&
    (kinds.length !== 1 ||
      (event.__$$element === "intermediateCatchEvent" && hasIncoming) ||
      (event.__$$element === "intermediateThrowEvent" && hasOutgoing))
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
}

/** Locate the current event by stable ID, never a previous React node prop. */
export function findEventById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  let found: { event: Normalized<BpmnEvent>; owner: EventScope } | undefined;
  visitFlowElementsAndArtifacts(process, ({ element, owner }) => {
    if (element["@_id"] !== id) return true;
    if (
      [
        "startEvent",
        "endEvent",
        "boundaryEvent",
        "intermediateCatchEvent",
        "intermediateThrowEvent",
      ].includes(element.__$$element)
    )
      found = { event: element as Normalized<BpmnEvent>, owner };
    return false;
  });
  return found;
}

export function eventById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
) {
  const found = findEventById(definitions, id);
  if (!found) throw new Error("BPMN_EVENT_NOT_FOUND");
  return found;
}

export function eventAllowedKinds(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
) {
  const { event, owner } = eventById(definitions, eventId);
  const attachedId =
    event.__$$element === "boundaryEvent"
      ? indexBpmnIds(definitions).resolveReference(
          event,
          event["@_attachedToRef"],
        )
      : undefined;
  return allowedEventDefinitionKinds(
    event,
    owner,
    owner.flowElement?.some(
      (element) =>
        element["@_id"] === attachedId && element.__$$element === "transaction",
    ),
  );
}

/** Explicit single/multiple trigger editing. Reuse compatible definitions by
 * kind and occurrence, retaining identities/metadata; do not replace an entire
 * I/O subtree through a trigger form. A new timer has an explicit one-minute
 * duration; conditional/link definitions retain their required model fields.
 * Candidate validation uses the current event's lexical attachment owner,
 * because the not-yet-inserted candidate has no namespace-index identity. */
export function setEventDefinitions(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  kinds: readonly EventDefinitionKind[],
  parallelMultiple = false,
) {
  const { event, owner } = eventById(definitions, id);
  const current = [...(event.eventDefinition ?? [])];
  const resolved = eventDefinitions(definitions, event);
  const currentParallel =
    "@_parallelMultiple" in event && event["@_parallelMultiple"] === true;
  // XML groups inline definitions before definitionRef elements. The trigger
  // alternatives are unordered, so an unchanged multiset must not allocate a
  // new model merely because a referenced trigger precedes an inline choice.
  const existingKinds = resolved
    .map((definition) => definition.__$$element)
    .sort();
  if (
    currentParallel === parallelMultiple &&
    kinds.length === resolved.length &&
    [...kinds].sort().every((kind, index) => existingKinds[index] === kind)
  )
    return;
  const available = resolved.map((definition, index) => ({
    originalIndex: index as number | undefined,
    definition: definition as Normalized<EventDefinition>,
    reference:
      index >= current.length
        ? event.eventDefinitionRef?.[index - current.length]
        : undefined,
  }));
  const entries = kinds.map((kind) => {
    const index = available.findIndex(
      (entry) => entry.definition.__$$element === kind,
    );
    if (index >= 0) return available.splice(index, 1)[0];
    const previous =
      kinds.length === 1 &&
      current.length === 1 &&
      !event.eventDefinitionRef?.length
        ? current[0]
        : undefined;
    const definition = newEventDefinition(kind, previous);
    return {
      definition,
      reference: undefined,
      originalIndex: previous ? 0 : undefined,
    };
  });
  const next = entries
    .filter((entry) => !entry.reference)
    .map((entry) => entry.definition);
  const nextRefs = entries.flatMap((entry) =>
    entry.reference ? [entry.reference] : [],
  );
  applyEventDefinitions(
    definitions,
    event,
    owner,
    next,
    nextRefs,
    parallelMultiple,
    undefined,
    [
      ...entries.filter((entry) => !entry.reference),
      ...entries.filter((entry) => entry.reference),
    ].map((entry) => entry.originalIndex),
  );
}

/** A link name identifies the same-scope throw/catch group. Renaming that
 * group keeps explicit definition references and shared-root consumers intact.
 * Empty unpaired drafts do not form an accidental global name group. */
export function setLinkName(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  target: EventDefinitionTarget,
  name: string,
) {
  const selected = eventDefinitionFor(definitions, eventId, target);
  if (
    selected?.__$$element !== "linkEventDefinition" ||
    selected["@_name"] === name
  )
    return;
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  const scopes = new Set<EventScope>();
  visitFlowElementsAndArtifacts(process, ({ owner }) => {
    scopes.add(owner);
  });
  const groups = [...scopes].map(
    (owner) =>
      owner.flowElement?.flatMap((event) =>
        event.__$$element === "intermediateCatchEvent" ||
        event.__$$element === "intermediateThrowEvent"
          ? eventDefinitions(definitions, event).flatMap((definition) =>
              definition.__$$element === "linkEventDefinition"
                ? [{ definition, event }]
                : [],
            )
          : [],
      ) ?? [],
  );
  const affected = new Set([selected]);
  if (selected["@_name"]) {
    let previous = 0;
    while (previous !== affected.size) {
      previous = affected.size;
      for (const group of groups)
        if (
          group.some((peer) => affected.has(peer.definition as typeof selected))
        )
          for (const peer of group)
            if (peer.definition["@_name"] === selected["@_name"])
              affected.add(peer.definition as typeof selected);
    }
  }
  for (const group of groups)
    if (
      name &&
      group.some(
        (peer) =>
          affected.has(peer.definition as typeof selected) &&
          peer.event.__$$element === "intermediateCatchEvent",
      ) &&
      group.some(
        (peer) =>
          !affected.has(peer.definition as typeof selected) &&
          peer.event.__$$element === "intermediateCatchEvent" &&
          peer.definition["@_name"] === name,
      )
    )
      throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  for (const definition of affected) definition["@_name"] = name;
}

function newEventDefinition(
  kind: EventDefinitionKind,
  previous?: Normalized<EventDefinition>,
): Normalized<EventDefinition> {
  const base = {
    ...previous,
    "@_id": previous?.["@_id"] ?? generateUuid(),
    __$$element: kind,
  };
  const definition: Normalized<EventDefinition> =
    kind === "conditionalEventDefinition"
      ? {
          ...base,
          __$$element: kind,
          condition: { "@_id": generateUuid(), __$$text: "" },
        }
      : kind === "linkEventDefinition"
        ? { ...base, __$$element: kind, "@_name": "" }
        : kind === "timerEventDefinition"
          ? {
              ...base,
              __$$element: kind,
              timeDuration: { "@_id": generateUuid(), __$$text: "PT1M" },
            }
          : (base as Normalized<EventDefinition>);
  if (previous)
    keepIntersection({
      fromElement: previous.__$$element,
      toElement: kind,
      srcObj: previous,
      targetObj: definition,
    });
  return definition;
}

type EventDefinitionChoice =
  { kind: EventDefinitionKind } | { referenceId: string };

/** Change/remove one concrete trigger, or append at the current list length.
 * A referenced root is never morphed or deleted by changing this event's choice.
 * All writes belong to the caller's Immer command, including QName bindings. */
export function editEventDefinition(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  index: number,
  choice?: EventDefinitionChoice,
) {
  const { event, owner } = eventById(definitions, eventId);
  const inline = event.eventDefinition ?? [];
  const refs = event.eventDefinitionRef ?? [];
  if (
    index < 0 ||
    index > inline.length + refs.length ||
    (!choice && index === inline.length + refs.length)
  )
    throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  const next = [...inline],
    nextRefs = [...refs];
  const nextOrder = inline.map((_, i): number | undefined => i),
    nextRefOrder = refs.map((_, i): number | undefined => inline.length + i);
  const previous = index < inline.length ? inline[index] : undefined;
  const definitionOwners = new Map<EventDefinition, EventDefinition>();
  if (choice && "kind" in choice && previous?.__$$element === choice.kind)
    return;
  if (choice && "referenceId" in choice) {
    const root = definitions.rootElement?.find(
      (root) => root["@_id"] === choice.referenceId,
    );
    if (!root || !root.__$$element.endsWith("EventDefinition"))
      throw new Error("BPMN_INVALID_EVENT_CONTEXT");
    const references = indexBpmnIds(definitions);
    const oldRef =
      index >= inline.length ? refs[index - inline.length] : undefined;
    if (
      oldRef &&
      references.resolveReference(oldRef, oldRef.__$$text) ===
        choice.referenceId
    )
      return;
    const reference = {
      __$$text: references.referenceFor(event, choice.referenceId)!,
    };
    if (previous) {
      next.splice(index, 1);
      nextOrder.splice(index, 1);
    } else if (oldRef) {
      nextRefs.splice(index - inline.length, 1);
      nextRefOrder.splice(index - inline.length, 1);
    }
    nextRefs.push(reference);
    nextRefOrder.push(index < inline.length + refs.length ? index : undefined);
  } else {
    if (previous) {
      next.splice(index, 1);
      nextOrder.splice(index, 1);
    } else if (index < inline.length + refs.length) {
      nextRefs.splice(index - inline.length, 1);
      nextRefOrder.splice(index - inline.length, 1);
    }
    if (choice) {
      const referenced =
        !previous && index < inline.length + refs.length
          ? eventDefinitions(definitions, event)[index]
          : undefined;
      let replacement = newEventDefinition(choice.kind, previous);
      if (referenced?.__$$element === choice.kind) {
        // This model owner is also compiled without DOM libraries for workers.
        const { structuredClone } = globalThis as typeof globalThis & {
          structuredClone<T>(value: T): T;
        };
        replacement = structuredClone(
          isDraft(referenced) ? currentDraft(referenced) : referenced,
        ) as Normalized<EventDefinition>;
        Object.assign(
          replacement,
          indexBpmnIds(definitions).namespaceDeclarationsFor(referenced),
        );
        const fragment = { rootElement: [replacement] };
        const randomizer = getNewBpmnIdRandomizer(definitions);
        randomizer.ack({
          json: fragment.rootElement,
          parentJson: fragment,
          type: "BPMN20__tDefinitions",
          attr: "rootElement",
        });
        randomizer.randomize({ skipAlreadyAttributedIds: false });
        definitionOwners.set(replacement, referenced);
      }
      next.splice(Math.min(index, next.length), 0, replacement);
      nextOrder.splice(
        Math.min(index, nextOrder.length),
        0,
        index < inline.length + refs.length ? index : undefined,
      );
    }
  }
  applyEventDefinitions(
    definitions,
    event,
    owner,
    next,
    nextRefs,
    "@_parallelMultiple" in event && event["@_parallelMultiple"] === true,
    definitionOwners,
    [...nextOrder, ...nextRefOrder],
  );
}

/** Promote this inline declaration without duplicating its identity or losing
 * its inherited namespace scope. Existing consumers keep the same ID; the
 * current event switches to a standard definitionRef in one history command. */
export function shareEventDefinition(
  definitions: Normalized<BPMN20__tDefinitions>,
  eventId: string,
  index: number,
) {
  const { event } = eventById(definitions, eventId);
  const definition = event.eventDefinition?.[index];
  if (!definition) throw new Error("BPMN_INVALID_EVENT_CONTEXT");
  Object.assign(
    definition,
    indexBpmnIds(definitions).namespaceDeclarationsFor(definition),
  );
  definition["@_id"] ??= generateUuid();
  const reference = {
    __$$text: indexBpmnIds(definitions).referenceFor(
      event,
      definition["@_id"],
    )!,
  };
  reorderEventPayloads(event, [
    ...event.eventDefinition!.flatMap((_, i) => (i === index ? [] : [i])),
    ...(event.eventDefinitionRef ?? []).map(
      (_, i) => event.eventDefinition!.length + i,
    ),
    index,
  ]);
  event.eventDefinition!.splice(index, 1);
  if (!event.eventDefinition!.length) delete event.eventDefinition;
  (definitions.rootElement ??= []).push(definition);
  (event.eventDefinitionRef ??= []).push(reference);
}

function applyEventDefinitions(
  definitions: Normalized<BPMN20__tDefinitions>,
  event: Normalized<BpmnEvent>,
  owner: EventScope,
  next: Normalized<EventDefinition>[],
  nextRefs: NonNullable<BpmnEvent["eventDefinitionRef"]>,
  parallelMultiple: boolean,
  definitionOwners?: ReadonlyMap<EventDefinition, EventDefinition>,
  payloadOrder?: readonly (number | undefined)[],
) {
  const current = event.eventDefinition ?? [];
  const candidate = {
    ...event,
    eventDefinition: next,
    eventDefinitionRef: nextRefs,
  };
  if ("@_parallelMultiple" in event || parallelMultiple) {
    if (
      candidate.__$$element !== "startEvent" &&
      candidate.__$$element !== "intermediateCatchEvent" &&
      candidate.__$$element !== "boundaryEvent"
    )
      throw new Error("BPMN_INVALID_EVENT_CONTEXT");
    candidate["@_parallelMultiple"] = parallelMultiple;
  }
  assertEventContext(definitions, candidate, owner, event, definitionOwners);
  const references = indexBpmnIds(definitions);
  const retainedIds = new Set<string>();
  const collect = (value: unknown, visitor: (id: string) => void) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((child) => collect(child, visitor));
      return;
    }
    const object = value as Record<string, unknown>;
    if (typeof object["@_id"] === "string") visitor(object["@_id"]);
    for (const [key, child] of Object.entries(object))
      if (!key.startsWith("@_") && !key.startsWith("__$$"))
        collect(child, visitor);
  };
  collect(next, (id) => retainedIds.add(id));
  collect(current, (id) => {
    if (!retainedIds.has(id) && references.isReferenced(id))
      throw new Error("BPMN_DEFINITION_IN_USE");
  });
  if (payloadOrder) reorderEventPayloads(event, payloadOrder);
  if (next.length) event.eventDefinition = next;
  else delete event.eventDefinition;
  if (nextRefs.length) event.eventDefinitionRef = nextRefs;
  else delete event.eventDefinitionRef;
  if (
    "@_parallelMultiple" in candidate &&
    (event.__$$element === "startEvent" ||
      event.__$$element === "intermediateCatchEvent" ||
      event.__$$element === "boundaryEvent")
  )
    event["@_parallelMultiple"] = candidate["@_parallelMultiple"];
  assertConnectionScope(definitions, owner);
}

/** EventDefinition/definitionRef schema order also orders their payload slots
 * (BPMN 2.0.2, 10.3.1 Events). Sharing/inlining may change that order even though
 * identities are stable. Move the complete payloads, never their IDREF consumers.
 * A trigger-only control cannot add/remove or guess an unmatched payload contract. */
function reorderEventPayloads(
  event: Normalized<BpmnEvent>,
  order: readonly (number | undefined)[],
) {
  const payloads =
    "dataOutput" in event
      ? event.dataOutput
      : "dataInput" in event
        ? event.dataInput
        : undefined;
  if (!payloads?.length) return;
  const count =
    (event.eventDefinition?.length ?? 0) +
    (event.eventDefinitionRef?.length ?? 0);
  if (
    order.length === count &&
    order.every((source, index) => source === index)
  )
    return;
  if (
    order.length !== count ||
    payloads.length !== count ||
    order.some(
      (source) => source === undefined || source < 0 || source >= count,
    ) ||
    new Set(order).size !== count
  )
    throw new Error("BPMN_DEFINITION_IN_USE");
  if ("dataOutput" in event && event.dataOutput) {
    const previous = event.dataOutput;
    event.dataOutput = order.map((source) => previous[source!]);
  } else if ("dataInput" in event && event.dataInput) {
    const previous = event.dataInput;
    event.dataInput = order.map((source) => previous[source!]);
  }
}
