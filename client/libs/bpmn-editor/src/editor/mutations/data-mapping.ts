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
  type BPMN20__tProcess,
  type BPMN20__tDataAssociation,
  type BPMN20__tDataInput,
  type BPMN20__tDataOutput,
  type BPMN20__tBaseElement,
} from "../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../normalization/normalize";
import { type ElementFilter } from "../../xml-parser/element-filter";
import { type Unpacked } from "../../xyflow/tsExt/tsExt";
export type Task = Normalized<
  ElementFilter<
    Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
    | "task"
    | "scriptTask"
    | "serviceTask"
    | "businessRuleTask"
    | "userTask"
    | "manualTask"
    | "sendTask"
    | "receiveTask"
    | "callActivity"
    | "subProcess"
    | "adHocSubProcess"
    | "transaction"
  >
>;
export type WithDataMapping = Normalized<
  ElementFilter<
    Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
    | "callActivity"
    | "businessRuleTask"
    | "userTask"
    | "task"
    | "serviceTask"
    | "scriptTask"
    | "manualTask"
    | "sendTask"
    | "receiveTask"
    | "adHocSubProcess"
    | "subProcess"
    | "transaction"
  >
>;
export type WithInputDataMapping = Normalized<
  ElementFilter<
    Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
    "endEvent" | "intermediateThrowEvent"
  >
>;
export type WithOutputDataMapping = Normalized<
  ElementFilter<
    Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
    "startEvent" | "intermediateCatchEvent" | "boundaryEvent"
  >
>;
export type DataMapping = {
  /** Existing XML identity, not the editable name or the row's array position. */
  id?: string;
  /** Private identity for an imported optional-ID slot in this synchronous form
   * snapshot. Never serialize it or use it after the host source changes. */
  originalIndex?: number;
  /** Output assignments require an item-aware target even when the value is an expression. */
  targetRef?: string;
  name: string;
  /** Lexical itemSubjectRef, or a pending declaration selection. Programmatic
   * builtin defaults use a private builtin: token that the XML owner resolves;
   * neither this DTO nor those tokens are persisted as engine dtype metadata. */
  dtype: string;
  /** Private form intent only: a selected declaration ID can have the same
   * spelling as an imported external token. Never serialize this into XML. */
  typeIsSelection?: true;
} & (
  | {
      isExpression: true;
      value: string;
    }
  | {
      isExpression: false;
      variableRef: string | undefined;
    }
);
/** Existing mapping rows borrow the actual item scope; new rows inherit their
 * I/O or event owner. A copied UI row has no XML namespace scope of its own. */
export function dataMappingTypeOwner(
  element: WithDataMapping | WithInputDataMapping | WithOutputDataMapping,
  row: Pick<DataMapping, "id" | "originalIndex">,
  direction: "input" | "output",
): BPMN20__tBaseElement & { "@_itemSubjectRef"?: string } {
  if (
    element.__$$element === "endEvent" ||
    element.__$$element === "intermediateThrowEvent"
  )
    return mappingItem(element.dataInput ?? [], row) ?? element;
  if (
    element.__$$element === "startEvent" ||
    element.__$$element === "intermediateCatchEvent" ||
    element.__$$element === "boundaryEvent"
  )
    return mappingItem(element.dataOutput ?? [], row) ?? element;
  const items =
    direction === "input"
      ? element.ioSpecification?.dataInput
      : element.ioSpecification?.dataOutput;
  return mappingItem(items ?? [], row) ?? element.ioSpecification ?? element;
}

