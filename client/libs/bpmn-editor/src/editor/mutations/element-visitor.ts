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
  type BPMN20__tLaneSet,
  type BPMN20__tProcess,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { type ElementFilter } from "../../xml-parser/element-filter";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
import { type Normalized } from "../normalization/normalize";
import { meta, elements } from "../../schemas/bpmn-2_0/ts-gen/meta";
import type { Meta } from "../../xml-parser";
export type FoundElement<F> = {
  owner: ElementOwner;
  element: F;
  array: ElementVisitorArgs["element"][];
  index: number;
};
type ElementOwner = Normalized<
  | ElementFilter<
      Unpacked<NonNullable<BPMN20__tDefinitions["rootElement"]>>,
      "process"
    >
  | ElementFilter<
      Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
      "subProcess" | "adHocSubProcess" | "transaction"
    >
>;
export type ElementVisitorArgs = {
  element: Normalized<
    Unpacked<
      NonNullable<
        BPMN20__tProcess["flowElement"] | BPMN20__tProcess["artifact"]
      >
    >
  >;
  index: number;
  array: ElementVisitorArgs["element"][];
  owner: ElementOwner;
};
export type LaneVisitorArgs = {
  lane: Normalized<BPMN20__tLane>;
  index: number;
  array: LaneVisitorArgs["lane"][];
  owner: Normalized<BPMN20__tLaneSet>;
  parentLane?: Normalized<BPMN20__tLane>;
  depth: number;
};

/** Lane sets belong to one flow scope, not to the definitions-wide process.
 * Expose that owner when a command spans nested subprocess lane trees. */
export function visitProcessLanes(
  process: ElementOwner,
  visitor: (args: LaneVisitorArgs & { scope: ElementOwner }) => boolean | void,
) {
  const scopes = [process];
  visitFlowElementsAndArtifacts(process, ({ element }) => {
    if (
      element.__$$element === "subProcess" ||
      element.__$$element === "adHocSubProcess" ||
      element.__$$element === "transaction"
    )
      scopes.push(element);
  });
  for (const scope of scopes)
    if (!visitLanes(scope, (args) => visitor({ ...args, scope }))) return false;
  return true;
}

/**
 * Visits flow elements and artifacts in their actual owning arrays, including
 * embedded, event, ad-hoc and transaction subprocesses. Returning false stops
 * the entire traversal, not just the innermost container. Mutations use the
 * supplied owner/array/index; this helper never creates missing owners.
 */
export function visitFlowElementsAndArtifacts(
  process: ElementOwner,
  visitor: (args: ElementVisitorArgs) => boolean | void,
): boolean {
  for (let index = 0; index < (process.flowElement ?? []).length; index++) {
    const element = process.flowElement![index];
    if (
      visitor({
        element,
        index,
        owner: process,
        array: process.flowElement!,
      }) === false
    )
      return false;
    if (
      (element.__$$element === "subProcess" ||
        element.__$$element === "adHocSubProcess" ||
        element.__$$element === "transaction") &&
      visitFlowElementsAndArtifacts(element, visitor) === false
    )
      return false;
  }
  for (let index = 0; index < (process.artifact ?? []).length; index++) {
    if (
      visitor({
        element: process.artifact![index],
        index,
        owner: process,
        array: process.artifact!,
      }) === false
    )
      return false;
  }
  return true;
}

/** Preorder traversal of every nested lane in its immediate lane-set owner.
 * Descendants follow ancestors so display projection can choose deepest valid
 * membership without rewriting permitted ancestor flowNodeRefs. False aborts
 * globally; this read never creates lane sets or changes membership. */
export function visitLanes(
  process: ElementOwner,
  visitor: (args: LaneVisitorArgs) => boolean | void,
): boolean {
  const visitSet = (
    owner: Normalized<BPMN20__tLaneSet>,
    depth: number,
    parentLane?: Normalized<BPMN20__tLane>,
  ): boolean => {
    for (let index = 0; index < (owner.lane ?? []).length; index++) {
      const lane = owner.lane![index];
      if (
        visitor({
          lane,
          index,
          owner,
          array: owner.lane!,
          parentLane,
          depth,
        }) === false
      )
        return false;
      if (
        lane.childLaneSet &&
        visitSet(lane.childLaneSet, depth + 1, lane) === false
      )
        return false;
    }
    return true;
  };
  for (const laneSet of process.laneSet ?? []) {
    if (!visitSet(laneSet, 0)) return false;
  }
  return true;
}

/** Observational source traversal, including non-graphical definitions and
 * properties. Unlike mutation visitors it accepts unnormalized input and never
 * allocates IDs, repairs DI or opens an opaque XML subtree. False skips that
 * subtree, not unrelated siblings. The profile owns all semantic decisions. */
export function visitBpmnSourceObjects(
  definitions: BPMN20__tDefinitions,
  visitor: (context: {
    value: Readonly<Record<string, unknown>>;
    property: string;
    elementId?: string;
    schemaType?: string;
  }) => boolean | void,
) {
  const visit = (
    input: unknown,
    property: string,
    parentId?: string,
    declaredType?: string,
  ) => {
    if (Array.isArray(input)) {
      for (const value of input) visit(value, property, parentId, declaredType);
      return;
    }
    if (!input || typeof input !== "object") return;
    const value = input as Readonly<Record<string, unknown>>;
    const concrete =
      typeof value.__$$element === "string" ? value.__$$element : property;
    const schemaType =
      (elements as Record<string, string>)[concrete] ?? declaredType;
    const properties = (meta as Meta)[schemaType ?? ""];
    const elementId =
      typeof value["@_id"] === "string" ? value["@_id"] : parentId;
    if (
      visitor({ value, property, elementId, schemaType }) === false ||
      typeof value.__$$xml === "string"
    )
      return;
    for (const [name, child] of Object.entries(value))
      if (!name.startsWith("@_") && !name.startsWith("__$$"))
        visit(child, name, elementId, properties?.[name]?.type);
  };
  visit(definitions, "definitions", undefined, "BPMN20__tDefinitions");
}
