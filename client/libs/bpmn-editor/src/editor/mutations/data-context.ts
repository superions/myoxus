// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDataObjectReference,
  BPMN20__tProcess,
  BPMN20__tSubProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";

export type DataScope = BPMN20__tProcess | BPMN20__tSubProcess;

/** dataObjectRef is a same-scope XML IDREF, not a QName. Namespace aliases
 * cannot make a nested declaration or a different element kind a valid target.
 * An unbound reference is a standard modelling draft with no collection marker. */
export function dataObjectReferenceTarget(
  scope: DataScope,
  reference: BPMN20__tDataObjectReference,
) {
  if (reference["@_dataObjectRef"] === undefined) return undefined;
  const id = reference["@_dataObjectRef"].trim();
  const target = scope.flowElement?.find(
    (element) => element.__$$element === "dataObject" && element["@_id"] === id,
  );
  if (target?.__$$element !== "dataObject")
    throw new Error("BPMN_INVALID_CONNECTION");
  return target;
}
