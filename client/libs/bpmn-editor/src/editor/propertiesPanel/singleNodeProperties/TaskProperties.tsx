/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus; see provenance.json for retained source and patches.

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  MyoxusTextInput,
} from "@myoxus/ui-facade";
import type { Task } from "../../mutations/data-mapping";
import type { TaskVariant } from "../../diagram/BpmnDiagramDomain";
import type { PropsWithChildren } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { updateFlowElement } from "../../mutations/renameNode";
import { BidirectionalDataMappingFormSection } from "../dataMapping/DataMappingFormSection";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { TaskIcon } from "../../diagram/nodes/NodeIcons";
import { useBpmnEditorI18n } from "../../i18n";
import { MultiInstanceCheckbox } from "../multiInstanceCheckbox/MultiInstanceCheckbox";
import { MultiInstanceProperties } from "../multiInstance/MultiInstanceProperties";
import { ResourceRoles } from "../resources/ResourceRoles";

export function TaskProperties({
  task,
  children,
}: PropsWithChildren<{
  task: Extract<Task, { __$$element: "task" | TaskVariant }>;
}>) {
  const { i18n } = useBpmnEditorI18n(),
    t = useI18n(),
    store = useBpmnEditorStoreApi(),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const titles = {
    task: i18n.singleNodeProperties.task,
    userTask: i18n.singleNodeProperties.userTask,
    businessRuleTask: i18n.singleNodeProperties.businessRuleTask,
    serviceTask: i18n.singleNodeProperties.serviceTask,
    scriptTask: i18n.singleNodeProperties.scriptTask,
    manualTask: t["com.myoxus.editor.shape.bpmn.manual-task"](),
    sendTask: t["com.myoxus.editor.shape.bpmn.send-task"](),
    receiveTask: t["com.myoxus.editor.shape.bpmn.receive-task"](),
  };
  return (
    <Accordion
      multiple
      defaultValue={["properties"]}
      keepMounted
      keepMountedMode="display-none"
    >
      <AccordionItem value="properties">
        <AccordionControl
          icon={
            <TaskIcon
              variant={
                task.__$$element === "task" ? undefined : task.__$$element
              }
              isIcon={task.__$$element !== "task"}
            />
          }
        >
          {task["@_name"] || titles[task.__$$element]}
        </AccordionControl>
        <AccordionPanel>
          <Stack>
            <NameDocumentationAndId element={task} />
            {(
              [
                "userTask",
                "businessRuleTask",
                "serviceTask",
                "sendTask",
                "receiveTask",
              ] as string[]
            ).includes(task.__$$element) && (
              <MyoxusTextInput
                label={i18n.singleNodeProperties.implementation}
                value={
                  "@_implementation" in task
                    ? (task["@_implementation"] ?? "")
                    : ""
                }
                placeholder={
                  task.__$$element === "userTask" ||
                  task.__$$element === "businessRuleTask"
                    ? "##unspecified"
                    : "##WebService"
                }
                disabled={readOnly}
                onChange={(value) =>
                  store.setState((state) => {
                    if (!state.settings.isReadOnly)
                      updateFlowElement({
                        definitions: state.bpmn.model.definitions,
                        id: task["@_id"],
                        newFlowElement: {
                          "@_implementation": value || undefined,
                        },
                      });
                  })
                }
              />
            )}
            {children}
            <BidirectionalDataMappingFormSection element={task} />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="activity">
        <AccordionControl>{i18n.propertiesPanel.activity}</AccordionControl>
        <AccordionPanel>
          <Stack>
            <MultiInstanceCheckbox element={task} />
            <MultiInstanceProperties element={task} />
          </Stack>
        </AccordionPanel>
      </AccordionItem>
      <ResourceRoles ownerId={task["@_id"]} />
    </Accordion>
  );
}
