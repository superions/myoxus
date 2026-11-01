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
import { useContext, useRef, useCallback } from "react";
export interface Commands {
  togglePropertiesPanel: () => void;
  createGroup: () => void;
  appendTaskNode: () => void;
  appendGatewayNode: () => void;
  appendIntermediateCatchEventNode: () => void;
  appendIntermediateThrowEventNode: () => void;
  appendEndEventNode: () => void;
  appendTextAnnotationNode: () => void;
  selectAll: () => void;
  paste: () => Promise<void>;
  /** Duplicate the selected private fragment without reading/writing the OS clipboard. */
  duplicate: () => void;
  copy: () => Promise<void>;
  cut: () => Promise<void>;
  cancelAction: () => void;
  focusOnSelection: () => void;
  resetPosition: () => void;
  undo: () => void;
  redo: () => void;
}
const CommandsContext = React.createContext<{
  commandsRef: React.MutableRefObject<Commands>;
  reportReady(): void;
}>({} as any);
export function useCommands() {
  return useContext(CommandsContext);
}
export function CommandsContextProvider(
  props: React.PropsWithChildren<{ onReady?: () => void }>,
) {
  const onReady = useRef(props.onReady);
  onReady.current = props.onReady;
  const reportReady = useCallback(() => onReady.current?.(), []);
  const commandsRef = useRef<Commands>({
    undo: () => {
      throw new Error("BPMN command provider is not mounted");
    },
    redo: () => {
      throw new Error("BPMN command provider is not mounted");
    },
    togglePropertiesPanel: () => {
      throw new Error(
        "BPMN EDITOR: togglePropertiesPanel command not implemented.",
      );
    },
    createGroup: () => {
      throw new Error("BPMN EDITOR: createGroup command not implemented.");
    },
    appendTaskNode: () => {
      throw new Error("BPMN EDITOR: appendTaskNode command not implemented.");
    },
    appendGatewayNode: () => {
      throw new Error(
        "BPMN EDITOR: appendGatewayNode command not implemented.",
      );
    },
    appendIntermediateCatchEventNode: () => {
      throw new Error(
        "BPMN EDITOR: appendIntermediateCatchEventNode command not implemented.",
      );
    },
    appendIntermediateThrowEventNode: () => {
      throw new Error(
        "BPMN EDITOR: appendIntermediateThrowEventNode command not implemented.",
      );
    },
    appendEndEventNode: () => {
      throw new Error(
        "BPMN EDITOR: appendEndEventNode command not implemented.",
      );
    },
    appendTextAnnotationNode: () => {
      throw new Error(
        "BPMN EDITOR: appendTextAnnotationNode command not implemented.",
      );
    },
    selectAll: () => {
      throw new Error("BPMN EDITOR: selectAll command not implemented.");
    },
    paste: () => {
      throw new Error("BPMN EDITOR: paste command not implemented.");
    },
    duplicate: () => {
      throw new Error("BPMN EDITOR: duplicate command not implemented.");
    },
    copy: () => {
      throw new Error("BPMN EDITOR: copy command not implemented.");
    },
    cut: () => {
      throw new Error("BPMN EDITOR: cut command not implemented.");
    },
    cancelAction: () => {
      throw new Error("BPMN EDITOR: cancelAction command not implemented.");
    },
    focusOnSelection: () => {
      throw new Error("BPMN EDITOR: focusOnSelection command not implemented.");
    },
    resetPosition: () => {
      throw new Error("BPMN EDITOR: resetPosition command not implemented.");
    },
  });
  return (
    <CommandsContext.Provider
      value={{
        commandsRef,
        reportReady,
      }}
    >
      {props.children}
    </CommandsContext.Provider>
  );
}
