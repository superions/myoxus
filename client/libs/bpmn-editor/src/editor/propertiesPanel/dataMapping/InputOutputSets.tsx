// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Group,
  Text,
  Button,
  IconButton,
  MultiSelect,
  MyoxusTextInput,
  Alert,
} from "@myoxus/ui-facade";
import { ArrowUpSmallIcon, ArrowDownSmallIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { useState } from "react";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  inputOutputOwner,
  inputOutputSpecification,
  createIoSet,
  setIoSetName,
  setIoSetReferences,
  deleteIoSet,
  moveIoSet,
  deleteEmptyIoSpecification,
} from "../../mutations/io-sets";
import {
  ioSetKeys,
  isEventIoOwner,
  type IoSet,
  type IoDirection,
  type IoSetField,
} from "../../mutations/io-context";
import { acceptsDataAssociation } from "../../mutations/data-association-context";

/** The controls edit actual set owners, not a flattened mapping-row projection.
 * Retained arrays keep evaluation order and their IDREF wrapper metadata. */
export function InputOutputSets({ ownerId }: { ownerId: string }) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    definitions = useBpmnEditorStore((state) => state.bpmn.model.definitions),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly),
    [error, setError] = useState<"in-use" | "invalid">();
  const owner = inputOutputOwner(definitions, ownerId),
    spec = inputOutputSpecification(owner),
    event = isEventIoOwner(owner);
  const command = (run: (model: typeof definitions) => void) => {
    setError(undefined);
    try {
      store.setState((state) => {
        if (!state.settings.isReadOnly) run(state.bpmn.model.definitions);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "BPMN_DEFINITION_IN_USE")
        setError("in-use");
      else if (
        error instanceof Error &&
        error.message === "BPMN_INVALID_IO_SET"
      )
        setError("invalid");
      else throw error;
    }
  };
  return (
    <AccordionItem value="io-sets">
      <AccordionControl>
        {t["com.myoxus.editor.bpmn.io-sets"]()}
      </AccordionControl>
      <AccordionPanel>
        <Stack>
          {error && (
            <Alert>
              {error === "in-use"
                ? t["com.myoxus.editor.bpmn.definition-in-use"]()
                : t["com.myoxus.editor.bpmn.invalid-io-set"]()}
            </Alert>
          )}
          {(["input", "output"] as const)
            .filter(
              (direction) => !event || acceptsDataAssociation(owner, direction),
            )
            .map((direction: IoDirection) => {
              const sets: IoSet[] =
                  direction === "input"
                    ? (spec?.inputSet ?? [])
                    : (spec?.outputSet ?? []),
                otherSets =
                  direction === "input" ? spec?.outputSet : spec?.inputSet,
                items =
                  direction === "input" ? spec?.dataInput : spec?.dataOutput,
                keys = ioSetKeys[direction];
              const choices = (items ?? [])
                  .filter((item) => item["@_id"])
                  .map((item) => ({
                    value: item["@_id"]!,
                    label: `${item["@_name"] || item["@_id"]} (${item["@_id"]})`,
                  })),
                counterparts = (otherSets ?? [])
                  .filter((set) => set["@_id"])
                  .map((set) => ({
                    value: set["@_id"]!,
                    label: `${set["@_name"] || set["@_id"]} (${set["@_id"]})`,
                  }));
              return (
                <Stack key={direction}>
                  <Text>
                    {direction === "input"
                      ? t["com.myoxus.editor.bpmn.input-sets"]()
                      : t["com.myoxus.editor.bpmn.output-sets"]()}
                  </Text>
                  <Accordion multiple>
                    {sets.map((set, position) => {
                      const identity = set["@_id"] ?? position,
                        values = (field: IoSetField) =>
                          set[keys[field]]?.map((ref) => ref.__$$text.trim()) ??
                          [],
                        change = (field: IoSetField, ids: string[]) =>
                          command((model) =>
                            setIoSetReferences(
                              model,
                              ownerId,
                              direction,
                              identity,
                              field,
                              ids,
                            ),
                          ),
                        members = new Set(values("members"));
                      return (
                        <AccordionItem key={identity} value={String(identity)}>
                          <AccordionControl>
                            {set["@_name"] ||
                              set["@_id"] ||
                              (direction === "input"
                                ? t["com.myoxus.editor.bpmn.input-sets"]()
                                : t["com.myoxus.editor.bpmn.output-sets"]())}
                          </AccordionControl>
                          <AccordionPanel>
                            <Stack>
                              <MyoxusTextInput
                                label={t["com.myoxus.common.name"]()}
                                value={set["@_name"] ?? ""}
                                disabled={readOnly}
                                onChange={(name) =>
                                  command((model) =>
                                    setIoSetName(
                                      model,
                                      ownerId,
                                      direction,
                                      identity,
                                      name,
                                    ),
                                  )
                                }
                              />
                              <MyoxusTextInput
                                label={t["com.myoxus.editor.bpmn.element-id"]()}
                                value={set["@_id"] ?? ""}
                                readOnly
                              />
                              <MultiSelect
                                label={
                                  direction === "input"
                                    ? t["com.myoxus.editor.bpmn.inputs"]()
                                    : t["com.myoxus.editor.bpmn.outputs"]()
                                }
                                data={choices}
                                value={values("members")}
                                disabled={readOnly}
                                onChange={(ids) => change("members", ids)}
                              />
                              <MultiSelect
                                label={
                                  direction === "input"
                                    ? t[
                                        "com.myoxus.editor.bpmn.optional-inputs"
                                      ]()
                                    : t[
                                        "com.myoxus.editor.bpmn.optional-outputs"
                                      ]()
                                }
                                data={choices.filter((choice) =>
                                  members.has(choice.value),
                                )}
                                value={values("optional")}
                                disabled={readOnly}
                                onChange={(ids) => change("optional", ids)}
                              />
                              <MultiSelect
                                label={
                                  direction === "input"
                                    ? t[
                                        "com.myoxus.editor.bpmn.executing-inputs"
                                      ]()
                                    : t[
                                        "com.myoxus.editor.bpmn.executing-outputs"
                                      ]()
                                }
                                data={choices.filter((choice) =>
                                  members.has(choice.value),
                                )}
                                value={values("executing")}
                                disabled={readOnly}
                                onChange={(ids) => change("executing", ids)}
                              />
                              {!event && (
                                <MultiSelect
                                  label={
                                    direction === "input"
                                      ? t[
                                          "com.myoxus.editor.bpmn.output-sets"
                                        ]()
                                      : t["com.myoxus.editor.bpmn.input-sets"]()
                                  }
                                  data={counterparts}
                                  value={values("counterparts")}
                                  disabled={readOnly}
                                  onChange={(ids) =>
                                    change("counterparts", ids)
                                  }
                                />
                              )}
                              <Group>
                                {!event && (
                                  <>
                                    <IconButton
                                      tooltip={t[
                                        "com.myoxus.keyboardShortcuts.moveUp"
                                      ]()}
                                      disabled={readOnly || position === 0}
                                      onClick={() =>
                                        command((model) =>
                                          moveIoSet(
                                            model,
                                            ownerId,
                                            direction,
                                            identity,
                                            -1,
                                          ),
                                        )
                                      }
                                    >
                                      <ArrowUpSmallIcon />
                                    </IconButton>
                                    <IconButton
                                      tooltip={t[
                                        "com.myoxus.keyboardShortcuts.moveDown"
                                      ]()}
                                      disabled={
                                        readOnly || position === sets.length - 1
                                      }
                                      onClick={() =>
                                        command((model) =>
                                          moveIoSet(
                                            model,
                                            ownerId,
                                            direction,
                                            identity,
                                            1,
                                          ),
                                        )
                                      }
                                    >
                                      <ArrowDownSmallIcon />
                                    </IconButton>
                                  </>
                                )}
                                <Button
                                  disabled={readOnly}
                                  onClick={() =>
                                    command((model) =>
                                      deleteIoSet(
                                        model,
                                        ownerId,
                                        direction,
                                        identity,
                                      ),
                                    )
                                  }
                                >
                                  {t.Delete()}
                                </Button>
                              </Group>
                            </Stack>
                          </AccordionPanel>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                  <Button
                    disabled={readOnly || (event && sets.length > 0)}
                    onClick={() =>
                      command((model) => createIoSet(model, ownerId, direction))
                    }
                  >
                    {direction === "input"
                      ? t["com.myoxus.editor.bpmn.add-input-set"]()
                      : t["com.myoxus.editor.bpmn.add-output-set"]()}
                  </Button>
                </Stack>
              );
            })}
          {!event && spec && (
            <Button
              disabled={
                readOnly ||
                !!spec.dataInput?.length ||
                !!spec.dataOutput?.length
              }
              onClick={() =>
                command((model) => deleteEmptyIoSpecification(model, ownerId))
              }
            >
              {t["com.myoxus.editor.bpmn.remove-empty-io"]()}
            </Button>
          )}
        </Stack>
      </AccordionPanel>
    </AccordionItem>
  );
}
