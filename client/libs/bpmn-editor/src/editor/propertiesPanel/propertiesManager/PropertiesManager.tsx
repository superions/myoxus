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
import { Fragment } from "react";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";

import {
  MyoxusTextInput,
  EmptyState,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  Stack,
  Select,
} from "@myoxus/ui-facade";
import { Button, Grid, IconButton } from "@myoxus/ui-facade";
import { PlusIcon as PlusCircleIcon } from "@myoxus/icons/react";
import { CloseIcon as TimesIcon } from "@myoxus/icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { addOrGetItemDefinitions } from "../../mutations/addOrGetItemDefinitions";
import { deleteItemDefinition } from "../../mutations/deleteItemDefinition";
import {
  renameItemDefinition,
  itemDefinitionById,
  setItemDefinitionMetadata,
} from "../../mutations/renameItemDefinition";
import { addOrGetMessages } from "../../mutations/addOrGetMessages";
import { renameMessage } from "../../mutations/renameMessage";
import { deleteMessage } from "../../mutations/deleteMessage";
import { addOrGetSignals } from "../../mutations/addOrGetSignals";
import { renameSignal } from "../../mutations/renameSignal";
import { deleteSignal } from "../../mutations/deleteSignal";
import { addOrGetErrors } from "../../mutations/addOrGetErrors";
import { addOrGetEscalations } from "../../mutations/addOrGetEscalations";
import { deleteEscalation } from "../../mutations/deleteEscalation";
import { renameEscalation } from "../../mutations/renameEscalation";
import { deleteError } from "../../mutations/deleteError";
import { renameError } from "../../mutations/renameError";
import { useBpmnEditorI18n } from "../../i18n";
import { usePendingEdit } from "../../../xyflow/reactExt/PendingEdits";
import { ResourceDefinitions } from "../resources/ResourceDefinitions";
export function PropertiesManager() {
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const errors = useBpmnEditorStore((s) =>
    s.bpmn.model.definitions.rootElement?.filter(
      (s) => s.__$$element === "error",
    ),
  );
  const escalations = useBpmnEditorStore((s) =>
    s.bpmn.model.definitions.rootElement?.filter(
      (s) => s.__$$element === "escalation",
    ),
  );
  const itemDefinitions = useBpmnEditorStore((s) =>
    s.bpmn.model.definitions.rootElement?.filter(
      (root) => root.__$$element === "itemDefinition",
    ),
  );
  const messages = useBpmnEditorStore(
    (s) =>
      s.bpmn.model.definitions.rootElement?.filter(
        (root) => root.__$$element === "message",
      ) ?? [],
  );
  const signals = useBpmnEditorStore((s) =>
    s.bpmn.model.definitions.rootElement?.filter(
      (s) => s.__$$element === "signal",
    ),
  );
  const [activeTab, setActiveTab] = useState("0");
  const onSelectTab = useCallback((tabIndex: string) => {
    setActiveTab(tabIndex);
  }, []);
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const ids = indexBpmnIds(definitions);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [typeDrafts, setTypeDrafts] = useState(
    new Map<
      string | number,
      { value: string; base: string | undefined; anonymous?: object }
    >(),
  );
  const typeInputs = useRef(new Map<string | number, HTMLInputElement>());
  const focusType = useRef<string | number | undefined>(undefined);
  const typeAt = (model: typeof definitions, id: string | number) => {
    try {
      return itemDefinitionById(model, id);
    } catch {
      return undefined;
    }
  };
  // Undo/source replacement may invalidate a draft's base. Unrelated model
  // edits must not erase a partially typed prefix or allocate another timer.
  useEffect(() => {
    setTypeDrafts((previous) => {
      const retained = new Map(
        [...previous].filter(([id, draft]) => {
          const root = typeAt(definitions, id);
          return (
            root &&
            root["@_structureRef"] === draft.base &&
            (!draft.anonymous || root === draft.anonymous)
          );
        }),
      );
      return retained.size === previous.size ? previous : retained;
    });
  }, [definitions]);
  const validType = (entry: object, value: string) => {
    if (!value.trim()) return true;
    try {
      ids.expandQName(entry, value);
      return true;
    } catch {
      return false;
    }
  };
  const invalidTypeId = [...typeDrafts].find(([id, draft]) => {
    const entry = typeAt(definitions, id);
    return !entry || !validType(entry, draft.value);
  })?.[0];
  usePendingEdit(typeDrafts.size > 0, {
    commit: () => {
      const current = bpmnEditorStoreApi.getState();
      if (current.settings.isReadOnly || invalidTypeId !== undefined)
        return false;
      const currentIds = indexBpmnIds(current.bpmn.model.definitions);
      for (const [id, draft] of typeDrafts) {
        const entry = typeAt(current.bpmn.model.definitions, id);
        if (
          entry?.__$$element !== "itemDefinition" ||
          entry["@_structureRef"] !== draft.base ||
          (draft.anonymous && entry !== draft.anonymous)
        )
          return false;
        try {
          if (draft.value.trim()) currentIds.expandQName(entry, draft.value);
        } catch {
          return false;
        }
      }
      // All fields are validated before one transaction: one invalid prefix
      // cannot leave earlier type rows committed as a misleading partial save.
      bpmnEditorStoreApi.setState((s) => {
        if (s.settings.isReadOnly) return;
        for (const [id, draft] of typeDrafts)
          renameItemDefinition({
            definitions: s.bpmn.model.definitions,
            id,
            newItemDefinitionName: draft.value,
          });
      });
      setTypeDrafts(new Map());
      return true;
    },
    discard: () => setTypeDrafts(new Map()),
    focus: () => {
      const id = invalidTypeId ?? typeDrafts.keys().next().value;
      focusType.current = id;
      setActiveTab("0");
      if (id !== undefined) {
        setActiveType(String(id));
        typeInputs.current.get(id)?.focus();
      }
    },
  });
  return (
    <Tabs
      value={String(activeTab)}
      onValueChange={(value) => onSelectTab(value)}
    >
      <TabsList>
        <TabsTrigger value="resources">
          {t["com.myoxus.editor.bpmn.resource"]()}
        </TabsTrigger>
        <TabsTrigger value={String(0)}>
          {i18n.propertiesManager.dataTypes}
        </TabsTrigger>
        <TabsTrigger value={String(1)}>
          {i18n.propertiesManager.messages}
        </TabsTrigger>
        <TabsTrigger value={String(2)}>
          {i18n.propertiesManager.signals}
        </TabsTrigger>
        <TabsTrigger value={String(3)}>
          {i18n.propertiesManager.escalations}
        </TabsTrigger>
        <TabsTrigger value={String(4)}>
          {i18n.propertiesManager.errors}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="resources">
        <ResourceDefinitions />
      </TabsContent>
      <TabsContent value={String(0)}>
        {((itemDefinitions?.length ?? 0) > 0 && (
          <>
            <Button
              disabled={isReadOnly}
              onClick={() => {
                bpmnEditorStoreApi.setState((s) => {
                  if (s.settings.isReadOnly) return;
                  const { itemDefinition } = addOrGetItemDefinitions({
                    definitions: s.bpmn.model.definitions,
                    dataType: "",
                  });
                  setActiveType(itemDefinition["@_id"]);
                });
              }}
            >
              {i18n.propertiesManager.addDataType}
            </Button>
            <Accordion
              value={activeType}
              onChange={(value) =>
                setActiveType(Array.isArray(value) ? (value[0] ?? null) : value)
              }
            >
              {itemDefinitions?.map((entry) => {
                const id =
                  entry["@_id"] ?? definitions.rootElement!.indexOf(entry);
                return (
                  <AccordionItem key={id} value={String(id)}>
                    <AccordionControl>
                      {entry["@_id"] ||
                        entry["@_structureRef"] ||
                        i18n.propertiesManager.dataType}
                    </AccordionControl>
                    <AccordionPanel>
                      <Stack>
                        <MyoxusTextInput
                          label={t["com.myoxus.editor.bpmn.element-id"]()}
                          value={entry["@_id"] ?? ""}
                          readOnly
                        />
                        <MyoxusTextInput
                          label={i18n.propertiesManager.dataType}
                          ref={(input) => {
                            if (input) {
                              typeInputs.current.set(id, input);
                              if (focusType.current === id) {
                                input.focus();
                                focusType.current = undefined;
                              }
                            } else typeInputs.current.delete(id);
                          }}
                          type="text"
                          placeholder={
                            i18n.propertiesManager.dataTypeplaceholder
                          }
                          value={
                            typeDrafts.get(id)?.value ??
                            entry["@_structureRef"] ??
                            ""
                          }
                          error={
                            typeDrafts.has(id) &&
                            !validType(entry, typeDrafts.get(id)!.value)
                              ? t["com.myoxus.editor.bpmn.invalid-type-name"]()
                              : undefined
                          }
                          onChange={(value) =>
                            setTypeDrafts((previous) => {
                              const next = new Map(previous);
                              if (value === (entry["@_structureRef"] ?? ""))
                                next.delete(id);
                              else
                                next.set(id, {
                                  value,
                                  base: entry["@_structureRef"],
                                  anonymous:
                                    typeof id === "number" ? entry : undefined,
                                });
                              return next;
                            })
                          }
                          onBlur={() => {
                            const draft = typeDrafts.get(id);
                            if (!draft || !validType(entry, draft.value))
                              return;
                            const current = bpmnEditorStoreApi.getState();
                            const root = typeAt(
                              current.bpmn.model.definitions,
                              id,
                            );
                            if (
                              current.settings.isReadOnly ||
                              !root ||
                              root["@_structureRef"] !== draft.base ||
                              (draft.anonymous && root !== draft.anonymous)
                            )
                              return;
                            bpmnEditorStoreApi.setState((s) => {
                              if (!s.settings.isReadOnly)
                                renameItemDefinition({
                                  definitions: s.bpmn.model.definitions,
                                  id,
                                  newItemDefinitionName: draft.value,
                                });
                            });
                            setTypeDrafts((previous) => {
                              const next = new Map(previous);
                              next.delete(id);
                              return next;
                            });
                          }}
                          disabled={isReadOnly}
                        />
                        <Select
                          label={t["com.myoxus.editor.bpmn.item-kind"]()}
                          value={entry["@_itemKind"] ?? "unset"}
                          data={[
                            { value: "unset", label: i18n.undefined },
                            {
                              value: "Information",
                              label:
                                t["com.myoxus.editor.bpmn.item-information"](),
                            },
                            {
                              value: "Physical",
                              label:
                                t["com.myoxus.editor.bpmn.item-physical"](),
                            },
                          ]}
                          disabled={isReadOnly || typeDrafts.has(id)}
                          onChange={(value) => {
                            if (
                              value !== "unset" &&
                              value !== "Information" &&
                              value !== "Physical"
                            )
                              return;
                            bpmnEditorStoreApi.setState((s) => {
                              if (!s.settings.isReadOnly)
                                setItemDefinitionMetadata(
                                  s.bpmn.model.definitions,
                                  id,
                                  "@_itemKind",
                                  value === "unset" ? undefined : value,
                                );
                            });
                          }}
                        />
                        <Select
                          label={t["com.myoxus.editor.bpmn.is-collection"]()}
                          value={
                            entry["@_isCollection"] === undefined
                              ? "unset"
                              : String(entry["@_isCollection"])
                          }
                          data={[
                            { value: "unset", label: i18n.undefined },
                            {
                              value: "true",
                              label: t["com.myoxus.document-context.yes"](),
                            },
                            {
                              value: "false",
                              label: t["com.myoxus.document-context.no"](),
                            },
                          ]}
                          disabled={isReadOnly || typeDrafts.has(id)}
                          onChange={(value) => {
                            if (
                              value !== "unset" &&
                              value !== "true" &&
                              value !== "false"
                            )
                              return;
                            bpmnEditorStoreApi.setState((s) => {
                              if (!s.settings.isReadOnly)
                                setItemDefinitionMetadata(
                                  s.bpmn.model.definitions,
                                  id,
                                  "@_isCollection",
                                  value === "unset"
                                    ? undefined
                                    : value === "true",
                                );
                            });
                          }}
                        />
                        <Button
                          disabled={
                            isReadOnly ||
                            (!!entry["@_id"] && ids.isReferenced(entry["@_id"]))
                          }
                          onClick={() => {
                            bpmnEditorStoreApi.setState((s) => {
                              if (s.settings.isReadOnly) return;
                              deleteItemDefinition({
                                definitions: s.bpmn.model.definitions,
                                id,
                              });
                            });
                          }}
                        >
                          {entry["@_id"] && ids.isReferenced(entry["@_id"])
                            ? t[
                                "com.myoxus.settings.workspace.properties.in-use"
                              ]()
                            : t.Delete()}
                        </Button>
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </>
        )) || (
          <EmptyState
            title={
              isReadOnly
                ? i18n.propertiesManager.noDataTypeProperties
                : i18n.propertiesManager.noDataTypePropertiesYet
            }
            description={
              !isReadOnly && (
                <Button
                  variant="primary"
                  onClick={() => {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      addOrGetItemDefinitions({
                        definitions: s.bpmn.model.definitions,
                        dataType: "",
                      });
                    });
                  }}
                >
                  {i18n.propertiesManager.addDataType}
                </Button>
              )
            }
          ></EmptyState>
        )}
      </TabsContent>
      <TabsContent value={String(1)}>
        {((messages?.length ?? 0) > 0 && (
          <>
            <Grid>
              <Grid.Col span={11}>
                <b>{i18n.propertiesManager.messages}</b>
              </Grid.Col>
              <Grid.Col span={1}>
                {!isReadOnly && (
                  <IconButton
                    variant={"plain"}
                    onClick={() => {
                      bpmnEditorStoreApi.setState((s) => {
                        if (s.settings.isReadOnly) return;
                        addOrGetMessages({
                          definitions: s.bpmn.model.definitions,
                          messageName: "",
                        });
                      });
                    }}
                    tooltip={t.Create()}
                  >
                    <PlusCircleIcon />
                  </IconButton>
                )}
              </Grid.Col>
            </Grid>
            {messages?.map((entry) => (
              <Fragment key={entry["@_id"]}>
                <Grid>
                  <Grid.Col span={11}>
                    <MyoxusTextInput
                      type="text"
                      placeholder={i18n.propertiesManager.name}
                      value={entry["@_name"]}
                      onChange={(e) => {
                        bpmnEditorStoreApi.setState((s) => {
                          if (s.settings.isReadOnly) return;
                          renameMessage({
                            definitions: s.bpmn.model.definitions,
                            id: entry["@_id"],
                            newMessageName: e,
                          });
                        });
                      }}
                      disabled={isReadOnly}
                    />
                  </Grid.Col>
                  <Grid.Col span={1}>
                    {
                      <IconButton
                        disabled={isReadOnly || ids.isReferenced(entry["@_id"])}
                        variant={"plain"}
                        onClick={() => {
                          bpmnEditorStoreApi.setState((s) => {
                            if (s.settings.isReadOnly) return;
                            deleteMessage({
                              definitions: s.bpmn.model.definitions,
                              id: entry["@_id"],
                            });
                          });
                        }}
                        tooltip={
                          ids.isReferenced(entry["@_id"])
                            ? t[
                                "com.myoxus.settings.workspace.properties.in-use"
                              ]()
                            : t.Delete()
                        }
                      >
                        <TimesIcon />
                      </IconButton>
                    }
                  </Grid.Col>
                </Grid>
              </Fragment>
            ))}
          </>
        )) || (
          <EmptyState
            title={
              isReadOnly
                ? i18n.propertiesManager.noMessageproperties
                : i18n.propertiesManager.noMessagepropertiesYet
            }
            description={
              !isReadOnly && (
                <Button
                  variant="primary"
                  onClick={() => {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      addOrGetMessages({
                        definitions: s.bpmn.model.definitions,
                        messageName: "",
                      });
                    });
                  }}
                >
                  {i18n.propertiesManager.addMessage}
                </Button>
              )
            }
          ></EmptyState>
        )}
      </TabsContent>
      <TabsContent value={String(2)}>
        {((signals?.length ?? 0) > 0 && (
          <>
            <Grid>
              <Grid.Col span={11}>
                <b>{i18n.propertiesManager.signals}</b>
              </Grid.Col>
              <Grid.Col span={1}>
                {!isReadOnly && (
                  <IconButton
                    variant={"plain"}
                    onClick={() => {
                      bpmnEditorStoreApi.setState((s) => {
                        if (s.settings.isReadOnly) return;
                        addOrGetSignals({
                          definitions: s.bpmn.model.definitions,
                          signalName: "",
                        });
                      });
                    }}
                    tooltip={t.Create()}
                  >
                    <PlusCircleIcon />
                  </IconButton>
                )}
              </Grid.Col>
            </Grid>
            {signals?.map((entry) => (
              <Fragment key={entry["@_id"]}>
                <Grid>
                  <Grid.Col span={11}>
                    <MyoxusTextInput
                      type="text"
                      placeholder={i18n.propertiesManager.name}
                      value={entry["@_name"]}
                      onChange={(e) => {
                        bpmnEditorStoreApi.setState((s) => {
                          if (s.settings.isReadOnly) return;
                          renameSignal({
                            definitions: s.bpmn.model.definitions,
                            id: entry["@_id"],
                            newSignalName: e,
                          });
                        });
                      }}
                      disabled={isReadOnly}
                    />
                  </Grid.Col>
                  <Grid.Col span={1}>
                    {
                      <IconButton
                        disabled={isReadOnly || ids.isReferenced(entry["@_id"])}
                        variant={"plain"}
                        onClick={() => {
                          bpmnEditorStoreApi.setState((s) => {
                            if (s.settings.isReadOnly) return;
                            deleteSignal({
                              definitions: s.bpmn.model.definitions,
                              id: entry["@_id"],
                            });
                          });
                        }}
                        tooltip={
                          ids.isReferenced(entry["@_id"])
                            ? t[
                                "com.myoxus.settings.workspace.properties.in-use"
                              ]()
                            : t.Delete()
                        }
                      >
                        <TimesIcon />
                      </IconButton>
                    }
                  </Grid.Col>
                </Grid>
              </Fragment>
            ))}
          </>
        )) || (
          <EmptyState
            title={
              isReadOnly
                ? i18n.propertiesManager.noSignalproperties
                : i18n.propertiesManager.noSignalpropertiesYet
            }
            description={
              !isReadOnly && (
                <Button
                  variant="primary"
                  onClick={() => {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      addOrGetSignals({
                        definitions: s.bpmn.model.definitions,
                        signalName: "",
                      });
                    });
                  }}
                >
                  {i18n.propertiesManager.addSignal}
                </Button>
              )
            }
          ></EmptyState>
        )}
      </TabsContent>
      <TabsContent value={String(3)}>
        {((escalations?.length ?? 0) > 0 && (
          <>
            <Grid>
              <Grid.Col span={11}>
                <b>{i18n.propertiesManager.escalations}</b>
              </Grid.Col>
              <Grid.Col span={1}>
                {!isReadOnly && (
                  <IconButton
                    variant={"plain"}
                    onClick={() => {
                      bpmnEditorStoreApi.setState((s) => {
                        if (s.settings.isReadOnly) return;
                        addOrGetEscalations({
                          definitions: s.bpmn.model.definitions,
                          escalationName: "",
                        });
                      });
                    }}
                    tooltip={t.Create()}
                  >
                    <PlusCircleIcon />
                  </IconButton>
                )}
              </Grid.Col>
            </Grid>
            {escalations?.map((entry) => (
              <Fragment key={entry["@_id"]}>
                <Grid>
                  <Grid.Col span={11}>
                    <MyoxusTextInput
                      type="text"
                      placeholder={i18n.propertiesManager.name}
                      value={entry["@_name"]}
                      onChange={(e) => {
                        bpmnEditorStoreApi.setState((s) => {
                          if (s.settings.isReadOnly) return;
                          renameEscalation({
                            definitions: s.bpmn.model.definitions,
                            id: entry["@_id"],
                            newEscalationName: e,
                          });
                        });
                      }}
                      disabled={isReadOnly}
                    />
                  </Grid.Col>
                  <Grid.Col span={1}>
                    {
                      <IconButton
                        disabled={isReadOnly || ids.isReferenced(entry["@_id"])}
                        variant={"plain"}
                        onClick={() => {
                          bpmnEditorStoreApi.setState((s) => {
                            if (s.settings.isReadOnly) return;
                            deleteEscalation({
                              definitions: s.bpmn.model.definitions,
                              id: entry["@_id"],
                            });
                          });
                        }}
                        tooltip={
                          ids.isReferenced(entry["@_id"])
                            ? t[
                                "com.myoxus.settings.workspace.properties.in-use"
                              ]()
                            : t.Delete()
                        }
                      >
                        <TimesIcon />
                      </IconButton>
                    }
                  </Grid.Col>
                </Grid>
              </Fragment>
            ))}
          </>
        )) || (
          <EmptyState
            title={
              isReadOnly
                ? i18n.propertiesManager.noEscalationproperties
                : i18n.propertiesManager.noEscalationpropertiesYet
            }
            description={
              !isReadOnly && (
                <Button
                  variant="primary"
                  onClick={() => {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      addOrGetEscalations({
                        definitions: s.bpmn.model.definitions,
                        escalationName: "",
                      });
                    });
                  }}
                >
                  {i18n.propertiesManager.addEscalation}
                </Button>
              )
            }
          ></EmptyState>
        )}
      </TabsContent>
      <TabsContent value={String(4)}>
        {((errors?.length ?? 0) > 0 && (
          <>
            <Grid>
              <Grid.Col span={11}>
                <b>{i18n.propertiesManager.errors}</b>
              </Grid.Col>
              <Grid.Col span={1}>
                {!isReadOnly && (
                  <IconButton
                    variant={"plain"}
                    onClick={() => {
                      bpmnEditorStoreApi.setState((s) => {
                        if (s.settings.isReadOnly) return;
                        addOrGetErrors({
                          definitions: s.bpmn.model.definitions,
                          errorName: "",
                        });
                      });
                    }}
                    tooltip={t.Create()}
                  >
                    <PlusCircleIcon />
                  </IconButton>
                )}
              </Grid.Col>
            </Grid>
            {errors?.map((entry) => (
              <Fragment key={entry["@_id"]}>
                <Grid>
                  <Grid.Col span={11}>
                    <MyoxusTextInput
                      type="text"
                      placeholder={i18n.propertiesManager.name}
                      value={entry["@_name"]}
                      onChange={(e) => {
                        bpmnEditorStoreApi.setState((s) => {
                          if (s.settings.isReadOnly) return;
                          renameError({
                            definitions: s.bpmn.model.definitions,
                            id: entry["@_id"],
                            newErrorName: e,
                          });
                        });
                      }}
                      disabled={isReadOnly}
                    />
                  </Grid.Col>
                  <Grid.Col span={1}>
                    {
                      <IconButton
                        disabled={isReadOnly || ids.isReferenced(entry["@_id"])}
                        variant={"plain"}
                        onClick={() => {
                          bpmnEditorStoreApi.setState((s) => {
                            if (s.settings.isReadOnly) return;
                            deleteError({
                              definitions: s.bpmn.model.definitions,
                              id: entry["@_id"],
                            });
                          });
                        }}
                        tooltip={
                          ids.isReferenced(entry["@_id"])
                            ? t[
                                "com.myoxus.settings.workspace.properties.in-use"
                              ]()
                            : t.Delete()
                        }
                      >
                        <TimesIcon />
                      </IconButton>
                    }
                  </Grid.Col>
                </Grid>
              </Fragment>
            ))}
          </>
        )) || (
          <EmptyState
            title={
              isReadOnly
                ? i18n.propertiesManager.noErrorproperties
                : i18n.propertiesManager.noErrorpropertiesYet
            }
            description={
              !isReadOnly && (
                <Button
                  variant="primary"
                  onClick={() => {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      addOrGetErrors({
                        definitions: s.bpmn.model.definitions,
                        errorName: "",
                      });
                    });
                  }}
                >
                  {i18n.propertiesManager.addError}
                </Button>
              )
            }
          ></EmptyState>
        )}
      </TabsContent>
    </Tabs>
  );
}
