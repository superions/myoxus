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
import { useCallback, useContext, useMemo, useRef, useState } from "react";
// Node hooks consume this provider during domain initialization. Loading the
// editor runtime here would cycle through its node map before NODE_TYPES exists.
import type { BpmnEditorProps } from "./BpmnEditor";
import type { BpmnLatestModel } from "../marshaller";
export type BpmnEditorContextProviderProps = Pick<BpmnEditorProps, "model">;
export type BpmnModelBeforeEditing = BpmnLatestModel;
export type BpmnEditorContextType = {
  bpmnModelBeforeEditingRef: React.MutableRefObject<BpmnModelBeforeEditing>;
  bpmnEditorRootElementRef: React.RefObject<HTMLDivElement | null>;
  /** Explicit open/close handoff only; layout/canvas changes never request focus. */
  propertiesPanelFocusRef: React.MutableRefObject<"invoker" | "panel" | null>;
  commandError: "in-use" | "invalid" | undefined;
  onCommandError: (error: unknown) => void;
  clearCommandError: () => void;
};
const BpmnEditorContext = React.createContext<BpmnEditorContextType | null>(
  null,
);
export function useBpmnEditor() {
  const context = useContext(BpmnEditorContext);
  if (!context) throw new Error("BPMN editor context is missing");
  return context;
}
export function BpmnEditorContextProvider(
  props: React.PropsWithChildren<BpmnEditorContextProviderProps>,
) {
  const bpmnModelBeforeEditingRef = useRef<BpmnModelBeforeEditing>(props.model);
  const bpmnEditorRootElementRef = useRef<HTMLDivElement>(null);
  const propertiesPanelFocusRef = useRef<"invoker" | "panel" | null>(null);
  const [commandError, setCommandError] =
    useState<BpmnEditorContextType["commandError"]>();
  const clearCommandError = useCallback(() => setCommandError(undefined), []);
  const onCommandError = useCallback((error: unknown) => {
    if (error instanceof Error && error.message === "BPMN_DEFINITION_IN_USE")
      setCommandError("in-use");
    else if (
      error instanceof Error &&
      [
        "BPMN_ACTIVITY_SCOPE",
        "BPMN_ACTIVITY_CYCLE",
        "BPMN_LANE_CYCLE",
        "BPMN_SUBPROCESS_COLLAPSED",
        "BPMN_INVALID_ACTIVITY_CONTEXT",
        "BPMN_INVALID_EVENT_CONTEXT",
        "BPMN_INVALID_CONNECTION",
      ].includes(error.message)
    )
      setCommandError("invalid");
    else throw error;
  }, []);
  const value = useMemo<BpmnEditorContextType>(
    () => ({
      bpmnModelBeforeEditingRef,
      bpmnEditorRootElementRef,
      propertiesPanelFocusRef,
      commandError,
      onCommandError,
      clearCommandError,
    }),
    [commandError, onCommandError, clearCommandError],
  );
  return (
    <BpmnEditorContext.Provider value={value}>
      {props.children}
    </BpmnEditorContext.Provider>
  );
}
