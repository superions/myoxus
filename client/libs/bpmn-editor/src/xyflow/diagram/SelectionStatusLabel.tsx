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
// Modified by Myoxus: React 19/XYFlow 12 and direct Facade integration; see provenance.json.

import * as React from "react";
import * as RF from "@xyflow/react";
import {
  useXyFlowReactKieDiagramStore,
  useXyFlowReactKieDiagramStoreApi,
} from "../store/Store";
import { useI18n } from "@myoxus/i18n";
import { CloseIcon } from "@myoxus/icons/react";
import { Group, IconButton, Text } from "@myoxus/ui-facade";

export function SelectionStatusLabel() {
  const t = useI18n();
  const xyFlowStoreApi = RF.useStoreApi();

  const selectedNodesCount = useXyFlowReactKieDiagramStore(
    (s) => s.computed(s).getDiagramData().selectedNodesById.size,
  );
  const selectedEdgesCount = useXyFlowReactKieDiagramStore(
    (s) => s.computed(s).getDiagramData().selectedEdgesById.size,
  );
  const xyFlowReactKieDiagramStoreApi = useXyFlowReactKieDiagramStoreApi();

  React.useEffect(() => {
    xyFlowStoreApi.setState({ nodesSelectionActive: selectedNodesCount >= 2 });
  }, [xyFlowStoreApi, selectedNodesCount]);

  const onClose = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      xyFlowReactKieDiagramStoreApi.setState((state) => {
        state.xyFlowReactKieDiagram._selectedNodes = [];
        state.xyFlowReactKieDiagram._selectedEdges = [];
      });
    },
    [xyFlowReactKieDiagramStoreApi],
  );

  return selectedNodesCount + selectedEdgesCount >= 2 ? (
    <RF.Panel position={"top-center"}>
      <Group>
        <Text role="status">
          {t["com.myoxus.diagram.selection-count"]({
            count: (selectedNodesCount + selectedEdgesCount).toLocaleString(
              t.language,
            ),
          })}
        </Text>
        <IconButton
          onClick={onClose}
          tooltip={t["com.myoxus.common.clear-selection"]()}
        >
          <CloseIcon />
        </IconButton>
      </Group>
    </RF.Panel>
  ) : null;
}
