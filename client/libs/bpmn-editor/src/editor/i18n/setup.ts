/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * License); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing;
 * software distributed under the License is distributed on an
 * AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
// SPDX-License-Identifier: Apache-2.0
// Modified by Myoxus; see provenance.json for retained source and patches.

import { useI18n } from "@myoxus/i18n";
import { useMemo } from "react";

/** Retained component vocabulary projected from generated Myoxus translations. */
export function useBpmnEditorI18n() {
  const t = useI18n();
  const language = t.language;
  return useMemo(
    () => ({
      locale: language,
      i18n: {
        bpmnDiagramEmptyState: {
          emptyBpmnTitle: t["com.myoxus.editor.bpmn.empty-title"](),
          startByDraggingNodes: t["com.myoxus.editor.bpmn.empty-help"](),
        },
        bpmnPalette: {
          processVariables: t["com.myoxus.editor.bpmn.data-properties"](),
          addVariable: t["com.myoxus.editor.bpmn.add-data-property"](),
          noVariables: t["com.myoxus.editor.bpmn.no-data-properties"](),
          noVariablesYet: t["com.myoxus.editor.bpmn.no-data-properties"](),
          emptyBpmnBody: t["com.myoxus.editor.bpmn.data-properties-help"](),
          propertiesManagement: t["com.myoxus.editor.bpmn.definitions"](),
          correlations: t["com.myoxus.editor.bpmn.correlations"](),
          intermediateCatchEvents: t["com.myoxus.editor.bpmn.catch-event"](),
          intermediateThrowEvents: t["com.myoxus.editor.bpmn.throw-event"](),
          gateways: t["com.myoxus.editor.bpmn.gateways"](),
          startEvents: t["com.myoxus.editor.shape.bpmn.start-event"](),
          endEvents: t["com.myoxus.editor.shape.bpmn.end-event"](),
          tasks: t["com.myoxus.editor.shape.bpmn.task"](),
          lanes: t["com.myoxus.editor.shape.bpmn.lane"](),
          group: t["com.myoxus.editor.shape.bpmn.group"](),
          textAnnotation: t["com.myoxus.editor.shape.bpmn.annotation"](),
          dataObject: t["com.myoxus.editor.shape.bpmn.data-object"](),
          callActivity: t["com.myoxus.editor.shape.bpmn.call-activity"](),
          subProcesses: t["com.myoxus.editor.shape.bpmn.sub-process"](),
        },
        propertiesPanel: {
          variables: t["com.myoxus.editor.bpmn.data-properties"](),
          var: t["com.myoxus.editor.bpmn.data-properties"](),
          noVariablesYet: t["com.myoxus.editor.bpmn.no-data-properties"](),
          enteringExpressions:
            t["com.myoxus.editor.bpmn.data-properties-help"](),
          dataType: t["com.myoxus.editor.bpmn.data-type"](),
          source: t["com.myoxus.editor.mermaid.chart-source"](),
          target: t["com.myoxus.editor.mermaid.chart-target"](),
          activity: t["com.myoxus.editor.bpmn.activity"](),
          association: t["com.myoxus.editor.bpmn.association"](),
          calledElement: t["com.myoxus.editor.bpmn.called-element"](),
          cantEditProperties: t["com.myoxus.editor.bpmn.mixed-selection"](),
          collectionInput: t["com.myoxus.editor.bpmn.collection-input"](),
          collectionOutput: t["com.myoxus.editor.bpmn.collection-output"](),
          completionCondition:
            t["com.myoxus.editor.bpmn.completion-condition"](),
          conditionalExpression:
            t["com.myoxus.editor.bpmn.conditional-expression"](),
          dataInput: t["com.myoxus.editor.bpmn.data-input"](),
          dataInputPlaceholder: t["com.myoxus.editor.bpmn.data-input"](),
          dataOutput: t["com.myoxus.editor.bpmn.data-output"](),
          dataOutputPlaceholder: t["com.myoxus.editor.bpmn.data-output"](),
          defaultRoute: t["com.myoxus.editor.bpmn.default-flow"](),
          documentation: t["com.myoxus.editor.bpmn.documentation"](),
          documentationPlaceholder: t["com.myoxus.editor.bpmn.documentation"](),
          executable: t["com.myoxus.editor.bpmn.executable"](),
          executionMode: t["com.myoxus.editor.bpmn.execution-mode"](),
          expression: t["com.myoxus.editor.bpmn.expression"](),
          expressionLanguage: t["com.myoxus.editor.bpmn.expression-language"](),
          timerOptions: t["com.myoxus.editor.bpmn.timer"](),
          fireOnceAfterDuration: t["com.myoxus.editor.bpmn.timer-duration"](),
          fireMultipleTimes: t["com.myoxus.editor.bpmn.timer-cycle"](),
          fireAtspecificDate: t["com.myoxus.editor.bpmn.timer-date"](),
          id: t["com.myoxus.editor.bpmn.element-id"](),
          multiInstance: t["com.myoxus.editor.bpmn.multi-instance"](),
          noPropertiesToEdit: t["com.myoxus.editor.bpmn.no-properties"](),
          process: t["com.myoxus.editor.bpmn.process"](),
          sequenceFlow: t["com.myoxus.editor.bpmn.sequence-flow"](),
          sequential: t["com.myoxus.editor.bpmn.sequential"](),
          selectOnlyNodes: t["com.myoxus.editor.bpmn.select-nodes"](),
          selectOnlyEdges: t["com.myoxus.editor.bpmn.select-edges"](),
          noMatches: t["com.myoxus.editor.bpmn.no-matches"](),
          name: t["com.myoxus.common.name"](),
          namePlaceholder: t["com.myoxus.common.name"](),
          enterNamePlaceholder: t["com.myoxus.common.name"](),
          namespace: t["com.myoxus.common.namespace"](),
          type: t["com.myoxus.common.type"](),
          close: t["com.myoxus.peek-view-controls.close"](),
          copy: t["Copy"](),
          createDataType: t["Create"](),
          createMessage: t["Create"](),
          createSignal: t["Create"](),
          createError: t["Create"](),
          createEscalation: t["Create"](),
          none: t["com.myoxus.sidebar.common.none"](),
          noneYet: t["com.myoxus.sidebar.common.none"](),
          private: t["com.myoxus.workspace-overview.public-status.private"](),
          public: t["com.myoxus.workspace-overview.public-status.public"](),
          unsupported: t["com.myoxus.database.field.type.unsupported"](),
          link: t["com.myoxus.editor.keyboard.link"](),
          endEvent: t["com.myoxus.editor.shape.bpmn.end-event"](),
          edgesNodesSelected: (count: number) =>
            t["com.myoxus.editor.bpmn.nodes-and-edges"]({
              count: new Intl.NumberFormat(t.language).format(count),
            }),
          multipleNodesSelected: (count: number) =>
            t["com.myoxus.editor.bpmn.nodes-selected"]({
              count: new Intl.NumberFormat(t.language).format(count),
            }),
          multipleEdgesSelected: (count: number) =>
            t["com.myoxus.editor.bpmn.edges-selected"]({
              count: new Intl.NumberFormat(t.language).format(count),
            }),
        },
        correlation: {
          properties: t["com.myoxus.editor.bpmn.correlations"](),
          addCorrelationProperty: t["com.myoxus.editor.bpmn.add-correlation"](),
          messageBindings: t["com.myoxus.editor.bpmn.message-bindings"](),
        },
        singleNodeProperties: {
          intermediateCatchEvent: t["com.myoxus.editor.bpmn.catch-event"](),
          intermediateThrowEvent: t["com.myoxus.editor.bpmn.throw-event"](),
          actors: t["com.myoxus.editor.bpmn.actors"](),
          actorsPlaceholder: t["com.myoxus.editor.bpmn.actors-placeholder"](),
          adhocSubprocess: t["com.myoxus.editor.bpmn.adhoc-subprocess"](),
          adhocOrdering: t["com.myoxus.editor.bpmn.adhoc-ordering"](),
          adhocCompletionCondition:
            t["com.myoxus.editor.bpmn.completion-condition"](),
          boundaryEvent: t["com.myoxus.editor.bpmn.boundary-event"](),
          cancelActivity: t["com.myoxus.editor.bpmn.cancel-activity"](),
          eventSubprocess: t["com.myoxus.editor.bpmn.event-subprocess"](),
          format: t["com.myoxus.editor.bpmn.text-format"](),
          implementation: t["com.myoxus.editor.bpmn.implementation"](),
          interface: t["com.myoxus.editor.bpmn.interface"](),
          interrupting: t["com.myoxus.editor.bpmn.interrupting"](),
          operation: t["com.myoxus.editor.bpmn.operation"](),
          parallel: t["com.myoxus.editor.bpmn.parallel"](),
          script: t["com.myoxus.editor.bpmn.script"](),
          transaction: t["com.myoxus.editor.bpmn.transaction"](),
          sequential: t["com.myoxus.editor.bpmn.sequential"](),
          text: t["Text"](),
          startEvent: t["com.myoxus.editor.shape.bpmn.start-event"](),
          task: t["com.myoxus.editor.shape.bpmn.task"](),
          lane: t["com.myoxus.editor.shape.bpmn.lane"](),
          textAnnotation: t["com.myoxus.editor.shape.bpmn.annotation"](),
          callActivity: t["com.myoxus.editor.shape.bpmn.call-activity"](),
          subprocess: t["com.myoxus.editor.shape.bpmn.sub-process"](),
          businessRuleTask:
            t["com.myoxus.editor.shape.bpmn.business-rule-task"](),
          complexGateway: t["com.myoxus.editor.shape.bpmn.complex-gateway"](),
          eventBasedGateway:
            t["com.myoxus.editor.shape.bpmn.event-based-gateway"](),
          exclusiveGateway:
            t["com.myoxus.editor.shape.bpmn.exclusive-gateway-xor"](),
          inclusiveGateway:
            t["com.myoxus.editor.shape.bpmn.inclusive-gateway-or"](),
          parallelGateway:
            t["com.myoxus.editor.shape.bpmn.parallel-gateway-and"](),
          scriptTask: t["com.myoxus.editor.shape.bpmn.script-task"](),
          serviceTask: t["com.myoxus.editor.shape.bpmn.service-task"](),
          userTask: t["com.myoxus.editor.shape.bpmn.user-task"](),
        },
        bpmnTopRightPanels: {
          overlays: t["com.myoxus.editor.bpmn.overlays"](),
          propertiesPanel: t["com.myoxus.editor.bpmn.properties"](),
        },
        dataMapping: {
          title: t["com.myoxus.editor.bpmn.data-mapping"](),
          input: t["com.myoxus.editor.bpmn.input"](),
          output: t["com.myoxus.editor.bpmn.output"](),
          inputs: t["com.myoxus.editor.bpmn.inputs"](),
          outputs: t["com.myoxus.editor.bpmn.outputs"](),
          dataType: t["com.myoxus.editor.bpmn.data-type"](),
          noWhiteSpaces: t["com.myoxus.editor.bpmn.no-whitespace"](),
          name: t["com.myoxus.common.name"](),
          namePlaceholder: t["com.myoxus.common.name"](),
          save: t["Save"](),
          mappingForElement: (name: string) =>
            t["com.myoxus.editor.bpmn.data-mapping-for"]({
              name,
            }),
          addDataMapping: (section: "input" | "output") =>
            section === "input"
              ? t["com.myoxus.editor.bpmn.add-input-mapping"]()
              : t["com.myoxus.editor.bpmn.add-output-mapping"](),
          noDataMappings: (section: "input" | "output") =>
            section === "input"
              ? t["com.myoxus.editor.bpmn.no-input-mapping"]()
              : t["com.myoxus.editor.bpmn.no-output-mapping"](),
          noDataMappingsYet: (section: "input" | "output") =>
            section === "input"
              ? t["com.myoxus.editor.bpmn.no-input-mapping"]()
              : t["com.myoxus.editor.bpmn.no-output-mapping"](),
        },
        propertiesManager: {
          dataType: t["com.myoxus.editor.bpmn.data-type"](),
          dataTypeplaceholder: t["com.myoxus.editor.bpmn.data-type"](),
          dataTypes: t["com.myoxus.editor.bpmn.data-types"](),
          messages: t["com.myoxus.editor.bpmn.messages"](),
          signals: t["com.myoxus.editor.bpmn.signals"](),
          errors: t["com.myoxus.editor.bpmn.errors"](),
          escalations: t["com.myoxus.editor.bpmn.escalations"](),
          addDataType: t["com.myoxus.editor.bpmn.add-data-type"](),
          addMessage: t["com.myoxus.editor.bpmn.add-message"](),
          addSignal: t["com.myoxus.editor.bpmn.add-signal"](),
          addError: t["com.myoxus.editor.bpmn.add-error"](),
          addEscalation: t["com.myoxus.editor.bpmn.add-escalation"](),
          noDataTypeProperties: t["com.myoxus.editor.bpmn.no-data-types"](),
          noDataTypePropertiesYet: t["com.myoxus.editor.bpmn.no-data-types"](),
          noMessageproperties: t["com.myoxus.editor.bpmn.no-messages"](),
          noMessagepropertiesYet: t["com.myoxus.editor.bpmn.no-messages"](),
          noSignalproperties: t["com.myoxus.editor.bpmn.no-signals"](),
          noSignalpropertiesYet: t["com.myoxus.editor.bpmn.no-signals"](),
          noErrorproperties: t["com.myoxus.editor.bpmn.no-errors"](),
          noErrorpropertiesYet: t["com.myoxus.editor.bpmn.no-errors"](),
          noEscalationproperties: t["com.myoxus.editor.bpmn.no-escalations"](),
          noEscalationpropertiesYet:
            t["com.myoxus.editor.bpmn.no-escalations"](),
          name: t["com.myoxus.common.name"](),
        },
        enableStyles: t["com.myoxus.editor.bpmn.styles"](),
        eventDefinitionProperties: {
          errorCode: t["com.myoxus.editor.bpmn.error-code"](),
          escalationCode: t["com.myoxus.editor.bpmn.escalation-code"](),
          message: t["com.myoxus.editor.bpmn.message"](),
          signal: t["com.myoxus.editor.bpmn.signal"](),
        },
        overlaysPanel: {
          snapping: t["com.myoxus.editor.bpmn.snapping"](),
          horizontal: t["com.myoxus.common.orientation.horizontal"](),
          vertical: t["com.myoxus.common.orientation.vertical"](),
        },
        undefined: t["com.myoxus.editor.bpmn.undefined"](),
        nodeLabel: {
          placeHolder: t["com.myoxus.common.name"](),
        },
      },
    }),
    // The translator wrapper is stable while its current language changes.
    [t, language],
  );
}
