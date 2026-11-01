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
  IconButton,
  MyoxusTextInput,
  MyoxusTextarea,
  Stack,
  notify,
} from "@myoxus/ui-facade";
import { FlowCategories } from "../categories/FlowCategories";
import { CopyIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { updateFlowElement, updateLane } from "../../mutations/renameNode";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  type BPMN20__tAssociation,
  type BPMN20__tGroup,
  type BPMN20__tTextAnnotation,
  type BPMN20__tLane,
  type BPMN20__tProcess,
} from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Unpacked } from "../../../xyflow/tsExt/tsExt";
import {
  visitFlowElementsAndArtifacts,
  visitProcessLanes,
} from "../../mutations/element-visitor";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import { useCallback } from "react";
import { useBpmnEditorI18n } from "../../i18n";
export function NameDocumentationAndId({
  element,
}: {
  element: Normalized<
    | Unpacked<NonNullable<BPMN20__tProcess["flowElement"]>>
    | (BPMN20__tLane & {
        __$$element: "lane";
      })
    | (BPMN20__tAssociation & {
        __$$element: "association";
      })
    | (BPMN20__tGroup & {
        __$$element: "group";
      })
    | (BPMN20__tTextAnnotation & {
        __$$element: "textAnnotation";
      })
  >;
}) {
  const { i18n } = useBpmnEditorI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const t = useI18n();
  const settings = useBpmnEditorStore((s) => s.settings);
  const onNameChanged = useCallback(
    (newName: string = "") => {
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        if (element.__$$element === "lane") {
          updateLane({
            definitions: s.bpmn.model.definitions,
            newLane: {
              "@_name": newName,
            },
            id: element["@_id"],
          });
        } else {
          updateFlowElement({
            definitions: s.bpmn.model.definitions,
            id: element["@_id"],
            newFlowElement: {
              "@_name": newName,
            },
          });
        }
      });
    },
    [element, bpmnEditorStoreApi],
  );
  // Prose edits preserve optional identity/format metadata and every later
  // documentation entry; reading/editing an anonymous entry never assigns an ID.
  const onDocumentationChanged = useCallback(
    (newDocumentation: string) =>
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        const { process } = addOrGetProcessAndDiagramElements({
          definitions: s.bpmn.model.definitions,
        });
        if (element.__$$element === "lane") {
          visitProcessLanes(process, ({ lane: e }) => {
            if (e["@_id"] === element["@_id"]) {
              if (newDocumentation) {
                e.documentation ??= [];
                e.documentation[0] = {
                  ...e.documentation[0],
                  __$$text: newDocumentation,
                };
              } else if (e.documentation) {
                e.documentation.splice(0, 1);
              }
            }
            return true;
          });
        } else {
          visitFlowElementsAndArtifacts(process, ({ element: e }) => {
            if (
              e["@_id"] === element["@_id"] &&
              e.__$$element === element.__$$element
            ) {
              if (newDocumentation) {
                e.documentation ??= [];
                e.documentation[0] = {
                  ...e.documentation[0],
                  __$$text: newDocumentation,
                };
              } else if (e.documentation) {
                e.documentation.splice(0, 1);
              }
            }
            return true;
          });
        }
      }),
    [bpmnEditorStoreApi, element],
  );
  return (
    <Stack>
      {element.__$$element !== "association" &&
        element.__$$element !== "group" &&
        element.__$$element !== "textAnnotation" && (
          <MyoxusTextInput
            disabled={settings.isReadOnly}
            id={element["@_id"]}
            name={element["@_name"]}
            value={element["@_name"] || ""}
            placeholder={i18n.propertiesPanel.enterNamePlaceholder}
            onChange={onNameChanged}
            label={i18n.propertiesPanel.name}
          />
        )}

      <MyoxusTextarea
        disabled={settings.isReadOnly}
        value={element.documentation?.[0]?.__$$text ?? ""}
        onChange={onDocumentationChanged}
        placeholder={i18n.propertiesPanel.documentationPlaceholder}
        rows={3}
        label={i18n.propertiesPanel.documentation}
      />

      <MyoxusTextInput
        label={i18n.propertiesPanel.id}
        readOnly
        value={element["@_id"]}
        endFix={
          <IconButton
            tooltip={i18n.propertiesPanel.copy}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(element["@_id"]);
              } catch {
                notify.error(t["com.myoxus.common.operation-failed"]());
              }
            }}
          >
            <CopyIcon />
          </IconButton>
        }
      />
      <FlowCategories id={element["@_id"]} />
    </Stack>
  );
}
