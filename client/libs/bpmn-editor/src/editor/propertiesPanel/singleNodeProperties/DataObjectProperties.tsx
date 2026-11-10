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
  Checkbox,
  Button,
  Select,
  MyoxusTextInput,
  Stack,
  Text,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { DataObjectIcon } from "../../diagram/nodes/NodeIcons";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  setDataObjectDetails,
  setDataObjectItemType,
  dataObjectIsCollection,
  setDataObjectReference,
  createDataObjectBacking,
} from "../../mutations/data";
import { findConnectionElement } from "../../mutations/connection";
import { useBpmnEditorI18n } from "../../i18n";
export function DataObjectProperties({
  dataObject: initial,
}: {
  dataObject: { "@_id": string };
}) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions);
  const location = findConnectionElement(definitions, initial["@_id"]),
    object = location?.element;
  if (
    object?.__$$element !== "dataObject" &&
    object?.__$$element !== "dataObjectReference"
  )
    return null;
  const backing =
    object.__$$element === "dataObjectReference"
      ? location!.owner.flowElement?.find(
          (element) =>
            element.__$$element === "dataObject" &&
            element["@_id"] === object["@_dataObjectRef"]?.trim(),
        )
      : undefined;
  return (
    <Accordion defaultValue="properties">
      <AccordionItem value="properties">
        <AccordionControl icon={<DataObjectIcon />}>
          {object["@_name"] ||
            (object.__$$element === "dataObjectReference"
              ? t["com.myoxus.editor.bpmn.data-object-reference"]()
              : i18n.bpmnPalette.dataObject)}
        </AccordionControl>
        <AccordionPanel keepMounted keepMountedMode="display-none">
          <DataObjectFields id={initial["@_id"]} />
        </AccordionPanel>
      </AccordionItem>
      {backing && (
        <AccordionItem value="backing">
          <AccordionControl>
            {t["com.myoxus.editor.bpmn.referenced-data-object"]()}
          </AccordionControl>
          <AccordionPanel keepMounted keepMountedMode="display-none">
            <DataObjectFields id={backing["@_id"]} />
          </AccordionPanel>
        </AccordionItem>
      )}
    </Accordion>
  );
}

function DataObjectFields({ id }: { id: string }) {
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    ),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly),
    t = useI18n(),
    { onCommandError } = useBpmnEditor();
  const location = findConnectionElement(definitions, id),
    dataObject = location?.element;
  if (
    dataObject?.__$$element !== "dataObject" &&
    dataObject?.__$$element !== "dataObjectReference"
  )
    return null;
  const isReference = dataObject.__$$element === "dataObjectReference";
  const command = (run: (model: typeof definitions) => void) => {
    try {
      bpmnEditorStoreApi.setState((state) => {
        if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  const change = (value: Parameters<typeof setDataObjectDetails>[2]) => {
    try {
      bpmnEditorStoreApi.setState((state) => {
        if (!state.settings.isReadOnly)
          setDataObjectDetails(
            state.bpmn.model.definitions,
            dataObject["@_id"],
            value,
          );
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  return (
    <Stack>
      <NameDocumentationAndId element={dataObject} />
      {dataObject.__$$element === "dataObjectReference" && (
        <>
          <Select
            label={t["com.myoxus.editor.bpmn.referenced-data-object"]()}
            value={dataObject["@_dataObjectRef"]?.trim() ?? ""}
            disabled={readOnly}
            data={[
              { value: "", label: t["com.myoxus.editor.bpmn.undefined"]() },
              ...(location!.owner.flowElement ?? [])
                .filter((element) => element.__$$element === "dataObject")
                .map((element) => ({
                  value: element["@_id"],
                  label: `${element["@_name"] || element["@_id"]} (${element["@_id"]})`,
                })),
            ]}
            onChange={(target) =>
              command((model) =>
                setDataObjectReference(model, id, target || undefined),
              )
            }
          />
          <Button
            disabled={readOnly}
            onClick={() =>
              command((model) => createDataObjectBacking(model, id))
            }
          >
            {t["com.myoxus.editor.bpmn.create-data-object"]()}
          </Button>
        </>
      )}

      <ItemDefinitionRefSelector
        referenceOwner={dataObject}
        value={dataObject["@_itemSubjectRef"]}
        onChange={(newItemDefinitionRef) => {
          try {
            bpmnEditorStoreApi.setState((state) => {
              if (!state.settings.isReadOnly)
                setDataObjectItemType(
                  state.bpmn.model.definitions,
                  dataObject["@_id"],
                  newItemDefinitionRef,
                );
            });
          } catch (error) {
            onCommandError(error);
          }
        }}
      />
      <Checkbox
        label={t["com.myoxus.editor.bpmn.data-collection"]()}
        checked={dataObjectIsCollection(definitions, id)}
        disabled={readOnly || isReference || !!dataObject["@_itemSubjectRef"]}
        onChange={(_event, checked) => change({ collection: checked })}
      />
      {(isReference || dataObject["@_itemSubjectRef"]) && (
        <Text>
          {isReference
            ? t["com.myoxus.editor.bpmn.collection-from-object"]()
            : t["com.myoxus.editor.bpmn.data-collection-from-type"]()}
        </Text>
      )}
      <MyoxusTextInput
        label={t["com.myoxus.editor.bpmn.data-state"]()}
        value={dataObject.dataState?.["@_name"] ?? ""}
        disabled={readOnly}
        onChange={(state) => change({ state })}
      />
    </Stack>
  );
}
