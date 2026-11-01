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
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import { type BPMN20__tInclusiveGateway } from "../../../schemas/bpmn-2_0/ts-gen/types";
import { type Normalized } from "../../normalization/normalize";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { GatewayPropertiesFields } from "./GatewayPropertiesFields";
import { GatewayIcon } from "../../diagram/nodes/NodeIcons";
import { useBpmnEditorI18n } from "../../i18n";
export function InclusiveGatewayProperties({
  inclusiveGateway,
}: {
  inclusiveGateway: Normalized<BPMN20__tInclusiveGateway> & {
    __$$element: "inclusiveGateway";
  };
}) {
  const { i18n } = useBpmnEditorI18n();
  return (
    <Accordion defaultValue={"properties"}>
      <AccordionItem value="properties">
        <AccordionControl
          icon={
            <GatewayIcon variant={inclusiveGateway.__$$element} isIcon={true} />
          }
        >
          {inclusiveGateway["@_name"] ||
            i18n.singleNodeProperties.inclusiveGateway}
        </AccordionControl>
        <AccordionPanel>
          <NameDocumentationAndId element={inclusiveGateway} />

          <GatewayPropertiesFields gateway={inclusiveGateway} />
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
