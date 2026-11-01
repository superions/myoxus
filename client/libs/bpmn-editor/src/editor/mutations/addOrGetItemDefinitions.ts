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
import { generateUuid } from "../../xyflow/uuid/uuid";
import { resolveBpmnProcessOwner } from "../../process-source";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
export const DEFAULT_DATA_TYPES = {
  STRING: "String",
  BOOLEAN: "Boolean",
  FLOAT: "Float",
  INTEGER: "Integer",
  OBJECT: "Object",
};
const XML_SCHEMA_NAMESPACE = "http://www.w3.org/2001/XMLSchema";
const BUILTIN_TYPES: Readonly<Record<string, string>> = {
  String: "string",
  Boolean: "boolean",
  Float: "float",
  Integer: "integer",
  Object: "anyType",
};

/** UI conveniences denote standard XML Schema types, not label-derived types
 * in the BPMN model namespace. Only scalar Information declarations qualify;
 * a Physical item or collection with the same QName is not the same data type. */
export function defaultDataType(
  index: ReturnType<typeof indexBpmnIds>,
  item: {
    "@_structureRef"?: string;
    "@_itemKind"?: string;
    "@_isCollection"?: boolean;
  },
) {
  if (
    !item["@_structureRef"] ||
    item["@_itemKind"] === "Physical" ||
    item["@_isCollection"] === true
  )
    return undefined;
  const type = index.expandQName(item, item["@_structureRef"]);
  return type.namespace === XML_SCHEMA_NAMESPACE
    ? Object.keys(BUILTIN_TYPES).find(
        (token) => BUILTIN_TYPES[token] === type.localPart,
      )
    : undefined;
}
/** Requires the existing single process/plane; creates only a type declaration, not its owner. */
export function addOrGetItemDefinitions({
  definitions,
  dataType,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  dataType: string;
}): {
  itemDefinition: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "itemDefinition"
  >;
} {
  resolveBpmnProcessOwner(definitions);
  const roots = definitions.rootElement!;
  const index = indexBpmnIds(definitions);
  const builtin = Object.hasOwn(BUILTIN_TYPES, dataType)
    ? BUILTIN_TYPES[dataType]
    : undefined;
  const requested = builtin
    ? { namespace: XML_SCHEMA_NAMESPACE, localPart: builtin }
    : dataType
      ? index.expandQName(definitions, dataType)
      : undefined;
  const itemDefinitions = roots.filter(
    (s) => s.__$$element === "itemDefinition",
  );
  const existingItemDefinition = itemDefinitions.find((item) => {
    // This creation convenience requests a scalar Information item. Explicit
    // declaration selections elsewhere remain identity-based, never QName-based.
    if (
      !requested ||
      !item["@_structureRef"] ||
      item["@_itemKind"] === "Physical" ||
      item["@_isCollection"] === true ||
      !item["@_id"]
    )
      return false;
    const existing = index.expandQName(item, item["@_structureRef"]);
    return (
      existing.namespace === requested.namespace &&
      existing.localPart === requested.localPart
    );
  });
  if (existingItemDefinition) {
    return {
      itemDefinition: existingItemDefinition,
    };
  }
  const newItemDefinition: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "itemDefinition"
  > = {
    __$$element: "itemDefinition",
    "@_id": generateUuid(),
    ...(dataType && !builtin ? { "@_structureRef": dataType } : {}),
  };
  roots.push(newItemDefinition);
  if (builtin)
    newItemDefinition["@_structureRef"] = indexBpmnIds(definitions).qnameFor(
      newItemDefinition,
      XML_SCHEMA_NAMESPACE,
      builtin,
      "xsd",
    );
  return {
    itemDefinition: newItemDefinition,
  };
}
