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
import type { SubProcess } from "../../mutations/activity";
import { activityById } from "../../mutations/activity";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import { useBpmnEditorI18n } from "../../i18n";
import { SubProcessProperties } from "./SubProcessProperties";

export function AdHocSubProcessProperties({
  adHocSubProcess,
}: {
  adHocSubProcess: Extract<SubProcess, { __$$element: "adHocSubProcess" }>;
}) {
  const t = useI18n();
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const change = (action: (subProcess: typeof adHocSubProcess) => void) =>
    store.setState((state) => {
      if (state.settings.isReadOnly) return;
      const owner = activityById(
        state.bpmn.model.definitions,
        adHocSubProcess["@_id"],
      );
      if (owner.__$$element === "adHocSubProcess") action(owner);
    });
  return (
    <SubProcessProperties subProcess={adHocSubProcess}>
      <Select
        label={i18n.singleNodeProperties.adhocOrdering}
        disabled={readOnly}
        value={adHocSubProcess["@_ordering"] ?? null}
        data={[
          { value: "Sequential", label: i18n.singleNodeProperties.sequential },
          { value: "Parallel", label: i18n.singleNodeProperties.parallel },
        ]}
        clearable
        clearButtonProps={{
          "aria-label": t["com.myoxus.common.clear-selection"](),
        }}
        onClear={() =>
          change((owner) => {
            delete owner["@_ordering"];
          })
        }
        onChange={(value) => {
          if (value === "Sequential" || value === "Parallel")
            change((owner) => {
              owner["@_ordering"] = value;
            });
        }}
      />
      <Checkbox
        label={t["com.myoxus.editor.bpmn.cancel-remaining-instances"]()}
        checked={adHocSubProcess["@_cancelRemainingInstances"] ?? true}
        disabled={readOnly}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          change((owner) => {
            owner["@_cancelRemainingInstances"] = checked;
          });
        }}
      />
      <MyoxusTextarea
        label={i18n.singleNodeProperties.adhocCompletionCondition}
        value={adHocSubProcess.completionCondition?.__$$text ?? ""}
        disabled={readOnly}
        onChange={(value) =>
          change((owner) => {
            // Edit only expression text; imported ID/type/language/scope survives.
            owner.completionCondition ??= {
              "@_id": generateUuid(),
              __$$text: "",
            };
            owner.completionCondition.__$$text = value;
          })
        }
      />
    </SubProcessProperties>
  );
}
