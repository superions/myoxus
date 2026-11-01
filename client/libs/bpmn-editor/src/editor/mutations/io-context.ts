// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tInputSet,
  BPMN20__tOutputSet,
  BPMN20__tInputOutputSpecification,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { DataAssociationHost } from "./data-association-context";

export type IoSet = BPMN20__tInputSet & BPMN20__tOutputSet;
export type IoDirection = "input" | "output";
export const ioSetKeys = {
  input: {
    members: "dataInputRefs",
    optional: "optionalInputRefs",
    executing: "whileExecutingInputRefs",
    counterparts: "outputSetRefs",
  },
  output: {
    members: "dataOutputRefs",
    optional: "optionalOutputRefs",
    executing: "whileExecutingOutputRefs",
    counterparts: "inputSetRefs",
  },
} as const;
export type IoSetField = keyof typeof ioSetKeys.input;
export const isEventIoOwner = (host: { __$$element?: unknown }) =>
  [
    "startEvent",
    "intermediateCatchEvent",
    "boundaryEvent",
    "endEvent",
    "intermediateThrowEvent",
  ].includes(String(host.__$$element));

export function eventIoSpecification(
  host: DataAssociationHost,
): BPMN20__tInputOutputSpecification {
  return {
    dataInput: host.dataInput,
    dataOutput: host.dataOutput,
    inputSet: host.inputSet ? [host.inputSet] : [],
    outputSet: host.outputSet ? [host.outputSet] : [],
  };
}

/** OMG 10.61/10.62: subset links stay within their set; every specified slot
 * belongs to at least one set of its direction. Counterpart references are
 * local IDREFs, not QName aliases or sets borrowed from another activity.
 * Event sets are optional singletons; an absent event set is not synthesized. */
export function assertIoSets(
  specification: BPMN20__tInputOutputSpecification,
  requirePairs = true,
) {
  for (const direction of ["input", "output"] as const) {
    const sets =
        direction === "input"
          ? specification.inputSet
          : specification.outputSet,
      items =
        direction === "input"
          ? specification.dataInput
          : specification.dataOutput,
      opposite =
        direction === "input"
          ? specification.outputSet
          : specification.inputSet,
      keys = ioSetKeys[direction];
    if (!sets?.length) {
      if (requirePairs) throw new Error("BPMN_INVALID_IO_SET");
      continue;
    }
    const ids = new Set(
        items?.map((item) => item["@_id"]).filter((id): id is string => !!id),
      ),
      otherIds = new Set(
        opposite?.map((set) => set["@_id"]).filter((id): id is string => !!id),
      );
    for (const set of sets as IoSet[]) {
      const members = new Set(
        set[keys.members]?.map((ref) => ref.__$$text.trim()),
      );
      if ([...members].some((id) => !ids.has(id)))
        throw new Error("BPMN_INVALID_IO_SET");
      for (const field of [keys.optional, keys.executing])
        if (set[field]?.some((ref) => !members.has(ref.__$$text.trim())))
          throw new Error("BPMN_INVALID_IO_SET");
      if (
        set[keys.counterparts]?.some(
          (ref) => !otherIds.has(ref.__$$text.trim()),
        )
      )
        throw new Error("BPMN_INVALID_IO_SET");
    }
    if (
      items?.some(
        (item) =>
          !item["@_id"] ||
          !sets.some((set) =>
            (set as IoSet)[keys.members]?.some(
              (ref) => ref.__$$text.trim() === item["@_id"],
            ),
          ),
      )
    )
      throw new Error("BPMN_INVALID_IO_SET");
  }
}
