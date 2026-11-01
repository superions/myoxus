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
  Select,
  Stack,
  MyoxusNumberInput,
  notify,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  setActivityCompensation,
  setActivityLoop,
  setActivityQuantity,
  type Activity,
  type ActivityLoopMode,
} from "../../mutations/activity";
import { visitFlowElementsAndArtifacts } from "../../mutations/element-visitor";
export type WithMultipleInstance = Activity;
export function MultiInstanceCheckbox({
  element,
}: {
  element: WithMultipleInstance;
}) {
  const t = useI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const connected = useBpmnEditorStore((state) => {
    const process = state.bpmn.model.definitions.rootElement?.find(
      (root) => root.__$$element === "process",
    );
    let connected = false;
    if (process?.__$$element === "process")
      visitFlowElementsAndArtifacts(process, ({ element: flow }) => {
        if (
          flow.__$$element === "sequenceFlow" &&
          (flow["@_sourceRef"] === element["@_id"] ||
            flow["@_targetRef"] === element["@_id"])
        )
          connected = true;
      });
    return connected;
  });
  return (
    <Stack>
      {/* These common Activity attributes are independent of loop cardinality.
          Empty fields preserve absent schema defaults until explicitly edited. */}
      {(
        [
          ["@_startQuantity", t["com.myoxus.editor.bpmn.start-quantity"]()],
          [
            "@_completionQuantity",
            t["com.myoxus.editor.bpmn.completion-quantity"](),
          ],
        ] as const
      ).map(([field, label]) => (
        <MyoxusNumberInput
          key={field}
          label={label}
          value={element[field] ?? ""}
          placeholder="1"
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          allowDecimal={false}
          disabled={isReadOnly}
          onChange={(value) => {
            if (
              value !== "" &&
              (typeof value !== "number" ||
                !Number.isSafeInteger(value) ||
                value < 1)
            )
              return;
            bpmnEditorStoreApi.setState((state) => {
              if (!state.settings.isReadOnly)
                setActivityQuantity(
                  state.bpmn.model.definitions,
                  element["@_id"],
                  field,
                  value === "" ? undefined : value,
                );
            });
          }}
        />
      ))}
      <Select
        label={t["com.myoxus.editor.bpmn.loop-mode"]()}
        value={
          element.loopCharacteristics?.__$$element ===
          "standardLoopCharacteristics"
            ? "standard"
            : element.loopCharacteristics?.__$$element ===
                "multiInstanceLoopCharacteristics"
              ? element.loopCharacteristics["@_isSequential"]
                ? "sequential"
                : "parallel"
              : "none"
        }
        disabled={
          isReadOnly ||
          (element.__$$element === "subProcess" &&
            element["@_triggeredByEvent"] === true)
        }
        data={[
          { value: "none", label: t["com.myoxus.editor.bpmn.no-loop"]() },
          {
            value: "standard",
            label: t["com.myoxus.editor.bpmn.standard-loop"](),
          },
          { value: "parallel", label: t["com.myoxus.editor.bpmn.parallel"]() },
          {
            value: "sequential",
            label: t["com.myoxus.editor.bpmn.sequential"](),
          },
        ]}
        onChange={(value) => {
          if (!["none", "standard", "parallel", "sequential"].includes(value))
            return;
          try {
            bpmnEditorStoreApi.setState((state) => {
              if (!state.settings.isReadOnly)
                setActivityLoop(
                  state.bpmn.model.definitions,
                  element["@_id"],
                  value as ActivityLoopMode,
                );
            });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "BPMN_DEFINITION_IN_USE"
            )
              notify.error(t["com.myoxus.editor.bpmn.definition-in-use"]());
            else throw error;
          }
        }}
      />
      <Checkbox
        label={t["com.myoxus.editor.bpmn.compensation"]()}
        disabled={
          isReadOnly ||
          connected ||
          !!element.incoming?.length ||
          !!element.outgoing?.length
        }
        checked={element["@_isForCompensation"] ?? false}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          bpmnEditorStoreApi.setState((state) => {
            if (!state.settings.isReadOnly)
              setActivityCompensation(
                state.bpmn.model.definitions,
                element["@_id"],
                checked,
              );
          });
        }}
      />
    </Stack>
  );
}
