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

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { Select, SearchCombobox, Stack } from "@myoxus/ui-facade";
import type { Task } from "../../mutations/data-mapping";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { TaskProperties } from "./TaskProperties";
import { updateFlowElement } from "../../mutations/renameNode";
import { addOrGetInterfaces } from "../../mutations/addOrGetInterfaces";
import { addOrGetOperations } from "../../mutations/addOrGetOperations";
import { addOrGetMessages } from "../../mutations/addOrGetMessages";
import { useDefinitionChoice } from "../../typeaheadSelect/use-definition-choice";
import { useBpmnEditorI18n } from "../../i18n";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import { visitFlowElementsAndArtifacts } from "../../mutations/element-visitor";
export function ServiceTaskProperties({
  serviceTask,
}: {
  serviceTask: Extract<
    Task,
    { __$$element: "serviceTask" | "sendTask" | "receiveTask" }
  >;
}) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const operationId = useBpmnEditorStore((state) =>
    indexBpmnIds(state.bpmn.model.definitions).resolveReference(
      serviceTask,
      serviceTask["@_operationRef"],
    ),
  );
  const interfaces = useBpmnEditorStore(
    (state) =>
      state.bpmn.model.definitions.rootElement?.filter(
        (root) => root.__$$element === "interface",
      ) ?? [],
  );
  const currentOwner = interfaces.find((owner) =>
    owner.operation.some((operation) => operation["@_id"] === operationId),
  );
  const [chosenInterface, setChosenInterface] = useState<string | undefined>();
  const selectedInterface = chosenInterface ?? currentOwner?.["@_id"];
  const owner = interfaces.find((owner) => owner["@_id"] === selectedInterface);
  const changeReference = (reference: string | undefined) =>
    store.setState((state) => {
      if (state.settings.isReadOnly) return;
      const { process } = addOrGetProcessAndDiagramElements({
        definitions: state.bpmn.model.definitions,
      });
      visitFlowElementsAndArtifacts(process, ({ element }) => {
        if (
          (element.__$$element === "serviceTask" ||
            element.__$$element === "sendTask" ||
            element.__$$element === "receiveTask") &&
          element["@_id"] === serviceTask["@_id"]
        ) {
          element["@_operationRef"] = indexBpmnIds(
            state.bpmn.model.definitions,
          ).referenceFor(element, reference, element["@_operationRef"]);
          return false;
        }
        return true;
      });
    });
  const interfaceChoice = useDefinitionChoice({
    choices: interfaces.map((owner) => ({
      value: owner["@_id"],
      label: owner["@_name"],
    })),
    selected: selectedInterface,
    disabled: readOnly,
    label: i18n.singleNodeProperties.interface,
    emptyLabel: i18n.propertiesPanel.noMatches,
    createLabel: t.Create(),
    onSelect: (reference) => {
      setChosenInterface(reference);
      if (reference !== currentOwner?.["@_id"]) changeReference(undefined);
    },
    create: (name) => {
      let created: string | undefined;
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          created = addOrGetInterfaces({
            definitions: state.bpmn.model.definitions,
            interfaceName: name,
          }).interface["@_id"];
      });
      if (!created) throw new Error("BPMN_READ_ONLY");
      return created;
    },
  });
  const operationChoice = useDefinitionChoice({
    choices:
      owner?.operation.map((operation) => ({
        value: operation["@_id"],
        label: operation["@_name"],
      })) ?? [],
    selected: serviceTask["@_operationRef"],
    referenceOwner: serviceTask,
    disabled: readOnly || !owner,
    label: i18n.singleNodeProperties.operation,
    emptyLabel: i18n.propertiesPanel.noMatches,
    createLabel: t.Create(),
    onSelect: changeReference,
    create: (name) => {
      if (!selectedInterface) throw new Error("BPMN_INTERFACE_OWNER_REQUIRED");
      let created: string | undefined;
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          created = addOrGetOperations({
            definitions: state.bpmn.model.definitions,
            interfaceId: selectedInterface,
            operationName: name,
          }).operation["@_id"];
      });
      if (!created) throw new Error("BPMN_READ_ONLY");
      return created;
    },
  });
  const messages = useBpmnEditorStore(
    (state) =>
      state.bpmn.model.definitions.rootElement?.filter(
        (root) => root.__$$element === "message",
      ) ?? [],
  );
  const messageChoice = useDefinitionChoice({
    choices: messages.map((message) => ({
      value: message["@_id"],
      label: message["@_name"] || message["@_id"],
    })),
    selected:
      serviceTask.__$$element === "serviceTask"
        ? undefined
        : serviceTask["@_messageRef"],
    referenceOwner: serviceTask,
    disabled: readOnly,
    label: t["com.myoxus.editor.bpmn.message"](),
    emptyLabel: i18n.propertiesPanel.noMatches,
    createLabel: t.Create(),
    onSelect: (reference) =>
      store.setState((state) => {
        if (state.settings.isReadOnly) return;
        const { process } = addOrGetProcessAndDiagramElements({
          definitions: state.bpmn.model.definitions,
        });
        visitFlowElementsAndArtifacts(process, ({ element }) => {
          if (
            (element.__$$element !== "sendTask" &&
              element.__$$element !== "receiveTask") ||
            element["@_id"] !== serviceTask["@_id"]
          )
            return true;
          const encoded = indexBpmnIds(
            state.bpmn.model.definitions,
          ).referenceFor(element, reference, element["@_messageRef"]);
          if (encoded) element["@_messageRef"] = encoded;
          else delete element["@_messageRef"];
          return false;
        });
      }),
    create: (name) => {
      let reference: string | undefined;
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          reference = addOrGetMessages({
            definitions: state.bpmn.model.definitions,
            messageName: name,
          }).messageRef;
      });
      if (!reference) throw new Error("BPMN_READ_ONLY");
      return reference;
    },
  });
  return (
    <TaskProperties task={serviceTask}>
      <Stack>
        {serviceTask.__$$element !== "serviceTask" && (
          <SearchCombobox {...messageChoice} />
        )}
        <SearchCombobox {...interfaceChoice} />
        <SearchCombobox {...operationChoice} />
        {serviceTask.__$$element === "receiveTask" && (
          <Select
            label={t["com.myoxus.editor.bpmn.instantiate"]()}
            value={
              serviceTask["@_instantiate"] === undefined
                ? "unset"
                : String(serviceTask["@_instantiate"])
            }
            disabled={readOnly}
            data={[
              { value: "unset", label: i18n.undefined },
              { value: "true", label: t["com.myoxus.document-context.yes"]() },
              { value: "false", label: t["com.myoxus.document-context.no"]() },
            ]}
            onChange={(value) =>
              store.setState((state) => {
                if (!state.settings.isReadOnly)
                  updateFlowElement({
                    definitions: state.bpmn.model.definitions,
                    id: serviceTask["@_id"],
                    newFlowElement: {
                      "@_instantiate":
                        value === "unset" ? undefined : value === "true",
                    },
                  });
              })
            }
          />
        )}
      </Stack>
    </TaskProperties>
  );
}
