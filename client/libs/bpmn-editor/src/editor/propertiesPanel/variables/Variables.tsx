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

import { type ComponentType, type JSX, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import { CloseIcon, PlusIcon } from "@myoxus/icons/react";
import {
  IconButton,
  Alert,
  Stack,
  MyoxusTextInput,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@myoxus/ui-facade";
import { addOrGetProcessAndDiagramElements } from "../../mutations/addOrGetProcessAndDiagramElements";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import {
  addVariable,
  deleteVariable,
  propertyOwnerById,
  findOwnedProperty,
  type PropertyOwner,
} from "../../mutations/addVariable";
import { ItemDefinitionRefSelector } from "../itemDefinitionRefSelector/ItemDefinitionRefSelector";
import { useBpmnEditorI18n } from "../../i18n";
import { indexBpmnIds } from "../../idRandomizer/bpmn-id-randomizer";
export type WithVariables = PropertyOwner;
export function Variables({
  p,
  EmptyState,
}: {
  p: WithVariables | undefined;
  EmptyState: ComponentType<{
    addButton: JSX.Element;
  }>;
}) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const references = indexBpmnIds(definitions);
  const [deleteError, setDeleteError] = useState(false);
  const changeOwner = (
    change: (
      owner: WithVariables,
      index: ReturnType<typeof indexBpmnIds>,
    ) => void,
  ) => {
    store.setState((state) => {
      if (state.settings.isReadOnly) return;
      const { process } = addOrGetProcessAndDiagramElements({
        definitions: state.bpmn.model.definitions,
      });
      const index = indexBpmnIds(state.bpmn.model.definitions);
      change(
        propertyOwnerById(
          state.bpmn.model.definitions,
          p?.["@_id"] ?? process["@_id"],
        ),
        index,
      );
    });
  };
  const addButton = (
    <IconButton
      tooltip={i18n.bpmnPalette.addVariable}
      disabled={readOnly}
      onClick={() => {
        store.setState((state) => {
          if (!state.settings.isReadOnly)
            addVariable({
              definitions: state.bpmn.model.definitions,
              pId: p?.["@_id"],
            });
        });
      }}
    >
      <PlusIcon />
    </IconButton>
  );
  if (!p?.property?.length) return <EmptyState addButton={addButton} />;
  return (
    <Stack>
      {deleteError && (
        <Alert>{t["com.myoxus.editor.bpmn.definition-in-use"]()}</Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{i18n.propertiesPanel.name}</TableHead>
            <TableHead>{i18n.propertiesPanel.dataType}</TableHead>
            <TableHead>{addButton}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {p.property.map((entry, originalIndex) => (
            <TableRow key={entry["@_id"] ?? originalIndex}>
              <TableCell>
                <MyoxusTextInput
                  aria-label={i18n.propertiesPanel.name}
                  disabled={readOnly}
                  value={entry["@_name"] ?? ""}
                  placeholder={i18n.propertiesPanel.namePlaceholder}
                  onChange={(value) =>
                    changeOwner((owner) => {
                      const property = findOwnedProperty(
                        owner,
                        entry["@_id"],
                        originalIndex,
                      );
                      if (property) property["@_name"] = value;
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <ItemDefinitionRefSelector
                  showLabel={false}
                  referenceOwner={entry}
                  value={entry["@_itemSubjectRef"]}
                  onChange={(reference) =>
                    changeOwner((owner, index) => {
                      const property = findOwnedProperty(
                        owner,
                        entry["@_id"],
                        originalIndex,
                      );
                      if (property && reference)
                        property["@_itemSubjectRef"] = index.referenceFor(
                          property,
                          reference,
                          property["@_itemSubjectRef"],
                        );
                      else if (property) delete property["@_itemSubjectRef"];
                    })
                  }
                />
              </TableCell>
              <TableCell>
                <IconButton
                  tooltip={t.Delete()}
                  disabled={
                    readOnly ||
                    (!!entry["@_id"] && references.isReferenced(entry["@_id"]))
                  }
                  onClick={() => {
                    setDeleteError(false);
                    try {
                      store.setState((state) => {
                        if (!state.settings.isReadOnly)
                          deleteVariable(
                            state.bpmn.model.definitions,
                            p["@_id"],
                            entry["@_id"],
                            originalIndex,
                          );
                      });
                    } catch {
                      setDeleteError(true);
                    }
                  }}
                >
                  <CloseIcon />
                </IconButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );
}
