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
/** Requires the existing single process/plane; creates only an interface, not its owner. */
export function addOrGetInterfaces({
  definitions,
  interfaceName,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  interfaceName: string;
}): {
  interface: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "interface"
  >;
} {
  resolveBpmnProcessOwner(definitions);
  const roots = definitions.rootElement!;
  const interfaces = roots.filter((s) => s.__$$element === "interface");
  const matching = interfaceName
    ? interfaces.filter((owner) => owner["@_name"] === interfaceName)
    : [];
  if (matching.length > 1) throw new Error("BPMN_AMBIGUOUS_DEFINITION_NAME");
  const existingInterface = matching[0];
  if (existingInterface) {
    return {
      interface: existingInterface,
    };
  }
  const newInterface: ElementFilter<
    Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
    "interface"
  > = {
    __$$element: "interface",
    "@_id": generateUuid(),
    "@_name": interfaceName,
    operation: [],
  };
  roots.push(newInterface);
  return {
    interface: newInterface,
  };
}
