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

import { useI18n } from "@myoxus/i18n";

import type { Gateway as GatewayModel } from "../../../mutations/connection-context";
import { setGatewayKind } from "../../../mutations/connection";
import { useBpmnEditor } from "../../../BpmnEditorContext";
import { bpmnConstructState } from "../../../../source-profile";
import { type Normalized } from "../../../normalization/normalize";
import { useBpmnEditorStoreApi } from "../../../store/StoreContext";
import { GatewayIcon } from "../NodeIcons";
export type Gateway = Normalized<GatewayModel>;
export function useGatewayNodeMorphingActions(gateway: Gateway) {
  const t = useI18n();
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { onCommandError } = useBpmnEditor();
  const morphGateway = (kind: Gateway["__$$element"]) => {
    try {
      bpmnEditorStoreApi.setState((state) => {
        if (!state.settings.isReadOnly)
          setGatewayKind(state.bpmn.model.definitions, gateway["@_id"], kind);
      });
    } catch (error) {
      onCommandError(error);
    }
  };
  const morphingActions = [
    {
      icon: <GatewayIcon variant={"parallelGateway"} isIcon={true} />,
      key: "1",
      title: t["com.myoxus.editor.shape.bpmn.parallel-gateway-and"](),
      id: "parallelGateway",
      action: () => morphGateway("parallelGateway"),
    } as const,
    {
      icon: <GatewayIcon variant={"exclusiveGateway"} isIcon={true} />,
      key: "2",
      title: t["com.myoxus.editor.shape.bpmn.exclusive-gateway-xor"](),
      id: "exclusiveGateway",
      action: () => morphGateway("exclusiveGateway"),
    } as const,
    {
      icon: <GatewayIcon variant={"inclusiveGateway"} isIcon={true} />,
      key: "3",
      title: t["com.myoxus.editor.shape.bpmn.inclusive-gateway-or"](),
      id: "inclusiveGateway",
      action: () => morphGateway("inclusiveGateway"),
    } as const,
    {
      icon: <GatewayIcon variant={"eventBasedGateway"} isIcon={true} />,
      key: "4",
      title: t["com.myoxus.editor.shape.bpmn.event-based-gateway"](),
      id: "eventBasedGateway",
      action: () => morphGateway("eventBasedGateway"),
    } as const,
    {
      icon: <GatewayIcon variant={"complexGateway"} isIcon={true} />,
      key: "5",
      title: t["com.myoxus.editor.shape.bpmn.complex-gateway"](),
      id: "complexGateway",
      action: () => morphGateway("complexGateway"),
    } as const,
  ];
  return morphingActions.filter(
    (action) => bpmnConstructState(action.id) === "editable",
  );
}
