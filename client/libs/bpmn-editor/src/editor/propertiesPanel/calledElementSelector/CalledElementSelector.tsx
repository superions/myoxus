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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { ResourceRoles } from "../resources/ResourceRoles";
import { InputOutputSets } from "../dataMapping/InputOutputSets";
import {
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Button,
  Checkbox,
  Group,
  Modal,
  MultiSelect,
  MyoxusTextInput,
  MyoxusTextarea,
  SearchCombobox,
  Select,
  Stack,
  Text,
  notify,
} from "@myoxus/ui-facade";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import type { Task } from "../../mutations/data-mapping";
import {
  addGlobalTaskData,
  deleteGlobalTaskData,
  createGlobalTask,
  deleteGlobalTask,
  isGlobalTask,
  renameGlobalTask,
  setCalledElement,
  validCalledElement,
  supportedInterfaceChoices,
  setSupportedInterfaces,
  type GlobalTask,
  type GlobalTaskKind,
} from "../../mutations/global-tasks";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
import { isXmlNCName } from "../../../xml-parser/q-names";
import { usePendingEdit } from "../../../xyflow/reactExt/PendingEdits";
import { useDefinitionChoice } from "../../typeaheadSelect/use-definition-choice";
import { useBpmnEditorI18n } from "../../i18n";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { visitFlowElementsAndArtifacts } from "../../mutations/element-visitor";

export type WithCalledElement =
  Extract<Task, { __$$element: "callActivity" }> | undefined;

