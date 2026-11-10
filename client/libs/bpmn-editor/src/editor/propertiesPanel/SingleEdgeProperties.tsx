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
  Text,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { DataAssociationProperties } from "./singleEdgeProperties/DataAssociationProperties";
import * as RF from "@xyflow/react";
import { type BpmnDiagramEdgeData } from "../diagram/BpmnDiagramDomain";
import { AssociationPath, SequenceFlowPath } from "../diagram/edges/EdgeSvgs";
import { UnknownNodeIcon } from "../diagram/nodes/NodeIcons";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { assertUnreachable } from "../ts-ext/assertUnreachable";
import { AssociationProperties } from "./singleEdgeProperties/AssociationProperties";
import { SequenceFlowProperties } from "./singleEdgeProperties/SequenceFlowProperties";
import { useBpmnEditorI18n } from "../i18n";
import {
  NameDocumentationAndId,
  TechnicalPropertiesContext,
} from "./nameDocumentationAndId/NameDocumentationAndId";
import { Fragment } from "react";
const edgeSvgViewboxSize = 25;
const nodeSvgProps = {
  width: 100,
  height: 70,
  x: 0,
  y: 15,
  strokeWidth: 8,
};
export function SingleEdgeProperties() {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const store = useBpmnEditorStoreApi();
  const furtherOpen = useBpmnEditorStore(
    (s) => s.propertiesPanel.isFurtherOpen,
  );
  const selectedEdge = useBpmnEditorStore(
    (s) =>
      [...s.computed(s).getDiagramData().selectedEdgesById.values()][0] as
        undefined | RF.Edge<BpmnDiagramEdgeData>,
  );
  const { properties, title, icon } = (() => {
    const bpmnElement = selectedEdge?.data?.bpmnElement;
    const e = bpmnElement?.__$$element;
    switch (e) {
      case "dataInputAssociation":
      case "dataOutputAssociation":
        return {
          properties: <DataAssociationProperties id={bpmnElement!["@_id"]} />,
          title: t["com.myoxus.editor.bpmn.data-association"](),
          icon: (
            <svg
              width="1em"
              height="1em"
              viewBox={`0 0 ${edgeSvgViewboxSize} ${edgeSvgViewboxSize}`}
            >
              <AssociationPath
                d={`M2,${edgeSvgViewboxSize - 2} L${edgeSvgViewboxSize},0`}
                associationDirection="One"
                strokeWidth={2}
              />
            </svg>
          ),
        };
      // Events
      case "sequenceFlow":
        return {
          properties: <SequenceFlowProperties sequenceFlow={bpmnElement!} />,
          title: i18n.propertiesPanel.sequenceFlow,
          icon: (
            <svg
              width="1em"
              height="1em"
              viewBox={`0 0 ${edgeSvgViewboxSize} ${edgeSvgViewboxSize}`}
            >
              <SequenceFlowPath
                d={`M2,${edgeSvgViewboxSize - 2} L${edgeSvgViewboxSize - 2},0`}
                {...nodeSvgProps}
              />
            </svg>
          ),
        };
      case "association":
        return {
          properties: <AssociationProperties association={bpmnElement!} />,
          title: i18n.propertiesPanel.association,
          icon: (
            <svg
              width="1em"
              height="1em"
              viewBox={`0 0 ${edgeSvgViewboxSize} ${edgeSvgViewboxSize}`}
            >
              <AssociationPath
                d={`M2,${edgeSvgViewboxSize - 2} L${edgeSvgViewboxSize},0`}
                {...nodeSvgProps}
                strokeWidth={2}
              />
            </svg>
          ),
        };
      case undefined:
        return {
          properties: <Text>{i18n.propertiesPanel.noPropertiesToEdit}</Text>,
          title: i18n.propertiesPanel.unsupported,
          icon: <UnknownNodeIcon />,
        };
      default:
        assertUnreachable(e);
    }
  })();
  const host = selectedEdge?.data?.bpmnElement;
  return (
    <Fragment key={selectedEdge?.id}>
      {host &&
        (host.__$$element === "sequenceFlow" ||
        host.__$$element === "association" ? (
          <NameDocumentationAndId element={host} primaryOnly />
        ) : (
          <DataAssociationProperties id={host["@_id"]} primaryOnly />
        ))}
      <Accordion
        value={furtherOpen ? "further" : null}
        onChange={(value) =>
          store.setState((s) => {
            s.propertiesPanel.isFurtherOpen = value === "further";
          })
        }
      >
        <AccordionItem value="further">
          <AccordionControl>
            {t["com.myoxus.editor.bpmn.further-properties"]()}
          </AccordionControl>
          <AccordionPanel keepMounted keepMountedMode="display-none">
            <TechnicalPropertiesContext.Provider value={true}>
              <Accordion defaultValue="properties">
                <AccordionItem value="properties">
                  <AccordionControl icon={icon}>{title}</AccordionControl>
                  <AccordionPanel keepMounted keepMountedMode="display-none">
                    {properties}
                  </AccordionPanel>
                </AccordionItem>
              </Accordion>
            </TechnicalPropertiesContext.Provider>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </Fragment>
  );
}
