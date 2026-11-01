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

import { Checkbox, Select, Stack } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditorI18n } from "../../i18n";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { eventById } from "../../mutations/event";
import { visitFlowElementsAndArtifacts } from "../../mutations/element-visitor";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import {
  useEventDefinition,
  type EventDefinitionProps,
} from "../eventDefinition/useEventDefinition";

export function ActivitySelector(props: EventDefinitionProps) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const { definition, change, readOnly, definitions } = useEventDefinition(
    props,
    "compensateEventDefinition",
  );
  let { owner } = eventById(definitions, props.eventId);
  if ("@_triggeredByEvent" in owner && owner["@_triggeredByEvent"]) {
    const id = owner["@_id"];
    visitFlowElementsAndArtifacts(
      addOrGetProcessAndDiagramElements({ definitions }).process,
      (location) => {
        if (location.element["@_id"] === id) {
          owner = location.owner;
          return false;
        }
        return true;
      },
    );
  }
  const activities =
    owner.flowElement?.filter((element) =>
      [
        "task",
        "userTask",
        "manualTask",
        "serviceTask",
        "scriptTask",
        "businessRuleTask",
        "sendTask",
        "receiveTask",
        "callActivity",
        "subProcess",
        "adHocSubProcess",
        "transaction",
      ].includes(element.__$$element),
    ) ?? [];
  const references = indexBpmnIds(definitions);
  const value = definition
    ? (references.resolveReference(definition, definition["@_activityRef"]) ??
      definition["@_activityRef"] ??
      "")
    : "";
  return (
    <Stack>
      <Select
        label={i18n.propertiesPanel.activity}
        value={value}
        disabled={readOnly}
        onChange={(value) =>
          change((definition, currentDefinitions) => {
            definition["@_activityRef"] = indexBpmnIds(
              currentDefinitions,
            ).referenceFor(
              definition,
              value || undefined,
              definition["@_activityRef"],
            );
          })
        }
        data={[
          { value: "", label: i18n.undefined },
          ...activities.map((element) => ({
            value: element["@_id"]!,
            label: element["@_name"] ?? element["@_id"]!,
          })),
          ...(value && activities.every((element) => element["@_id"] !== value)
            ? [{ value, label: value }]
            : []),
        ]}
      />
      <Checkbox
        label={t["com.myoxus.editor.bpmn.wait-for-compensation"]()}
        checked={definition?.["@_waitForCompletion"] ?? true}
        disabled={readOnly}
        onChange={(_event, checked) =>
          change((definition) => {
            definition["@_waitForCompletion"] = checked;
          })
        }
      />
    </Stack>
  );
}
