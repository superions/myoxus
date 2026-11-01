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
import { useBpmnEditorStore } from "../../store/StoreContext";
import {
  useDefinitionChoice,
  type DefinitionChoice,
} from "../../typeaheadSelect/use-definition-choice";
import { useMemo } from "react";
import { useBpmnEditorI18n } from "../../i18n";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
export type OnVariableChange = (
  newVariableRef: string | undefined,
  args: {
    isExpression: boolean;
  },
) => void;
export function VariableSelector({
  value,
  onChange,
  allowExpressions,
  omitIds,
  label,
}: {
  value: string | undefined;
  onChange: OnVariableChange;
  allowExpressions: boolean;
  omitIds?: string[];
  label?: string;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const variablesById = useBpmnEditorStore(
    (s) =>
      new Map(
        addOrGetProcessAndDiagramElements({
          definitions: s.bpmn.model.definitions,
        }).process.property?.map((p) => [p["@_id"], p]),
      ),
  );
  const options = useMemo(() => {
    const options: DefinitionChoice[] = [...variablesById.values()]
      .filter((v) => !omitIds?.includes(v["@_id"]))
      .map((v) => ({
        value: v["@_id"],
        label: v["@_name"] ?? v["@_id"],
      }));
    if (!value) {
      // Don't add anything.
    } else if (variablesById.has(value)) {
      // Don't add anything.
    }
    // In this case, value is an expression
    else if (allowExpressions) {
      options.push({
        value: value,
        label: value,
      });
    }
    // In this case, value is a reference to an unknown variable
    else {
      options.push({
        value,
        label: value,
      });
    }
    return options;
  }, [allowExpressions, omitIds, value, variablesById]);
  const choice = useDefinitionChoice({
    choices: options,
    selected: value,
    disabled: isReadOnly,
    label:
      label ??
      (allowExpressions
        ? i18n.propertiesPanel.expression
        : i18n.propertiesPanel.var),
    emptyLabel: allowExpressions
      ? i18n.propertiesPanel.enteringExpressions
      : i18n.propertiesPanel.noVariablesYet,
    create: allowExpressions ? (expression) => expression : undefined,
    createLabel: allowExpressions ? i18n.propertiesPanel.expression : undefined,
    createEvenWhenMatched: allowExpressions,
    onSelect: (next, _label, reason) =>
      onChange(next, {
        isExpression:
          reason === "created" ||
          (allowExpressions && next !== undefined && !variablesById.has(next)),
      }),
  });
  return <SearchCombobox {...choice} />;
}
