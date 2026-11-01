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

import { Select, Stack } from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useBpmnEditor } from "../../BpmnEditorContext";
import {
  findConnectionElement,
  setAssociationDirection,
} from "../../mutations/connection";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { type BPMN20__tAssociation } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
export function AssociationProperties({
  association,
}: {
  association: Normalized<BPMN20__tAssociation> & {
    __$$element: "association";
  };
}) {
  const t = useI18n(),
    store = useBpmnEditorStoreApi(),
    { onCommandError } = useBpmnEditor();
  const definitions = useBpmnEditorStore(
      (state) => state.bpmn.model.definitions,
    ),
    readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const current = findConnectionElement(
    definitions,
    association["@_id"],
  )?.element;
  if (current?.__$$element !== "association") return null;
  return (
    <Stack>
      <NameDocumentationAndId element={association} />
      <Select
        label={t["com.myoxus.editor.bpmn.association-direction"]()}
        value={current["@_associationDirection"] ?? "None"}
        disabled={readOnly}
        data={[
          {
            value: "None",
            label: t["com.myoxus.editor.bpmn.association-none"](),
          },
          {
            value: "One",
            label: t["com.myoxus.editor.bpmn.association-one"](),
          },
          {
            value: "Both",
            label: t["com.myoxus.editor.bpmn.association-both"](),
          },
        ]}
        onChange={(value) => {
          if (value !== "None" && value !== "One" && value !== "Both") return;
          try {
            store.setState((state) => {
              if (!state.settings.isReadOnly)
                setAssociationDirection(
                  state.bpmn.model.definitions,
                  association["@_id"],
                  value,
                );
            });
          } catch (error) {
            onCommandError(error);
          }
        }}
      />
    </Stack>
  );
}
