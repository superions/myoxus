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
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Button,
  Checkbox,
  MyoxusNumberInput,
  MyoxusTextInput,
  MyoxusTextarea,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { activityById, type Activity } from "../../mutations/activity";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { useBpmnEditorI18n } from "../../i18n";
export type WithMultiInstanceProperties = Activity;

export function MultiInstanceProperties({ element }: { element: Activity }) {
  const t = useI18n();
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const activity = activityById(definitions, element["@_id"]);
  const loop = activity.loopCharacteristics;
  const references = indexBpmnIds(definitions);
  type Loop = NonNullable<Activity["loopCharacteristics"]>;
  const change = (
    action: (loop: Loop, modelDefinitions: typeof definitions) => void,
  ) =>
    store.setState((state) => {
      if (state.settings.isReadOnly) return;
      const owner = activityById(state.bpmn.model.definitions, element["@_id"]);
      if (owner.loopCharacteristics)
        action(owner.loopCharacteristics, state.bpmn.model.definitions);
    });
  if (!loop) return null;
  if (loop.__$$element === "standardLoopCharacteristics")
    return (
      <Stack>
        <Checkbox
          label={t["com.myoxus.editor.bpmn.test-before"]()}
          checked={loop["@_testBefore"] ?? false}
          disabled={readOnly}
          onChange={(event) => {
            const value = event.currentTarget.checked;
            change((loop) => {
              if (loop.__$$element === "standardLoopCharacteristics")
                loop["@_testBefore"] = value;
            });
          }}
        />
        <MyoxusNumberInput
          label={t["com.myoxus.editor.bpmn.loop-maximum"]()}
          value={loop["@_loopMaximum"] ?? ""}
          min={0}
          allowDecimal={false}
          disabled={readOnly}
          onChange={(value) =>
            change((loop) => {
              if (loop.__$$element !== "standardLoopCharacteristics") return;
              if (
                typeof value === "number" &&
                Number.isSafeInteger(value) &&
                value >= 0
              )
                loop["@_loopMaximum"] = value;
              else if (value === "") delete loop["@_loopMaximum"];
            })
          }
        />
        <MyoxusTextarea
          label={t["com.myoxus.editor.bpmn.loop-condition"]()}
          value={loop.loopCondition?.__$$text ?? ""}
          disabled={readOnly}
          onChange={(value) =>
            change((loop) => {
              if (loop.__$$element !== "standardLoopCharacteristics") return;
              loop.loopCondition ??= { "@_id": generateUuid(), __$$text: "" };
              loop.loopCondition.__$$text = value;
            })
          }
        />
      </Stack>
    );
  if (loop.__$$element !== "multiInstanceLoopCharacteristics") return null;
  const ioInputs = activity.ioSpecification?.dataInput ?? [];
  const ioOutputs = activity.ioSpecification?.dataOutput ?? [];
  return (
    <Stack>
      <MyoxusTextarea
        label={t["com.myoxus.editor.bpmn.loop-cardinality"]()}
        value={loop.loopCardinality?.__$$text ?? ""}
        disabled={readOnly}
        onChange={(value) =>
          change((loop) => {
            if (loop.__$$element !== "multiInstanceLoopCharacteristics") return;
            loop.loopCardinality ??= { "@_id": generateUuid(), __$$text: "" };
            loop.loopCardinality.__$$text = value;
          })
        }
      />
      <MyoxusTextarea
        label={i18n.propertiesPanel.completionCondition}
        value={loop.completionCondition?.__$$text ?? ""}
        disabled={readOnly}
        onChange={(value) =>
          change((loop) => {
            if (loop.__$$element !== "multiInstanceLoopCharacteristics") return;
            loop.completionCondition ??= {
              "@_id": generateUuid(),
              __$$text: "",
            };
            loop.completionCondition.__$$text = value;
          })
        }
      />
      {(["input", "output"] as const).map((direction) => {
        const ref =
          direction === "input"
            ? loop.loopDataInputRef
            : loop.loopDataOutputRef;
        const item =
          direction === "input" ? loop.inputDataItem : loop.outputDataItem;
        const targetId = references.resolveReference(
          ref ?? loop,
          ref?.__$$text,
        );
        const data = (direction === "input" ? ioInputs : ioOutputs).map(
          (item) => ({
            value: `internal:${item["@_id"]}`,
            label: item["@_name"] || item["@_id"],
          }),
        );
        if (
          ref &&
          !data.some((option) => option.value === `internal:${targetId}`)
        )
          data.push({
            value: `reference:${ref.__$$text}`,
            label: ref.__$$text,
          });
        const current = ref
          ? data.some((option) => option.value === `internal:${targetId}`)
            ? `internal:${targetId}`
            : `reference:${ref.__$$text}`
          : null;
        return (
          <Accordion key={direction}>
            <AccordionItem value="data">
              <AccordionControl>
                {direction === "input"
                  ? i18n.propertiesPanel.collectionInput
                  : i18n.propertiesPanel.collectionOutput}
              </AccordionControl>
              <AccordionPanel>
                <Stack>
                  <Select
                    label={
                      direction === "input"
                        ? i18n.propertiesPanel.collectionInput
                        : i18n.propertiesPanel.collectionOutput
                    }
                    data={data}
                    value={current}
                    clearable
                    clearButtonProps={{
                      "aria-label": t["com.myoxus.common.clear-selection"](),
                    }}
                    disabled={readOnly}
                    onClear={() =>
                      change((loop) => {
                        if (
                          loop.__$$element !==
                          "multiInstanceLoopCharacteristics"
                        )
                          return;
                        if (direction === "input") delete loop.loopDataInputRef;
                        else delete loop.loopDataOutputRef;
                      })
                    }
                    onChange={(value) =>
                      change((loop, modelDefinitions) => {
                        if (
                          loop.__$$element !==
                            "multiInstanceLoopCharacteristics" ||
                          !value.startsWith("internal:")
                        )
                          return;
                        const key =
                          direction === "input"
                            ? "loopDataInputRef"
                            : "loopDataOutputRef";
                        const encoded = indexBpmnIds(
                          modelDefinitions,
                        ).referenceFor(
                          loop[key] ?? loop,
                          value.slice("internal:".length),
                          loop[key]?.__$$text,
                        )!;
                        loop[key] ??= { __$$text: "" };
                        loop[key].__$$text = encoded;
                      })
                    }
                  />
                  <MyoxusTextInput
                    label={
                      direction === "input"
                        ? i18n.propertiesPanel.dataInput
                        : i18n.propertiesPanel.dataOutput
                    }
                    value={item?.["@_name"] ?? ""}
                    disabled={readOnly}
                    onChange={(value) =>
                      change((loop) => {
                        if (
                          loop.__$$element !==
                          "multiInstanceLoopCharacteristics"
                        )
                          return;
                        const owner = (loop[
                          direction === "input"
                            ? "inputDataItem"
                            : "outputDataItem"
                        ] ??= { "@_id": generateUuid() });
                        owner["@_name"] = value;
                      })
                    }
                  />
                  <ItemDefinitionRefSelector
                    value={item?.["@_itemSubjectRef"]}
                    referenceOwner={item ?? loop}
                    onChange={(id) =>
                      change((loop, modelDefinitions) => {
                        if (
                          loop.__$$element !==
                          "multiInstanceLoopCharacteristics"
                        )
                          return;
                        const owner = (loop[
                          direction === "input"
                            ? "inputDataItem"
                            : "outputDataItem"
                        ] ??= { "@_id": generateUuid() });
                        if (id)
                          owner["@_itemSubjectRef"] = indexBpmnIds(
                            modelDefinitions,
                          ).referenceFor(owner, id, owner["@_itemSubjectRef"]);
                        else delete owner["@_itemSubjectRef"];
                      })
                    }
                  />
                </Stack>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        );
      })}
      <Select
        label={t["com.myoxus.editor.bpmn.loop-behavior"]()}
        value={loop["@_behavior"] ?? "All"}
        disabled={readOnly}
        data={[
          { value: "All", label: t["com.myoxus.editor.bpmn.behavior-all"]() },
          { value: "One", label: t["com.myoxus.editor.bpmn.behavior-one"]() },
          { value: "None", label: t["com.myoxus.editor.bpmn.behavior-none"]() },
          {
            value: "Complex",
            label: t["com.myoxus.editor.bpmn.behavior-complex"](),
          },
        ]}
        onChange={(value) =>
          change((loop) => {
            if (
              loop.__$$element === "multiInstanceLoopCharacteristics" &&
              (value === "All" ||
                value === "One" ||
                value === "None" ||
                value === "Complex")
            )
              loop["@_behavior"] = value;
          })
        }
      />
      {(["@_oneBehaviorEventRef", "@_noneBehaviorEventRef"] as const).map(
        (field) => {
          const id = references.resolveReference(loop, loop[field]);
          const data = (definitions.rootElement ?? [])
            .filter((root) => root.__$$element.endsWith("EventDefinition"))
            .map((root) => ({
              value: `internal:${root["@_id"]}`,
              label: root["@_id"],
            }));
          if (
            loop[field] &&
            !data.some((option) => option.value === `internal:${id}`)
          )
            data.push({
              value: `reference:${loop[field]}`,
              label: loop[field]!,
            });
          const value = loop[field]
            ? data.some((option) => option.value === `internal:${id}`)
              ? `internal:${id}`
              : `reference:${loop[field]}`
            : null;
          return (
            <Select
              key={field}
              label={
                field === "@_oneBehaviorEventRef"
                  ? t["com.myoxus.editor.bpmn.one-behavior-event"]()
                  : t["com.myoxus.editor.bpmn.none-behavior-event"]()
              }
              data={data}
              value={value}
              disabled={readOnly}
              clearable
              clearButtonProps={{
                "aria-label": t["com.myoxus.common.clear-selection"](),
              }}
              onClear={() =>
                change((loop) => {
                  if (loop.__$$element === "multiInstanceLoopCharacteristics")
                    delete loop[field];
                })
              }
              onChange={(value) =>
                change((loop, modelDefinitions) => {
                  if (
                    loop.__$$element !== "multiInstanceLoopCharacteristics" ||
                    !value.startsWith("internal:")
                  )
                    return;
                  loop[field] = indexBpmnIds(modelDefinitions).referenceFor(
                    loop,
                    value.slice("internal:".length),
                    loop[field],
                  );
                })
              }
            />
          );
        },
      )}
      <Accordion>
        <AccordionItem value="complex">
          <AccordionControl>
            {t["com.myoxus.editor.bpmn.behavior-complex"]()}
          </AccordionControl>
          <AccordionPanel>
            <Stack>
              {loop.complexBehaviorDefinition?.map((behavior, index) => (
                <Stack key={behavior["@_id"] ?? index}>
                  <MyoxusTextarea
                    label={i18n.propertiesPanel.conditionalExpression}
                    value={behavior.condition.__$$text ?? ""}
                    disabled={readOnly}
                    onChange={(value) =>
                      change((loop) => {
                        if (
                          loop.__$$element ===
                          "multiInstanceLoopCharacteristics"
                        )
                          loop.complexBehaviorDefinition![
                            index
                          ].condition.__$$text = value;
                      })
                    }
                  />
                  {/* This event belongs to loop semantics, never flowElement/DI. Editing
                its name retains standard event definitions and all I/O metadata. */}
                  <MyoxusTextInput
                    label={t["com.myoxus.editor.bpmn.implicit-event-name"]()}
                    value={behavior.event?.["@_name"] ?? ""}
                    disabled={readOnly}
                    onChange={(value) =>
                      change((loop) => {
                        if (
                          loop.__$$element !==
                          "multiInstanceLoopCharacteristics"
                        )
                          return;
                        const owner = loop.complexBehaviorDefinition![index];
                        owner.event ??= { "@_id": generateUuid() };
                        owner.event["@_name"] = value;
                      })
                    }
                  />
                </Stack>
              ))}
              <Button
                disabled={readOnly}
                onClick={() =>
                  change((loop) => {
                    if (loop.__$$element === "multiInstanceLoopCharacteristics")
                      (loop.complexBehaviorDefinition ??= []).push({
                        "@_id": generateUuid(),
                        condition: { "@_id": generateUuid(), __$$text: "" },
                        event: { "@_id": generateUuid() },
                      });
                  })
                }
              >
                {t.Create()}
              </Button>
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Stack>
  );
}