export function CalledElementSelector({
  element: suppliedElement,
  onRequestFocus,
}: {
  element: WithCalledElement;
  onRequestFocus?: () => void;
}) {
  const t = useI18n();
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  let currentElement: WithCalledElement;
  const process = definitions.rootElement?.find(
    (root) => root.__$$element === "process",
  );
  if (process?.__$$element === "process")
    visitFlowElementsAndArtifacts(process, ({ element: current }) => {
      if (
        current.__$$element !== "callActivity" ||
        current["@_id"] !== suppliedElement?.["@_id"]
      )
        return true;
      currentElement = current;
      return false;
    });
  const element = currentElement;
  const references = indexBpmnIds(definitions);
  const kindTitles = {
    globalTask: t["com.myoxus.editor.bpmn.global-task"](),
    globalUserTask: t["com.myoxus.editor.bpmn.global-user-task"](),
    globalManualTask: t["com.myoxus.editor.bpmn.global-manual-task"](),
    globalScriptTask: t["com.myoxus.editor.bpmn.global-script-task"](),
    globalBusinessRuleTask:
      t["com.myoxus.editor.bpmn.global-business-rule-task"](),
  };
  const callableRoots =
    definitions.rootElement?.filter(
      (root) => root.__$$element === "process" || isGlobalTask(root),
    ) ?? [];
  const selectedId =
    element && references.resolveReference(element, element["@_calledElement"]);
  const selected = callableRoots.find(
    (root): root is GlobalTask =>
      isGlobalTask(root) && root["@_id"] === selectedId,
  );
  const { options: interfaceOptions, selected: selectedInterfaces } =
    supportedInterfaceChoices(definitions, selected);
  const sourceValue = element?.["@_calledElement"] ?? "";
  const elementId = element?.["@_id"];
  const definitionId = selected?.["@_id"] ?? "";
  const [draft, setDraft] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [deletionId, setDeletionId] = useState<string | undefined>();
  const deletionTarget = definitions.rootElement?.find(
    (root): root is GlobalTask =>
      isGlobalTask(root) && root["@_id"] === deletionId,
  );
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<GlobalTaskKind>("globalTask");
  const [idDraft, setIdDraft] = useState(selected?.["@_id"] ?? "");
  const createNameInput = useRef<HTMLInputElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const [definitionPanel, setDefinitionPanel] = useState<string | null>(
    "definition",
  );
  const [focusField, setFocusField] = useState<
    "reference" | "id" | undefined
  >();
  useEffect(() => setDraft(undefined), [elementId, sourceValue]);
  useEffect(() => setIdDraft(definitionId), [definitionId]);
  const valid =
    !!element && validCalledElement(definitions, element, draft ?? sourceValue);
  const validId =
    !!selected &&
    isXmlNCName(idDraft) &&
    (idDraft === selected["@_id"] || !references.getOriginalIds().has(idDraft));

  const choice = useDefinitionChoice({
    choices: callableRoots
      .filter((root) => !!root["@_id"])
      .map((root) => ({
        value: root["@_id"],
        label:
          root["@_name"] ||
          (isGlobalTask(root) ? kindTitles[root.__$$element] : root["@_id"]),
      })),
    selected: element?.["@_calledElement"],
    referenceOwner: element,
    disabled: readOnly || !element,
    label: i18n.propertiesPanel.calledElement,
    emptyLabel: i18n.propertiesPanel.noMatches,
    createLabel: t["com.myoxus.editor.bpmn.use-reference"](),
    createEvenWhenMatched: true,
    canCreate: (value) =>
      !!element && validCalledElement(definitions, element, value),
    create: (value) => value,
    onSelect: (value, _label, reason) => {
      if (!element) return;
      const renamedSelection =
        selected &&
        idDraft !== selected["@_id"] &&
        (reason === "created"
          ? value && references.resolveReference(element, value)
          : value) === selected["@_id"];
      if (!commitDefinitionId()) {
        requestFocus("id");
        return;
      }
      store.setState((state) => {
        if (!state.settings.isReadOnly)
          setCalledElement(
            state.bpmn.model.definitions,
            element["@_id"],
            value === undefined
              ? undefined
              : renamedSelection
                ? { kind: "internal", id: idDraft }
                : reason === "created"
                  ? { kind: "reference", qname: value }
                  : { kind: "internal", id: value },
          );
      });
      setDraft(undefined);
    },
  });
  const requestFocus = (field: "reference" | "id") => {
    onRequestFocus?.();
    if (field === "id") setDefinitionPanel("definition");
    setFocusField(field);
  };
  function commitDefinitionId() {
    if (!selected || idDraft === selected["@_id"]) return true;
    if (!validId || store.getState().settings.isReadOnly) return false;
    store.setState((state) => {
      if (!state.settings.isReadOnly)
        renameGlobalTask(
          state.bpmn.model.definitions,
          selected["@_id"],
          idDraft,
        );
    });
    return true;
  }
  useLayoutEffect(() => {
    if (!focusField) return;
    if (focusField === "id") idInput.current?.focus();
    else document.getElementById(choice.inputId!)?.focus();
    setFocusField(undefined);
  }, [choice.inputId, focusField]);
  // Search text is a real field draft, not a second declaration or debounce.
  // Keep it visible across dropdown close; Save must validate/commit it instead
  // of silently exporting the old reference. Explicit choice retains ID intent.
  usePendingEdit(draft !== undefined && draft !== sourceValue, {
    commit: () => {
      if (!valid || !element || store.getState().settings.isReadOnly)
        return false;
      store.setState((state) =>
        setCalledElement(state.bpmn.model.definitions, element["@_id"], {
          kind: "reference",
          qname: draft ?? sourceValue,
        }),
      );
      setDraft(undefined);
      choice.onClose?.();
      return true;
    },
    discard: () => {
      setDraft(undefined);
      choice.onClose?.();
    },
    focus: () => requestFocus("reference"),
  });
  usePendingEdit(createOpen, {
    commit: () => false,
    discard: () => setCreateOpen(false),
    focus: () => createNameInput.current?.focus(),
  });
  usePendingEdit(!!selected && idDraft !== selected["@_id"], {
    commit: commitDefinitionId,
    discard: () => setIdDraft(selected?.["@_id"] ?? ""),
    focus: () => requestFocus("id"),
  });
  const change = (
    action: (root: GlobalTask, modelDefinitions: typeof definitions) => void,
  ) =>
    store.setState((state) => {
      if (state.settings.isReadOnly || !selected) return;
      const root = state.bpmn.model.definitions.rootElement?.find(
        (root): root is GlobalTask =>
          isGlobalTask(root) && root["@_id"] === selected["@_id"],
      );
      if (root) action(root, state.bpmn.model.definitions);
    });
  const reportInUse = (action: () => void) => {
    try {
      action();
    } catch (error) {
      if (error instanceof Error && error.message === "BPMN_DEFINITION_IN_USE")
        notify.error(t["com.myoxus.editor.bpmn.definition-in-use"]());
      else if (
        error instanceof Error &&
        error.message === "BPMN_INVALID_CALLED_INTERFACE"
      )
        notify.error(t["com.myoxus.common.operation-failed"]());
      else throw error;
    }
  };
  return (
    <Stack>
      <SearchCombobox
        {...choice}
        data-testid="called-element-selector"
        value={draft ?? choice.value}
        options={choice.options.map((option) => {
          const root = callableRoots.find(
            (root) => root["@_id"] === option.value,
          );
          return root
            ? {
                ...option,
                meta: isGlobalTask(root)
                  ? kindTitles[root.__$$element]
                  : i18n.propertiesPanel.process,
                code: root["@_id"],
              }
            : option;
        })}
        state={
          draft !== undefined &&
          !valid &&
          !choice.options.some((option) =>
            callableRoots.some((root) => root["@_id"] === option.value),
          )
            ? {
                kind: "error",
                label: t["com.myoxus.editor.bpmn.invalid-called-element"](),
              }
            : choice.state
        }
        onInputChange={(value) => {
          setDraft(value);
          choice.onInputChange(value);
        }}
        onInputFocus={() => {
          if (!commitDefinitionId()) {
            requestFocus("id");
            return;
          }
          if (draft !== undefined) choice.onInputChange(draft);
          else choice.onInputFocus();
        }}
        onInputKeyDown={(event) => {
          if (event.key === "Escape") setDraft(undefined);
          choice.onInputKeyDown(event);
        }}
      />
      <Group>
        <Button
          disabled={readOnly || !element}
          onClick={() => {
            if (!commitDefinitionId()) {
              requestFocus("id");
              return;
            }
            setNewName("");
            setCreateOpen(true);
          }}
        >
          {t.Create()}
        </Button>
        {selected && (
          <Button
            disabled={readOnly}
            onClick={() => {
              if (!commitDefinitionId()) {
                requestFocus("id");
                return;
              }
              setDeletionId(idDraft);
            }}
          >
            {t.Delete()}
          </Button>
        )}
      </Group>
      {selected && (
        <Accordion
          keepMounted
          keepMountedMode="display-none"
          value={definitionPanel}
          onChange={(value) => {
            if (!Array.isArray(value)) setDefinitionPanel(value);
          }}
        >
          <AccordionItem value="definition">
            <AccordionControl>
              {selected["@_name"] || kindTitles[selected.__$$element]}
            </AccordionControl>
            <AccordionPanel>
              <Stack>
                <MyoxusTextInput
                  ref={idInput}
                  label={i18n.propertiesPanel.id}
                  value={idDraft}
                  error={!validId}
                  disabled={readOnly}
                  onChange={setIdDraft}
                />
                <MyoxusTextInput
                  label={t["com.myoxus.common.name"]()}
                  value={selected["@_name"] ?? ""}
                  disabled={readOnly}
                  onChange={(value) =>
                    change((root) => {
                      if (value) root["@_name"] = value;
                      else delete root["@_name"];
                    })
                  }
                />
                <MyoxusTextarea
                  label={i18n.propertiesPanel.documentation}
                  value={selected.documentation?.[0].__$$text ?? ""}
                  disabled={readOnly}
                  onChange={(value) =>
                    change((root) => {
                      if (!value && !root.documentation?.length) return;
                      root.documentation ??= [];
                      if (!root.documentation.length)
                        root.documentation.push({
                          "@_id": generateUuid(),
                          __$$text: "",
                        });
                      root.documentation[0].__$$text = value;
                    })
                  }
                />
                <MultiSelect
                  label={t["com.myoxus.editor.bpmn.supported-interfaces"]()}
                  data={interfaceOptions}
                  value={selectedInterfaces}
                  disabled={readOnly}
                  searchable
                  nothingFoundMessage={i18n.propertiesPanel.noMatches}
                  onChange={(values) =>
                    reportInUse(() =>
                      change((root, modelDefinitions) => {
                        setSupportedInterfaces(
                          modelDefinitions,
                          root["@_id"],
                          values,
                        );
                      }),
                    )
                  }
                />
                {(selected.__$$element === "globalUserTask" ||
                  selected.__$$element === "globalBusinessRuleTask") && (
                  <MyoxusTextInput
                    label={i18n.singleNodeProperties.implementation}
                    placeholder="##unspecified"
                    value={selected["@_implementation"] ?? ""}
                    disabled={readOnly}
                    onChange={(value) =>
                      change((root) => {
                        if (
                          root.__$$element !== "globalUserTask" &&
                          root.__$$element !== "globalBusinessRuleTask"
                        )
                          return;
                        if (value) root["@_implementation"] = value;
                        else delete root["@_implementation"];
                      })
                    }
                  />
                )}
                {selected.__$$element === "globalScriptTask" && (
                  <>
                    <MyoxusTextInput
                      label={t["com.myoxus.editor.bpmn.script-language"]()}
                      value={selected["@_scriptLanguage"] ?? ""}
                      disabled={readOnly}
                      onChange={(value) =>
                        change((root) => {
                          if (root.__$$element !== "globalScriptTask") return;
                          if (value) root["@_scriptLanguage"] = value;
                          else delete root["@_scriptLanguage"];
                        })
                      }
                    />
                    <MyoxusTextarea
                      label={i18n.singleNodeProperties.script}
                      value={selected.script?.__$$text ?? ""}
                      disabled={readOnly}
                      onChange={(value) =>
                        change((root) => {
                          if (root.__$$element !== "globalScriptTask") return;
                          root.script ??= { __$$text: "" };
                          root.script.__$$text = value;
                        })
                      }
                    />
                  </>
                )}
                <Accordion>
                  <AccordionItem value="io">
                    <AccordionControl>
                      {i18n.dataMapping.title}
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        {(["input", "output"] as const).map((direction) => (
                          <Stack key={direction}>
                            <Text>
                              {direction === "input"
                                ? i18n.dataMapping.inputs
                                : i18n.dataMapping.outputs}
                            </Text>
                            {(direction === "input"
                              ? selected.ioSpecification?.dataInput
                              : selected.ioSpecification?.dataOutput
                            )?.map((data, dataIndex) => (
                              <Stack key={data["@_id"] ?? dataIndex}>
                                <MyoxusTextInput
                                  label={i18n.dataMapping.name}
                                  value={data["@_name"] ?? ""}
                                  disabled={readOnly}
                                  onChange={(value) =>
                                    change((root) => {
                                      const item = (
                                        direction === "input"
                                          ? root.ioSpecification?.dataInput
                                          : root.ioSpecification?.dataOutput
                                      )?.[dataIndex];
                                      if (item) {
                                        if (value) item["@_name"] = value;
                                        else delete item["@_name"];
                                      }
                                    })
                                  }
                                />
                                <ItemDefinitionRefSelector
                                  value={data["@_itemSubjectRef"]}
                                  referenceOwner={data}
                                  onChange={(id) =>
                                    change((root, modelDefinitions) => {
                                      const item = (
                                        direction === "input"
                                          ? root.ioSpecification?.dataInput
                                          : root.ioSpecification?.dataOutput
                                      )?.[dataIndex];
                                      if (!item) return;
                                      if (id)
                                        item["@_itemSubjectRef"] = indexBpmnIds(
                                          modelDefinitions,
                                        ).referenceFor(
                                          item,
                                          id,
                                          item["@_itemSubjectRef"],
                                        );
                                      else delete item["@_itemSubjectRef"];
                                    })
                                  }
                                />
                                <Checkbox
                                  label={t[
                                    "com.myoxus.editor.bpmn.is-collection"
                                  ]()}
                                  checked={data["@_isCollection"] ?? false}
                                  disabled={readOnly}
                                  onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    change((root) => {
                                      const item = (
                                        direction === "input"
                                          ? root.ioSpecification?.dataInput
                                          : root.ioSpecification?.dataOutput
                                      )?.[dataIndex];
                                      if (item)
                                        item["@_isCollection"] = checked;
                                    });
                                  }}
                                />
                                <Button
                                  disabled={readOnly}
                                  onClick={() =>
                                    reportInUse(() =>
                                      store.setState((state) => {
                                        if (!state.settings.isReadOnly)
                                          deleteGlobalTaskData(
                                            state.bpmn.model.definitions,
                                            selected["@_id"],
                                            direction,
                                            dataIndex,
                                          );
                                      }),
                                    )
                                  }
                                >
                                  {t.Delete()}
                                </Button>
                              </Stack>
                            ))}
                            <Button
                              disabled={readOnly}
                              onClick={() =>
                                store.setState((state) => {
                                  if (!state.settings.isReadOnly)
                                    addGlobalTaskData(
                                      state.bpmn.model.definitions,
                                      selected["@_id"],
                                      direction,
                                    );
                                })
                              }
                            >
                              {i18n.dataMapping.addDataMapping(direction)}
                            </Button>
                          </Stack>
                        ))}
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                  <ResourceRoles ownerId={selected["@_id"]} />
                  <InputOutputSets ownerId={selected["@_id"]} />
                  {selected.__$$element === "globalUserTask" && (
                    <AccordionItem value="rendering">
                      <AccordionControl>
                        {t["com.myoxus.editor.bpmn.rendering"]()}
                      </AccordionControl>
                      <AccordionPanel>
                        <Stack>
                          {selected.rendering?.map((rendering, index) => (
                            <Stack key={rendering["@_id"] ?? index}>
                              <MyoxusTextarea
                                label={i18n.propertiesPanel.documentation}
                                value={
                                  rendering.documentation?.[0].__$$text ?? ""
                                }
                                disabled={readOnly}
                                onChange={(value) =>
                                  change((root) => {
                                    if (root.__$$element !== "globalUserTask")
                                      return;
                                    const owner = root.rendering![index];
                                    owner.documentation ??= [
                                      { "@_id": generateUuid(), __$$text: "" },
                                    ];
                                    if (!owner.documentation.length)
                                      owner.documentation.push({
                                        "@_id": generateUuid(),
                                        __$$text: "",
                                      });
                                    owner.documentation[0].__$$text = value;
                                  })
                                }
                              />
                            </Stack>
                          ))}
                          <Button
                            disabled={readOnly}
                            onClick={() =>
                              change((root) => {
                                if (root.__$$element === "globalUserTask")
                                  (root.rendering ??= []).push({
                                    "@_id": generateUuid(),
                                  });
                              })
                            }
                          >
                            {t.Create()}
                          </Button>
                        </Stack>
                      </AccordionPanel>
                    </AccordionItem>
                  )}
                </Accordion>
              </Stack>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t["com.myoxus.editor.bpmn.create-global-task"]()}
      >
        <Stack>
          <Select
            label={t["com.myoxus.common.type"]()}
            data={Object.entries(kindTitles).map(([value, label]) => ({
              value,
              label,
            }))}
            value={newKind}
            disabled={readOnly}
            onChange={(value) => {
              if (Object.hasOwn(kindTitles, value))
                setNewKind(value as GlobalTaskKind);
            }}
          />
          <MyoxusTextInput
            ref={createNameInput}
            label={t["com.myoxus.common.name"]()}
            value={newName}
            disabled={readOnly}
            onChange={setNewName}
          />
          <Group>
            <Button onClick={() => setCreateOpen(false)}>{t.Cancel()}</Button>
            <Button
              disabled={readOnly || !element}
              onClick={() => {
                if (!element || store.getState().settings.isReadOnly) return;
                store.setState((state) => {
                  const root = createGlobalTask(
                    state.bpmn.model.definitions,
                    newKind,
                    newName,
                  );
                  setCalledElement(
                    state.bpmn.model.definitions,
                    element["@_id"],
                    { kind: "internal", id: root["@_id"] },
                  );
                });
                setDraft(undefined);
                setCreateOpen(false);
              }}
            >
              {t.Create()}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        open={!!deletionTarget}
        onOpenChange={(open) => {
          if (!open) setDeletionId(undefined);
        }}
        title={t.Delete()}
      >
        <Stack>
          <Text>
            {t["com.myoxus.editor.bpmn.delete-global-task-confirmation"]({
              name:
                deletionTarget?.["@_name"] ||
                (deletionTarget ? kindTitles[deletionTarget.__$$element] : ""),
            })}
          </Text>
          <Group>
            <Button onClick={() => setDeletionId(undefined)}>
              {t.Cancel()}
            </Button>
            <Button
              disabled={readOnly}
              onClick={() => {
                if (!deletionTarget || store.getState().settings.isReadOnly)
                  return;
                try {
                  store.setState((state) => {
                    if (!state.settings.isReadOnly)
                      deleteGlobalTask(
                        state.bpmn.model.definitions,
                        deletionTarget["@_id"],
                        { kind: "clear" },
                      );
                  });
                } catch (error) {
                  if (
                    error instanceof Error &&
                    error.message === "BPMN_DEFINITION_IN_USE"
                  ) {
                    notify.error(
                      t["com.myoxus.editor.bpmn.definition-in-use"](),
                    );
                    return;
                  }
                  throw error;
                }
                setDraft(undefined);
                setDeletionId(undefined);
              }}
            >
              {t.Delete()}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
