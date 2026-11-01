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

import { type DC__Point } from "../../xyflow/maths/model";
import { type Normalized } from "../normalization/normalize";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { type BPMN20__tDefinitions } from "../../schemas/bpmn-2_0/ts-gen/types";
export function repositionEdgeWaypoint({
  definitions,
  __readonly_edgeIndex,
  __readonly_waypointIndex,
  __readonly_waypoint,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  __readonly_edgeIndex: number;
  __readonly_waypointIndex: number;
  __readonly_waypoint: DC__Point;
}) {
  const { diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const diagramElement = diagramElements[__readonly_edgeIndex];
  if (diagramElement.__$$element !== "bpmndi:BPMNEdge") {
    throw new Error(
      "BPMN MUTATION: Can't reposition a waypoint on a non-BPMN edge.",
    );
  }
  if (
    __readonly_waypointIndex >
    (diagramElement["di:waypoint"]?.length ?? 0) - 1
  ) {
    throw new Error(
      `BPMN MUTATION: Can't reposition missing waypoint '${__readonly_waypointIndex}' on BPMN edge '${diagramElement["@_id"]}'.`,
    );
  }
  diagramElement["di:waypoint"]![__readonly_waypointIndex] =
    __readonly_waypoint;
}
