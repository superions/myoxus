// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BPMN20__tDefinitions,
  BPMN20__tDataStore,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import type { Normalized } from "../normalization/normalize";
import { connectionElement, findConnectionElement } from "./connection";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../xyflow/uuid/uuid";

/** DataStore is a definitions root with no shape. Every DataStoreReference owns
 * its own name/state/DI and resolves a lexical QName to that shared root, even
 * across subprocess scopes. Deleting a reference never deletes its root. */
export function referencedDataStore(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
): (Normalized<BPMN20__tDataStore> & { __$$element: "dataStore" }) | undefined {
  const element = findConnectionElement(definitions, id)?.element;
  if (element?.__$$element !== "dataStoreReference") return undefined;
  const target = indexBpmnIds(definitions).resolveReference(
    element,
    element["@_dataStoreRef"],
  );
  const root = definitions.rootElement?.find(
    (root) => root.__$$element === "dataStore" && root["@_id"] === target,
  );
  return root?.__$$element === "dataStore" ? root : undefined;
}

export function setDataStoreReference(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  targetId?: string,
) {
  const { element } = connectionElement(definitions, id);
  if (element.__$$element !== "dataStoreReference")
    throw new Error("BPMN_INVALID_CONNECTION");
  if (!targetId) {
    delete element["@_dataStoreRef"];
    return;
  }
  if (
    !definitions.rootElement?.some(
      (root) => root.__$$element === "dataStore" && root["@_id"] === targetId,
    )
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  element["@_dataStoreRef"] = indexBpmnIds(definitions).referenceFor(
    element,
    targetId,
    element["@_dataStoreRef"],
  );
}

export function createDataStore(
  definitions: Normalized<BPMN20__tDefinitions>,
  referenceId: string,
) {
  const id = generateUuid();
  (definitions.rootElement ??= []).push({
    __$$element: "dataStore",
    "@_id": id,
  });
  setDataStoreReference(definitions, referenceId, id);
}

export function setDataStoreDetails(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string,
  change: {
    name?: string;
    documentation?: string;
    capacity?: number | "";
    unlimited?: boolean;
    state?: string;
    itemId?: string | null;
  },
) {
  const root = definitions.rootElement?.find(
    (root) => root.__$$element === "dataStore" && root["@_id"] === id,
  );
  if (root?.__$$element !== "dataStore")
    throw new Error("BPMN_INVALID_CONNECTION");
  if (
    change.capacity !== undefined &&
    change.capacity !== "" &&
    (!Number.isSafeInteger(change.capacity) || change.capacity < 0)
  )
    throw new Error("BPMN_INVALID_CONNECTION");
  if (change.itemId !== undefined) {
    if (change.itemId === null) delete root["@_itemSubjectRef"];
    else {
      if (
        !definitions.rootElement?.some(
          (item) =>
            item.__$$element === "itemDefinition" &&
            item["@_id"] === change.itemId,
        )
      )
        throw new Error("BPMN_INVALID_CONNECTION");
      root["@_itemSubjectRef"] = indexBpmnIds(definitions).referenceFor(
        root,
        change.itemId,
        root["@_itemSubjectRef"],
      );
    }
  }
  if (change.name !== undefined) root["@_name"] = change.name;
  if (change.unlimited !== undefined) root["@_isUnlimited"] = change.unlimited;
  // The official Semantic.xsd defaults isUnlimited to true. Toggling it does
  // not erase an authored capacity: it becomes effective again when bounded.
  if (change.capacity !== undefined) {
    if (change.capacity === "") delete root["@_capacity"];
    else root["@_capacity"] = change.capacity;
  }
  if (change.documentation !== undefined) {
    root.documentation ??= [];
    root.documentation[0] ??= { "@_id": generateUuid() };
    root.documentation[0].__$$text = change.documentation;
  }
  if (change.state !== undefined) {
    if (change.state) {
      root.dataState ??= { "@_id": generateUuid() };
      root.dataState["@_name"] = change.state;
    } else {
      if (
        root.dataState?.["@_id"] &&
        indexBpmnIds(definitions).isReferenced(root.dataState["@_id"])
      )
        throw new Error("BPMN_DEFINITION_IN_USE");
      delete root.dataState;
    }
  }
}
