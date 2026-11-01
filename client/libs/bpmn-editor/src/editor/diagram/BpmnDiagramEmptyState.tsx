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

import { type Dispatch, type SetStateAction } from "react";
import { Panel } from "@xyflow/react";
import { EmptyState, IconButton } from "@myoxus/ui-facade";
import { CloseIcon } from "@myoxus/icons/react";
import { useBpmnEditorI18n } from "../i18n";
export function BpmnDiagramEmptyState({
  setShowEmptyState,
}: {
  setShowEmptyState: Dispatch<SetStateAction<boolean>>;
}) {
  const { i18n } = useBpmnEditorI18n();
  return (
    <Panel position="top-center">
      <EmptyState
        title={i18n.bpmnDiagramEmptyState.emptyBpmnTitle}
        description={i18n.bpmnDiagramEmptyState.startByDraggingNodes}
        cta={
          <IconButton
            tooltip={i18n.propertiesPanel.close}
            onClick={(event) => {
              // Hand focus back before React removes the focused dismiss button.
              event.currentTarget
                .closest<HTMLElement>('[role="application"]')
                ?.focus({ preventScroll: true });
              setShowEmptyState(false);
            }}
          >
            <CloseIcon />
          </IconButton>
        }
      />
    </Panel>
  );
}