function mappingItem<T extends { "@_id"?: string }>(
  items: T[],
  row: Pick<DataMapping, "id" | "originalIndex">,
): T | undefined {
  if (row.id) return items.find((item) => item["@_id"] === row.id);
  const index = row.originalIndex;
  return index !== undefined &&
    Number.isInteger(index) &&
    index >= 0 &&
    !items[index]?.["@_id"]
    ? items[index]
    : undefined;
}
function sameMappingRow(a: DataMapping, b: DataMapping) {
  return a.id
    ? a.id === b.id
    : a.originalIndex !== undefined &&
        !b.id &&
        a.originalIndex === b.originalIndex;
}
export function getDataMapping(
  element: WithDataMapping | WithInputDataMapping | WithOutputDataMapping,
) {
  let inputDataMapping: DataMapping[] = [];
  let outputDataMapping: DataMapping[] = [];
  if (
    element.__$$element !== "startEvent" &&
    element.__$$element !== "intermediateCatchEvent" &&
    element.__$$element !== "boundaryEvent"
  ) {
    const dataInputs =
      element.__$$element === "endEvent" ||
      element.__$$element === "intermediateThrowEvent"
        ? element.dataInput
        : element.ioSpecification?.dataInput;
    inputDataMapping =
      dataInputs?.flatMap((dataInput, originalIndex) => {
        const identity = dataInput["@_id"]
          ? { id: dataInput["@_id"] }
          : { originalIndex };
        const association = element.dataInputAssociation?.find(
          (association) =>
            association.targetRef?.__$$text === dataInput["@_id"],
        );
        return association?.assignment
          ? {
              ...identity,
              name: dataInput?.["@_name"] || "",
              dtype: dataInput?.["@_itemSubjectRef"] ?? "",
              isExpression: true,
              value: association.assignment?.[0]?.from.__$$text || "",
            }
          : {
              ...identity,
              name: dataInput?.["@_name"] || "",
              dtype: dataInput?.["@_itemSubjectRef"] ?? "",
              isExpression: false,
              variableRef: association?.sourceRef?.[0]?.__$$text,
            };
      }) ?? [];
  }
  if (
    element.__$$element !== "endEvent" &&
    element.__$$element !== "intermediateThrowEvent"
  ) {
    const dataOutputs =
      element.__$$element === "startEvent" ||
      element.__$$element === "intermediateCatchEvent" ||
      element.__$$element === "boundaryEvent"
        ? element.dataOutput
        : element.ioSpecification?.dataOutput;
    outputDataMapping =
      dataOutputs?.flatMap((dataOutput, originalIndex) => {
        const identity = dataOutput["@_id"]
          ? { id: dataOutput["@_id"] }
          : { originalIndex };
        const association = element.dataOutputAssociation?.find(
          (association) =>
            association.sourceRef?.[0]?.__$$text === dataOutput["@_id"],
        );
        return association?.assignment
          ? {
              ...identity,
              targetRef: association.targetRef.__$$text,
              name: dataOutput?.["@_name"] || "",
              dtype: dataOutput?.["@_itemSubjectRef"] ?? "",
              isExpression: true,
              value: association?.assignment?.[0]?.to.__$$text || "",
            }
          : {
              ...identity,
              name: dataOutput?.["@_name"] || "",
              dtype: dataOutput?.["@_itemSubjectRef"] ?? "",
              isExpression: false,
              variableRef: association?.targetRef.__$$text,
            };
      }) ?? [];
  }
  return {
    inputDataMapping,
    outputDataMapping,
  };
}
import { generateUuid } from "../../xyflow/uuid/uuid";
import { addOrGetProcessAndDiagramElements } from "./addOrGetProcessAndDiagramElements";
import { visitFlowElementsAndArtifacts } from "./element-visitor";
import {
  DEFAULT_DATA_TYPES,
  addOrGetItemDefinitions,
} from "./addOrGetItemDefinitions";
import { indexBpmnIds } from "../idRandomizer/bpmn-id-randomizer";
export function setInputDataMapping(
  inputDataMapping: DataMapping[],
  elementWithData:
    WithInputDataMapping | NonNullable<WithDataMapping["ioSpecification"]>,
  elementWithAssociation: WithInputDataMapping | WithDataMapping,
) {
  const result = updateMappings(
    "input",
    inputDataMapping,
    elementWithData.dataInput ?? [],
    elementWithAssociation.dataInputAssociation ?? [],
  );
  if (result.changed) {
    if (result.data.length) elementWithData.dataInput = result.data;
    else delete elementWithData.dataInput;
    if (result.associations.length)
      elementWithAssociation.dataInputAssociation = result.associations;
    else delete elementWithAssociation.dataInputAssociation;
  }
}
export function setOutputDataMapping(
  outputDataMapping: DataMapping[],
  elementWithData:
    WithOutputDataMapping | NonNullable<WithDataMapping["ioSpecification"]>,
  elementWithAssociation: WithOutputDataMapping | WithDataMapping,
) {
  const result = updateMappings(
    "output",
    outputDataMapping,
    elementWithData.dataOutput ?? [],
    elementWithAssociation.dataOutputAssociation ?? [],
  );
  if (result.changed) {
    if (result.data.length) elementWithData.dataOutput = result.data;
    else delete elementWithData.dataOutput;
    if (result.associations.length)
      elementWithAssociation.dataOutputAssociation = result.associations;
    else delete elementWithAssociation.dataOutputAssociation;
  }
}

