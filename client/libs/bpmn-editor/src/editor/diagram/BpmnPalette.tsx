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
  EmptyState,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
  Modal,
  Scrollable,
  Stack,
} from "@myoxus/ui-facade";
import * as React from "react";
import { useI18n } from "@myoxus/i18n";
import { useCallback } from "react";
import * as RF from "@xyflow/react";
import {
  type BpmnNodeElement,
  type BpmnNodeType,
  DEFAULT_NODE_SIZES,
  elementToNodeType,
  MIN_NODE_SIZES,
  NODE_TYPES,
} from "./BpmnDiagramDomain";
import {
  CallActivityIcon,
  DataObjectIcon,
  DataStoreIcon,
  EndEventIcon,
  GatewayIcon,
  GroupIcon,
  DataInputIcon,
  DataOutputIcon,
  IntermediateCatchEventIcon,
  IntermediateThrowEventIcon,
  LaneIcon,
  StartEventIcon,
  SubProcessIcon,
  TaskIcon,
  TextAnnotationIcon,
} from "./nodes/NodeIcons";
import { CodeIcon } from "@myoxus/icons/react";
import { UsersIcon as PeopleCarryIcon } from "@myoxus/icons/react";
import { SettingsIcon as ServicesIcon } from "@myoxus/icons/react";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { BpmnDiagramLhsPanel } from "../store/Store";
import { addOrGetProcessAndDiagramElements } from "../mutations/addOrGetProcessAndDiagramElements";
import { Correlations } from "../propertiesPanel/correlations/Correlations";
import { Variables } from "../propertiesPanel/variables/Variables";
import { addVariable } from "../mutations/addVariable";
import { snapShapeDimensions } from "../../xyflow/snapgrid/SnapGrid";
import { generateUuid } from "../../xyflow/uuid/uuid";
import { NODE_LAYERS } from "../../xyflow/nodes/Hooks";
import { getNewNodeDefaultName } from "../mutations/addStandaloneNode";
import { addStandaloneNode } from "../mutations/addStandaloneNode";
import { setSubProcessKind } from "../mutations/activity";
import { PropertiesManager } from "../propertiesPanel/propertiesManager/PropertiesManager";
import { useBpmnEditorI18n } from "../i18n";
import { bpmnConstructState } from "../../source-profile";
export const MIME_TYPE_FOR_BPMN_EDITOR_NEW_NODE_FROM_PALETTE =
  "application/myoxus-bpmn-editor--new-node-from-palette";
