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

import { useEffect, useRef } from "react";
import { useBpmnEditor } from "../BpmnEditorContext";
import { useI18n } from "@myoxus/i18n";
import { notify } from "@myoxus/ui-facade";
import * as RF from "@xyflow/react";
import {
  buildClipboardFromDiagram,
  getClipboard,
  type BpmnEditorDiagramClipboard,
} from "../clipboard/Clipboard";
import { useCommands } from "../commands/CommandsContextProvider";
import { useBpmnEditorStoreApi } from "../store/StoreContext";
import { DEFAULT_VIEWPORT } from "../../xyflow/diagram/XyFlowReactKieDiagram";
import {
  type BpmnDiagramEdgeData,
  type BpmnNodeType,
  DEFAULT_NODE_SIZES,
  NODE_TYPES,
} from "./BpmnDiagramDomain";
import {
  CONTAINER_NODES_DESIRABLE_PADDING,
  getBounds,
} from "../../xyflow/maths/DcMaths";
import { type BpmnDiagramNodeData } from "./BpmnDiagramDomain";
import { addStandaloneNode } from "../mutations/addStandaloneNode";
import { addConnectedNode } from "../mutations/addConnectedNode";
import {
  getNewBpmnIdRandomizer,
  indexBpmnIds,
} from "../idRandomizer/bpmn-id-randomizer";
import { addOrGetProcessAndDiagramElements } from "../mutations/addOrGetProcessAndDiagramElements";
import { dataAssociationById } from "../mutations/data-association";
import { dataAssociationRouteEndpoints } from "../mutations/data-association-context";
import { addOrGetLanes } from "../mutations/addOrGetLanes";
import { deleteEdge } from "../mutations/deleteEdge";
import { deleteNode } from "../mutations/deleteNode";
import { inspectBpmnEditability } from "../../process-source";
export function BpmnDiagramCommands() {
  const xyFlowStoreApi = RF.useStoreApi<
    RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
    RF.Edge<BpmnDiagramEdgeData>
  >();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { commandsRef, reportReady } = useCommands();
  const xyFlow = RF.useReactFlow<
    RF.Node<BpmnDiagramNodeData, BpmnNodeType>,
    RF.Edge<BpmnDiagramEdgeData>
  >();
  const { bpmnEditorRootElementRef } = useBpmnEditor();
  const t = useI18n();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const root = bpmnEditorRootElementRef.current;
    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.defaultPrevented
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable=true]")
      )
        return;
      // Canvas zoom never reaches the browser's document zoom or the outer
      // editor's shortcuts. Native XYFlow viewport changes are source-free.
      if (
        event.target instanceof Element &&
        event.target.closest(".react-flow")
      ) {
        const zoom =
          event.key === "+" || event.key === "="
            ? () => xyFlow.zoomIn()
            : event.key === "-"
              ? () => xyFlow.zoomOut()
              : event.key === "0"
                ? () => xyFlow.fitView()
                : undefined;
        if (zoom) {
          event.preventDefault();
          event.stopPropagation();
          void zoom();
          return;
        }
      }
      const command =
        event.key.toLowerCase() === "z"
          ? event.shiftKey
            ? commandsRef.current.redo
            : commandsRef.current.undo
          : event.key.toLowerCase() === "y"
            ? commandsRef.current.redo
            : event.key.toLowerCase() === "c"
              ? commandsRef.current.copy
              : event.key.toLowerCase() === "v"
                ? commandsRef.current.paste
                : event.key.toLowerCase() === "x"
                  ? commandsRef.current.cut
                  : event.key.toLowerCase() === "d"
                    ? commandsRef.current.duplicate
                    : event.key.toLowerCase() === "a"
                      ? commandsRef.current.selectAll
                      : undefined;
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      Promise.resolve()
        .then(command)
        .catch(() => notify.error(t["com.myoxus.common.operation-failed"]()));
    };
    root?.addEventListener("keydown", keydown);
    return () => root?.removeEventListener("keydown", keydown);
  }, [bpmnEditorRootElementRef, commandsRef, t, xyFlow]);
  useEffect(() => {
    commandsRef.current.undo = () =>
      bpmnEditorStoreApi.setState((s) => s.dispatch(s).undo());
    commandsRef.current.redo = () =>
      bpmnEditorStoreApi.setState((s) => s.dispatch(s).redo());
  }, [bpmnEditorStoreApi, commandsRef]);

  // Cancel action
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.cancelAction = async () => {
      xyFlowStoreApi.setState((xyFlowState) => {
        if (xyFlowState.connection.inProgress) {
          xyFlowState.cancelConnection();
          bpmnEditorStoreApi.setState((state) => {
            state.xyFlowReactKieDiagram.ongoingConnection = undefined;
          });
        } else {
          (document.activeElement as any)?.blur?.();
        }
        return xyFlowState;
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlowStoreApi]);

  // Reset position to origin
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.resetPosition = async () => {
      xyFlow.setViewport(DEFAULT_VIEWPORT, {
        duration: 200,
      });
    };
  }, [commandsRef, xyFlow]);

  // Focus on selection
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.focusOnSelection = async () => {
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length <= 0) {
        return;
      }
      const bounds = getBounds({
        nodes: selectedNodes,
        padding: 100,
      });
      xyFlow.fitBounds(
        {
          x: bounds["@_x"],
          y: bounds["@_y"],
          width: bounds["@_width"],
          height: bounds["@_height"],
        },
        {
          duration: 200,
        },
      );
    };
  }, [commandsRef, xyFlow]);

  // Cut nodes
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.cut = async () => {
      const sourceAtInvocation = bpmnEditorStoreApi.getState().bpmn.model;
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const { clipboard, copiedEdgesById, danglingEdgesById, copiedNodesById } =
        buildClipboardFromDiagram(
          xyFlowStoreApi.getState(),
          bpmnEditorStoreApi.getState(),
        );
      await navigator.clipboard.writeText(JSON.stringify(clipboard));
      if (
        !mounted.current ||
        bpmnEditorStoreApi.getState().settings.isReadOnly ||
        bpmnEditorStoreApi.getState().bpmn.model !== sourceAtInvocation
      )
        return;
      bpmnEditorStoreApi.setState((state) => {
        [...copiedEdgesById.values(), ...danglingEdgesById.values()].forEach(
          (edge) => {
            if (
              (edge.data?.bpmnElement.__$$element === "dataInputAssociation" ||
                edge.data?.bpmnElement.__$$element ===
                  "dataOutputAssociation") &&
              !dataAssociationById(
                state.bpmn.model.definitions,
                edge.data.bpmnElement["@_id"],
              )
            )
              return;
            deleteEdge({
              definitions: state.bpmn.model.definitions,
              __readonly_edgeId: edge.id,
            });
            state.dispatch(state).setEdgeStatus(edge.id, {
              selected: false,
              draggingWaypoint: false,
            });
          },
        );

        // Delete nodes
        xyFlowStoreApi
          .getState()
          .nodes.forEach((node: RF.Node<BpmnDiagramNodeData>) => {
            if (copiedNodesById.has(node.id)) {
              deleteNode({
                definitions: state.bpmn.model.definitions,
                __readonly_bpmnElementId: node.data.bpmnElement?.["@_id"],
                __readonly_bpmnEdgeData: state
                  .computed(state)
                  .getDiagramData()
                  .edges.flatMap((edge) => edge.data!),
              });
              state.dispatch(state).setNodeStatus(node.id, {
                selected: false,
                dragging: false,
                resizing: false,
              });
            }
          });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlowStoreApi]);

  // Copy nodes
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.copy = async () => {
      const { clipboard } = buildClipboardFromDiagram(
        xyFlowStoreApi.getState(),
        bpmnEditorStoreApi.getState(),
      );
      await navigator.clipboard.writeText(JSON.stringify(clipboard));
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlowStoreApi]);

  // Paste nodes
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    const pasteClipboard = (clipboard: BpmnEditorDiagramClipboard) => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      getNewBpmnIdRandomizer({
        ...clipboard.namespaceDeclarations,
        "@_targetNamespace": clipboard.namespaceWhereClipboardWasCreatedFrom,
      })
        .ack({
          json: clipboard.processFlowElements,
          type: "BPMN20__tProcess",
          attr: "flowElement",
        })
        .ack({
          json: clipboard.artifacts,
          type: "BPMN20__tProcess",
          attr: "artifact",
        })
        .ack({
          json: clipboard.lanes,
          type: "BPMN20__tLaneSet",
          attr: "lane",
        })
        .ack({
          json: clipboard.processIo,
          type: "BPMN20__tProcess",
          attr: "ioSpecification",
        })
        .ack({
          json: clipboard.shapes,
          type: "BPMNDI__BPMNPlane",
          attr: "di:DiagramElement",
          __$$element: "bpmndi:BPMNShape",
        })
        .ack({
          json: clipboard.edges,
          type: "BPMNDI__BPMNPlane",
          attr: "di:DiagramElement",
          __$$element: "bpmndi:BPMNEdge",
        })
        .randomize({
          skipAlreadyAttributedIds: false,
        });
      bpmnEditorStoreApi.setState((state) => {
        const { process, plane } = addOrGetProcessAndDiagramElements({
          definitions: state.bpmn.model.definitions,
        });
        const diagramElements = (plane["di:DiagramElement"] ??= []);
        if (clipboard.processIo) {
          if (!process.ioSpecification)
            process.ioSpecification = clipboard.processIo;
          else {
            const spec = process.ioSpecification,
              copy = clipboard.processIo;
            for (const key of [
              "dataInput",
              "dataOutput",
              "inputSet",
              "outputSet",
            ] as const)
              (spec[key] ??= []).push(...(copy[key] ?? []));
          }
        }
        process.flowElement ??= [];
        process.flowElement.push(...clipboard.processFlowElements);
        process.artifact ??= [];
        process.artifact.push(...clipboard.artifacts);
        if (clipboard.lanes.length) {
          addOrGetLanes({
            definitions: state.bpmn.model.definitions,
          }).lanes.push(...clipboard.lanes);
        }
        diagramElements.push(
          ...clipboard.shapes.map((s) => ({
            ...s,
            __$$element: "bpmndi:BPMNShape" as const,
          })),
        );
        diagramElements.push(
          ...clipboard.edges.map((s) => ({
            ...s,
            __$$element: "bpmndi:BPMNEdge" as const,
          })),
        );
        // The private clipboard is another semantic entry, not permission to
        // bypass the source profile. Throwing aborts this Immer draft atomically.
        if (
          inspectBpmnEditability(state.bpmn.model.definitions).state !==
          "editable"
        )
          throw new Error("BPMN_UNSUPPORTED_ELEMENT");
        state.xyFlowReactKieDiagram._selectedNodes = [
          ...clipboard.processFlowElements.filter(
            (flowElement) => flowElement.__$$element !== "sequenceFlow",
          ),
          ...clipboard.artifacts,
          ...clipboard.lanes,
          ...(clipboard.processIo?.dataInput ?? []),
          ...(clipboard.processIo?.dataOutput ?? []),
        ].map((s) => s["@_id"]);
        const references = indexBpmnIds(state.bpmn.model.definitions);
        const pastedEdges = new Set(
          clipboard.edges.map((edge) => edge["@_id"]),
        );
        state.xyFlowReactKieDiagram._selectedEdges = diagramElements
          .filter(
            (element) =>
              element.__$$element === "bpmndi:BPMNEdge" &&
              pastedEdges.has(element["@_id"]),
          )
          .map((element) => {
            const id = references.resolveReference(
                element,
                element["@_bpmnElement"],
              )!,
              mapping = dataAssociationById(state.bpmn.model.definitions, id);
            const endpoint =
              mapping && element.__$$element === "bpmndi:BPMNEdge"
                ? dataAssociationRouteEndpoints(
                    state.bpmn.model.definitions,
                    mapping,
                    element,
                  )
                : undefined;
            return endpoint && endpoint.sourceId !== endpoint.sourceIds[0]
              ? element["@_id"]
              : id;
          });
      });
    };
    commandsRef.current.paste = async () => {
      const sourceAtInvocation = bpmnEditorStoreApi.getState().bpmn.model;
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const text = await navigator.clipboard.readText();
      if (
        !mounted.current ||
        bpmnEditorStoreApi.getState().settings.isReadOnly ||
        bpmnEditorStoreApi.getState().bpmn.model !== sourceAtInvocation
      )
        return;
      const clipboard = getClipboard(text);
      if (clipboard) pasteClipboard(clipboard);
    };
    commandsRef.current.duplicate = () => {
      const state = bpmnEditorStoreApi.getState();
      if (state.settings.isReadOnly) return;
      const { clipboard } = buildClipboardFromDiagram(
        xyFlowStoreApi.getState(),
        state,
      );
      if (!clipboard.shapes.length) return;
      // Translate the private fragment once, including nested shapes, manual
      // labels and routes. Remapping/insertion stays the ordinary atomic paste
      // command; originals and the user's OS clipboard are never modified.
      const grid = state.xyFlowReactKieDiagram.snapGrid;
      const translate = (point: { "@_x": number; "@_y": number }) => {
        point["@_x"] += grid.x * 2;
        point["@_y"] += grid.y * 2;
      };
      for (const shape of clipboard.shapes) {
        translate(shape["dc:Bounds"]);
        if (shape["bpmndi:BPMNLabel"]?.["dc:Bounds"])
          translate(shape["bpmndi:BPMNLabel"]["dc:Bounds"]);
      }
      for (const edge of clipboard.edges) {
        for (const point of edge["di:waypoint"]) translate(point);
        if (edge["bpmndi:BPMNLabel"]?.["dc:Bounds"])
          translate(edge["bpmndi:BPMNLabel"]["dc:Bounds"]);
      }
      pasteClipboard(clipboard);
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlowStoreApi]);

  // Select/deselect all nodes
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.selectAll = async () => {
      const allNodeIds = xyFlowStoreApi.getState().nodes.map((s) => s.id);
      const allEdgeIds = xyFlowStoreApi.getState().edges.map((s) => s.id);
      bpmnEditorStoreApi.setState((state) => {
        const allSelectedNodesSet = new Set(
          state.xyFlowReactKieDiagram._selectedNodes,
        );
        const allSelectedEdgesSet = new Set(
          state.xyFlowReactKieDiagram._selectedEdges,
        );

        // If everything is selected, deselect everything.
        if (
          allNodeIds.every(
            (id) =>
              allSelectedNodesSet.has(id) &&
              allEdgeIds.every((id) => allSelectedEdgesSet.has(id)),
          )
        ) {
          state.xyFlowReactKieDiagram._selectedNodes = [];
          state.xyFlowReactKieDiagram._selectedEdges = [];
        } else {
          state.xyFlowReactKieDiagram._selectedNodes = allNodeIds;
          state.xyFlowReactKieDiagram._selectedEdges = allEdgeIds;
        }
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlowStoreApi]);

  // Create group wrapping selection
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.createGroup = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length <= 0) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        if (state.xyFlowReactKieDiagram._selectedNodes.length <= 0) {
          return;
        }
        const { id: newNodeId } = addStandaloneNode({
          definitions: state.bpmn.model.definitions,
          __readonly_newNode: {
            type: NODE_TYPES.group,
            bounds: getBounds({
              nodes: selectedNodes,
              padding: CONTAINER_NODES_DESIRABLE_PADDING,
            }),
            data: undefined,
          },
          __readonly_element: "group",
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create task node from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendTaskNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.startEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.task,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.task]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.task]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create gateway node from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendGatewayNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.startEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.gateway,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.gateway]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.gateway]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create intermediate catch event from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendIntermediateCatchEventNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.startEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.intermediateCatchEvent,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.intermediateCatchEvent]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.intermediateCatchEvent](
                {
                  snapGrid: state.xyFlowReactKieDiagram.snapGrid,
                },
              )["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create intermediate throw event from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendIntermediateThrowEventNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.startEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.intermediateThrowEvent,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.intermediateThrowEvent]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.intermediateThrowEvent](
                {
                  snapGrid: state.xyFlowReactKieDiagram.snapGrid,
                },
              )["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create end event from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendEndEventNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.endEvent,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.endEvent]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.endEvent]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Create Text Annotation from current node
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.appendTextAnnotationNode = async () => {
      if (bpmnEditorStoreApi.getState().settings.isReadOnly) return;
      const selectedNodes = xyFlow.getNodes().filter((s) => s.selected);
      if (selectedNodes.length !== 1) {
        return;
      }

      // Check node type
      if (
        selectedNodes[0].type !== NODE_TYPES.startEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateCatchEvent &&
        selectedNodes[0].type !== NODE_TYPES.intermediateThrowEvent &&
        selectedNodes[0].type !== NODE_TYPES.task &&
        selectedNodes[0].type !== NODE_TYPES.endEvent &&
        selectedNodes[0].type !== NODE_TYPES.subProcess &&
        selectedNodes[0].type !== NODE_TYPES.gateway &&
        selectedNodes[0].type !== NODE_TYPES.lane &&
        selectedNodes[0].type !== NODE_TYPES.dataObject &&
        selectedNodes[0].type !== NODE_TYPES.group
      ) {
        return;
      }
      bpmnEditorStoreApi.setState((state) => {
        const { id: newNodeId } = addConnectedNode({
          definitions: state.bpmn.model.definitions,
          __readonly_sourceNode: {
            bounds: selectedNodes[0].data.shape["dc:Bounds"],
            id: selectedNodes[0].id,
            shapeId: selectedNodes[0].data.shape["@_id"],
            type: selectedNodes[0].type as BpmnNodeType,
          },
          __readonly_newNode: {
            type: NODE_TYPES.textAnnotation,
            bounds: {
              "@_x":
                selectedNodes[0].data.shape["dc:Bounds"]["@_x"] +
                selectedNodes[0].data.shape["dc:Bounds"]["@_width"] +
                100,
              "@_y": selectedNodes[0].data.shape["dc:Bounds"]["@_y"],
              "@_width": DEFAULT_NODE_SIZES[NODE_TYPES.textAnnotation]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_width"],
              "@_height": DEFAULT_NODE_SIZES[NODE_TYPES.textAnnotation]({
                snapGrid: state.xyFlowReactKieDiagram.snapGrid,
              })["@_height"],
            },
          },
        });
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
        state.dispatch(state).setNodeStatus(newNodeId, {
          selected: true,
        });
      });
    };
  }, [bpmnEditorStoreApi, commandsRef, xyFlow]);

  // Show Properties panel
  useEffect(() => {
    if (!commandsRef.current) {
      return;
    }
    commandsRef.current.togglePropertiesPanel = async () => {
      bpmnEditorStoreApi.setState((state) => {
        state.propertiesPanel.isOpen = !state.propertiesPanel.isOpen;
      });
    };
  }, [bpmnEditorStoreApi, commandsRef]);
  // ReactFlow can mount its children after the outer editor's effects. Publish
  // readiness only after every command above has its live implementation.
  useEffect(() => reportReady(), [reportReady]);
  return null;
}
