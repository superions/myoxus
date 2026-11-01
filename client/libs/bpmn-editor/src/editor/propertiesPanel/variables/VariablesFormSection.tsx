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
  Group,
} from "@myoxus/ui-facade";
import { type ReactNode } from "react";
import { Variables, type WithVariables } from "./Variables";
import { WorkflowIcon as DomainIcon } from "@myoxus/icons/react";
import { PropertiesPanelListEmptyState } from "../emptyState/PropertiesPanelListEmptyState";
import { useBpmnEditorStore } from "../../store/StoreContext";
import { useBpmnEditorI18n } from "../../i18n";
export function VariablesFormSection({ p }: { p: undefined | WithVariables }) {
  const { i18n, locale } = useBpmnEditorI18n();
  const variablesCount = p?.property?.length ?? 0;
  return (
    <Accordion defaultValue="variables">
      <AccordionItem value="variables">
        <AccordionControl icon={<DomainIcon />}>
          {i18n.propertiesPanel.variables} (
          {new Intl.NumberFormat(locale).format(variablesCount)})
        </AccordionControl>
        <AccordionPanel>
          <Variables p={p} EmptyState={VariablesEmptyState} />
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}
function VariablesEmptyState({ addButton }: { addButton: ReactNode }) {
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  return (
    <Group>
      <PropertiesPanelListEmptyState />
      {!isReadOnly && addButton}
    </Group>
  );
}
