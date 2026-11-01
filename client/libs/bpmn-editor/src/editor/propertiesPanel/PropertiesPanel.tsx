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
  Scrollable,
  Stack,
  Text,
} from "@myoxus/ui-facade";
import { CloseIcon } from "@myoxus/icons/react";
import { GlobalProperties } from "./GlobalProperties";
import { SingleEdgeProperties } from "./SingleEdgeProperties";
import { SingleNodeProperties } from "./SingleNodeProperties";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { useBpmnEditorI18n } from "../i18n";
import { useBpmnEditor } from "../BpmnEditorContext";
import { useLayoutEffect, useRef } from "react";
export function PropertiesPanel() {
  const { i18n } = useBpmnEditorI18n();
  const store = useBpmnEditorStoreApi();
  const { propertiesPanelFocusRef } = useBpmnEditor();
  const closeButton = useRef<HTMLButtonElement>(null);
  const isOpen = useBpmnEditorStore((state) => state.propertiesPanel.isOpen);
  useLayoutEffect(() => {
    if (isOpen && propertiesPanelFocusRef.current === "panel") {
      // Native Splitter sizes settle after this child's layout effect. Focus
      // only the explicit opener's request, once the pane has a rendered box.
      const frame = requestAnimationFrame(() => {
        if (propertiesPanelFocusRef.current === "panel") {
          propertiesPanelFocusRef.current = null;
          closeButton.current?.focus();
        }
      });
      return () => {
        cancelAnimationFrame(frame);
        if (propertiesPanelFocusRef.current === "panel")
          propertiesPanelFocusRef.current = null;
      };
    }
    return undefined;
  }, [isOpen, propertiesPanelFocusRef]);
  const selectedNodesById = useBpmnEditorStore(
    (s) => s.computed(s).getDiagramData().selectedNodesById,
  );
  const selectedEdgesById = useBpmnEditorStore(
    (s) => s.computed(s).getDiagramData().selectedEdgesById,
  );
  return (
    <Scrollable.Viewport
      data-testid={"kie-tools--bpmn-editor--properties-panel-container"}
      onKeyDown={(e) => {
        // In macOS, we can not stopPropagation here because, otherwise, shortcuts are not handled
        // See https://github.com/apache/incubator-kie-issues/issues/1164
        if (!e.metaKey) {
          // Prevent ReactFlow KeyboardShortcuts from triggering when editing stuff on Properties Panel
          e.stopPropagation();
        }
      }}
    >
      <Stack>
        <Group>
          <Text>{i18n.bpmnTopRightPanels.propertiesPanel}</Text>
          <IconButton
            ref={closeButton}
            tooltip={i18n.propertiesPanel.close}
            onClick={() => {
              propertiesPanelFocusRef.current = "invoker";
              store.setState((state) => {
                state.propertiesPanel.isOpen = false;
              });
            }}
          >
            <CloseIcon />
          </IconButton>
        </Group>
        {selectedEdgesById.size <= 0 && selectedNodesById.size <= 0 && (
          <GlobalProperties />
        )}
        {selectedEdgesById.size <= 0 && selectedNodesById.size === 1 && (
          <SingleNodeProperties />
        )}
        {selectedEdgesById.size <= 0 && selectedNodesById.size > 1 && (
          <Text>
            {i18n.propertiesPanel.multipleNodesSelected(selectedNodesById.size)}
          </Text>
        )}
        {selectedEdgesById.size === 1 && selectedNodesById.size <= 0 && (
          <SingleEdgeProperties />
        )}
        {selectedEdgesById.size > 1 && selectedNodesById.size <= 0 && (
          <Text>
            {i18n.propertiesPanel.multipleEdgesSelected(selectedEdgesById.size)}
          </Text>
        )}
        {selectedEdgesById.size >= 1 && selectedNodesById.size >= 1 && (
          <>
            <Text>
              {i18n.propertiesPanel.edgesNodesSelected(
                selectedNodesById.size + selectedEdgesById.size,
              )}
            </Text>
            <Text>{i18n.propertiesPanel.cantEditProperties}</Text>
            <Group>
              <Button
                variant="plain"
                onClick={() =>
                  store.setState((state) => {
                    state.xyFlowReactKieDiagram._selectedEdges = [];
                  })
                }
              >
                {i18n.propertiesPanel.selectOnlyNodes}
              </Button>
              <Button
                variant="plain"
                onClick={() =>
                  store.setState((state) => {
                    state.xyFlowReactKieDiagram._selectedNodes = [];
                  })
                }
              >
                {i18n.propertiesPanel.selectOnlyEdges}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Scrollable.Viewport>
  );
}
