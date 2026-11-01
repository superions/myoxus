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
  Divider,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import { type BPMN20__tIntermediateCatchEvent } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { OutputOnlyAssociationFormSection } from "../dataMapping/DataMappingFormSection";
import { EventDefinitionProperties } from "../eventDefinition/EventDefinitionProperties";
import { IntermediateCatchEventIcon } from "../../diagram/nodes/NodeIcons";
import { useBpmnEditorI18n } from "../../i18n";
import { eventNotation } from "../../mutations/event";
import { useBpmnEditorStore } from "../../store/StoreContext";
export function IntermediateCatchEventProperties({
  intermediateCatchEvent,
}: {
  intermediateCatchEvent: Normalized<BPMN20__tIntermediateCatchEvent> & {
    __$$element: "intermediateCatchEvent";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  const notation = useBpmnEditorStore((state) =>
    eventNotation(state.bpmn.model.definitions, intermediateCatchEvent["@_id"]),
  );
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
            {intermediateCatchEvent["@_name"] ||
              i18n.singleNodeProperties.intermediateCatchEvent}
          </AccordionControl>
          <AccordionPanel>
            <NameDocumentationAndId element={intermediateCatchEvent} />

            <Divider />

            <EventDefinitionProperties event={intermediateCatchEvent} />
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      <OutputOnlyAssociationFormSection element={intermediateCatchEvent} />
    </>
  );
}
