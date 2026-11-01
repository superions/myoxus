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
import { type State } from "../store/Store";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import type { ElementVisitorArgs } from "./element-visitor";

/** Explicit creation owner for the single lane set of a flow scope. Imported
 * sibling lane sets are not merged or selected by array position. Read and
 * membership commands use visitLanes and must not materialize this owner. */
export function addOrGetLanes({
  definitions,
  scope,
}: {
  definitions: State["bpmn"]["model"]["definitions"];
  scope?: ElementVisitorArgs["owner"];
}) {
  const process =
    scope ??
    addOrGetProcessAndDiagramElements({
      definitions,
    }).process;
  if ((process.laneSet?.length ?? 0) > 1)
    throw new Error("BPMN_UNSUPPORTED_ELEMENT");
  if (!process.laneSet?.length) process.laneSet = [{ "@_id": generateUuid() }];
  process.laneSet[0].lane ??= [];
  return {
    lanes: process.laneSet[0].lane,
  };
}
