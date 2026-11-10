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

import { type BpmnLatestModel } from "../marshaller";
import type { BpmnThemeRoles } from "../modeller";
import {
  Box,
  Splitter,
  notify,
  type SplitterPaneSize,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { original } from "immer";
import * as React from "react";
import { useCallback, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { getViewportForBounds } from "@xyflow/react";
import { ErrorBoundary } from "react-error-boundary";
import { BpmnEditorContextProvider, useBpmnEditor } from "./BpmnEditorContext";
import { BpmnEditorErrorFallback } from "./BpmnEditorErrorFallback";
import { BpmnDiagram } from "./diagram/BpmnDiagram";
import { type Normalized, normalize } from "./normalization/normalize";
import { INITIAL_COMPUTED_CACHE } from "./store/initialComputedCache";
import { ComputedStateCache } from "../xyflow/store/ComputedStateCache";
import { XyFlowReactKieDiagramStoreApiContext } from "../xyflow/store/Store";
import {
  type State,
  createBpmnEditorStore,
  getDefaultStaticState,
} from "./store/Store";
import {
  BpmnEditorStoreApiContext,
  useBpmnEditorStore,
  useBpmnEditorStoreApi,
} from "./store/StoreContext";
import { BpmnDiagramSvg } from "./svg/BpmnDiagramSvg";
import {
  type Commands,
  CommandsContextProvider,
  useCommands,
} from "./commands/CommandsContextProvider";
import { type DiagramRef } from "../xyflow/diagram/XyFlowReactKieDiagram";
import {
  type BpmnDiagramEdgeData,
  type BpmnDiagramNodeData,
  type BpmnNodeType,
} from "./diagram/BpmnDiagramDomain";
import { PropertiesPanel } from "./propertiesPanel/PropertiesPanel";
import {
  PendingEdits,
  PendingEditsContext,
} from "../xyflow/reactExt/PendingEdits";
const ON_MODEL_CHANGE_DEBOUNCE_TIME_IN_MS = 500;
const SVG_PADDING = 20;
export type BpmnEditorRef = {
  reset: (model: BpmnLatestModel) => void;
  /** Local source replacement is one retained command, unlike a remote reset. */
  replaceModel: (model: BpmnLatestModel) => Normalized<BpmnLatestModel>;
  getDiagramSvg: (signal?: AbortSignal) => Promise<string | undefined>;
  getCommands: () => Commands;
  /** Commits valid field drafts, cancels unfinished gestures, then emits the current settled model. */
  flush: () => Normalized<BpmnLatestModel>;
  fitToContent: () => Promise<void>;
};
export type OnBpmnModelChange = (model: Normalized<BpmnLatestModel>) => void;

/** Internal retained model entry; source inspection and host persistence remain separate boundaries. */
export type BpmnEditorProps = {
  model: BpmnLatestModel;
  onModelChange?: OnBpmnModelChange;
  onModelDebounceStateChanged?: (changed: boolean) => void;
  onWorkingStateChange?: (state: {
    model: Normalized<BpmnLatestModel>;
    pending: boolean;
    canUndo: boolean;
    canRedo: boolean;
  }) => void;
  onError?: () => void;
  onReady?: () => void;
  locale: string;
  readOnly?: boolean;
  themeRoles?: BpmnThemeRoles;
};
export const BpmnEditorInternal = ({
  model,
  onModelChange,
  onModelDebounceStateChanged,
  onWorkingStateChange,
  forwardRef,
  locale,
  readOnly = false,
  themeRoles,
}: BpmnEditorProps & {
  forwardRef?: React.Ref<BpmnEditorRef>;
}) => {
  const isPropertiesPanelOpen = useBpmnEditorStore(
    (s) => s.propertiesPanel.isOpen,
  );
  const isFurtherPropertiesOpen = useBpmnEditorStore(
    (s) => s.propertiesPanel.isFurtherOpen,
  );
  // Native collapse keeps the inspector's field owners mounted; controlled
  // sizes restore the user's open-panel ratio without remounting either pane.
  const [splitSizes, setSplitSizes] = useState<SplitterPaneSize[]>([
    "70%",
    "30%",
  ]);
  const t = useI18n();
  const bpmn = useBpmnEditorStore((s) => s.bpmn);
  const isDiagramEditingInProgress = useBpmnEditorStore((s) =>
    s.computed(s).isDiagramEditingInProgress(),
  );
  const bpmnEditorStoreApi = useBpmnEditorStoreApi();
  const { commandsRef } = useCommands();
  const { bpmnModelBeforeEditingRef, bpmnEditorRootElementRef } =
    useBpmnEditor();
  const diagramRef = useRef<DiagramRef<
    BpmnNodeType,
    BpmnDiagramNodeData,
    BpmnDiagramEdgeData
  > | null>(null);
  const diagramContainerRef = useRef<HTMLDivElement>(null);
  const lastEmittedModelRef = useRef(bpmn.model);
  const [pendingEdits] = useState(() => new PendingEdits());
  const invalidFieldFocus = useRef<(() => void) | null>(null);
  React.useLayoutEffect(() => {
    pendingEdits.revealInvalid = (focus) => {
      const panel = bpmnEditorStoreApi.getState().propertiesPanel;
      if (panel.isOpen && panel.isFurtherOpen) focus();
      else {
        invalidFieldFocus.current = focus;
        bpmnEditorStoreApi.setState((state) => {
          state.propertiesPanel.isOpen = true;
          state.propertiesPanel.isFurtherOpen = true;
        });
      }
    };
    // Hidden inspector fields retain their owners. Reveal the same pane before
    // invoking its field/section focus, after the native hidden/inert flags and
    // Further properties' display-none retention have cleared.
    if (isPropertiesPanelOpen && invalidFieldFocus.current) {
      const focus = invalidFieldFocus.current;
      invalidFieldFocus.current = null;
      focus();
    }
    return () => {
      pendingEdits.revealInvalid = undefined;
    };
  }, [
    bpmnEditorStoreApi,
    isPropertiesPanelOpen,
    isFurtherPropertiesOpen,
    pendingEdits,
  ]);
  const callbacks = useRef({ onModelChange, onWorkingStateChange });
  callbacks.current = { onModelChange, onWorkingStateChange };
  const emitCurrent = useCallback(() => {
    bpmnEditorStoreApi.setState((s) => s.dispatch(s).commitHistory());
    const current = bpmnEditorStoreApi.getState().bpmn.model;
    if (lastEmittedModelRef.current !== current) {
      lastEmittedModelRef.current = current;
      callbacks.current.onModelChange?.(current);
    }
    return current;
  }, [bpmnEditorStoreApi]);
  React.useLayoutEffect(() => {
    const report = () => {
      const state = bpmnEditorStoreApi.getState();
      callbacks.current.onWorkingStateChange?.({
        model: state.bpmn.model,
        pending: pendingEdits.dirty,
        canUndo:
          !state.settings.isReadOnly &&
          (state.history.past.length > 0 ||
            state.bpmn.model !== state.history.current),
        canRedo: !state.settings.isReadOnly && state.history.future.length > 0,
      });
    };
    pendingEdits.onChange = report;
    const unsubscribe = bpmnEditorStoreApi.subscribe((next, previous) => {
      if (
        next.computed(next).isDiagramEditingInProgress() &&
        !previous.computed(previous).isDiagramEditingInProgress()
      )
        bpmnModelBeforeEditingRef.current = previous.bpmn.model;
      report();
    });
    report();
    return () => {
      unsubscribe();
      pendingEdits.onChange = undefined;
    };
  }, [bpmnEditorStoreApi, bpmnModelBeforeEditingRef, pendingEdits]);
  const flush = useCallback(() => {
    if (!pendingEdits.flush()) throw new Error("BPMN_PENDING_FIELD_INVALID");
    const before = bpmnEditorStoreApi.getState();
    if (before.computed(before).isDiagramEditingInProgress()) {
      // Drag/resize drafts are not commands until pointer completion. Cancel the
      // whole gesture rather than exporting an arbitrary intermediate position.
      bpmnEditorStoreApi.setState((s) => {
        s.bpmn.model =
          bpmnModelBeforeEditingRef.current as Normalized<BpmnLatestModel>;
        s.xyFlowReactKieDiagram = {
          ...getDefaultStaticState().xyFlowReactKieDiagram,
          snapGrid: s.xyFlowReactKieDiagram.snapGrid,
        };
        s.diagram.isEditingStyle = false;
      });
    }
    commandsRef.current.cancelAction();
    bpmnEditorStoreApi.setState((s) => {
      s.xyFlowReactKieDiagram.newNodeProjection = undefined;
    });
    return emitCurrent();
  }, [
    bpmnEditorStoreApi,
    bpmnModelBeforeEditingRef,
    commandsRef,
    emitCurrent,
    pendingEdits,
  ]);
  const projectDiagram = useCallback(
    async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      flush();
      const state = bpmnEditorStoreApi.getState();
      const { nodes, edges } = state.computed(state).getDiagramData();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "1");
      svg.setAttribute("height", "1");
      const root = createRoot(svg);
      const stopped = Promise.withResolvers<never>();
      const stop = () => stopped.reject(signal?.reason);
      signal?.addEventListener("abort", stop, { once: true });
      // Font loading itself is browser-owned, but cancellation must release this
      // renderer's model/React root and measurement DOM without waiting for it.
      const wait = async <T,>(promise: PromiseLike<T>) => {
        const result = await Promise.race([promise, stopped.promise]);
        signal?.throwIfAborted();
        return result;
      };
      try {
        await wait(document.fonts.ready);
        const host = bpmnEditorRootElementRef.current;
        if (!host) return undefined;
        // SVG getBBox needs a live layout tree, including text outside node
        // bounds and route extrema. Hidden measurement is not a screenshot.
        svg.style.position = "absolute";
        svg.style.visibility = "hidden";
        host.append(svg);
        const style = getComputedStyle(host);
        // Export is standalone: freeze the server-projected theme, not unresolved
        // page CSS variables or a separate hardcoded export font/palette.
        for (const property of Array.from(style)) {
          if (property.startsWith("--mantine-"))
            svg.style.setProperty(property, style.getPropertyValue(property));
        }
        const font = {
          fontFamily: themeRoles
            ? style.getPropertyValue(themeRoles.fontFamily).trim()
            : style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        };
        // Wrapping uses canvas.measureText during React render. Waiting only
        // before getBBox is too late: a newly requested glyph subset may already
        // have been wrapped with a fallback font. Load the projected label font
        // before producing the committed SVG tree.
        const labelText = nodes
          .map(({ data: { bpmnElement } }) =>
            bpmnElement.__$$element === "textAnnotation"
              ? (bpmnElement.text?.__$$text ?? "")
              : "@_name" in bpmnElement
                ? (bpmnElement["@_name"] ?? "")
                : "",
          )
          .join("");
        await wait(
          document.fonts.load(`${font.fontSize} ${font.fontFamily}`, labelText),
        );
        await wait(document.fonts.ready);
        // The committed tree, not a scheduled render, owns the serialized SVG.
        flushSync(() =>
          root.render(
            <g>
              <BpmnDiagramSvg
                nodes={nodes}
                edges={edges}
                font={font}
                definitions={state.bpmn.model.definitions}
              />
            </g>,
          ),
        );
        await wait(document.fonts.ready);
        const bounds = svg.querySelector("g")!.getBBox();
        const width = Math.max(1, bounds.width) + SVG_PADDING * 2;
        const height = Math.max(1, bounds.height) + SVG_PADDING * 2;
        svg.setAttribute("width", String(width));
        svg.setAttribute("height", String(height));
        svg.setAttribute(
          "viewBox",
          `${bounds.x - SVG_PADDING} ${bounds.y - SVG_PADDING} ${width} ${height}`,
        );
        svg.removeAttribute("style");
        // Only frozen theme variables belong in the exported root, not the
        // temporary measurement host's visibility/position declarations.
        for (const property of Array.from(style))
          if (property.startsWith("--mantine-"))
            svg.style.setProperty(property, style.getPropertyValue(property));
        // A standalone dark SVG otherwise puts pale labels/flows on the viewer's
        // default white canvas. Its surface is the same projected theme role,
        // never a local export palette or a change to document geometry.
        if (themeRoles)
          svg.style.backgroundColor = style
            .getPropertyValue(themeRoles.surface)
            .trim();
        return {
          svg: new XMLSerializer().serializeToString(svg),
          bounds: {
            x: bounds.x - SVG_PADDING,
            y: bounds.y - SVG_PADDING,
            width,
            height,
          },
          model: state.bpmn.model,
        };
      } finally {
        signal?.removeEventListener("abort", stop);
        root.unmount();
        svg.remove();
      }
    },
    [bpmnEditorRootElementRef, bpmnEditorStoreApi, flush, themeRoles],
  );
  const fitToContent = useCallback(async () => {
    const projection = await projectDiagram();
    const canvas =
      bpmnEditorRootElementRef.current?.querySelector<HTMLElement>(
        ".react-flow",
      );
    if (
      !projection ||
      projection.model !== bpmnEditorStoreApi.getState().bpmn.model ||
      !canvas
    )
      return;
    const bounds = canvas.getBoundingClientRect();
    const palette = canvas
      .querySelector<HTMLElement>("[data-bpmn-palette]")
      ?.getBoundingClientRect();
    // Native viewport fitting reserves the actually painted palette, not a
    // second responsive threshold or a changed diagram/label coordinate system.
    const viewport = getViewportForBounds(
      projection.bounds,
      bounds.width,
      bounds.height,
      0.1,
      1,
      {
        left: `${Math.max(0, (palette?.right ?? bounds.left) - bounds.left) + SVG_PADDING}px`,
        right: `${SVG_PADDING}px`,
        top: `${SVG_PADDING}px`,
        bottom: `${SVG_PADDING}px`,
      },
    );
    await diagramRef.current?.getReactFlowInstance()?.setViewport(viewport);
  }, [bpmnEditorRootElementRef, bpmnEditorStoreApi, projectDiagram]);
  useImperativeHandle(
    forwardRef,
    () => ({
      reset: (next) => {
        const normalized = normalize(next);
        lastEmittedModelRef.current = normalized;
        bpmnModelBeforeEditingRef.current = normalized;
        bpmnEditorStoreApi.setState((state) =>
          state.dispatch(state).reset(normalized),
        );
        pendingEdits.discard();
      },
      replaceModel: (next) => {
        if (bpmnEditorStoreApi.getState().settings.isReadOnly)
          throw new Error("BPMN_READ_ONLY");
        flush();
        const normalized = normalize(next);
        bpmnEditorStoreApi.setState((state) => {
          state.bpmn.model = normalized;
          state.xyFlowReactKieDiagram = {
            ...getDefaultStaticState().xyFlowReactKieDiagram,
            snapGrid: state.xyFlowReactKieDiagram.snapGrid,
          };
          state.diagram.isEditingStyle = false;
          state.focus.consumableId = undefined;
          state.dispatch(state).commitHistory();
        });
        bpmnModelBeforeEditingRef.current = normalized;
        return bpmnEditorStoreApi.getState().bpmn.model;
      },
      getDiagramSvg: async (signal) => (await projectDiagram(signal))?.svg,
      getCommands: () => commandsRef.current,
      flush,
      fitToContent,
    }),
    [
      bpmnEditorStoreApi,
      bpmnModelBeforeEditingRef,
      commandsRef,
      flush,
      pendingEdits,
      projectDiagram,
      fitToContent,
    ],
  );
  const observedModel = useRef(model);
  React.useEffect(() => {
    // StrictMode replays mount effects. Only a genuinely new host model may
    // reset this tree; replaying the initial prop would manufacture dirty XML.
    if (observedModel.current === model) return;
    observedModel.current = model;
    bpmnEditorStoreApi.setState((state) => {
      // Acknowledging the emitted object must not reset drafts, selection or history.
      if (model === original(state.bpmn.model)) return;
      const normalized = normalize(model);
      state.dispatch(state).reset(normalized);
      lastEmittedModelRef.current = normalized;
      bpmnModelBeforeEditingRef.current = normalized;
    });
  }, [bpmnEditorStoreApi, bpmnModelBeforeEditingRef, model]);
  React.useLayoutEffect(() => {
    // Preserve valid pre-denial field drafts in the local working model before
    // their command owners become read-only. Core has already locked durable
    // writes; this is recovery material, never a grant or a persistence ACK.
    // Invalid drafts stay registered without stealing focus on remote changes.
    if (readOnly && !bpmnEditorStoreApi.getState().settings.isReadOnly)
      pendingEdits.flush(false);
    bpmnEditorStoreApi.setState((state) => {
      state.settings.isReadOnly = readOnly;
    });
  }, [bpmnEditorStoreApi, pendingEdits, readOnly]);
  React.useEffect(() => {
    if (isDiagramEditingInProgress) return;
    onModelDebounceStateChanged?.(false);
    const timeout = setTimeout(() => {
      if (pendingEdits.dirty) return;
      onModelDebounceStateChanged?.(true);
      emitCurrent();
    }, ON_MODEL_CHANGE_DEBOUNCE_TIME_IN_MS);
    return () => clearTimeout(timeout);
  }, [
    isDiagramEditingInProgress,
    model,
    onModelChange,
    onModelDebounceStateChanged,
    bpmn.model,
    emitCurrent,
    pendingEdits,
  ]);
  return (
    <PendingEditsContext.Provider value={pendingEdits}>
      <Box ref={bpmnEditorRootElementRef} h="100%">
        <Splitter
          sizes={isPropertiesPanelOpen ? splitSizes : ["100%", 0]}
          onSizeChange={(sizes) => {
            if (isPropertiesPanelOpen) setSplitSizes(sizes);
          }}
        >
          <Splitter.Pane defaultSize="70%">
            <Box
              ref={diagramContainerRef}
              h="100%"
              data-testid="kie-bpmn-editor--diagram-container"
            >
              <BpmnDiagram
                diagramRef={diagramRef}
                container={diagramContainerRef}
                locale={locale}
                onFitToContent={() => {
                  void fitToContent().catch(() =>
                    notify.error(t["com.myoxus.common.operation-failed"]()),
                  );
                }}
              />
            </Box>
          </Splitter.Pane>
          <Splitter.Pane
            defaultSize="30%"
            hidden={!isPropertiesPanelOpen}
            inert={!isPropertiesPanelOpen}
          >
            <PropertiesPanel />
          </Splitter.Pane>
        </Splitter>
      </Box>
    </PendingEditsContext.Provider>
  );
};

