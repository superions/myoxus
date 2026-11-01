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

import {
  type BPMN20__tDefinitions,
  type BPMN20__tLane,
  type BPMN20__tProcess,
  type BPMN20__tTextAnnotation,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import { type Normalized } from "../normalization/normalize";
import {
  visitFlowElementsAndArtifacts,
  visitProcessLanes,
} from "./element-visitor";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { keepIntersection } from "../diagram/nodes/morphing/keepIntersection";
import type { Task } from "./data-mapping";
type NewFlowElement = Partial<
  Normalized<
    Unpacked<
      NonNullable<
        BPMN20__tProcess["flowElement"] | BPMN20__tProcess["artifact"]
      >
    >
  >
>;
/** Task morphs preserve the entire compatible schema projection, including
 * opaque extensions, inherited scopes, I/O, resource roles and loops. Only
 * fields absent from the target schema are removed. In particular all five
 * implementation-bearing tasks share tImplementation: an explicit value is
 * portable, while an absent value must remain absent despite different defaults.
 * No mapping reconciliation or definition deletion belongs to a type change. */
export function morphTask({
  definitions,
  id,
  from,
  to,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  id: string;
  from: Task["__$$element"];
  to: Task["__$$element"];
}) {
  const { process } = addOrGetProcessAndDiagramElements({ definitions });
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (element["@_id"] !== id || element.__$$element !== from) return true;
    keepIntersection({
      fromElement: from,
      toElement: to,
      srcObj: element,
      targetObj: element,
    });
    element.__$$element = to;
    return false;
  });
}
export function updateFlowElement({
  definitions,
  newFlowElement,
  id,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  newFlowElement: NewFlowElement;
  id: string;
}) {
  const { process } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  visitFlowElementsAndArtifacts(process, ({ array, index, owner, element }) => {
    if (element["@_id"] === id) {
      if (array !== owner.flowElement) {
        throw new Error(
          `BPMN MUTATION: Element with id ${id} is not a flowElement, but rather a ${element.__$$element}`,
        );
      }
      const keysToDelete = (
        Object.keys(newFlowElement) as (keyof NewFlowElement)[]
      ).filter(
        (key) =>
          newFlowElement[key] === undefined || newFlowElement[key] === "",
      );
      array[index] = {
        ...element,
        ...newFlowElement,
      } as typeof element;
      for (const key of keysToDelete) {
        delete array[index][key as keyof NewFlowElement];
      }
      return false; // Will stop visiting.
    }
    return true;
  });
}
export function updateLane({
  definitions,
  newLane,
  id,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  newLane: Partial<Normalized<BPMN20__tLane>>;
  id: string;
}) {
  const { process } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  visitProcessLanes(process, ({ lane, array, index }) => {
    if (lane["@_id"] !== id) return true;
    array[index] = {
      ...lane,
      ...newLane,
    };
    return false;
  });
}
export function updateTextAnnotation({
  definitions,
  newTextAnnotation,
  id,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  newTextAnnotation: Partial<Normalized<BPMN20__tTextAnnotation>>;
  id: string;
}) {
  const { process } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  visitFlowElementsAndArtifacts(process, ({ element, array, index }) => {
    if (element["@_id"] === id) {
      if (element.__$$element !== "textAnnotation") {
        throw new Error(
          `BPMN MUTATION: Element with id ${id} is not a textAnnotation, but rather a ${element.__$$element}`,
        );
      }
      array[index] = {
        ...array[index],
        ...newTextAnnotation,
      };
      return false; // Will stop visiting.
    }
    return true;
  });
}
