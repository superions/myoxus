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

import { MyoxusTextarea, MyoxusTextInput } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditorStore } from "../../store/StoreContext";
import { type BPMN20__tScriptTask } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { TaskProperties } from "./TaskProperties";
import { updateFlowElement } from "../../mutations/renameNode";
import { useBpmnEditorStoreApi } from "../../store/StoreContext";
import { visitFlowElementsAndArtifacts } from "../../mutations/element-visitor";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import { useBpmnEditorI18n } from "../../i18n";
export function ScriptTaskProperties({
  scriptTask,
}: {
  scriptTask: Normalized<BPMN20__tScriptTask> & {
    __$$element: "scriptTask";
  };
}) {
  const isBpmnReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  return (
    <TaskProperties task={scriptTask}>
      <MyoxusTextInput
        label={t["com.myoxus.editor.bpmn.script-format"]()}
        value={scriptTask["@_scriptFormat"] ?? ""}
        disabled={isBpmnReadOnly}
        onChange={(value) =>
          bpmnEditorStoreApi.setState((state) => {
            if (!state.settings.isReadOnly)
              updateFlowElement({
                definitions: state.bpmn.model.definitions,
                id: scriptTask["@_id"],
                newFlowElement: { "@_scriptFormat": value || undefined },
              });
          })
        }
      />
      <MyoxusTextarea
        label={i18n.singleNodeProperties.script}
        value={scriptTask?.script?.__$$text || ""}
        onChange={(newScript) => {
          bpmnEditorStoreApi.setState((s) => {
            if (s.settings.isReadOnly) return;
            const { process } = addOrGetProcessAndDiagramElements({
              definitions: s.bpmn.model.definitions,
            });
            visitFlowElementsAndArtifacts(process, ({ element: e }) => {
              if (
                e["@_id"] === scriptTask["@_id"] &&
                e.__$$element === scriptTask.__$$element
              ) {
                e.script ??= {
                  __$$text: newScript || "",
                };
                e.script.__$$text = newScript;
              }
              return true;
            });
          });
        }}
        disabled={isBpmnReadOnly}
      />
    </TaskProperties>
  );
}
