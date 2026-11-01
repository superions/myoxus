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

import { SearchCombobox } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";
import {
  addOrGetItemDefinitions,
  DEFAULT_DATA_TYPES,
  defaultDataType,
} from "../../mutations/addOrGetItemDefinitions";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useDefinitionChoice } from "../../typeaheadSelect/use-definition-choice";
import { useBpmnEditorI18n } from "../../i18n";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
const DEFAULT_OPTIONS = [
  {
    itemDefinitionRef: "builtin:String",
    dataType: DEFAULT_DATA_TYPES.STRING,
  },
  {
    itemDefinitionRef: "builtin:Boolean",
    dataType: DEFAULT_DATA_TYPES.BOOLEAN,
  },
  {
    itemDefinitionRef: "builtin:Float",
    dataType: DEFAULT_DATA_TYPES.FLOAT,
  },
  {
    itemDefinitionRef: "builtin:Integer",
    dataType: DEFAULT_DATA_TYPES.INTEGER,
  },
  {
    itemDefinitionRef: "builtin:Object",
    dataType: DEFAULT_DATA_TYPES.OBJECT,
  },
];
export type OnChangeItemDefinitionRefSelector = (
  newItemDefinitionRef: string | undefined,
  dataType: string | undefined,
) => void;
export function ItemDefinitionRefSelector({
  value,
  onChange,
  referenceOwner,
  showLabel = true,
}: {
  value: string | undefined;
  onChange: OnChangeItemDefinitionRefSelector;
  referenceOwner?: object;
  /** Table headers can supply the visible label; the field keeps its accessible name. */
  showLabel?: boolean;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const itemDefinitions = useBpmnEditorStore((s) => {
    const index = indexBpmnIds(s.bpmn.model.definitions);
    return (
      s.bpmn.model.definitions.rootElement
        ?.filter((s) => s.__$$element === "itemDefinition")
        .filter((s) => !!s["@_id"])
        .map((s) => ({
          itemDefinitionRef: s["@_id"],
          builtin: defaultDataType(index, s),
          dataType: defaultDataType(index, s) ?? s["@_structureRef"],
        })) ?? []
    );
  });
  const allOptions = useMemo(() => {
    // Distinct declarations can deliberately share a structureRef; labels never
    // decide XML identity. Defaults are creation conveniences, not declarations.
    return [
      ...itemDefinitions,
      ...DEFAULT_OPTIONS.filter(
        (option) =>
          !itemDefinitions.some((item) => item.builtin === option.dataType),
      ),
    ];
  }, [itemDefinitions]);
  const allOptionsById = useMemo(
    () => new Map(allOptions.map((i) => [i.itemDefinitionRef, i])),
    [allOptions],
  );
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const addOrGetItemDefinitionId = useCallback(
    ({ newDataType }: { newDataType: string }) => {
      let ref: string;
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        const { itemDefinition } = addOrGetItemDefinitions({
          definitions: s.bpmn.model.definitions,
          dataType: newDataType,
        });
        ref = itemDefinition["@_id"];
      });
      return ref!;
    },
    [bpmnEditorStoreApi],
  );
  const _onChange = useCallback(
    (
      newItemDefinitionRef: string | undefined,
      newItemDefinitionLabel: string | undefined,
      reason: "existing" | "created" | "cleared",
    ) => {
      const builtin = DEFAULT_OPTIONS.find(
        (option) => option.itemDefinitionRef === newItemDefinitionRef,
      );
      if (builtin) {
        const r = addOrGetItemDefinitionId({
          newDataType: builtin.dataType,
        });
        onChange(r, builtin.dataType);
      } else if (
        reason === "created" &&
        newItemDefinitionRef &&
        newItemDefinitionLabel
      ) {
        onChange(newItemDefinitionRef, newItemDefinitionLabel);
      } else {
        onChange(
          newItemDefinitionRef,
          allOptionsById.get(newItemDefinitionRef!)?.dataType,
        );
      }
    },
    [addOrGetItemDefinitionId, allOptionsById, onChange],
  );
  const options = useMemo(() => {
    return allOptions.map((d) => ({
      value: d.itemDefinitionRef,
      label: allOptions.some(
        (other) =>
          other.itemDefinitionRef !== d.itemDefinitionRef &&
          other.dataType === d.dataType,
      )
        ? `${d.dataType ?? d.itemDefinitionRef} (${d.itemDefinitionRef})`
        : (d.dataType ?? d.itemDefinitionRef),
    }));
  }, [allOptions]);
  const choice = useDefinitionChoice({
    choices: options,
    selected: value,
    referenceOwner,
    disabled: isReadOnly,
    label: i18n.dataMapping.dataType,
    emptyLabel: i18n.propertiesPanel.noMatches,
    onSelect: _onChange,
    create: (newDataType) =>
      addOrGetItemDefinitionId({
        newDataType,
      }),
    createLabel: i18n.propertiesPanel.createDataType,
    canCreate: (value) => {
      if (Object.values(DEFAULT_DATA_TYPES).includes(value)) return true;
      try {
        indexBpmnIds(definitions).expandQName(definitions, value);
        return true;
      } catch {
        return false;
      }
    },
  });
  return (
    <SearchCombobox
      {...choice}
      label={showLabel ? choice.label : undefined}
      aria-label={i18n.dataMapping.dataType}
    />
  );
}