export function BpmnPalette({ pulse: _pulse }: { pulse: boolean }) {
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const readOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const flow = RF.useReactFlow();
  const width = RF.useStore((s) => s.width);
  const height = RF.useStore((s) => s.height);
  const onDragStart = useCallback(
    <T extends BpmnNodeType>(
      event: React.DragEvent,
      nodeType: T,
      element: keyof typeof elementToNodeType,
      bpmnElement?: BpmnNodeElement,
    ) => {
      if (readOnly) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(
        MIME_TYPE_FOR_BPMN_EDITOR_NEW_NODE_FROM_PALETTE,
        JSON.stringify({
          nodeType,
          element,
        }),
      );
      event.dataTransfer.effectAllowed = "move";

      // Remove default effect of dragging elements.
      const transparentDiv = document.createElement("div");
      transparentDiv.style.width = "1px";
      transparentDiv.style.height = "1px";
      transparentDiv.style.opacity = "0";
      document.body.append(transparentDiv);
      event.dataTransfer.setDragImage(transparentDiv, 0, 0);
      setTimeout(() => {
        transparentDiv.remove();
      }, 0);
      bpmnEditorStoreApi.setState((s) => {
        const snapGrid = s.xyFlowReactKieDiagram.snapGrid;
        const bpmnShape = {
          "@_id": generateUuid(),
          "dc:Bounds": {
            ...DEFAULT_NODE_SIZES[nodeType]({
              snapGrid,
            }),
            "@_x": 0,
            "@_y": 0,
          },
        };
        const position = {
          x: bpmnShape["dc:Bounds"]["@_x"],
          y: bpmnShape["dc:Bounds"]["@_y"],
        };
        const dimensions = snapShapeDimensions(
          snapGrid,
          bpmnShape,
          MIN_NODE_SIZES[nodeType]({
            snapGrid,
          }),
        );
        s.xyFlowReactKieDiagram.newNodeProjection = {
          id: generateUuid(),
          type: nodeType,
          hidden: true,
          position,
          width: dimensions.width,
          height: dimensions.height,
          data: {
            parentXyFlowNode: undefined,
            shape: bpmnShape,
            shapeIndex: -1,
            bpmnElement: bpmnElement ?? {
              "@_id": generateUuid(),
              "@_name": getNewNodeDefaultName({
                type: nodeType,
                element,
              }),
              __$$element: element as any,
            },
          },
          zIndex: NODE_LAYERS.ATTACHED_NODES,
          style: {
            width: dimensions.width,
            height: dimensions.height,
            zIndex: NODE_LAYERS.ATTACHED_NODES,
          },
        };
      });
    },
    [bpmnEditorStoreApi, readOnly],
  );
  const onDragEnd = useCallback(() => {
    // Makes sure there's no leftovers even when user pressed Esc during drag.
    bpmnEditorStoreApi.setState(
      (s) => (s.xyFlowReactKieDiagram.newNodeProjection = undefined),
    );
  }, [bpmnEditorStoreApi]);
  const openLhsPanel = useBpmnEditorStore((s) => s.diagram.openLhsPanel);
  const process = useBpmnEditorStore(
    (s) =>
      addOrGetProcessAndDiagramElements({
        definitions: s.bpmn.model.definitions,
      }).process,
  );
  const { i18n } = useBpmnEditorI18n();
  const panels = [
    {
      value: BpmnDiagramLhsPanel.VARIABLES,
      construct: "property",
      label: i18n.bpmnPalette.processVariables,
      Icon: CodeIcon,
      content: <Variables p={process} EmptyState={VariablesEmptyState} />,
    },
    {
      value: BpmnDiagramLhsPanel.CORRELATIONS,
      construct: "correlationSubscription",
      label: i18n.bpmnPalette.correlations,
      Icon: PeopleCarryIcon,
      content: <Correlations />,
    },
    {
      value: BpmnDiagramLhsPanel.PROPERTIES_MANAGEMENT,
      construct: "itemDefinition",
      label: i18n.bpmnPalette.propertiesManagement,
      Icon: ServicesIcon,
      content: <PropertiesManager />,
    },
  ];
  const palette = [
    {
      type: NODE_TYPES.startEvent,
      element: "startEvent",
      label: i18n.bpmnPalette.startEvents,
      Icon: StartEventIcon,
    },
    {
      type: NODE_TYPES.intermediateCatchEvent,
      element: "intermediateCatchEvent",
      label: i18n.bpmnPalette.intermediateCatchEvents,
      Icon: IntermediateCatchEventIcon,
    },
    {
      type: NODE_TYPES.intermediateThrowEvent,
      element: "intermediateThrowEvent",
      label: i18n.bpmnPalette.intermediateThrowEvents,
      Icon: IntermediateThrowEventIcon,
    },
    {
      type: NODE_TYPES.endEvent,
      element: "endEvent",
      label: i18n.bpmnPalette.endEvents,
      Icon: EndEventIcon,
    },
    {
      type: NODE_TYPES.task,
      element: "task",
      label: i18n.bpmnPalette.tasks,
      Icon: TaskIcon,
    },
    ...(
      [
        ["userTask", t["com.myoxus.editor.shape.bpmn.user-task"]()],
        ["manualTask", t["com.myoxus.editor.shape.bpmn.manual-task"]()],
        [
          "businessRuleTask",
          t["com.myoxus.editor.shape.bpmn.business-rule-task"](),
        ],
        ["serviceTask", t["com.myoxus.editor.shape.bpmn.service-task"]()],
        ["scriptTask", t["com.myoxus.editor.shape.bpmn.script-task"]()],
        ["sendTask", t["com.myoxus.editor.shape.bpmn.send-task"]()],
        ["receiveTask", t["com.myoxus.editor.shape.bpmn.receive-task"]()],
      ] as const
    ).map(([element, label]) => ({
      type: NODE_TYPES.task,
      element,
      label,
      Icon: () => <TaskIcon variant={element} palette />,
    })),
    {
      type: NODE_TYPES.task,
      element: "callActivity",
      label: i18n.bpmnPalette.callActivity,
      Icon: CallActivityIcon,
    },
    {
      type: NODE_TYPES.subProcess,
      element: "subProcess",
      label: i18n.bpmnPalette.subProcesses,
      Icon: () => <SubProcessIcon palette />,
    },
    {
      type: NODE_TYPES.subProcess,
      element: "adHocSubProcess",
      label: t["com.myoxus.editor.bpmn.adhoc-subprocess"](),
      Icon: () => <SubProcessIcon palette adHoc />,
    },
    {
      type: NODE_TYPES.subProcess,
      element: "transaction",
      label: t["com.myoxus.editor.bpmn.transaction"](),
      Icon: () => <SubProcessIcon variant="transaction" palette />,
    },
    {
      type: NODE_TYPES.subProcess,
      element: "subProcess",
      eventMode: true,
      label: t["com.myoxus.editor.bpmn.event-subprocess"](),
      Icon: () => <SubProcessIcon variant="event" palette />,
    },
    {
      type: NODE_TYPES.gateway,
      element: "exclusiveGateway",
      label: i18n.bpmnPalette.gateways,
      Icon: () => <GatewayIcon variant="exclusiveGateway" palette />,
    },
    ...(
      [
        [
          "inclusiveGateway",
          t["com.myoxus.editor.shape.bpmn.inclusive-gateway-or"](),
        ],
        [
          "parallelGateway",
          t["com.myoxus.editor.shape.bpmn.parallel-gateway-and"](),
        ],
        [
          "eventBasedGateway",
          t["com.myoxus.editor.shape.bpmn.event-based-gateway"](),
        ],
        ["complexGateway", t["com.myoxus.editor.shape.bpmn.complex-gateway"]()],
      ] as const
    ).map(([element, label]) => ({
      type: NODE_TYPES.gateway,
      element,
      label,
      Icon: () => <GatewayIcon variant={element} palette />,
    })),
    {
      type: NODE_TYPES.lane,
      element: "lane",
      label: i18n.bpmnPalette.lanes,
      Icon: LaneIcon,
    },
    {
      type: NODE_TYPES.dataObject,
      element: "dataObject",
      label: i18n.bpmnPalette.dataObject,
      Icon: DataObjectIcon,
    },
    {
      type: NODE_TYPES.dataObject,
      element: "dataObjectReference",
      label: t["com.myoxus.editor.bpmn.data-object-reference"](),
      Icon: DataObjectIcon,
    },
    {
      type: NODE_TYPES.dataObject,
      element: "dataInput",
      label: t["com.myoxus.editor.bpmn.data-input"](),
      Icon: DataInputIcon,
    },
    {
      type: NODE_TYPES.dataObject,
      element: "dataOutput",
      label: t["com.myoxus.editor.bpmn.data-output"](),
      Icon: DataOutputIcon,
    },
    {
      type: NODE_TYPES.dataObject,
      element: "dataStoreReference",
      label: t["com.myoxus.editor.shape.bpmn.data-store"](),
      Icon: DataStoreIcon,
    },
    {
      type: NODE_TYPES.group,
      element: "group",
      label: i18n.bpmnPalette.group,
      Icon: GroupIcon,
    },
    {
      type: NODE_TYPES.textAnnotation,
      element: "textAnnotation",
      label: i18n.bpmnPalette.textAnnotation,
      Icon: TextAnnotationIcon,
    },
  ] as const;
  return (
    // Bound the floating panel to both canvas edges so Mantine owns overflow;
    // top-only anchoring otherwise clips commands below the canvas viewport.
    <RF.Panel position="top-left" style={{ bottom: 0 }}>
      <Scrollable.Viewport
        scrollbars="y"
        offsetScrollbars="y"
        tabIndex={-1}
        aria-label={t["com.myoxus.actions"]()}
      >
        {/* Keep native focus outlines inside the scroll viewport's clip edge. */}
        <Stack p="xs">
          {panels
            // Definitions management is not a graphical palette capability. Its
            // focused fields preserve the rest of each standard declaration.
            .filter(
              (panel) =>
                panel.value === BpmnDiagramLhsPanel.PROPERTIES_MANAGEMENT ||
                bpmnConstructState(panel.construct) === "editable",
            )
            .map(({ value, label, Icon, content }) =>
              value === BpmnDiagramLhsPanel.PROPERTIES_MANAGEMENT ||
              value === BpmnDiagramLhsPanel.VARIABLES ? (
                // Definition/property tables are forms, not anchored canvas menus.
                // A native modal owns their scroll/focus outside canvas transforms.
                <React.Fragment key={value}>
                  <IconButton
                    tooltip={label}
                    aria-expanded={openLhsPanel === value}
                    onClick={() =>
                      bpmnEditorStoreApi.setState((state) => {
                        state.diagram.openLhsPanel = value;
                      })
                    }
                  >
                    <Icon />
                  </IconButton>
                  <Modal
                    open={openLhsPanel === value}
                    title={label}
                    onOpenChange={(open) =>
                      bpmnEditorStoreApi.setState((state) => {
                        state.diagram.openLhsPanel = open
                          ? value
                          : BpmnDiagramLhsPanel.NONE;
                      })
                    }
                  >
                    {content}
                  </Modal>
                </React.Fragment>
              ) : (
                <Popover
                  key={value}
                  open={openLhsPanel === value}
                  position="right"
                  onOpenChange={(open) =>
                    bpmnEditorStoreApi.setState((s) => {
                      s.diagram.openLhsPanel = open
                        ? value
                        : BpmnDiagramLhsPanel.NONE;
                    })
                  }
                >
                  <PopoverTarget>
                    <IconButton
                      tooltip={label}
                      aria-expanded={openLhsPanel === value}
                      onClick={() =>
                        bpmnEditorStoreApi.setState((s) => {
                          s.diagram.openLhsPanel =
                            s.diagram.openLhsPanel === value
                              ? BpmnDiagramLhsPanel.NONE
                              : value;
                        })
                      }
                    >
                      <Icon />
                    </IconButton>
                  </PopoverTarget>
                  <PopoverContent>{content}</PopoverContent>
                </Popover>
              ),
            )}
          {palette
            .filter((item) => bpmnConstructState(item.element) === "editable")
            .map((item) => {
              const { type, element, label, Icon } = item;
              const eventMode = "eventMode" in item && item.eventMode;
              return (
                <IconButton
                  key={eventMode ? "eventSubProcess" : element}
                  tooltip={label}
                  disabled={readOnly}
                  draggable={!readOnly}
                  onDragStart={(event) =>
                    onDragStart(
                      event,
                      type,
                      element,
                      eventMode
                        ? {
                            "@_id": generateUuid(),
                            __$$element: "subProcess",
                            "@_triggeredByEvent": true,
                          }
                        : undefined,
                    )
                  }
                  onDragEnd={onDragEnd}
                  onClick={() => {
                    if (readOnly) return;
                    const viewport = flow.getViewport();
                    const bounds = {
                      ...DEFAULT_NODE_SIZES[type]({
                        snapGrid:
                          bpmnEditorStoreApi.getState().xyFlowReactKieDiagram
                            .snapGrid,
                      }),
                      "@_x": (width / 2 - viewport.x) / viewport.zoom,
                      "@_y": (height / 2 - viewport.y) / viewport.zoom,
                    };
                    bpmnEditorStoreApi.setState((s) => {
                      const { id } = addStandaloneNode({
                        definitions: s.bpmn.model.definitions,
                        __readonly_element: element,
                        __readonly_newNode: {
                          type,
                          bounds,
                          data: undefined,
                        },
                      });
                      if (eventMode)
                        setSubProcessKind(
                          s.bpmn.model.definitions,
                          id,
                          "event",
                        );
                      s.xyFlowReactKieDiagram._selectedNodes = [id];
                    });
                  }}
                >
                  <Icon />
                </IconButton>
              );
            })}
        </Stack>
      </Scrollable.Viewport>
    </RF.Panel>
  );
}
function VariablesEmptyState({
  addButton: _,
}: {
  addButton: React.JSX.Element;
}) {
  const { i18n } = useBpmnEditorI18n();
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  return (
    <EmptyState
      title={
        isReadOnly
          ? i18n.bpmnPalette.noVariables
          : i18n.bpmnPalette.noVariablesYet
      }
      description={i18n.bpmnPalette.emptyBpmnBody}
      cta={
        !isReadOnly && (
          <Button
            onClick={() => {
              bpmnEditorStoreApi.setState((s) => {
                const { process } = addOrGetProcessAndDiagramElements({
                  definitions: s.bpmn.model.definitions,
                });
                addVariable({
                  definitions: s.bpmn.model.definitions,
                  pId: process["@_id"],
                });
              });
            }}
          >
            {i18n.bpmnPalette.addVariable}
          </Button>
        )
      }
    />
  );
}
