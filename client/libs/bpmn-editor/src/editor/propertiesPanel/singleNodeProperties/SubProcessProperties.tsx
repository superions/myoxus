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
  Button,
  Stack,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
} from "@myoxus/ui-facade";
import type { ReactNode } from "react";
import type { SubProcess } from "../../mutations/activity";
import { NameDocumentationAndId } from "../nameDocumentationAndId/NameDocumentationAndId";
import { SubProcessIcon } from "../../diagram/nodes/NodeIcons";
import { MultiInstanceProperties } from "../multiInstance/MultiInstanceProperties";
import { MultiInstanceCheckbox } from "../multiInstanceCheckbox/MultiInstanceCheckbox";
import { useBpmnEditorI18n } from "../../i18n";
import { useI18n } from "@myoxus/i18n";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../../store/StoreContext";
import { setSubProcessExpanded } from "../../mutations/activity";
import { ResourceRoles } from "../resources/ResourceRoles";
import { BidirectionalDataMappingFormSection } from "../dataMapping/DataMappingFormSection";
export function SubProcessProperties({
  subProcess,
  children,
}: {
  subProcess: SubProcess;
  children?: ReactNode;
}) {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const expanded = useBpmnEditorStore(
    (state) =>
      state.computed(state).getDiagramData().nodesById.get(subProcess["@_id"])
        ?.data.shape["@_isExpanded"] === true,
  );
  return (
    <Accordion multiple defaultValue={["properties"]}>
      <AccordionItem value="properties">
        <AccordionControl
          icon={
            <SubProcessIcon
              variant={
                subProcess.__$$element === "transaction"
                  ? "transaction"
                  : "@_triggeredByEvent" in subProcess &&
                      subProcess["@_triggeredByEvent"]
                    ? "event"
                    : "other"
              }
            />
          }
        >
          {subProcess["@_name"] ||
            (subProcess.__$$element === "transaction"
              ? i18n.singleNodeProperties.transaction
              : subProcess.__$$element === "adHocSubProcess"
                ? i18n.singleNodeProperties.adhocSubprocess
                : subProcess["@_triggeredByEvent"]
                  ? i18n.singleNodeProperties.eventSubprocess
                  : i18n.singleNodeProperties.subprocess)}
        </AccordionControl>
        <AccordionPanel keepMounted keepMountedMode="display-none">
          <Stack>
            <NameDocumentationAndId element={subProcess} />
            {children}
            <BidirectionalDataMappingFormSection element={subProcess} />
            <Button
              disabled={readOnly}
              onClick={() =>
                store.setState((state) => {
                  if (state.settings.isReadOnly) return;
                  setSubProcessExpanded(
                    state.bpmn.model.definitions,
                    subProcess["@_id"],
                    !expanded,
                  );
                  if (expanded) {
                    state.xyFlowReactKieDiagram._selectedNodes = [
                      subProcess["@_id"],
                    ];
                    state.xyFlowReactKieDiagram._selectedEdges = [];
                  }
                })
              }
            >
              {expanded
                ? t["com.myoxus.editor.bpmn.collapse-subprocess"]()
                : t["com.myoxus.editor.bpmn.expand-subprocess"]()}
            </Button>
          </Stack>
        </AccordionPanel>
      </AccordionItem>
      {!subProcess["@_triggeredByEvent"] && (
        <AccordionItem value="activity">
          <AccordionControl>{i18n.propertiesPanel.activity}</AccordionControl>
          <AccordionPanel keepMounted keepMountedMode="display-none">
            <Stack>
              <MultiInstanceCheckbox element={subProcess} />
              <MultiInstanceProperties element={subProcess} />
            </Stack>
          </AccordionPanel>
        </AccordionItem>
      )}
      <ResourceRoles ownerId={subProcess["@_id"]} />
    </Accordion>
  );
}
