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

import * as React from "react";
import { NodeToolbar, Position } from "@xyflow/react";
import {
  Group,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { WorkflowIcon as ProcessAutomationIcon } from "@myoxus/icons/react";
import { type MorphingAction } from "./MorphingAction";
import { useBpmnEditorStore } from "../../../store/StoreContext";
export function NodeMorphingPanel<A extends MorphingAction>({
  isToggleVisible,
  isExpanded,
  setExpanded,
  actions,
  selectedActionId,
  disabledActionIds,
}: {
  isToggleVisible: boolean;
  isExpanded: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  disabledActionIds: Set<string>;
  actions: A[];
  selectedActionId?: A["id"];
}) {
  const isReadOnly = useBpmnEditorStore((s) => s.settings.isReadOnly);
  const t = useI18n();
  if (actions.length < 2) return null;
  return (
    <NodeToolbar
      position={Position.Left}
      isVisible={!isReadOnly && (isToggleVisible || isExpanded)}
    >
      <Popover
        open={isExpanded}
        onOpenChange={setExpanded}
        position="bottom-start"
      >
        <PopoverTarget>
          <IconButton
            tooltip={t["com.myoxus.common.type"]()}
            aria-expanded={isExpanded}
            onClick={() => setExpanded((previous) => !previous)}
          >
            <ProcessAutomationIcon />
          </IconButton>
        </PopoverTarget>
        <PopoverContent>
          <Group>
            {actions.map(({ id, key, action, icon, title }) => (
              <IconButton
                key={id}
                tooltip={key ? `${title} (${key})` : title}
                aria-pressed={selectedActionId === id}
                disabled={disabledActionIds.has(id) || selectedActionId === id}
                onClick={() => {
                  action();
                  setExpanded(false);
                }}
              >
                {icon}
              </IconButton>
            ))}
          </Group>
        </PopoverContent>
      </Popover>
    </NodeToolbar>
  );
}
