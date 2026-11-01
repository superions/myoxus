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
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../../store/StoreContext";
import { useBpmnEditor } from "../../../BpmnEditorContext";
import {
  allowedEventDefinitionKinds,
  findEventById,
  setEventDefinitions,
  type BpmnEvent,
  type EventDefinitionKind,
} from "../../../mutations/event";
import type { Normalized } from "../../../normalization/normalize";
import { indexBpmnIds } from "../../../idRandomizer/bpmn-id-randomizer";
import {
  EndEventIcon,
  EventDefinitionIcon,
  IntermediateCatchEventIcon,
  IntermediateThrowEventIcon,
  StartEventIcon,
} from "../NodeIcons";
import { bpmnConstructState } from "../../../../source-profile";

export type Event = Normalized<BpmnEvent>;
export function useEventNodeMorphingActions(event: Event) {
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const { onCommandError } = useBpmnEditor();
  const current = findEventById(definitions, event["@_id"]);
  if (!current) return [];
  const attached =
    current.event.__$$element === "boundaryEvent"
      ? indexBpmnIds(definitions).resolveReference(
          current.event,
          current.event["@_attachedToRef"],
        )
      : undefined;
  const allowed = allowedEventDefinitionKinds(
    current.event,
    current.owner,
    current.owner.flowElement?.some(
      (element) =>
        element["@_id"] === attached && element.__$$element === "transaction",
    ),
  );
  const filled =
    event.__$$element === "intermediateThrowEvent" ||
    event.__$$element === "endEvent";
  const morph = (kind?: EventDefinitionKind) => {
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          setEventDefinitions(
            state.bpmn.model.definitions,
            event["@_id"],
            kind ? [kind] : [],
          );
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  const choices = [
    {
      id: "messageEventDefinition",
      key: "2",
      title: t["com.myoxus.editor.bpmn.message"](),
    },
    {
      id: "timerEventDefinition",
      key: "3",
      title: t["com.myoxus.editor.shape.bpmn.timer-event"](),
    },
    {
      id: "errorEventDefinition",
      key: "4",
      title: t["com.myoxus.editor.shape.bpmn.error-event"](),
    },
    {
      id: "escalationEventDefinition",
      key: "5",
      title: t["com.myoxus.editor.bpmn.escalation"](),
    },
    {
      id: "compensateEventDefinition",
      key: "6",
      title: t["com.myoxus.editor.bpmn.compensation"](),
    },
    {
      id: "conditionalEventDefinition",
      key: "7",
      title: t["com.myoxus.editor.bpmn.conditional-expression"](),
    },
    {
      id: "linkEventDefinition",
      key: "8",
      title: t["com.myoxus.editor.keyboard.link"](),
    },
    {
      id: "signalEventDefinition",
      key: "9",
      title: t["com.myoxus.editor.bpmn.signal"](),
    },
    {
      id: "terminateEventDefinition",
      key: "0",
      title: t["com.myoxus.editor.shape.bpmn.terminate-event"](),
    },
    {
      id: "cancelEventDefinition",
      key: "c",
      title: t["com.myoxus.editor.bpmn.cancel-event"](),
    },
  ] as const;
  const noneAllowed =
    event.__$$element === "endEvent" ||
    event.__$$element === "intermediateThrowEvent" ||
    (event.__$$element === "startEvent" &&
      !(
        "@_triggeredByEvent" in current.owner &&
        current.owner["@_triggeredByEvent"]
      ));
  return [
    ...(noneAllowed
      ? [
          {
            id: "none",
            key: "1",
            title: t["com.myoxus.sidebar.common.none"](),
            action: () => morph(),
            icon:
              event.__$$element === "startEvent" ? (
                <StartEventIcon />
              ) : event.__$$element === "endEvent" ? (
                <EndEventIcon />
              ) : event.__$$element === "intermediateThrowEvent" ? (
                <IntermediateThrowEventIcon />
              ) : (
                <IntermediateCatchEventIcon />
              ),
          },
        ]
      : []),
    ...choices
      .filter(
        (choice) =>
          allowed.includes(choice.id) &&
          bpmnConstructState(choice.id) === "editable",
      )
      .map((choice) => ({
        ...choice,
        action: () => morph(choice.id),
        icon: (
          <EventDefinitionIcon
            stroke="var(--mantine-color-text)"
            fill="var(--mantine-color-body)"
            filled={filled}
            variant={choice.id}
          />
        ),
      })),
  ];
}
