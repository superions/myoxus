// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BPMN20__tProcess } from "../../schemas/bpmn-2_0/ts-gen/types";
type SourceSubProcess = Extract<
  NonNullable<BPMN20__tProcess["flowElement"]>[number],
  { __$$element: "subProcess" | "adHocSubProcess" | "transaction" }
>;

/** Ad-hoc work has no direct start/end events. Ordinary embedded subprocesses
 * start with none events; event-triggered subprocesses own a distinct context.
 * Source admission shares this guard without loading editor/React commands. */
export function assertSubProcessContext(subProcess: SourceSubProcess) {
  if (
    subProcess.__$$element === "transaction" &&
    subProcess["@_triggeredByEvent"]
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  if (
    subProcess.__$$element === "subProcess" &&
    subProcess["@_triggeredByEvent"]
  ) {
    const starts =
      subProcess.flowElement?.filter(
        (element) => element.__$$element === "startEvent",
      ) ?? [];
    if (
      subProcess.incoming?.length ||
      subProcess.outgoing?.length ||
      subProcess.loopCharacteristics ||
      starts.length !== 1 ||
      (!starts[0].eventDefinition?.length &&
        !starts[0].eventDefinitionRef?.length)
    )
      throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  }
  if (
    subProcess.__$$element === "adHocSubProcess" &&
    subProcess.flowElement?.some(
      (element) =>
        element.__$$element === "startEvent" ||
        element.__$$element === "endEvent",
    )
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
  if (
    (subProcess.__$$element === "subProcess" ||
      subProcess.__$$element === "transaction") &&
    !subProcess["@_triggeredByEvent"] &&
    subProcess.flowElement?.some(
      (element) =>
        element.__$$element === "startEvent" &&
        (element.eventDefinition?.length || element.eventDefinitionRef?.length),
    )
  )
    throw new Error("BPMN_INVALID_ACTIVITY_CONTEXT");
}
