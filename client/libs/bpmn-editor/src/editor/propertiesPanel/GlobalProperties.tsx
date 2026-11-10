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
  AccordionControl,
  AccordionItem,
  AccordionPanel,
  Checkbox,
  MyoxusTextInput,
  MyoxusTextarea,
  Select,
  MultiSelect,
  Stack,
  Button,
  Group,
  Modal,
  Text,
  notify,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { addOrGetProcessAndDiagramElements } from "../mutations/addOrGetProcessAndDiagramElements";
import {
  indexBpmnIds,
  changeBpmnTargetNamespace,
  changeBpmnDefinitionsId,
} from "../idRandomizer/bpmn-id-randomizer";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { useBpmnEditorI18n } from "../i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { usePendingEdit } from "../../xyflow/reactExt/PendingEdits";
import { resolveBpmnProcessOwner } from "../../process-source";
import { isXmlNCName, isBindableXmlNamespace } from "../../xml-parser/q-names";
import type { State } from "../store/Store";
import { ResourceRoles } from "./resources/ResourceRoles";
import { InputOutputSets } from "./dataMapping/InputOutputSets";
import {
  hasNonImmediateFlow,
  setProcessExecutable,
} from "../mutations/connection";
import {
  supportedInterfaceChoices,
  setSupportedInterfaces,
} from "../mutations/global-tasks";
export function GlobalProperties() {
  const t = useI18n();
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const furtherOpen = useBpmnEditorStore(
    (s) => s.propertiesPanel.isFurtherOpen,
  );
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const { process } = resolveBpmnProcessOwner(definitions);
  const processId = process["@_id"];
  const hasNonImmediate = hasNonImmediateFlow(definitions);
  const interfaces = supportedInterfaceChoices(definitions, process);
  const definitionsId = definitions["@_id"] ?? "";
  const namespace = definitions["@_targetNamespace"];
  const [idDraft, setIdDraft] = useState(processId);
  const [definitionsIdDraft, setDefinitionsIdDraft] = useState(definitionsId);
  const [namespaceDraft, setNamespaceDraft] = useState(namespace);
  const [panel, setPanel] = useState<string | null>("process");
  const [confirmation, setConfirmation] = useState<{
    base: string;
    value: string;
  } | null>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const definitionsIdInput = useRef<HTMLInputElement>(null);
  const namespaceInput = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<RefObject<HTMLInputElement | null> | null>(null);
  const focus = (target: RefObject<HTMLInputElement | null>, owner: string) => {
    focusTarget.current = target;
    store.setState((s) => {
      s.propertiesPanel.isFurtherOpen = true;
    });
    setPanel(owner);
    target.current?.focus();
  };
  useLayoutEffect(() => {
    focusTarget.current?.current?.focus();
    focusTarget.current = null;
  }, [panel, furtherOpen]);
  useEffect(() => setIdDraft(processId), [processId]);
  useEffect(() => setDefinitionsIdDraft(definitionsId), [definitionsId]);
  useEffect(() => {
    setNamespaceDraft(namespace);
    setConfirmation(null);
  }, [namespace]);
  const ids = indexBpmnIds(definitions);
  const validId =
    isXmlNCName(idDraft) &&
    (idDraft === processId || !ids.getOriginalIds().has(idDraft));
  const validDefinitionsId = definitionsIdDraft
    ? isXmlNCName(definitionsIdDraft) &&
      (definitionsIdDraft === definitionsId ||
        !ids.getOriginalIds().has(definitionsIdDraft))
    : !definitionsId || !ids.isReferenced(definitionsId);
  const validNamespace = isBindableXmlNamespace(namespaceDraft);
  const change = (
    action: (
      definitions: State["bpmn"]["model"]["definitions"],
      process: ReturnType<typeof addOrGetProcessAndDiagramElements>["process"],
    ) => void,
  ) => {
    store.setState((s) => {
      if (!s.settings.isReadOnly)
        action(
          s.bpmn.model.definitions,
          addOrGetProcessAndDiagramElements({
            definitions: s.bpmn.model.definitions,
          }).process,
        );
    });
  };
  const commitId = () => {
    const current = store.getState();
    if (
      !validId ||
      current.settings.isReadOnly ||
      resolveBpmnProcessOwner(current.bpmn.model.definitions).process[
        "@_id"
      ] !== processId
    )
      return false;
    change((definitions, process) =>
      indexBpmnIds(definitions).rename(process["@_id"], idDraft),
    );
    return true;
  };
  const commitDefinitionsId = () => {
    const current = store.getState();
    if (
      !validDefinitionsId ||
      current.settings.isReadOnly ||
      (current.bpmn.model.definitions["@_id"] ?? "") !== definitionsId
    )
      return false;
    change((definitions) =>
      changeBpmnDefinitionsId(definitions, definitionsIdDraft || undefined),
    );
    return true;
  };
  usePendingEdit(idDraft !== processId, {
    commit: commitId,
    discard: () => setIdDraft(processId),
    focus: () => focus(idInput, "process"),
  });
  usePendingEdit(definitionsIdDraft !== definitionsId, {
    commit: commitDefinitionsId,
    discard: () => setDefinitionsIdDraft(definitionsId),
    focus: () => focus(definitionsIdInput, "definitions"),
  });
  usePendingEdit(namespaceDraft !== namespace, {
    commit: () => false, // Namespace changes require their explicit confirmation command.
    discard: () => {
      setNamespaceDraft(namespace);
      setConfirmation(null);
    },
    focus: () => focus(namespaceInput, "definitions"),
  });
  return (
    <>
      <Stack>
        <MyoxusTextInput
          label={i18n.propertiesPanel.name}
          disabled={readOnly}
          value={process["@_name"] ?? ""}
          onChange={(value) =>
            change((_definitions, process) => {
              if (value) process["@_name"] = value;
              else delete process["@_name"];
            })
          }
        />
        <MyoxusTextarea
          label={i18n.propertiesPanel.documentation}
          disabled={readOnly}
          value={process.documentation?.[0]?.__$$text ?? ""}
          onChange={(value) =>
            change((_definitions, process) => {
              if (value) {
                process.documentation ??= [];
                process.documentation[0] = {
                  ...process.documentation[0],
                  __$$text: value,
                };
              } else process.documentation?.splice(0, 1);
            })
          }
        />
        <Accordion
          value={furtherOpen ? "further" : null}
          onChange={(value) =>
            store.setState((s) => {
              s.propertiesPanel.isFurtherOpen = value === "further";
            })
          }
        >
          <AccordionItem value="further">
            <AccordionControl>
              {t["com.myoxus.editor.bpmn.further-properties"]()}
            </AccordionControl>
            <AccordionPanel keepMounted keepMountedMode="display-none">
              <Accordion
                value={panel}
                onChange={(value) => {
                  if (!Array.isArray(value)) setPanel(value);
                }}
              >
                <AccordionItem value="process">
                  <AccordionControl>
                    {i18n.propertiesPanel.process}
                  </AccordionControl>
                  <AccordionPanel keepMounted keepMountedMode="display-none">
                    <Stack>
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.id}
                        ref={idInput}
                        disabled={readOnly}
                        value={idDraft}
                        error={!validId}
                        onChange={setIdDraft}
                        onBlur={() => {
                          if (idDraft !== processId) commitId();
                        }}
                      />
                      <Select
                        label={i18n.propertiesPanel.type}
                        disabled={readOnly}
                        value={process["@_processType"] ?? "None"}
                        data={[
                          {
                            value: "None",
                            label: i18n.propertiesPanel.none,
                          },
                          {
                            value: "Private",
                            label: i18n.propertiesPanel.private,
                          },
                          {
                            value: "Public",
                            label: i18n.propertiesPanel.public,
                          },
                        ]}
                        onChange={(value) =>
                          change((_definitions, process) => {
                            // The XSD default is None; unrelated edits never materialize it.
                            if (value === "None")
                              delete process["@_processType"];
                            else if (value === "Private" || value === "Public")
                              process["@_processType"] = value;
                          })
                        }
                      />
                      <Checkbox
                        label={t["com.myoxus.editor.bpmn.closed-process"]()}
                        disabled={readOnly}
                        checked={process["@_isClosed"] ?? false}
                        onChange={(_event, checked) =>
                          change((_definitions, process) => {
                            if (checked) process["@_isClosed"] = true;
                            else delete process["@_isClosed"]; // XSD default false, unlike isExecutable's unspecified state.
                          })
                        }
                      />
                      <Select
                        label={i18n.propertiesPanel.executable}
                        description={
                          hasNonImmediate
                            ? t["com.myoxus.editor.bpmn.immediate-required"]()
                            : undefined
                        }
                        disabled={readOnly}
                        value={
                          process["@_isExecutable"] === undefined
                            ? "unset"
                            : String(process["@_isExecutable"])
                        }
                        data={[
                          { value: "unset", label: i18n.undefined },
                          {
                            value: "true",
                            label: t["com.myoxus.document-context.yes"](),
                            disabled: hasNonImmediate,
                          },
                          {
                            value: "false",
                            label: t["com.myoxus.document-context.no"](),
                          },
                        ]}
                        onChange={(value) => {
                          if (
                            value !== "unset" &&
                            value !== "true" &&
                            value !== "false"
                          )
                            return;
                          try {
                            change((definitions) =>
                              setProcessExecutable(
                                definitions,
                                value === "unset"
                                  ? undefined
                                  : value === "true",
                              ),
                            );
                          } catch (error) {
                            notify.error(
                              error instanceof Error &&
                                error.message === "BPMN_INVALID_CONNECTION"
                                ? t[
                                    "com.myoxus.editor.bpmn.immediate-required"
                                  ]()
                                : t["com.myoxus.common.operation-failed"](),
                            );
                          }
                        }}
                      />
                      <Text>
                        {t["com.myoxus.editor.bpmn.execution-flag-help"]()}
                      </Text>
                      <MultiSelect
                        label={t[
                          "com.myoxus.editor.bpmn.supported-interfaces"
                        ]()}
                        data={interfaces.options}
                        value={interfaces.selected}
                        disabled={readOnly}
                        searchable
                        nothingFoundMessage={i18n.propertiesPanel.noMatches}
                        onChange={(values) => {
                          try {
                            change((definitions) =>
                              setSupportedInterfaces(
                                definitions,
                                processId,
                                values,
                              ),
                            );
                          } catch {
                            notify.error(
                              t["com.myoxus.common.operation-failed"](),
                            );
                          }
                        }}
                      />
                    </Stack>
                  </AccordionPanel>
                </AccordionItem>
                <AccordionItem value="definitions">
                  <AccordionControl>
                    {i18n.bpmnPalette.propertiesManagement}
                  </AccordionControl>
                  <AccordionPanel keepMounted keepMountedMode="display-none">
                    <Stack>
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.name}
                        disabled={readOnly}
                        value={definitions["@_name"] ?? ""}
                        onChange={(value) =>
                          change((definitions) => {
                            if (value) definitions["@_name"] = value;
                            else delete definitions["@_name"];
                          })
                        }
                      />
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.id}
                        ref={definitionsIdInput}
                        disabled={readOnly}
                        value={definitionsIdDraft}
                        error={!validDefinitionsId}
                        onChange={setDefinitionsIdDraft}
                        onBlur={() => {
                          if (definitionsIdDraft !== definitionsId)
                            commitDefinitionsId();
                        }}
                      />
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.namespace}
                        ref={namespaceInput}
                        disabled={readOnly}
                        value={namespaceDraft}
                        error={!validNamespace}
                        onChange={setNamespaceDraft}
                        description={
                          namespaceDraft !== namespace
                            ? t[
                                "com.myoxus.editor.bpmn.namespace-pending-help"
                              ]()
                            : undefined
                        }
                      />
                      <Button
                        variant="secondary"
                        disabled={
                          readOnly ||
                          !validNamespace ||
                          namespaceDraft === namespace
                        }
                        onClick={() =>
                          setConfirmation({
                            base: namespace,
                            value: namespaceDraft,
                          })
                        }
                      >
                        {t.Apply()}
                      </Button>
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.expressionLanguage}
                        disabled={readOnly}
                        value={definitions["@_expressionLanguage"] ?? ""}
                        placeholder="http://www.w3.org/1999/XPath"
                        onChange={(value) =>
                          change((definitions) => {
                            if (value)
                              definitions["@_expressionLanguage"] = value;
                            else delete definitions["@_expressionLanguage"];
                          })
                        }
                      />
                      <MyoxusTextInput
                        label={t["com.myoxus.editor.bpmn.type-language"]()}
                        disabled={readOnly}
                        value={definitions["@_typeLanguage"] ?? ""}
                        placeholder="http://www.w3.org/2001/XMLSchema"
                        onChange={(value) =>
                          change((definitions) => {
                            if (value) definitions["@_typeLanguage"] = value;
                            else delete definitions["@_typeLanguage"];
                          })
                        }
                      />
                    </Stack>
                  </AccordionPanel>
                </AccordionItem>
                <ResourceRoles ownerId={processId} />
                <InputOutputSets ownerId={processId} />
              </Accordion>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </Stack>
      <Modal
        open={confirmation !== null}
        title={t["com.myoxus.editor.bpmn.namespace-change-title"]()}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <Stack>
          <Text>
            {t["com.myoxus.editor.bpmn.namespace-change-description"]()}
          </Text>
          <Text>{confirmation?.value}</Text>
          <Group>
            <Button
              disabled={readOnly}
              onClick={() => {
                const current = store.getState();
                if (
                  !confirmation ||
                  current.settings.isReadOnly ||
                  current.bpmn.model.definitions["@_targetNamespace"] !==
                    confirmation.base
                )
                  return;
                change((definitions) =>
                  changeBpmnTargetNamespace(definitions, confirmation.value),
                );
                setConfirmation(null);
              }}
            >
              {t.Confirm()}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmation(null)}>
              {t.Cancel()}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
