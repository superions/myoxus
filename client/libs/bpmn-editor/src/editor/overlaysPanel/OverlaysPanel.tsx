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

import { Checkbox, Divider, NumberInput, Stack } from "@myoxus/ui-facade";
import {
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "../store/StoreContext";
import { useBpmnEditorI18n } from "../i18n";
const MIN_SNAP = 5;
const MAX_SNAP = 50;
const SNAP_STEP = 5;
export function OverlaysPanel() {
  const { i18n } = useBpmnEditorI18n();
  const snapGrid = useBpmnEditorStore((s) => s.xyFlowReactKieDiagram.snapGrid);
  const diagram = useBpmnEditorStore((s) => s.diagram);
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  return (
    <Stack onKeyDown={(e) => e.stopPropagation()}>
      <Checkbox
        label={i18n.overlaysPanel.snapping}
        checked={snapGrid.isEnabled}
        onChange={(_e, newValue) =>
          bpmnEditorStoreApi.setState((state) => {
            state.xyFlowReactKieDiagram.snapGrid.isEnabled = newValue;
          })
        }
      />
      <NumberInput
        label={i18n.overlaysPanel.horizontal}
        data-testid="kie-tools--bpmn-editor--horizontal-snapping-control"
        disabled={!snapGrid.isEnabled}
        value={snapGrid.x}
        min={MIN_SNAP}
        max={MAX_SNAP}
        step={SNAP_STEP}
        onChange={(value) =>
          bpmnEditorStoreApi.setState((state) => {
            if (typeof value === "number")
              state.xyFlowReactKieDiagram.snapGrid.x = Math.min(
                MAX_SNAP,
                Math.max(MIN_SNAP, value),
              );
          })
        }
      />
      <NumberInput
        label={i18n.overlaysPanel.vertical}
        data-testid="kie-tools--bpmn-editor--vertical-snapping-control"
        disabled={!snapGrid.isEnabled}
        value={snapGrid.y}
        min={MIN_SNAP}
        max={MAX_SNAP}
        step={SNAP_STEP}
        onChange={(value) =>
          bpmnEditorStoreApi.setState((state) => {
            if (typeof value === "number")
              state.xyFlowReactKieDiagram.snapGrid.y = Math.min(
                MAX_SNAP,
                Math.max(MIN_SNAP, value),
              );
          })
        }
      />
      <Divider />
      <Checkbox
        label={i18n.enableStyles}
        checked={diagram.overlays.enableCustomNodeStyles}
        onChange={(_e, newValue) =>
          bpmnEditorStoreApi.setState((state) => {
            state.diagram.overlays.enableCustomNodeStyles = newValue;
          })
        }
      />
    </Stack>
  );
}
