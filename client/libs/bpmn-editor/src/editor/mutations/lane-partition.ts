// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BPMN20__tDefinitions,
  BPMN20__tLane,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { meta } from "../../schemas/bpmn-2_0/ts-gen/meta";
import type { Meta } from "../../xml-parser";
import type { Normalized } from "../normalization/normalize";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { visitBpmnSourceObjects, visitProcessLanes } from "./element-visitor";

/** Lane partition targets are standard BaseElements, not arbitrary XML IDs.
 * The generated metadata flattens BaseElement's ID/documentation/extensions;
 * this excludes Definitions, Documentation and BPMNDI identities. Opaque XML
 * remains unopened through the existing observational source visitor. */
export function lanePartitionTargets(definitions: BPMN20__tDefinitions) {
  const targets: { value: string; label: string }[] = [];
  visitBpmnSourceObjects(definitions, ({ value, schemaType }) => {
    const schema = (meta as Meta)[schemaType ?? ""];
    const id = value["@_id"];
    if (
      typeof id !== "string" ||
      !schemaType?.startsWith("BPMN20__") ||
      !schema?.["@_id"] ||
      !schema.documentation ||
      !schema.extensionElements
    )
      return;
    const name = value["@_name"];
    targets.push({
      value: id,
      label: typeof name === "string" && name ? `${name} (${id})` : id,
    });
  });
  return targets;
}

export function validLanePartitionReference(
  definitions: BPMN20__tDefinitions,
  owner: object,
  value: string,
) {
  if (!value.trim()) return true;
  try {
    const index = indexBpmnIds(definitions),
      id = index.resolveReference(owner, value);
    if (id)
      return lanePartitionTargets(definitions).some(
        (target) => target.value === id,
      );
    const { namespace } = index.expandQName(owner, value);
    return (
      !!namespace &&
      namespace !== definitions["@_targetNamespace"] &&
      namespace !== "http://www.omg.org/spec/BPMN/20100524/MODEL"
    );
  } catch {
    return false;
  }
}

/** Resolve from the current snapshot: RF node props can lag a store update. */
export function lanePartitionOwner(
  definitions: Normalized<BPMN20__tDefinitions>,
  laneId: string,
) {
  const process = definitions.rootElement?.find(
    (root) => root.__$$element === "process",
  );
  if (!process) return;
  let lane: Normalized<BPMN20__tLane> | undefined;
  visitProcessLanes(process, ({ lane: current }) => {
    if (current["@_id"] !== laneId) return true;
    lane = current;
    return false;
  });
  return lane;
}

/** Partition classification metadata does not reassign members, move a lane or
 * replace its inline partitionElement. Encode at the live nested lane owner;
 * imported external references never alias a local element with the same name. */
export function setLanePartitionReference(
  definitions: Normalized<BPMN20__tDefinitions>,
  laneId: string,
  target:
    | { kind: "internal"; id: string }
    | { kind: "reference"; qname: string }
    | undefined,
) {
  const lane = lanePartitionOwner(definitions, laneId);
  if (!lane) throw new Error("BPMN_LANE_NOT_FOUND");
  if (!target) {
    delete lane["@_partitionElementRef"];
    return;
  }
  if (target.kind === "reference") {
    if (!validLanePartitionReference(definitions, lane, target.qname))
      throw new Error("BPMN_INVALID_LANE_PARTITION");
    if (target.qname.trim()) lane["@_partitionElementRef"] = target.qname;
    else delete lane["@_partitionElementRef"];
  } else {
    if (
      !lanePartitionTargets(definitions).some(
        (choice) => choice.value === target.id,
      )
    )
      throw new Error("BPMN_INVALID_LANE_PARTITION");
    lane["@_partitionElementRef"] = indexBpmnIds(definitions).referenceFor(
      lane,
      target.id,
      lane["@_partitionElementRef"],
    );
  }
}
