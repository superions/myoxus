// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tProcess,
  BPMN20__tDataInput,
  BPMN20__tDataOutput,
} from "../../schemas/bpmn-2_0/ts-gen/types";

export type ProcessIoKind = "dataInput" | "dataOutput";
export type ProcessIoItem = BPMN20__tDataInput | BPMN20__tDataOutput;

/** OMG 10.3.1: independent input/output notation depicts the top-level process
 * interface. Activity/Event slots remain owned implicit I/O, not flowElements
 * or separately invented process declarations. Reads never create a spec. */
export function processIoItems(process: BPMN20__tProcess) {
  return (["dataInput", "dataOutput"] as const).flatMap((kind) =>
    (process.ioSpecification?.[kind] ?? []).map((element, index) => ({
      kind,
      element,
      index,
      array: process.ioSpecification![kind]!,
    })),
  );
}
export function findProcessIoItem(process: BPMN20__tProcess, id: string) {
  return processIoItems(process).find(
    (location) => location.element["@_id"] === id,
  );
}
