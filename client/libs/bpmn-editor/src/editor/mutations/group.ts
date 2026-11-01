// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { connectionElement, findConnectionElement } from "./connection";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { addOrGetCategory } from "./addOrGetCategory";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { qnameListChoices, resolveQNameList } from "./qname-list";

function categoryValues(definitions: Normalized<BPMN20__tDefinitions>) {
  return (
    definitions.rootElement
      ?.filter((root) => root.__$$element === "category")
      .flatMap((root) => root.categoryValue ?? []) ?? []
  );
}

export function groupCategoryValue(
  definitions: Normalized<BPMN20__tDefinitions>,
  groupId: string,
) {
  const group = findConnectionElement(definitions, groupId)?.element;
  if (group?.__$$element !== "group") return undefined;
  const id = indexBpmnIds(definitions).resolveReference(
    group,
    group["@_categoryValueRef"],
  );
  return categoryValues(definitions).find((value) => value["@_id"] === id);
}

/** Category values are shared definitions, not group-owned names. Editing the
 * selected value intentionally updates every referring group; selecting another
 * value changes only this group. Neither clearing a reference nor deleting a
 * group destroys the shared category/value declaration. */
export function setGroupCategory(
  definitions: Normalized<BPMN20__tDefinitions>,
  groupId: string,
  valueId?: string,
) {
  const { element: group } = connectionElement(definitions, groupId);
  if (group.__$$element !== "group") throw new Error("BPMN_INVALID_CONNECTION");
  if (!valueId) {
    delete group["@_categoryValueRef"];
    return;
  }
  if (!categoryValues(definitions).some((value) => value["@_id"] === valueId))
    throw new Error("BPMN_INVALID_CONNECTION");
  group["@_categoryValueRef"] = indexBpmnIds(definitions).referenceFor(
    group,
    valueId,
    group["@_categoryValueRef"],
  );
}

export function setGroupCategoryText(
  definitions: Normalized<BPMN20__tDefinitions>,
  groupId: string,
  text = "",
) {
  const { element: group } = connectionElement(definitions, groupId);
  if (group.__$$element !== "group") throw new Error("BPMN_INVALID_CONNECTION");
  let value = groupCategoryValue(definitions, groupId);
  if (!value) {
    if (!text) return;
    value = { "@_id": generateUuid() };
    (addOrGetCategory({ definitions }).category.categoryValue ??= []).push(
      value,
    );
    setGroupCategory(definitions, groupId, value["@_id"]);
  }
  value["@_value"] = text;
}

/** CategoryValue references also belong to FlowElement, independently of a
 * graphical Group. Artifacts and lanes do not inherit this list. */
export function flowCategoryOwner(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
):
  Normalized<NonNullable<BPMN20__tProcess["flowElement"]>[number]> | undefined {
  const element = findConnectionElement(definitions, id)?.element;
  return element &&
    element.__$$element !== "association" &&
    element.__$$element !== "group" &&
    element.__$$element !== "textAnnotation"
    ? element
    : undefined;
}

export function flowCategoryChoices(
  definitions: Normalized<BPMN20__tDefinitions>,
  owner: ReturnType<typeof flowCategoryOwner>,
) {
  const values = categoryValues(definitions).filter((value) => !!value["@_id"]);
  const targets = values.map((value) => ({
    value: value["@_id"],
    label: value["@_value"] || value["@_id"],
  }));
  return qnameListChoices(definitions, owner?.categoryValueRef ?? [], targets);
}

/** A list edit changes only the selected FlowElement, not shared category
 * values, group membership or DI. Preflight every target before referenceFor
 * can add namespace bindings; preserve retained lexical reference nodes. */
export function setFlowCategories(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  values: readonly string[],
) {
  const owner = flowCategoryOwner(definitions, id);
  if (!owner) throw new Error("BPMN_INVALID_CONNECTION");
  const categories = new Set(
    categoryValues(definitions)
      .map((value) => value["@_id"])
      .filter(Boolean),
  );
  const next = resolveQNameList({
    definitions,
    owner,
    previous: owner.categoryValueRef ?? [],
    selected: values,
    targets: categories,
  });
  if (next.length) owner.categoryValueRef = next;
  else delete owner.categoryValueRef;
}