/** Owns one long-lived KIE store; ordinary host renders never reconstruct the editor model. */
export const BpmnEditor = React.forwardRef(
  (props: BpmnEditorProps, ref: React.Ref<BpmnEditorRef>) => {
    const [store] = useState(() => {
      const instance = createBpmnEditorStore(
        props.model,
        new ComputedStateCache<ReturnType<State["computed"]>>(
          INITIAL_COMPUTED_CACHE,
        ),
      );
      instance.setState((state) => {
        state.settings.isReadOnly = props.readOnly ?? false;
      });
      return instance;
    });
    return (
      <BpmnEditorContextProvider model={props.model}>
        <BpmnEditorStoreApiContext.Provider value={store}>
          <XyFlowReactKieDiagramStoreApiContext.Provider value={store}>
            <ErrorBoundary
              resetKeys={[props.model]}
              FallbackComponent={BpmnEditorErrorFallback}
              onError={props.onError}
              onReset={(event) => {
                const current = store.getState();
                // A renderer retry is not a new document/source. Preserve the
                // immutable settled model and its history; cloning it would
                // manufacture dirty state without a command or source emission.
                if (
                  event.reason === "imperative-api" &&
                  !current.computed(current).isDiagramEditingInProgress()
                )
                  return;
                const recovered: BpmnLatestModel =
                  event.reason === "imperative-api"
                    ? (event.args[0] ?? props.model)
                    : props.model;
                store.setState((state) => {
                  state.diagram = getDefaultStaticState().diagram;
                  state
                    .dispatch(state)
                    .reset(
                      event.reason === "imperative-api"
                        ? (recovered as Normalized<BpmnLatestModel>)
                        : normalize(recovered),
                    );
                });
              }}
            >
              <CommandsContextProvider onReady={props.onReady}>
                <BpmnEditorInternal forwardRef={ref} {...props} />
              </CommandsContextProvider>
            </ErrorBoundary>
          </XyFlowReactKieDiagramStoreApiContext.Provider>
        </BpmnEditorStoreApiContext.Provider>
      </BpmnEditorContextProvider>
    );
  },
);
