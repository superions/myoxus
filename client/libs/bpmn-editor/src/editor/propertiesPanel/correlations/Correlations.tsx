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

import { useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  Group,
  IconButton,
  MyoxusTextInput,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { CloseIcon } from "@myoxus/icons/react";
import { type BPMN20__tCorrelationProperty } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { generateUuid } from "../../../xyflow/uuid/uuid";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { MessageSelector } from "../messageSelector/MessageSelector";
import { useBpmnEditorI18n } from "../../i18n";
import { resolveBpmnProcessOwner } from "../../../process-source";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";

/** Standard definitions-level properties; correlation keys belong to excluded Collaborations. */
export function Correlations() {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const definitions = useBpmnEditorStore((s) => s.bpmn.model.definitions);
  const ids = indexBpmnIds(definitions);
  const properties = useBpmnEditorStore(
    (s) =>
      s.bpmn.model.definitions.rootElement?.filter(
        (root) => root.__$$element === "correlationProperty",
      ) ?? [],
  );
  const messages = useBpmnEditorStore(
    (s) =>
      s.bpmn.model.definitions.rootElement?.filter(
        (root) => root.__$$element === "message",
      ) ?? [],
  );
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const selected =
    properties.find((property) => property["@_id"] === selectedId) ??
    properties[0];
  const change = (
    update: (
      property: Normalized<BPMN20__tCorrelationProperty>,
      index: ReturnType<typeof indexBpmnIds>,
    ) => void,
  ) =>
    store.setState((s) => {
      if (s.settings.isReadOnly) return;
      resolveBpmnProcessOwner(s.bpmn.model.definitions);
      const property = s.bpmn.model.definitions.rootElement
        ?.filter((root) => root.__$$element === "correlationProperty")
        .find((property) => property["@_id"] === selected?.["@_id"]);
      if (property) update(property, indexBpmnIds(s.bpmn.model.definitions));
    });
  const availableMessage = messages.find(
    (message) =>
      !selected?.correlationPropertyRetrievalExpression.some(
        (binding) =>
          ids.resolveReference(binding, binding["@_messageRef"]) ===
          message["@_id"],
      ),
  );
  return (
    <Stack>
      <Group>
        <Select
          label={i18n.correlation.properties}
          value={selected?.["@_id"] ?? null}
          onChange={setSelectedId}
          data={properties.map((property) => ({
            value: property["@_id"],
            label: property["@_name"] || property["@_id"],
          }))}
        />
        <Button
          disabled={readOnly}
          onClick={() => {
            const id = generateUuid();
            store.setState((s) => {
              if (s.settings.isReadOnly) return;
              resolveBpmnProcessOwner(s.bpmn.model.definitions);
              s.bpmn.model.definitions.rootElement!.push({
                __$$element: "correlationProperty",
                "@_id": id,
                "@_name": "",
                correlationPropertyRetrievalExpression: [],
              });
            });
            setSelectedId(id);
          }}
        >
          {i18n.correlation.addCorrelationProperty}
        </Button>
        {selected && (
          <IconButton
            tooltip={t.Delete()}
            disabled={readOnly || ids.isReferenced(selected["@_id"])}
            onClick={() =>
              store.setState((s) => {
                if (!s.settings.isReadOnly) {
                  resolveBpmnProcessOwner(s.bpmn.model.definitions);
                  if (
                    indexBpmnIds(s.bpmn.model.definitions).isReferenced(
                      selected["@_id"],
                    )
                  )
                    throw new Error("BPMN_DEFINITION_IN_USE");
                  s.bpmn.model.definitions.rootElement =
                    s.bpmn.model.definitions.rootElement?.filter(
                      (root) => root["@_id"] !== selected["@_id"],
                    );
                }
              })
            }
          >
            <CloseIcon />
          </IconButton>
        )}
      </Group>
      {selected && (
        <>
          <MyoxusTextInput
            label={i18n.propertiesPanel.name}
            disabled={readOnly}
            value={selected["@_name"] ?? ""}
            onChange={(value) =>
              change((property) => {
                property["@_name"] = value;
              })
            }
          />
          <ItemDefinitionRefSelector
            referenceOwner={selected}
            value={selected["@_type"]}
            onChange={(reference) =>
              change((property, index) => {
                property["@_type"] = index.referenceFor(
                  property,
                  reference,
                  property["@_type"],
                );
              })
            }
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{i18n.eventDefinitionProperties.message}</TableHead>
                <TableHead>{i18n.propertiesPanel.expression}</TableHead>
                <TableHead>{i18n.correlation.messageBindings}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selected.correlationPropertyRetrievalExpression.map(
                (binding) => (
                  <TableRow key={binding["@_id"]}>
                    <TableCell>
                      <MessageSelector
                        referenceOwner={binding}
                        value={binding["@_messageRef"]}
                        disableValues={selected.correlationPropertyRetrievalExpression
                          .filter((item) => item["@_id"] !== binding["@_id"])
                          .flatMap((item) => {
                            const id = ids.resolveReference(
                              item,
                              item["@_messageRef"],
                            );
                            return id ? [id] : [];
                          })}
                        onChange={(reference) =>
                          change((property, index) => {
                            const current =
                              property.correlationPropertyRetrievalExpression.find(
                                (item) => item["@_id"] === binding["@_id"],
                              );
                            if (current && reference)
                              current["@_messageRef"] = index.referenceFor(
                                current,
                                reference,
                                current["@_messageRef"],
                              )!;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <MyoxusTextInput
                        label={i18n.propertiesPanel.expression}
                        disabled={readOnly}
                        value={binding.messagePath.__$$text ?? ""}
                        onChange={(text) =>
                          change((property) => {
                            const current =
                              property.correlationPropertyRetrievalExpression.find(
                                (item) => item["@_id"] === binding["@_id"],
                              );
                            if (current) current.messagePath.__$$text = text;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <IconButton
                        tooltip={t.Delete()}
                        disabled={readOnly}
                        onClick={() =>
                          change((property) => {
                            property.correlationPropertyRetrievalExpression =
                              property.correlationPropertyRetrievalExpression.filter(
                                (item) => item["@_id"] !== binding["@_id"],
                              );
                          })
                        }
                      >
                        <CloseIcon />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
          <Button
            disabled={readOnly || !availableMessage}
            onClick={() =>
              change((property, index) => {
                if (availableMessage)
                  property.correlationPropertyRetrievalExpression.push({
                    "@_id": generateUuid(),
                    "@_messageRef": index.referenceFor(
                      property,
                      availableMessage["@_id"],
                    )!,
                    messagePath: {
                      "@_id": generateUuid(),
                      __$$text: "",
                    },
                  });
              })
            }
          >
            {i18n.correlation.messageBindings}
          </Button>
        </>
      )}
    </Stack>
  );
}
