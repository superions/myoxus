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
import { addOrGetMessages } from "./addOrGetMessages";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { resolveBpmnProcessOwner } from "../../process-source";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
/** Requires the single process/plane and one explicit interface; operation
 * creation never repairs an owner or moves shared declarations. */
export function addOrGetOperations({
  definitions,
  interfaceId,
  operationName,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  interfaceId: string;
  operationName: string;
}): {
  interface: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "interface"
  >;
  operation: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "interface"
  >["operation"][number];
} {
  resolveBpmnProcessOwner(definitions);
  const interfaces =
    definitions.rootElement
      ?.filter((root) => root.__$$element === "interface")
      .filter((root) => root["@_id"] === interfaceId) ?? [];
  if (interfaces.length !== 1) throw new Error("BPMN_INTERFACE_OWNER_REQUIRED");
  const serviceTaskInterface = interfaces[0];
  serviceTaskInterface.operation ??= [];
  const existing = serviceTaskInterface.operation.filter(
    (operation) => operation["@_name"] === operationName,
  );
  if (existing.length > 1) throw new Error("BPMN_AMBIGUOUS_OPERATION_NAME");
  let operation = existing[0];
  if (!operation) {
    const { messageRef: inMessageId } = addOrGetMessages({
      definitions,
      messageName: "",
    });
    operation = {
      "@_id": generateUuid(),
      "@_name": operationName,
      inMessageRef: {
        __$$text: inMessageId,
      },
    };
    serviceTaskInterface.operation.push(operation);
    // inMessageRef is required; outMessageRef is optional and is not invented.
    // Resolve after insertion so a shadowed interface scope is available on the
    // actual text field, not guessed from definitions' namespace declarations.
    operation.inMessageRef.__$$text = indexBpmnIds(definitions).referenceFor(
      operation.inMessageRef,
      inMessageId,
    )!;
  } else if (operation["@_name"] !== operationName) {
    operation["@_name"] = operationName;
  }
  return {
    interface: serviceTaskInterface,
    operation: operation,
  };
}
