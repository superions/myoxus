/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus; see provenance.json for retained source and patches.

import { type BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
import { type ElementFilter } from "../../xml-parser/element-filter";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import { type Normalized } from "../normalization/normalize";
import { resolveBpmnProcessOwner } from "../../process-source";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";

/** ID-less imported declarations retain their current root-array ordinal.
 * They can be edited but cannot be selected by a QName until given an ID. */
export function itemDefinitionById(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string | number,
) {
  resolveBpmnProcessOwner(definitions);
  const root =
    typeof id === "number"
      ? Number.isInteger(id) && id >= 0
        ? definitions.rootElement?.[id]
        : undefined
      : definitions.rootElement?.find(
          (root) =>
            root.__$$element === "itemDefinition" && root["@_id"] === id,
        );
  if (
    !root ||
    root.__$$element !== "itemDefinition" ||
    (typeof id === "number" && root["@_id"])
  )
    throw new Error("BPMN_DEFINITION_NOT_FOUND");
  return root;
}

/** Explicit metadata edits preserve unset defaults and every other declaration
 * field/reference. No consumer is retyped or redirected as a side effect. */
export function setItemDefinitionMetadata(
  definitions: Normalized<BPMN20__tDefinitions>,
  id: string | number,
  field: "@_itemKind" | "@_isCollection",
  value: "Information" | "Physical" | boolean | undefined,
) {
  if (field === "@_itemKind") {
    if (value !== undefined && value !== "Information" && value !== "Physical")
      throw new Error("BPMN_INVALID_DATA_CONTEXT");
    const item = itemDefinitionById(definitions, id);
    if (value === undefined) delete item[field];
    else item[field] = value;
  } else {
    if (value !== undefined && typeof value !== "boolean")
      throw new Error("BPMN_INVALID_DATA_CONTEXT");
    const item = itemDefinitionById(definitions, id);
    if (value === undefined) delete item[field];
    else item[field] = value;
  }
}
/** Edits a complete external XML type name, not the ItemDefinition's stable ID.
 * Empty clears the optional type. Partial prefixes remain in the field owner's
 * draft, never in this model; no identity cascade follows a type edit. */
export function renameItemDefinition({
  definitions,
  id,
  newItemDefinitionName,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  id: string | number;
  newItemDefinitionName: string;
}):
  | {
      itemDefinition: ElementFilter<
        Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
        "itemDefinition"
      >;
    }
  | undefined {
  const itemDefinition = itemDefinitionById(definitions, id);
  const value = newItemDefinitionName.trim();
  if (value) indexBpmnIds(definitions).expandQName(itemDefinition, value);
  if (value) itemDefinition["@_structureRef"] = newItemDefinitionName;
  else delete itemDefinition["@_structureRef"];

  return {
    itemDefinition,
  };
}
