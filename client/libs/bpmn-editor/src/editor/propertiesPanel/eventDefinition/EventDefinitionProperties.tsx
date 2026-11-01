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
  Button,
  Checkbox,
  Group,
  IconButton,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { DeleteIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { bpmnConstructState } from "../../../source-profile";
import type { Normalized } from "../../normalization/normalize";
import { MessageSelector } from "../messageSelector/MessageSelector";
import { ErrorSelector } from "../errorSelector/ErrorSelector";
import { EscalationSelector } from "../escalationSelector/EscalationSelector";
import { SignalSelector } from "../signalSelector/SignalSelector";
import { TimerOptions } from "../timerOptions/TimerOptions";
import { ActivitySelector } from "../activitySelector/ActivitySelector";
import { ConditionalEventSelector } from "../conditionalExpression/ConditionalExpressionSelector";
import { LinkInput } from "../linkInput/LinkInput";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import {
  findEventById,
  eventDefinitions,
  eventDefinitionTarget,
  eventDefinitionFor,
  eventAllowedKinds,
  editEventDefinition,
  setEventDefinitions,
  shareEventDefinition,
  type BpmnEvent,
} from "../../mutations/event";

export type Event = Normalized<BpmnEvent>;
export function EventDefinitionProperties({ event }: { event: Event }) {
  const store = useBpmnEditorStoreApi();
  const t = useI18n();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const { onCommandError } = useBpmnEditor();
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const current = findEventById(definitions, event["@_id"])?.event;
  if (!current) return null;
  const triggers = eventDefinitions(definitions, current);
  const kinds = [
    {
      value: "messageEventDefinition",
      label: t["com.myoxus.editor.bpmn.message"](),
    },
    {
      value: "timerEventDefinition",
      label: t["com.myoxus.editor.bpmn.timer"](),
    },
    {
      value: "conditionalEventDefinition",
      label: t["com.myoxus.editor.bpmn.conditional-expression"](),
    },
    {
      value: "signalEventDefinition",
      label: t["com.myoxus.editor.bpmn.signal"](),
    },
    {
      value: "escalationEventDefinition",
      label: t["com.myoxus.editor.bpmn.escalation"](),
    },
    {
      value: "errorEventDefinition",
      label: t["com.myoxus.editor.shape.bpmn.error-event"](),
    },
    {
      value: "cancelEventDefinition",
      label: t["com.myoxus.editor.bpmn.cancel-event"](),
    },
    {
      value: "compensateEventDefinition",
      label: t["com.myoxus.editor.bpmn.compensation"](),
    },
    {
      value: "linkEventDefinition",
      label: t["com.myoxus.editor.keyboard.link"](),
    },
    {
      value: "terminateEventDefinition",
      label: t["com.myoxus.editor.shape.bpmn.terminate-event"](),
    },
  ] as const;
  const allowed = eventAllowedKinds(definitions, current["@_id"]);
  const choices = kinds.filter(
    (choice) =>
      allowed.includes(choice.value) &&
      bpmnConstructState(choice.value) === "editable",
  );
  const shared =
    definitions.rootElement?.filter((root) =>
      choices.some((choice) => choice.value === root.__$$element),
    ) ?? [];
  const edit = (
    index: number,
    choice?: Parameters<typeof editEventDefinition>[3],
  ) => {
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          editEventDefinition(
            state.bpmn.model.definitions,
            current["@_id"],
            index,
            choice,
          );
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  return (
    <Stack>
      {triggers.length > 1 &&
        (current.__$$element === "startEvent" ||
          current.__$$element === "boundaryEvent" ||
          current.__$$element === "intermediateCatchEvent") && (
          <Checkbox
            label={t["com.myoxus.editor.bpmn.parallel-multiple"]()}
            checked={current["@_parallelMultiple"] ?? false}
            disabled={readOnly}
            onChange={(_event, checked) => {
              try {
                store.setState((state) => {
                  if (!state.settings.isReadOnly)
                    setEventDefinitions(
                      state.bpmn.model.definitions,
                      current["@_id"],
                      triggers.map((definition) => definition.__$$element),
                      checked,
                    );
                });
              } catch (error) {
                onCommandError(error);
              }
            }}
          />
        )}
      {triggers.map((definition, index) => {
        const target = eventDefinitionTarget(definition, index);
        const props = { eventId: current["@_id"], target };
        const changeReference = (value: string | undefined) =>
          store.setState((state) => {
            if (state.settings.isReadOnly) return;
            const definition = eventDefinitionFor(
              state.bpmn.model.definitions,
              current["@_id"],
              target,
            );
            if (!definition) return;
            const references = indexBpmnIds(state.bpmn.model.definitions);
            switch (definition.__$$element) {
              case "messageEventDefinition":
                definition["@_messageRef"] = references.referenceFor(
                  definition,
                  value,
                  definition["@_messageRef"],
                );
                break;
              case "signalEventDefinition":
                definition["@_signalRef"] = references.referenceFor(
                  definition,
                  value,
                  definition["@_signalRef"],
                );
                break;
              case "errorEventDefinition":
                definition["@_errorRef"] = references.referenceFor(
                  definition,
                  value,
                  definition["@_errorRef"],
                );
                break;
              case "escalationEventDefinition":
                definition["@_escalationRef"] = references.referenceFor(
                  definition,
                  value,
                  definition["@_escalationRef"],
                );
                break;
            }
          });
        const key = `${definition["@_id"] ?? definition.__$$element}-${index}`;
        const fields = (() => {
          switch (definition.__$$element) {
            case "messageEventDefinition":
              return (
                <MessageSelector
                  referenceOwner={definition}
                  value={definition["@_messageRef"]}
                  onChange={changeReference}
                />
              );
            case "signalEventDefinition":
              return (
                <SignalSelector
                  referenceOwner={definition}
                  value={definition["@_signalRef"]}
                  onChange={changeReference}
                />
              );
            case "errorEventDefinition":
              return (
                <ErrorSelector
                  referenceOwner={definition}
                  value={definition["@_errorRef"]}
                  onChange={changeReference}
                />
              );
            case "escalationEventDefinition":
              return (
                <EscalationSelector
                  referenceOwner={definition}
                  value={definition["@_escalationRef"]}
                  onChange={changeReference}
                />
              );
            case "timerEventDefinition":
              return <TimerOptions key={key} {...props} />;
            case "conditionalEventDefinition":
              return <ConditionalEventSelector key={key} {...props} />;
            case "linkEventDefinition":
              return <LinkInput key={key} {...props} />;
            case "compensateEventDefinition":
              return current.__$$element === "intermediateThrowEvent" ||
                current.__$$element === "endEvent" ? (
                <ActivitySelector key={key} {...props} />
              ) : null;
            default:
              return null;
          }
        })();
        const reference =
          index >= (current.eventDefinition?.length ?? 0)
            ? definition["@_id"]
            : "@inline";
        return (
          <Stack key={key}>
            {!!choices.length && (
              <Group>
                <Select
                  label={t["com.myoxus.editor.bpmn.event-trigger"]()}
                  data={choices}
                  value={definition.__$$element}
                  disabled={readOnly}
                  onChange={(value) => {
                    const choice = choices.find(
                      (choice) => choice.value === value,
                    );
                    if (choice) edit(index, { kind: choice.value });
                  }}
                />
                <IconButton
                  icon={<DeleteIcon />}
                  variant="plain"
                  tooltip={t["Delete"]()}
                  disabled={readOnly}
                  onClick={() => edit(index)}
                />
              </Group>
            )}
            {!!shared.length && (
              <Select
                label={t["com.myoxus.editor.bpmn.definition-reference"]()}
                value={reference}
                disabled={readOnly}
                data={[
                  {
                    value: "@inline",
                    label: t["com.myoxus.editor.bpmn.inline-definition"](),
                  },
                  ...shared.map((root) => ({
                    value: root["@_id"]!,
                    label: root["@_id"]!,
                  })),
                ]}
                onChange={(value) => {
                  if (value)
                    edit(
                      index,
                      value === "@inline"
                        ? { kind: definition.__$$element }
                        : { referenceId: value },
                    );
                }}
              />
            )}
            {fields}
            {reference === "@inline" && !!choices.length && (
              <Button
                disabled={readOnly}
                onClick={() => {
                  try {
                    store.setState((state) => {
                      if (!state.settings.isReadOnly)
                        shareEventDefinition(
                          state.bpmn.model.definitions,
                          current["@_id"],
                          index,
                        );
                    });
                  } catch (error) {
                    onCommandError(error);
                  }
                }}
              >
                {t["com.myoxus.editor.bpmn.share-definition"]()}
              </Button>
            )}
          </Stack>
        );
      })}
      {!!choices.length && (
        <Button
          disabled={readOnly}
          onClick={() => edit(triggers.length, { kind: choices[0].value })}
        >
          {t["com.myoxus.editor.bpmn.add-trigger"]()}
        </Button>
      )}
    </Stack>
  );
}