/** Reconcile only edited rows; unchanged associations may contain richer standard
 * XML. Type selection has already been resolved by setDataMappingForElement:
 * do not reinterpret a finished lexical QName using labels or another map. */
function updateMappings<
  T extends Normalized<BPMN20__tDataInput | BPMN20__tDataOutput>,
>(
  direction: "input" | "output",
  rows: DataMapping[],
  previous: T[],
  associations: Normalized<BPMN20__tDataAssociation>[],
) {
  const owns = (
    association: Normalized<BPMN20__tDataAssociation>,
    id: string,
  ) =>
    !!id &&
    (direction === "input"
      ? association.targetRef.__$$text === id
      : association.sourceRef?.some((reference) => reference.__$$text === id));
  const existingRows = rows.map((row) => mappingItem(previous, row));
  const kept = new Set(existingRows.filter((item) => item !== undefined));
  if (
    kept.size !== existingRows.filter((item) => item !== undefined).length ||
    rows.some(
      (row, i) =>
        (row.id || row.originalIndex !== undefined) && !existingRows[i],
    )
  )
    throw new Error("BPMN_STALE_DATA_MAPPING");
  const removed = new Set(
    previous.filter((data) => !kept.has(data)).map((data) => data["@_id"]),
  );
  const nextAssociations = associations.filter(
    (association) => ![...removed].some((id) => owns(association, id)),
  );
  let changed = removed.size > 0;
  const data = rows.map((row, index) => {
    const existing = existingRows[index];
    if (row.id && !existing) throw new Error("BPMN_STALE_DATA_MAPPING");
    const item = existing ?? ({ "@_id": generateUuid() } as T);
    const type = row.dtype || undefined;
    if (
      !existing ||
      (item["@_name"] ?? "") !== row.name ||
      item["@_itemSubjectRef"] !== type
    ) {
      item["@_name"] = row.name;
      item["@_itemSubjectRef"] = type;
      changed = true;
    }
    const matching = associations.filter((association) =>
      owns(association, item["@_id"]),
    );
    const association = matching[0];
    const expression =
      association?.assignment?.[0]?.[direction === "input" ? "from" : "to"]
        .__$$text ?? "";
    const variable =
      direction === "input"
        ? association?.sourceRef?.[0]?.__$$text
        : association?.targetRef.__$$text;
    const sameBinding = row.isExpression
      ? Boolean(association?.assignment) &&
        expression === row.value &&
        (direction === "input" ||
          association?.targetRef.__$$text === row.targetRef)
      : !association?.assignment &&
        (variable ?? "") === (row.variableRef ?? "");
    if (sameBinding) return item;
    if (direction === "output" && row.isExpression && !row.targetRef)
      throw new Error("BPMN_OUTPUT_TARGET_REQUIRED");
    // The simple row editor cannot replace transformations, fan-in or several
    // assignments without losing information. Field-only edits still preserve them.
    if (
      matching.length > 1 ||
      association?.transformation ||
      (association?.assignment?.length ?? 0) > 1 ||
      (association?.sourceRef?.length ?? 0) > 1
    ) {
      throw new Error("BPMN_COMPLEX_DATA_MAPPING");
    }
    // A field-only edit of imported optional-ID I/O leaves its absent identity
    // absent. Explicit binding is the first operation that needs an IDREF.
    item["@_id"] ??= generateUuid();
    const next: Normalized<BPMN20__tDataAssociation> = association ?? {
      "@_id": generateUuid(),
      targetRef: { __$$text: "" },
    };
    if (!association) nextAssociations.push(next);
    if (row.isExpression) {
      const assignment = next.assignment?.[0] ?? {
        "@_id": generateUuid(),
        from: { "@_id": generateUuid(), __$$text: "" },
        to: { "@_id": generateUuid(), __$$text: "" },
      };
      assignment.from.__$$text =
        direction === "input" ? row.value : item["@_id"];
      assignment.to.__$$text = direction === "input" ? item["@_id"] : row.value;
      next.assignment = [assignment];
      next.sourceRef =
        direction === "input" ? [] : [{ __$$text: item["@_id"] }];
      next.targetRef.__$$text =
        direction === "input" ? item["@_id"] : row.targetRef!;
    } else {
      delete next.assignment;
      next.sourceRef =
        direction === "input"
          ? row.variableRef
            ? [{ __$$text: row.variableRef }]
            : []
          : [{ __$$text: item["@_id"] }];
      next.targetRef.__$$text =
        direction === "input" ? item["@_id"] : (row.variableRef ?? "");
    }
    changed = true;
    return item;
  });
  return { data, associations: nextAssociations, changed };
}
export function setInputAndOutputDataMapping(
  inputDataMapping: DataMapping[],
  outputDataMapping: DataMapping[],
  e: WithDataMapping,
) {
  if (
    !e.ioSpecification &&
    !inputDataMapping.length &&
    !outputDataMapping.length
  )
    return;
  // Required set arrays exist from creation; optional items/member references
  // appear only when populated. Empty arrays otherwise make the first writer
  // emit expanded empty tags that the next parse/write closes differently.
  e.ioSpecification ??= {
    "@_id": generateUuid(),
    inputSet: [],
    outputSet: [],
  };

  // input
  setInputDataMapping(inputDataMapping, e.ioSpecification, e);
  e.ioSpecification.inputSet[0] ??= {
    "@_id": generateUuid(),
  };
  const inputs = new Set(
    e.ioSpecification.dataInput?.map((data) => data["@_id"]),
  );
  for (const set of e.ioSpecification.inputSet) {
    for (const key of [
      "dataInputRefs",
      "optionalInputRefs",
      "whileExecutingInputRefs",
    ] as const) {
      if (set[key]?.some((reference) => !inputs.has(reference.__$$text))) {
        set[key] = set[key].filter((reference) =>
          inputs.has(reference.__$$text),
        );
        if (!set[key]?.length) delete set[key];
      }
    }
  }
  for (const id of inputs)
    if (
      !e.ioSpecification.inputSet.some((set) =>
        set.dataInputRefs?.some((reference) => reference.__$$text === id),
      )
    ) {
      (e.ioSpecification.inputSet[0].dataInputRefs ??= []).push({
        __$$text: id,
      });
    }

  // output
  setOutputDataMapping(outputDataMapping, e.ioSpecification, e);
  e.ioSpecification!.outputSet[0] ??= {
    "@_id": generateUuid(),
  };
  const outputs = new Set(
    e.ioSpecification.dataOutput?.map((data) => data["@_id"]),
  );
  for (const set of e.ioSpecification.outputSet) {
    for (const key of [
      "dataOutputRefs",
      "optionalOutputRefs",
      "whileExecutingOutputRefs",
    ] as const) {
      if (set[key]?.some((reference) => !outputs.has(reference.__$$text))) {
        set[key] = set[key].filter((reference) =>
          outputs.has(reference.__$$text),
        );
        if (!set[key]?.length) delete set[key];
      }
    }
  }
  for (const id of outputs)
    if (
      !e.ioSpecification.outputSet.some((set) =>
        set.dataOutputRefs?.some((reference) => reference.__$$text === id),
      )
    ) {
      (e.ioSpecification.outputSet[0].dataOutputRefs ??= []).push({
        __$$text: id,
      });
    }
}
export function setDataMappingForElement({
  definitions,
  elementId,
  element,
  inputDataMapping,
  outputDataMapping,
}: {
  definitions: Normalized<BPMN20__tDefinitions>;
  elementId: string;
  element: string;
  inputDataMapping: DataMapping[];
  outputDataMapping: DataMapping[];
}) {
  const { process, diagramElements } = addOrGetProcessAndDiagramElements({
    definitions,
  });
  const graphicalIndex = indexBpmnIds(definitions),
    graphicalAssociations = new Set(
      diagramElements
        .filter((edge) => edge.__$$element === "bpmndi:BPMNEdge")
        .map((edge) =>
          graphicalIndex.resolveReference(edge, edge["@_bpmnElement"]),
        ),
    );
  const graphicalPorts = new Set<string>();
  visitFlowElementsAndArtifacts(process, ({ element: owner }) => {
    for (const association of [
      ...("dataInputAssociation" in owner
        ? (owner.dataInputAssociation ?? [])
        : []),
      ...("dataOutputAssociation" in owner
        ? (owner.dataOutputAssociation ?? [])
        : []),
    ]) {
      if (!graphicalAssociations.has(association["@_id"])) continue;
      for (const ref of [
        ...(association.sourceRef ?? []),
        association.targetRef,
      ])
        graphicalPorts.add(ref.__$$text);
    }
  });
  // This row projection cannot move/delete visible routes. Keep graph-owned
  // bindings in the edge command owner; otherwise a row deletion leaves dangling
  // DI and a binding edit points an unchanged route at the wrong item/shape.
  visitFlowElementsAndArtifacts(process, ({ element: owner }) => {
    if (owner["@_id"] !== elementId || owner.__$$element !== element) return;
    const host = owner as
        WithDataMapping | WithInputDataMapping | WithOutputDataMapping,
      previous = getDataMapping(host);
    for (const direction of ["input", "output"] as const) {
      const oldRows =
          direction === "input"
            ? previous.inputDataMapping
            : previous.outputDataMapping,
        newRows = direction === "input" ? inputDataMapping : outputDataMapping;
      const associations =
        direction === "input"
          ? "dataInputAssociation" in host
            ? host.dataInputAssociation
            : []
          : "dataOutputAssociation" in host
            ? host.dataOutputAssociation
            : [];
      for (const row of oldRows) {
        const next = newRows.find((next) => sameMappingRow(row, next));
        if (!next) {
          // A receiver-owned bridge can consume this host's output. Its route
          // is not in this host's association array, but owns its slot lifetime.
          if (row.id && graphicalPorts.has(row.id))
            throw new Error("BPMN_GRAPHICAL_DATA_MAPPING");
          // EventDefinition payload correspondence is positional, not an IDREF.
          // Removing even an unreferenced slot can silently shift that contract.
          if (
            ("eventDefinition" in host && host.eventDefinition?.length) ||
            ("eventDefinitionRef" in host && host.eventDefinitionRef?.length)
          )
            throw new Error("BPMN_DEFINITION_IN_USE");
        }
        if (
          !row.id ||
          !associations?.some(
            (association) =>
              graphicalAssociations.has(association["@_id"]) &&
              (direction === "input"
                ? association.targetRef.__$$text === row.id
                : association.sourceRef?.some(
                    (ref) => ref.__$$text === row.id,
                  )),
          )
        )
          continue;
        if (!next) throw new Error("BPMN_GRAPHICAL_DATA_MAPPING");
        if (
          next.isExpression !== row.isExpression ||
          (next.isExpression &&
            row.isExpression &&
            next.targetRef !== row.targetRef) ||
          (!next.isExpression &&
            !row.isExpression &&
            next.variableRef !== row.variableRef)
        )
          throw new Error("BPMN_GRAPHICAL_DATA_MAPPING");
      }
    }
    return false;
  });
  const itemDefinitions =
    definitions.rootElement?.filter(
      (root) => root.__$$element === "itemDefinition",
    ) ?? [];
  const selectedTypes = new Map<string, string>();
  let index = indexBpmnIds(definitions);
  // Stable selected IDs and explicit builtin commands are resolved here, never
  // guessed from a display label or an imported structureRef at a lower layer.
  for (const definition of itemDefinitions)
    selectedTypes.set(definition["@_id"], definition["@_id"]);
  const scopedTypes = (
    rows: DataMapping[],
    element: WithDataMapping | WithInputDataMapping | WithOutputDataMapping,
    direction: "input" | "output",
  ) =>
    rows.map((row) => {
      const owner = dataMappingTypeOwner(element, row, direction);
      const previous =
        "@_itemSubjectRef" in owner ? owner["@_itemSubjectRef"] : undefined;
      if (!row.typeIsSelection && row.dtype === previous) return row;
      let id = selectedTypes.get(row.dtype);
      const builtin = row.dtype.startsWith("builtin:")
        ? row.dtype.slice(8)
        : undefined;
      if (
        !id &&
        builtin &&
        Object.values(DEFAULT_DATA_TYPES).includes(builtin)
      ) {
        id = addOrGetItemDefinitions({ definitions, dataType: builtin })
          .itemDefinition["@_id"];
        selectedTypes.set(row.dtype, id);
        index = indexBpmnIds(definitions);
      }
      if (!id) {
        if (row.typeIsSelection && row.dtype)
          throw new Error("BPMN_DANGLING_REFERENCE");
        return row; // An unchanged imported lexical QName is not a UI ID.
      }
      const dtype = index.referenceFor(owner, id, previous)!;
      return dtype === row.dtype ? row : { ...row, dtype };
    });
  visitFlowElementsAndArtifacts(process, ({ element: e }) => {
    if (e["@_id"] === elementId && e.__$$element === element) {
      // Transactions inherit the same activity I/O owner. Keep their concrete
      // kind so this lookup and the writer never silently treat them as absent.
      if (
        e.__$$element === "callActivity" ||
        e.__$$element === "manualTask" ||
        e.__$$element === "sendTask" ||
        e.__$$element === "receiveTask" ||
        e.__$$element === "businessRuleTask" ||
        e.__$$element === "userTask" ||
        e.__$$element === "task" ||
        e.__$$element === "serviceTask" ||
        e.__$$element === "scriptTask" ||
        e.__$$element === "subProcess" ||
        e.__$$element === "adHocSubProcess" ||
        e.__$$element === "transaction"
      ) {
        setInputAndOutputDataMapping(
          scopedTypes(inputDataMapping, e, "input"),
          scopedTypes(outputDataMapping, e, "output"),
          e,
        );
      } else if (
        e.__$$element === "endEvent" ||
        e.__$$element === "intermediateThrowEvent"
      ) {
        setInputDataMapping(scopedTypes(inputDataMapping, e, "input"), e, e);
      } else if (
        e.__$$element === "startEvent" ||
        e.__$$element === "intermediateCatchEvent" ||
        e.__$$element === "boundaryEvent"
      ) {
        setOutputDataMapping(scopedTypes(outputDataMapping, e, "output"), e, e);
      }
      return false; // Will stop visiting.
    }
    return true;
  });
  // Reconciliation may clear the edited owner's private mappings/memberships,
  // never consumers elsewhere (including non-graphical mappings or loop data).
  // Check removed nested IDs too; the caller's model transaction rolls back all
  // writes on rejection instead of publishing a dangling intermediate model.
  const after = indexBpmnIds(definitions),
    retained = after.getOriginalIds();
  for (const id of graphicalIndex.getOriginalIds())
    if (!retained.has(id) && after.isReferenced(id))
      throw new Error("BPMN_DEFINITION_IN_USE");
}
function updateDataMappingArray(
  dataMappingArray: DataMapping[],
  index: number,
  dataMappingUpdate: DataMappingUpdate,
) {
  if (dataMappingUpdate.nonEmpty) {
    if (index > -1) {
      dataMappingArray[index] = {
        ...dataMappingUpdate.dataMapping,
        id: dataMappingArray[index].id,
        originalIndex: dataMappingArray[index].originalIndex,
      };
    } else {
      dataMappingArray.push(dataMappingUpdate.dataMapping);
    }
  } else if (index > -1) {
    dataMappingArray.splice(index, 1);
  }
}
export function updateDataMappingWithValue(
  dataMappingArray: DataMapping[],
  value: string | undefined,
  name: string,
) {
  const index = dataMappingArray.findIndex((d) => d.name === name);
  const dataMappingUpdate = valueToDataMapping(value, name);
  updateDataMappingArray(dataMappingArray, index, dataMappingUpdate);
}
type DataMappingUpdate =
  | {
      nonEmpty: false;
      dataMapping: undefined;
    }
  | {
      nonEmpty: true;
      dataMapping: DataMapping;
    };
export function valueToDataMapping(
  value: string | undefined,
  type: string,
): DataMappingUpdate {
  return value === undefined
    ? {
        nonEmpty: false,
        dataMapping: undefined,
      }
    : {
        nonEmpty: true,
        dataMapping: {
          dtype: `builtin:${DEFAULT_DATA_TYPES.STRING}`,
          name: type,
          isExpression: true,
          value,
        },
      };
}
