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
  Popover,
  PopoverTarget,
  PopoverContent,
  Modal,
  Scrollable,
  Stack,
  Group,
  Accordion,
  AccordionItem,
  AccordionControl,
  AccordionPanel,
  MyoxusTextInput,
  Text,
  Card,
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
import { PropertiesManager } from "../propertiesPanel/propertiesManager/PropertiesManager";
import { useBpmnEditorI18n } from "../i18n";
import { bpmnConstructState } from "../../source-profile";
import { PaletteNotationContext } from "../../xyflow/nodes/NodeIcons";
export const MIME_TYPE_FOR_BPMN_EDITOR_NEW_NODE_FROM_PALETTE =
  "application/myoxus-bpmn-editor--new-node-from-palette";
export function BpmnPalette({ pulse: _pulse }: { pulse: boolean }) {
  const t = useI18n();
  const [query, setQuery] = React.useState("");
  const [openGroups, setOpenGroups] = React.useState<string[]>([
    "events",
    "tasks",
    "gateways",
  ]);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const denied = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const flowStore = RF.useStoreApi();
  const interactive = RF.useStore((s) => s.nodesDraggable);
  const readOnly = denied || !interactive;
  const beginNodeProjection = useCallback(
    <T extends BpmnNodeType>(
      event: React.DragEvent | undefined,
      nodeType: T,
      element: keyof typeof elementToNodeType,
      bpmnElement?: BpmnNodeElement,
    ) => {
      if (
        bpmnEditorStoreApi.getState().settings.isReadOnly ||
        !flowStore.getState().nodesDraggable
      ) {
        event?.preventDefault();
        return;
      }
      if (event) {
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
      }
      const placementModel = bpmnEditorStoreApi.getState().bpmn.model;
      bpmnEditorStoreApi.setState((s) => {
        s.xyFlowReactKieDiagram.placementElement = event ? undefined : element;
        s.xyFlowReactKieDiagram.placementModel = event
          ? undefined
          : placementModel;
        s.xyFlowReactKieDiagram.ongoingConnection = undefined;
        s.xyFlowReactKieDiagram.edgeIdBeingUpdated = undefined;
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
          draggable: false,
          selectable: false,
          connectable: false,
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
            pointerEvents: "none",
            opacity: 0.5,
            width: dimensions.width,
            height: dimensions.height,
            zIndex: NODE_LAYERS.ATTACHED_NODES,
          },
        };
      });
    },
    [bpmnEditorStoreApi, flowStore],
  );
  const onDragEnd = useCallback(() => {
    // Makes sure there's no leftovers even when user pressed Esc during drag.
    bpmnEditorStoreApi.setState((s) => {
      s.xyFlowReactKieDiagram.newNodeProjection = undefined;
      s.xyFlowReactKieDiagram.placementElement = undefined;
      s.xyFlowReactKieDiagram.placementModel = undefined;
    });
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
        ["serviceTask", t["com.myoxus.editor.shape.bpmn.service-task"]()],
        [
          "businessRuleTask",
          t["com.myoxus.editor.shape.bpmn.business-rule-task"](),
        ],
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
      label: t["com.myoxus.editor.shape.bpmn.exclusive-gateway-xor"](),
      Icon: () => <GatewayIcon variant="exclusiveGateway" palette />,
    },
    ...(
      [
        [
          "parallelGateway",
          t["com.myoxus.editor.shape.bpmn.parallel-gateway-and"](),
        ],
        [
          "inclusiveGateway",
          t["com.myoxus.editor.shape.bpmn.inclusive-gateway-or"](),
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
  const groups = [
    { id: "events", label: t["com.myoxus.editor.bpmn.palette-events"]() },
    { id: "tasks", label: t["com.myoxus.editor.bpmn.palette-tasks"]() },
    { id: "gateways", label: i18n.bpmnPalette.gateways },
    {
      id: "containers",
      label: t["com.myoxus.editor.bpmn.palette-containers"](),
    },
    { id: "data", label: t["com.myoxus.editor.bpmn.palette-data"]() },
  ];
  const groupFor = (item: (typeof palette)[number]) => {
    if (
      item.element === "callActivity" ||
      item.type === NODE_TYPES.subProcess ||
      item.type === NODE_TYPES.lane
    )
      return "containers";
    if (item.type === NODE_TYPES.task) return "tasks";
    if (item.type === NODE_TYPES.gateway) return "gateways";
    if (
      [
        NODE_TYPES.startEvent,
        NODE_TYPES.endEvent,
        NODE_TYPES.intermediateCatchEvent,
        NODE_TYPES.intermediateThrowEvent,
      ].some((type) => type === item.type)
    )
      return "events";
    return "data";
  };
  const entries = palette.filter(
    (item) =>
      bpmnConstructState(item.element) === "editable" &&
      item.label
        .toLocaleLowerCase(t.language)
        .includes(query.trim().toLocaleLowerCase(t.language)),
  );
  const renderEntry = (item: (typeof palette)[number]) => {
    const { type, element, label, Icon } = item;
    const eventMode = "eventMode" in item && item.eventMode;
    return (
      <Button
        key={eventMode ? "eventSubProcess" : element}
        aria-label={label}
        size="large"
        disabled={readOnly}
        draggable={!readOnly}
        onDragStart={(event) =>
          beginNodeProjection(
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
        onClick={() =>
          beginNodeProjection(
            undefined,
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
      >
        <Group wrap="nowrap">
          <PaletteNotationContext.Provider value={true}>
            <Icon />
          </PaletteNotationContext.Provider>
          {label}
        </Group>
      </Button>
    );
  };
  return (
    // Bound the floating panel to both canvas edges so Mantine owns overflow;
    // top-only anchoring otherwise clips commands below the canvas viewport.
    <RF.Panel position="top-left" style={{ bottom: 0 }}>
      <Scrollable.Viewport
        data-bpmn-palette
        scrollbars="y"
        offsetScrollbars="y"
        tabIndex={-1}
        aria-label={t["com.myoxus.actions"]()}
      >
        {/* Keep native focus outlines inside the scroll viewport's clip edge. */}
        <Card>
          <Stack>
            <MyoxusTextInput
              label={t["com.myoxus.editor.bpmn.search-elements"]()}
              value={query}
              onChange={setQuery}
            />
            {query && (
              <Button onClick={() => setQuery("")}>
                {t["com.myoxus.editor.field.clear"]()}
              </Button>
            )}
            {entries.length === 0 && (
              <Text>{t["com.myoxus.cmdk.no-results"]()}</Text>
            )}
            <Accordion
              multiple
              value={
                query.trim() ? groups.map((group) => group.id) : openGroups
              }
              onChange={(value) => setOpenGroups(value as string[])}
            >
              {groups.map((group) => {
                const items = entries.filter(
                  (item) => groupFor(item) === group.id,
                );
                const primaryCount = query.trim()
                  ? items.length
                  : group.id === "tasks"
                    ? 4
                    : group.id === "gateways"
                      ? 3
                      : items.length;
                return (
                  <AccordionItem key={group.id} value={group.id}>
                    <AccordionControl>{group.label}</AccordionControl>
                    <AccordionPanel keepMounted>
                      <Stack>
                        {items.slice(0, primaryCount).map(renderEntry)}
                        {items.length > primaryCount && (
                          <Accordion>
                            <AccordionItem value="more">
                              <AccordionControl>
                                {t["com.myoxus.editor.toolbar.more"]()}
                              </AccordionControl>
                              <AccordionPanel keepMounted>
                                <Stack>
                                  {items.slice(primaryCount).map(renderEntry)}
                                </Stack>
                              </AccordionPanel>
                            </AccordionItem>
                          </Accordion>
                        )}
                      </Stack>
                    </AccordionPanel>
                  </AccordionItem>
                );
              })}
              <AccordionItem value="process-data">
                <AccordionControl>
                  {t["com.myoxus.editor.bpmn.process-data"]()}
                </AccordionControl>
                <AccordionPanel keepMounted>
                  <Stack>
                    {panels
                      // Definitions management is not a graphical palette capability. Its
                      // focused fields preserve the rest of each standard declaration.
                      .filter(
                        (panel) =>
                          panel.value ===
                            BpmnDiagramLhsPanel.PROPERTIES_MANAGEMENT ||
                          bpmnConstructState(panel.construct) === "editable",
                      )
                      .map(({ value, label, Icon, content }) =>
                        value === BpmnDiagramLhsPanel.PROPERTIES_MANAGEMENT ||
                        value === BpmnDiagramLhsPanel.VARIABLES ? (
                          // Definition/property tables are forms, not anchored canvas menus.
                          // A native modal owns their scroll/focus outside canvas transforms.
                          <React.Fragment key={value}>
                            <Button
                              prefix={<Icon />}
                              aria-label={label}
                              aria-expanded={openLhsPanel === value}
                              onClick={() =>
                                bpmnEditorStoreApi.setState((state) => {
                                  state.diagram.openLhsPanel = value;
                                })
                              }
                            >
                              {label}
                            </Button>
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
                              <Button
                                prefix={<Icon />}
                                aria-label={label}
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
                                {label}
                              </Button>
                            </PopoverTarget>
                            <PopoverContent>{content}</PopoverContent>
                          </Popover>
                        ),
                      )}
                  </Stack>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </Stack>
        </Card>
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
