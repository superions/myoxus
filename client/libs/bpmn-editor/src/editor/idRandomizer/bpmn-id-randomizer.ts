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

import { generateUuid } from "../../xyflow/uuid/uuid";
import { elements, meta } from "../../schemas/bpmn-2_0/ts-gen/meta";
import { XmlParserTsIdRandomizer } from "../../xml-parser/id-randomizer";
import { type BpmnLatestModel } from "../../marshaller";
import { resolveBpmnProcessOwner } from "../../process-source";
import { isXmlNCName, parseXmlQName } from "../../xml-parser/q-names";

/** A fresh remapping transaction; never reuse its acknowledgements across pastes. */
export function getNewBpmnIdRandomizer(
  definitions?: BpmnLatestModel["definitions"],
) {
  const namespaces = new Map<string, string>();
  for (const [name, value] of Object.entries(definitions ?? {})) {
    if (name === "@_xmlns" && typeof value === "string")
      namespaces.set("", value);
    else if (name.startsWith("@_xmlns:") && typeof value === "string") {
      namespaces.set(name.slice("@_xmlns:".length), value);
    }
  }
  return new XmlParserTsIdRandomizer({
    meta,
    elements,
    newIdGenerator: generateUuid,
    namespaces,
    localNamespace: definitions?.["@_targetNamespace"],
    // Bare BPMN DI/semantic references use owned IDs under the standard model
    // namespace; a foreign default or explicitly foreign prefix stays external.
    unprefixedReferenceNamespace: "http://www.omg.org/spec/BPMN/20100524/MODEL",
    resolveType: ({ declaredType, value, namespaces }) => {
      if (declaredType !== "BPMN20__tExpression") return undefined;
      // Formal expressions are often carried by a schema-typed condition rather
      // than an element substitution. Their result type is still an owned QName
      // dependency for delete/rename/clipboard, not opaque expression text.
      const typed = Object.entries(value).find(
        ([name, content]) =>
          name.startsWith("@_") &&
          name.endsWith(":type") &&
          typeof content === "string" &&
          namespaces.get(name.slice(2, -5)) ===
            "http://www.w3.org/2001/XMLSchema-instance",
      )?.[1];
      if (typeof typed !== "string") return undefined;
      const qname = parseXmlQName(typed);
      return qname.localPart === "tFormalExpression" &&
        namespaces.get(qname.prefix ?? "") ===
          "http://www.omg.org/spec/BPMN/20100524/MODEL"
        ? "BPMN20__tFormalExpression"
        : undefined;
    },
    // These QNames name imported XML types/implementations, not BPMN IDs.
    // Other structureRef fields (Signal/Error/Escalation) do point to owned
    // ItemDefinitions and must continue participating in rename/delete checks.
    nonIdentityQNames: new Set([
      "BPMN20__tItemDefinition.@_structureRef",
      "BPMN20__tInterface.@_implementationRef",
      "BPMN20__tOperation.@_implementationRef",
    ]),
  });
}

/** Build a read-only declaration/reference index with the same QName rules as paste/rename. */
export function indexBpmnIds(definitions: BpmnLatestModel["definitions"]) {
  const index = getNewBpmnIdRandomizer(definitions);
  for (const attr of Object.keys(
    meta.BPMN20__tDefinitions,
  ) as (keyof typeof meta.BPMN20__tDefinitions)[]) {
    index.ack({
      json: definitions[attr],
      parentJson: definitions,
      type: "BPMN20__tDefinitions",
      attr,
    });
  }
  return index;
}

/** Change the declared target namespace without rebinding imported XML types
 * that happen to share its old alias. Call within the model/history transaction;
 * only the retained schema identity index owns the reference cascade. */
export function changeBpmnTargetNamespace(
  definitions: BpmnLatestModel["definitions"],
  namespace: string,
) {
  resolveBpmnProcessOwner(definitions);
  indexBpmnIds(definitions).retargetLocalReferences(namespace);
  definitions["@_targetNamespace"] = namespace;
}

/** Definitions have an optional identity, unlike the process. Clearing it is
 * permitted only when no schema reference consumes it; unrelated IDs stay put. */
export function changeBpmnDefinitionsId(
  definitions: BpmnLatestModel["definitions"],
  id: string | undefined,
) {
  resolveBpmnProcessOwner(definitions);
  const index = indexBpmnIds(definitions);
  const previous = definitions["@_id"];
  if (!id) {
    if (previous && index.isReferenced(previous))
      throw new Error("BPMN_DEFINITION_IN_USE");
    delete definitions["@_id"];
  } else {
    if (!isXmlNCName(id) || (id !== previous && index.getOriginalIds().has(id)))
      throw new Error("BPMN_INVALID_ID_RENAME");
    if (previous) index.rename(previous, id);
    else definitions["@_id"] = id;
  }
}
