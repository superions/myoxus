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
import {
  setSubProcessKind,
  type SubProcess,
} from "../../../mutations/activity";
import { useBpmnEditorStoreApi } from "../../../store/StoreContext";
import { useBpmnEditor } from "../../../BpmnEditorContext";
import { SubProcessIcon } from "../NodeIcons";
import { AdHocSubProcessIconSvg } from "../NodeSvgs";
import { bpmnConstructState } from "../../../../source-profile";

export function useSubProcessNodeMorphingActions(subProcess: SubProcess) {
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const { onCommandError } = useBpmnEditor();
  const morph = (
    kind: "subProcess" | "adHocSubProcess" | "transaction" | "event",
  ) => {
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          setSubProcessKind(
            state.bpmn.model.definitions,
            subProcess["@_id"],
            kind,
          );
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  // Loop modes are standard properties, not destructive pseudo-subprocess
  // types. Event mode is the standard triggeredByEvent flag, not a schema kind.
  return [
    {
      icon: <SubProcessIcon variant="other" />,
      key: "1",
      title: t["com.myoxus.editor.shape.bpmn.sub-process"](),
      id: "subProcess",
      action: () => morph("subProcess"),
    } as const,
    {
      icon: <SubProcessIcon variant="event" />,
      key: "2",
      title: t["com.myoxus.editor.bpmn.event-subprocess"](),
      id: "event",
      action: () => morph("event"),
    } as const,
    {
      icon: (
        <AdHocSubProcessIconSvg
          stroke="var(--mantine-color-text)"
          size={20}
          isIcon
        />
      ),
      key: "4",
      title: t["com.myoxus.editor.bpmn.adhoc-subprocess"](),
      id: "adHocSubProcess",
      action: () => morph("adHocSubProcess"),
    } as const,
    {
      icon: <SubProcessIcon variant="transaction" />,
      key: "5",
      title: t["com.myoxus.editor.bpmn.transaction"](),
      id: "transaction",
      action: () => morph("transaction"),
    } as const,
  ].filter(
    (action) =>
      bpmnConstructState(action.id === "event" ? "subProcess" : action.id) ===
      "editable",
  );
}
