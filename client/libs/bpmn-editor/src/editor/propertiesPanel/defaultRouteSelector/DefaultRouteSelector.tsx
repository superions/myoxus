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

import { Select } from "@myoxus/ui-facade";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  findConnectionElement,
  setDefaultFlow,
} from "../../mutations/connection";
import { canOwnDefault } from "../../mutations/connection-context";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { useBpmnEditorI18n } from "../../i18n";
export function DefaultRouteSelector({
  gateway,
}: {
  gateway: { "@_id": string };
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    ),
    { onCommandError } = useBpmnEditor();
  const location = findConnectionElement(definitions, gateway["@_id"]);
  if (!location || !canOwnDefault(location.element)) return null;
  const source = location.element,
    flows =
      location.owner.flowElement?.filter(
        (flow) =>
          flow.__$$element === "sequenceFlow" &&
          flow["@_sourceRef"] === gateway["@_id"],
      ) ?? [];
  const value =
    indexBpmnIds(definitions).resolveReference(source, source["@_default"]) ??
    "";
  return (
    <Select
      label={i18n.propertiesPanel.defaultRoute}
      value={value}
      onChange={(value) => {
        try {
          bpmnEditorStoreApi.setState((state) => {
            if (!state.settings.isReadOnly)
              setDefaultFlow(
                state.bpmn.model.definitions,
                gateway["@_id"],
                value || undefined,
              );
          });
        } catch (error) {
          onCommandError(error);
        }
      }}
      disabled={isReadOnly}
      data={[
        {
          value: "",
          label: i18n.propertiesPanel.none,
        },
        ...flows.map((flow) => ({
          value: flow["@_id"],
          label:
            flow.__$$element === "sequenceFlow"
              ? (flow["@_name"] ?? flow["@_id"])
              : flow["@_id"],
        })),
      ]}
    />
  );
}
