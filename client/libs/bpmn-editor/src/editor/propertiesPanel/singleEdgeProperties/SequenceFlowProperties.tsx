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

import { Checkbox, MyoxusTextarea, Select } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditorStore } from "../../store/StoreContext";
import { Stack } from "@myoxus/ui-facade";
import { type BPMN20__tSequenceFlow } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { useBpmnEditorStoreApi } from "../../store/StoreContext";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { useBpmnEditorI18n } from "../../i18n";
import {
  findConnectionElement,
  setDefaultFlow,
  setFlowCondition,
  setFlowImmediate,
} from "../../mutations/connection";
import { canOwnDefault } from "../../mutations/connection-context";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { resolveBpmnProcessOwner } from "../../../process-source";
export function SequenceFlowProperties({
  sequenceFlow,
}: {
  sequenceFlow: Normalized<BPMN20__tSequenceFlow> & {
    __$$element: "sequenceFlow";
  };
}) {
  const isBpmnReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const { onCommandError } = useBpmnEditor();
  const executable =
    resolveBpmnProcessOwner(definitions).process["@_isExecutable"] === true;
  const location = findConnectionElement(definitions, sequenceFlow["@_id"]);
  if (!location) return null;
  const { element: current, owner } = location;
  const source =
    current.__$$element === "sequenceFlow"
      ? owner.flowElement?.find(
          (element) => element["@_id"] === current["@_sourceRef"],
        )
      : undefined;
  const allowed = !!source && canOwnDefault(source);
  const isDefault =
    !!source &&
    "@_default" in source &&
    indexBpmnIds(definitions).resolveReference(source, source["@_default"]) ===
      sequenceFlow["@_id"];
  return (
    <Stack>
      <NameDocumentationAndId element={sequenceFlow} />
      <Select
        label={t["com.myoxus.editor.bpmn.immediate-flow"]()}
        description={
          executable
            ? t["com.myoxus.editor.bpmn.immediate-required"]()
            : undefined
        }
        value={
          sequenceFlow["@_isImmediate"] === undefined
            ? "unset"
            : String(sequenceFlow["@_isImmediate"])
        }
        data={[
          { value: "unset", label: i18n.undefined },
          { value: "true", label: t["com.myoxus.document-context.yes"]() },
          {
            value: "false",
            label: t["com.myoxus.document-context.no"](),
            disabled: executable,
          },
        ]}
        disabled={isBpmnReadOnly}
        onChange={(value) => {
          if (value !== "unset" && value !== "true" && value !== "false")
            return;
          try {
            bpmnEditorStoreApi.setState((state) => {
              if (!state.settings.isReadOnly)
                setFlowImmediate(
                  state.bpmn.model.definitions,
                  sequenceFlow["@_id"],
                  value === "unset" ? undefined : value === "true",
                );
            });
          } catch (error) {
            onCommandError(error);
          }
        }}
      />
      {allowed && (
        <Checkbox
          label={i18n.propertiesPanel.defaultRoute}
          disabled={isBpmnReadOnly}
          checked={isDefault}
          onChange={(_event, checked) => {
            try {
              bpmnEditorStoreApi.setState((state) => {
                if (!state.settings.isReadOnly)
                  setDefaultFlow(
                    state.bpmn.model.definitions,
                    source!["@_id"],
                    checked ? sequenceFlow["@_id"] : undefined,
                  );
              });
            } catch (error) {
              onCommandError(error);
            }
          }}
        />
      )}
      {allowed && (
        <MyoxusTextarea
          label={i18n.propertiesPanel.conditionalExpression}
          value={sequenceFlow.conditionExpression?.__$$text || ""}
          onChange={(text) => {
            try {
              bpmnEditorStoreApi.setState((s) => {
                if (s.settings.isReadOnly) return;
                setFlowCondition(
                  s.bpmn.model.definitions,
                  sequenceFlow["@_id"],
                  text,
                );
              });
            } catch (error) {
              onCommandError(error);
            }
          }}
          disabled={isBpmnReadOnly}
        />
      )}
    </Stack>
  );
}
