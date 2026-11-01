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
  Group,
  IconButton,
  Popover,
  PopoverTarget,
  PopoverContent,
} from "@myoxus/ui-facade";
import { InfoIcon } from "@myoxus/icons/react";
import { MonitorIcon as VirtualMachineIcon } from "@myoxus/icons/react";
import { useCallback } from "react";
import * as RF from "@xyflow/react";
import { OverlaysPanel } from "../overlaysPanel/OverlaysPanel";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { useBpmnEditorI18n } from "../i18n";
import { useBpmnEditor } from "../BpmnEditorContext";
import { useI18n } from "@myoxus/i18n";
export function TopRightCornerPanels() {
  const { i18n } = useBpmnEditorI18n();
  const t = useI18n();
  const flow = RF.useReactFlow();
  const hasSelection = RF.useStore(
    (state) =>
      state.nodes.some((node) => node.selected) ||
      state.edges.some((edge) => edge.selected),
  );
  const locked = RF.useStore((state) => state.nodesDraggable === false);
  const readOnly = useBpmnEditorStore((state) => state.settings.isReadOnly);
  const diagram = useBpmnEditorStore((s) => s.diagram);
  const propertiesPanel = useBpmnEditorStore((s) => s.propertiesPanel);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { propertiesPanelFocusRef } = useBpmnEditor();
  const propertiesInvoker = useCallback(
    (button: HTMLButtonElement | null) => {
      if (button && propertiesPanelFocusRef.current === "invoker") {
        propertiesPanelFocusRef.current = null;
        button.focus();
      }
    },
    [propertiesPanelFocusRef],
  );
  const togglePropertiesPanel = useCallback(() => {
    propertiesPanelFocusRef.current = propertiesPanel.isOpen
      ? "invoker"
      : "panel";
    bpmnEditorStoreApi.setState((state) => {
      state.propertiesPanel.isOpen = !state.propertiesPanel.isOpen;
    });
  }, [bpmnEditorStoreApi, propertiesPanel.isOpen, propertiesPanelFocusRef]);
  const toggleOverlaysPanel = useCallback(() => {
    bpmnEditorStoreApi.setState((state) => {
      state.diagram.overlaysPanel.isOpen = !state.diagram.overlaysPanel.isOpen;
    });
  }, [bpmnEditorStoreApi]);
  return (
    <RF.Panel position="top-right">
      <Group>
        <Button
          disabled={!hasSelection || readOnly || locked}
          onClick={(event) => {
            const canvas =
              event.currentTarget.closest<HTMLElement>(".react-flow");
            const nodes = flow.getNodes().filter((node) => node.selected);
            const edges = flow.getEdges().filter((edge) => edge.selected);
            if (readOnly || locked || (!nodes.length && !edges.length)) return;
            // The fork's onBeforeDelete owns one atomic semantic + DI command,
            // including incident flows and rejected-command rollback.
            void flow.deleteElements({ nodes, edges }).then(() => {
              // The controlled graph may remove elements in onBeforeDelete,
              // before RF returns its deleted arrays. Check the committed graph
              // instead, so a rejected command never steals focus.
              requestAnimationFrame(() => {
                const currentCanvas = canvas?.isConnected
                  ? canvas
                  : document.querySelector<HTMLElement>(
                      ".myoxus-bpmn-diagram.react-flow",
                    );
                const remaining = new Set(
                  [
                    ...(currentCanvas?.querySelectorAll<HTMLElement>(
                      ".react-flow__node, .react-flow__edge",
                    ) ?? []),
                  ].map((element) => element.dataset.id),
                );
                if (
                  currentCanvas &&
                  (nodes.some((node) => !remaining.has(node.id)) ||
                    edges.some((edge) => !remaining.has(edge.id)))
                ) {
                  currentCanvas.focus({ preventScroll: true });
                  // The 500 ms settled-model emission can replace React Flow
                  // after a delete, dropping focus back to body. Do not steal
                  // focus if the user has entered another control meanwhile.
                  setTimeout(() => {
                    const nextCanvas = document.querySelector<HTMLElement>(
                      ".myoxus-bpmn-diagram.react-flow",
                    );
                    if (document.activeElement === document.body)
                      nextCanvas?.focus({ preventScroll: true });
                  }, 650);
                }
              });
            });
          }}
        >
          {t.Delete()}
        </Button>
        <Popover
          open={diagram.overlaysPanel.isOpen}
          position="bottom-end"
          onOpenChange={(open) =>
            bpmnEditorStoreApi.setState((state) => {
              state.diagram.overlaysPanel.isOpen = open;
            })
          }
        >
          <PopoverTarget>
            <IconButton
              tooltip={i18n.bpmnTopRightPanels.overlays}
              aria-expanded={diagram.overlaysPanel.isOpen}
              onClick={toggleOverlaysPanel}
            >
              <VirtualMachineIcon />
            </IconButton>
          </PopoverTarget>
          <PopoverContent>
            <OverlaysPanel />
          </PopoverContent>
        </Popover>
        {!propertiesPanel.isOpen && (
          <IconButton
            ref={propertiesInvoker}
            tooltip={i18n.bpmnTopRightPanels.propertiesPanel}
            aria-expanded={false}
            onClick={togglePropertiesPanel}
          >
            <InfoIcon />
          </IconButton>
        )}
      </Group>
    </RF.Panel>
  );
}
