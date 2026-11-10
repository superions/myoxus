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
  MyoxusTextInput,
  Select,
  Stack,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import { type BPMN20__tGroup } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { GroupIcon } from "../../diagram/nodes/NodeIcons";
import { useI18n } from "@myoxus/i18n";
import {
  groupCategoryValue,
  setGroupCategory,
  setGroupCategoryText,
} from "../../mutations/group";
import { findConnectionElement } from "../../mutations/connection";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { useBpmnEditorI18n } from "../../i18n";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
export function GroupProperties({
  group,
}: {
  group: Normalized<BPMN20__tGroup> & {
    __$$element: "group";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n(),
    { onCommandError } = useBpmnEditor();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const settings = useBpmnEditorStore((s) => s.settings);
  const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    ),
    current = findConnectionElement(definitions, group["@_id"])?.element;
  if (current?.__$$element !== "group") return null;
  const categoryValue = groupCategoryValue(definitions, group["@_id"]),
    values =
      definitions.rootElement
        ?.filter((root) => root.__$$element === "category")
        .flatMap((root) => root.categoryValue ?? []) ?? [];
  const command = (run: (model: typeof definitions) => void) => {
    try {
      bpmnEditorStoreApi.setState((state) => {
        if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  return (
    <Accordion defaultValue={"properties"}>
      <AccordionItem value="properties">
        <AccordionControl icon={<GroupIcon />}>
          {t["com.myoxus.editor.shape.bpmn.group"]()}
        </AccordionControl>
        <AccordionPanel keepMounted keepMountedMode="display-none">
          <Stack>
            <Select
              label={t["com.myoxus.editor.bpmn.definition-reference"]()}
              value={
                indexBpmnIds(definitions).resolveReference(
                  current,
                  current["@_categoryValueRef"],
                ) ?? ""
              }
              disabled={settings.isReadOnly}
              data={[
                { value: "", label: t["com.myoxus.editor.bpmn.undefined"]() },
                ...values.map((value) => ({
                  value: value["@_id"],
                  label: value["@_value"] || value["@_id"],
                })),
              ]}
              onChange={(value) =>
                command((definitions) =>
                  setGroupCategory(
                    definitions,
                    group["@_id"],
                    value || undefined,
                  ),
                )
              }
            />
            <MyoxusTextInput
              disabled={settings.isReadOnly}
              value={categoryValue?.["@_value"] ?? ""}
              placeholder={i18n.propertiesPanel.enterNamePlaceholder}
              onChange={(text) =>
                command((definitions) =>
                  setGroupCategoryText(definitions, group["@_id"], text),
                )
              }
              label={i18n.propertiesPanel.name}
            />
            <NameDocumentationAndId element={group} />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
