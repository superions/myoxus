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
  Checkbox,
  Divider,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import { type BPMN20__tStartEvent } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { StartEventIcon } from "../../diagram/nodes/NodeIcons";
import {
  eventInterruption,
  eventNotation,
  setEventInterrupting,
} from "../../mutations/event";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { OutputOnlyAssociationFormSection } from "../dataMapping/DataMappingFormSection";
import { EventDefinitionProperties } from "../eventDefinition/EventDefinitionProperties";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { useBpmnEditorI18n } from "../../i18n";
import { bpmnConstructState } from "../../../source-profile";
export function StartEventProperties({
  startEvent,
}: {
  startEvent: Normalized<BPMN20__tStartEvent> & {
    __$$element: "startEvent";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const interruption = eventInterruption(definitions, startEvent["@_id"]);
  const notation = eventNotation(definitions, startEvent["@_id"]);
  const { onCommandError } = useBpmnEditor();
  return (
    <>
      <Accordion defaultValue={"properties"}>
        <AccordionItem value="properties">
          <AccordionControl
            icon={
              <StartEventIcon
                variant={notation === "none" ? undefined : notation}
              />
            }
          >
            {startEvent["@_name"] || i18n.singleNodeProperties.startEvent}
          </AccordionControl>
          <AccordionPanel>
            <NameDocumentationAndId element={startEvent} />

            {interruption.applicable && (
              <Checkbox
                disabled={readOnly || interruption.fixed}
                label={i18n.singleNodeProperties.interrupting}
                checked={interruption.value}
                onChange={(_e, isChecked) => {
                  try {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      setEventInterrupting(
                        s.bpmn.model.definitions,
                        startEvent["@_id"],
                        isChecked,
                      );
                    });
                  } catch (error) {
                    onCommandError(error);
                  }
                }}
              />
            )}

            <Divider />
            <EventDefinitionProperties event={startEvent} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      {bpmnConstructState("dataOutputAssociation") === "editable" && (
        <OutputOnlyAssociationFormSection element={startEvent} />
      )}
    </>
  );
}
