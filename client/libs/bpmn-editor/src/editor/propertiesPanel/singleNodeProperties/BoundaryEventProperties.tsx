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
import { type BPMN20__tBoundaryEvent } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { EventDefinitionProperties } from "../eventDefinition/EventDefinitionProperties";
import { OutputOnlyAssociationFormSection } from "../dataMapping/DataMappingFormSection";
import { IntermediateCatchEventIcon } from "../../diagram/nodes/NodeIcons";
import {
  eventInterruption,
  eventNotation,
  setEventInterrupting,
} from "../../mutations/event";
import { useBpmnEditor } from "../../BpmnEditorContext";
import { useBpmnEditorI18n } from "../../i18n";
export function BoundaryEventProperties({
  boundaryEvent,
}: {
  boundaryEvent: Normalized<BPMN20__tBoundaryEvent> & {
    __$$element: "boundaryEvent";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const definitions = useBpmnEditorStore(
    (state) => state.bpmn.model.definitions,
  );
  const interruption = eventInterruption(definitions, boundaryEvent["@_id"]);
  const notation = eventNotation(definitions, boundaryEvent["@_id"]);
  const { onCommandError } = useBpmnEditor();
  return (
    <>
      <Accordion defaultValue={"properties"}>
        <AccordionItem value="properties">
          <AccordionControl
            icon={
              <IntermediateCatchEventIcon
                variant={notation === "none" ? undefined : notation}
              />
            }
          >
            {boundaryEvent["@_name"] || i18n.singleNodeProperties.boundaryEvent}
          </AccordionControl>
          <AccordionPanel>
            <NameDocumentationAndId element={boundaryEvent} />

            <Divider />

            {interruption.applicable && (
              <Checkbox
                disabled={readOnly || interruption.fixed}
                label={i18n.singleNodeProperties.cancelActivity}
                checked={interruption.value}
                onChange={(_e, isChecked) => {
                  try {
                    bpmnEditorStoreApi.setState((s) => {
                      if (s.settings.isReadOnly) return;
                      setEventInterrupting(
                        s.bpmn.model.definitions,
                        boundaryEvent["@_id"],
                        isChecked,
                      );
                    });
                  } catch (error) {
                    onCommandError(error);
                  }
                }}
              />
            )}

            <EventDefinitionProperties event={boundaryEvent} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <OutputOnlyAssociationFormSection element={boundaryEvent} />
    </>
  );
}
