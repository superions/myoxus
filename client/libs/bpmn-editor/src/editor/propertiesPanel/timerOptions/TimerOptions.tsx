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

import { MyoxusTextInput, Select, Stack } from "@myoxus/ui-facade";
import {
  useEventDefinition,
  type EventDefinitionProps,
} from "../eventDefinition/useEventDefinition";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import { useBpmnEditorI18n } from "../../i18n";
type TimerField = "timeDuration" | "timeCycle" | "timeDate";
export function TimerOptions(props: EventDefinitionProps) {
  const { i18n } = useBpmnEditorI18n();
  const {
    definition: timer,
    change: edit,
    readOnly,
  } = useEventDefinition(props, "timerEventDefinition");
  const field: TimerField = timer?.timeCycle
    ? "timeCycle"
    : timer?.timeDate
      ? "timeDate"
      : "timeDuration";
  const options = [
    {
      value: "timeDuration",
      label: i18n.propertiesPanel.fireOnceAfterDuration,
    },
    {
      value: "timeCycle",
      label: i18n.propertiesPanel.fireMultipleTimes,
    },
    {
      value: "timeDate",
      label: i18n.propertiesPanel.fireAtspecificDate,
    },
  ];
  const change = (next: TimerField, text: string) =>
    edit((definition) => {
      // A timer is an XSD choice. Mode changes retain the expression's
      // identity, formal type, language and namespace metadata, not a new
      // empty object. Only its timer role and explicit text change.
      const previous =
        definition.timeCycle ?? definition.timeDate ?? definition.timeDuration;
      delete definition.timeCycle;
      delete definition.timeDate;
      delete definition.timeDuration;
      definition[next] = previous ?? { "@_id": generateUuid() };
      definition[next].__$$text = text;
    });
  return (
    <Stack>
      <Select
        label={i18n.propertiesPanel.timerOptions}
        data={options}
        disabled={readOnly}
        value={field}
        onChange={(next) => {
          if (
            next === "timeDuration" ||
            next === "timeCycle" ||
            next === "timeDate"
          )
            change(next, timer?.[field]?.__$$text ?? "");
        }}
      />
      <MyoxusTextInput
        label={options.find((option) => option.value === field)?.label}
        value={timer?.[field]?.__$$text ?? ""}
        disabled={readOnly}
        onChange={(text) => change(field, text)}
      />
    </Stack>
  );
}
