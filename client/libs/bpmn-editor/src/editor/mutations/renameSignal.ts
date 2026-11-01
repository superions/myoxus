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
/** Rename within the existing single process/plane, never an index-selected owner. */
export function renameSignal({
  definitions,
  id,
  newSignalName,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  id: string;
  newSignalName: string;
}):
  | {
      signal: ElementFilter<
        Unpacked<Normalized<BPMN20__tDefinitions["rootElement"]>>,
        "signal"
      >;
    }
  | undefined {
  resolveBpmnProcessOwner(definitions);
  const signal = definitions.rootElement!.find(
    (root) => root.__$$element === "signal" && root["@_id"] === id,
  );
  if (!signal || signal.__$$element !== "signal")
    throw new Error("BPMN_DEFINITION_NOT_FOUND");
  // A display-name edit never changes the payload type or stable identity.
  signal["@_name"] = newSignalName;
  return {
    signal,
  };
}
