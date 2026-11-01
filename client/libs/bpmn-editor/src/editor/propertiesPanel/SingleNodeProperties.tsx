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

import { Text } from "@myoxus/ui-facade";
import { Fragment } from "react";
import { useMemo } from "react";
import * as RF from "@xyflow/react";
import {
  type BpmnDiagramNodeData,
  type BpmnNodeType,
} from "../diagram/BpmnDiagramDomain";
import { useBpmnEditorStore } from "../store/StoreContext";
import { assertUnreachable } from "../ts-ext/assertUnreachable";
import { AdHocSubProcessProperties } from "./singleNodeProperties/AdHocSubProcessProperties";
import { BoundaryEventProperties } from "./singleNodeProperties/BoundaryEventProperties";
import { BusinessRuleTaskProperties } from "./singleNodeProperties/BusinessRuleTaskProperties";
import { CallActivityProperties } from "./singleNodeProperties/CallActivityProperties";
import { ComplexGatewayProperties } from "./singleNodeProperties/ComplexGatewayProperties";
import { DataObjectProperties } from "./singleNodeProperties/DataObjectProperties";
import { DataStoreProperties } from "./singleNodeProperties/DataStoreProperties";
import { EndEventProperties } from "./singleNodeProperties/EndEventProperties";
import { EventBasedGatewayProperties } from "./singleNodeProperties/EventBasedGatewayProperties";
import { EventSubProcessProperties } from "./singleNodeProperties/EventSubProcessProperties";
import { ExclusiveGatewayProperties } from "./singleNodeProperties/ExclusiveGatewayProperties";
import { GroupProperties } from "./singleNodeProperties/GroupProperties";
import { InclusiveGatewayProperties } from "./singleNodeProperties/InclusiveGatewayProperties";
import { IntermediateCatchEventProperties } from "./singleNodeProperties/IntermediateCatchEventProperties";
import { IntermediateThrowEventProperties } from "./singleNodeProperties/IntermediateThrowEventProperties";
import { LaneProperties } from "./singleNodeProperties/LaneProperties";
import { ParallelGatewayProperties } from "./singleNodeProperties/ParallelGatewayProperties";
import { ScriptTaskProperties } from "./singleNodeProperties/ScriptTaskProperties";
import { ServiceTaskProperties } from "./singleNodeProperties/ServiceTaskProperties";
import { StartEventProperties } from "./singleNodeProperties/StartEventProperties";
import { SubProcessProperties } from "./singleNodeProperties/SubProcessProperties";
import { TaskProperties } from "./singleNodeProperties/TaskProperties";
import { TextAnnotationProperties } from "./singleNodeProperties/TextAnnotationProperties";
import { TransactionProperties } from "./singleNodeProperties/TransactionProperties";
import { UserTaskProperties } from "./singleNodeProperties/UserTaskProperties";
import { useBpmnEditorI18n } from "../i18n";
import { Accordion } from "@myoxus/ui-facade";
import { InputOutputSets } from "./dataMapping/InputOutputSets";
import { acceptsDataAssociation } from "../mutations/data-association-context";
import { ProcessIoProperties } from "./singleNodeProperties/ProcessIoProperties";
import { isPropertyOwner } from "../mutations/addVariable";
import { VariablesFormSection } from "./variables/VariablesFormSection";
export function SingleNodeProperties() {
  const { i18n } = useBpmnEditorI18n();
  const selectedNode = useBpmnEditorStore(
    (s) =>
      [...s.computed(s).getDiagramData().selectedNodesById.values()][0] as
        undefined | RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
  );
  const { properties } = useMemo(() => {
    const bpmnElement = selectedNode?.data.bpmnElement;
    const e = bpmnElement?.__$$element;
    switch (e) {
      case "dataInput":
      case "dataOutput":
        return {
          properties: <ProcessIoProperties id={bpmnElement!["@_id"]} />,
        };
      // Events
      case "startEvent":
        return {
          properties: <StartEventProperties startEvent={bpmnElement!} />,
        };
      case "endEvent":
        return {
          properties: <EndEventProperties endEvent={bpmnElement!} />,
        };
      case "intermediateCatchEvent":
        return {
          properties: (
            <IntermediateCatchEventProperties
              intermediateCatchEvent={bpmnElement!}
            />
          ),
        };
      case "intermediateThrowEvent":
        return {
          properties: (
            <IntermediateThrowEventProperties
              intermediateThrowEvent={bpmnElement!}
            />
          ),
        };
      case "boundaryEvent":
        return {
          properties: <BoundaryEventProperties boundaryEvent={bpmnElement!} />,
        };
      // Gateways
      case "complexGateway":
        return {
          properties: (
            <ComplexGatewayProperties complexGateway={bpmnElement!} />
          ),
        };
      case "eventBasedGateway":
        return {
          properties: (
            <EventBasedGatewayProperties eventBasedGateway={bpmnElement!} />
          ),
        };
      case "exclusiveGateway":
        return {
          properties: (
            <ExclusiveGatewayProperties exclusiveGateway={bpmnElement!} />
          ),
        };
      case "inclusiveGateway":
        return {
          properties: (
            <InclusiveGatewayProperties inclusiveGateway={bpmnElement!} />
          ),
        };
      case "parallelGateway":
        return {
          properties: (
            <ParallelGatewayProperties parallelGateway={bpmnElement!} />
          ),
        };
      // Tasks
      case "task":
      case "manualTask":
        return {
          properties: <TaskProperties task={bpmnElement!} />,
        };
      case "businessRuleTask":
        return {
          properties: (
            <BusinessRuleTaskProperties businessRuleTask={bpmnElement!} />
          ),
        };
      case "scriptTask":
        return {
          properties: <ScriptTaskProperties scriptTask={bpmnElement!} />,
        };
      case "serviceTask":
      case "sendTask":
      case "receiveTask":
        return {
          properties: <ServiceTaskProperties serviceTask={bpmnElement!} />,
        };
      case "userTask":
        return {
          properties: <UserTaskProperties userTask={bpmnElement!} />,
        };
      case "callActivity":
        return {
          properties: <CallActivityProperties callActivity={bpmnElement!} />,
        };
      // Sub-processes
      case "subProcess":
        if (bpmnElement?.["@_triggeredByEvent"]) {
          return {
            properties: (
              <EventSubProcessProperties eventSubProcess={bpmnElement!} />
            ),
          };
        } else {
          return {
            properties: <SubProcessProperties subProcess={bpmnElement!} />,
          };
        }
      case "adHocSubProcess":
        return {
          properties: (
            <AdHocSubProcessProperties adHocSubProcess={bpmnElement!} />
          ),
        };
      case "transaction":
        return {
          properties: <TransactionProperties transaction={bpmnElement!} />,
        };
      // Misc.
      case "dataObject":
      case "dataObjectReference":
        return {
          properties: <DataObjectProperties dataObject={bpmnElement!} />,
        };
      case "dataStoreReference":
        return {
          properties: <DataStoreProperties id={bpmnElement!["@_id"]} />,
        };
      case "textAnnotation":
        return {
          properties: (
            <TextAnnotationProperties textAnnotation={bpmnElement!} />
          ),
        };
      case "group":
        return {
          properties: <GroupProperties group={bpmnElement!} />,
        };
      case "lane":
        return {
          properties: <LaneProperties lane={bpmnElement!} />,
        };
      // Unsupported
      //// events
      case "event":
      case undefined:
        return {
          properties: <Text>{i18n.propertiesPanel.noPropertiesToEdit}</Text>,
        };
      default:
        assertUnreachable(e);
    }
  }, [i18n.propertiesPanel.noPropertiesToEdit, selectedNode?.data.bpmnElement]);
  // Field-local drafts and definition choices belong to the selected XML element.
  const host = selectedNode?.data.bpmnElement;
  return (
    <Fragment key={selectedNode?.id}>
      {properties}
      {host && isPropertyOwner(host) && <VariablesFormSection p={host} />}
      {host &&
        (acceptsDataAssociation(host, "input") ||
          acceptsDataAssociation(host, "output")) && (
          <Accordion>
            <InputOutputSets ownerId={host["@_id"]} />
          </Accordion>
        )}
    </Fragment>
  );
}
