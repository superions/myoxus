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

import { type BPMN20__tProcess } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type ElementFilter } from "../../../xml-parser/element-filter";
import { type Unpacked } from "../../../xyflow/tsExt/tsExt";
import { SearchCombobox } from "@myoxus/ui-facade";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useDefinitionChoice } from "../../typeaheadSelect/use-definition-choice";
import { useCallback, useMemo } from "react";
import { addOrGetErrors } from "../../mutations/addOrGetErrors";
import { useBpmnEditorI18n } from "../../i18n";
export type EventWithError =
  | undefined
  | Normalized<
      ElementFilter<
        Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>,
        | "startEvent"
        | "intermediateCatchEvent"
        | "intermediateThrowEvent"
        | "endEvent"
        | "boundaryEvent"
      >
    >;
export type OnErrorChange = (
  newErrorRef: string | undefined,
  newError: string | undefined,
) => void;
export function ErrorSelector({
  value,
  onChange,
  referenceOwner,
  omitValues,
}: {
  value: string | undefined;
  onChange: OnErrorChange;
  referenceOwner?: object;
  omitValues?: string[];
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const errorsById = useBpmnEditorStore(
    (s) =>
      new Map(
        s.bpmn.model.definitions.rootElement
          ?.filter((e) => e.__$$element === "error")
          .map((m) => [m["@_id"], m] as const),
      ),
  );
  const omitIdsSet = useMemo(
    () => new Set<string | undefined>(omitValues),
    [omitValues],
  );
  const options = useMemo(
    () =>
      [...errorsById.values()]
        .filter((m) => !omitIdsSet.has(m["@_id"]))
        .map((m) => ({
          value: m["@_id"],
          label: m["@_name"] ?? m["@_id"],
        })),
    [errorsById, omitIdsSet],
  );
  const onCreate = useCallback(
    (newErrorName: string) => {
      let newErrorId: string;
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        newErrorId = addOrGetErrors({
          definitions: s.bpmn.model.definitions,
          errorName: newErrorName,
        }).errorRef;
      });
      return newErrorId!;
    },
    [bpmnEditorStoreApi],
  );
  const choice = useDefinitionChoice({
    choices: options,
    selected: value,
    referenceOwner,
    disabled: isReadOnly,
    label: i18n.eventDefinitionProperties.errorCode,
    emptyLabel: i18n.propertiesPanel.noMatches,
    onSelect: onChange,
    create: onCreate,
    createLabel: i18n.propertiesPanel.createError,
  });
  return <SearchCombobox {...choice} />;
}
