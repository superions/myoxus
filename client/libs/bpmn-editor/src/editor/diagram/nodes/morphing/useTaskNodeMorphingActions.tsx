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

import { useI18n } from "@myoxus/i18n";

import { useCallback } from "react";
import { useBpmnEditorStoreApi } from "../../../store/StoreContext";
import { CallActivityIcon, TaskIcon } from "../NodeIcons";
import { morphTask } from "../../../mutations/renameNode";
import { type Task } from "../../../mutations/data-mapping";
import { bpmnConstructState } from "../../../../source-profile";
export function useTaskNodeMorphingActions(task: Task) {
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const morphTo = useCallback(
    (newTaskElement: Task["__$$element"]) => {
      if (
        newTaskElement === task.__$$element ||
        bpmnConstructState(newTaskElement) !== "editable"
      )
        return;
      bpmnEditorStoreApi.setState((s) => {
        if (!s.settings.isReadOnly)
          morphTask({
            definitions: s.bpmn.model.definitions,
            id: task["@_id"],
            from: task.__$$element,
            to: newTaskElement,
          });
      });
    },
    [bpmnEditorStoreApi, task],
  );
  const morphingActions = [
    {
      icon: <TaskIcon />,
      key: "1",
      title: t["com.myoxus.editor.shape.bpmn.task"](),
      id: "task",
      action: () => morphTo("task"),
    } as const,
    {
      icon: <TaskIcon variant={"userTask"} isIcon={true} />,
      key: "2",
      title: t["com.myoxus.editor.shape.bpmn.user-task"](),
      id: "userTask",
      action: () => morphTo("userTask"),
    } as const,
    {
      icon: <TaskIcon variant={"businessRuleTask"} isIcon={true} />,
      key: "3",
      title: t["com.myoxus.editor.shape.bpmn.business-rule-task"](),
      id: "businessRuleTask",
      action: () => morphTo("businessRuleTask"),
    } as const,
    {
      icon: <TaskIcon variant={"serviceTask"} isIcon={true} />,
      key: "4",
      title: t["com.myoxus.editor.shape.bpmn.service-task"](),
      id: "serviceTask",
      action: () => morphTo("serviceTask"),
    } as const,
    {
      icon: <TaskIcon variant={"scriptTask"} isIcon={true} />,
      key: "5",
      title: t["com.myoxus.editor.shape.bpmn.script-task"](),
      id: "scriptTask",
      action: () => morphTo("scriptTask"),
    } as const,
    {
      icon: <CallActivityIcon />,
      key: "6",
      title: t["com.myoxus.editor.shape.bpmn.call-activity"](),
      id: "callActivity",
      action: () => morphTo("callActivity"),
    } as const,
    {
      icon: <TaskIcon variant="manualTask" isIcon />,
      key: "7",
      title: t["com.myoxus.editor.shape.bpmn.manual-task"](),
      id: "manualTask",
      action: () => morphTo("manualTask"),
    } as const,
    {
      icon: <TaskIcon variant="sendTask" isIcon />,
      key: "8",
      title: t["com.myoxus.editor.shape.bpmn.send-task"](),
      id: "sendTask",
      action: () => morphTo("sendTask"),
    } as const,
    {
      icon: <TaskIcon variant="receiveTask" isIcon />,
      key: "9",
      title: t["com.myoxus.editor.shape.bpmn.receive-task"](),
      id: "receiveTask",
      action: () => morphTo("receiveTask"),
    } as const,
  ];
  return morphingActions.filter(
    (action) => bpmnConstructState(action.id) === "editable",
  );
}
