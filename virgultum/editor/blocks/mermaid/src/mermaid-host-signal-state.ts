// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal } from "@preact/signals-core";

import type {
  MermaidVisualModel,
  MermaidVisualNodeShape,
} from "./families/runtime/gfx-host-contract.js";
import type {
  MermaidSelectionActionModel,
  MermaidTitlePresentation,
} from "./families/runtime/shell-contract.js";
import type {
  MermaidRenderState,
  MermaidViewMode,
} from "./mermaid-block-constants.js";
import type { MermaidGfxSnapGuide } from "./mermaid-gfx-snap.js";
import type { MermaidPageSelectionItem } from "./mermaid-page-selection-controller.js";
import {
  createMermaidPageSelectionState,
  type MermaidPageSelectionState,
} from "./mermaid-page-selection-state.js";
import {
  createMermaidPageViewportState,
  type MermaidPageViewportState,
} from "./mermaid-page-viewport-state.js";

export type MermaidGeometryHudState = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
};

export type MermaidSubgraphDropPreviewState = {
  height: number;
  id: string;
  left: number;
  top: number;
  width: number;
};

/**
 * Reactive signal store for transient UI state owned by `MermaidBlockComponent`.
 *
 * Writing any signal field automatically notifies the mounted `MermaidBlockComponent`
 * projection effect without requiring manual `requestUpdate()` calls at mutation sites.
 */
export class MermaidHostSignalState {
  readonly mode$ = signal<MermaidViewMode>("visual");
  readonly renderState$ = signal<MermaidRenderState>("empty");
  readonly renderErrorLine$ = signal<number | null>(null);
  readonly renderErrorMessage$ = signal<string | null>(null);
  readonly svg$ = signal<string>("");
  readonly lastValidSvg$ = signal<string>("");

  readonly pageSelectionState$ = signal<MermaidPageSelectionState>(
    createMermaidPageSelectionState(),
  );
  readonly pageViewportState$ = signal<MermaidPageViewportState>(
    createMermaidPageViewportState(),
  );
  readonly embeddedGfxActionsSafeInset$ = signal<number>(0);

  readonly pendingVisualInsertShape$ = signal<MermaidVisualNodeShape | null>(
    null,
  );
  readonly showAllVisualShapes$ = signal<boolean>(false);
  readonly keyboardFocusedVisualItem$ = signal<Pick<
    MermaidPageSelectionItem,
    "editKey" | "kind"
  > | null>(null);
  readonly pageSelectionAnnouncement$ = signal<string>("");
  readonly visualInspectorSuppressed$ = signal<boolean>(false);
  readonly visualAutoViewportHeight$ = signal<number | null>(null);
  readonly visualNodeDragModel$ = signal<MermaidVisualModel | null>(null);
  readonly visualNodePointerSessionActive$ = signal<boolean>(false);

  readonly snapToGridEnabled$ = signal<boolean>(true);
  readonly activeSnapGuides$ = signal<readonly MermaidGfxSnapGuide[]>([]);
  readonly activeGeometryHud$ = signal<MermaidGeometryHudState | null>(null);
  readonly hoveredVisualNodeId$ = signal<string>("");
  readonly visualContextMenu$ = signal<{ left: number; top: number } | null>(
    null,
  );
  readonly visualAlignmentGuideId$ = signal<string>("");
  readonly visualSubgraphDropPreview$ =
    signal<MermaidSubgraphDropPreviewState | null>(null);

  readonly familyActionTarget$ = signal<HTMLElement | null>(null);
  readonly familyHeaderActionTarget$ = signal<HTMLElement | null>(null);
  readonly familySelectionAction$ = signal<MermaidSelectionActionModel | null>(
    null,
  );
  readonly familyTitlePresentationPreview$ =
    signal<MermaidTitlePresentation | null>(null);

  /** Revision counter bumped for external non-signal updates (model props, history, theme, viewport). */
  readonly externalRevision$ = signal<number>(0);

  bumpExternalRevision() {
    this.externalRevision$.value = this.externalRevision$.peek() + 1;
  }

  /** Subscribes an active signal effect to every transient UI signal in this store. */
  trackAll() {
    void this.mode$.value;
    void this.renderState$.value;
    void this.renderErrorLine$.value;
    void this.renderErrorMessage$.value;
    void this.svg$.value;
    void this.lastValidSvg$.value;
    void this.pageSelectionState$.value;
    void this.pageViewportState$.value;
    void this.embeddedGfxActionsSafeInset$.value;
    void this.pendingVisualInsertShape$.value;
    void this.showAllVisualShapes$.value;
    void this.keyboardFocusedVisualItem$.value;
    void this.pageSelectionAnnouncement$.value;
    void this.visualInspectorSuppressed$.value;
    void this.visualAutoViewportHeight$.value;
    void this.visualNodeDragModel$.value;
    void this.visualNodePointerSessionActive$.value;
    void this.snapToGridEnabled$.value;
    void this.activeSnapGuides$.value;
    void this.activeGeometryHud$.value;
    void this.hoveredVisualNodeId$.value;
    void this.visualContextMenu$.value;
    void this.visualAlignmentGuideId$.value;
    void this.visualSubgraphDropPreview$.value;
    void this.familyActionTarget$.value;
    void this.familyHeaderActionTarget$.value;
    void this.familySelectionAction$.value;
    void this.familyTitlePresentationPreview$.value;
    void this.externalRevision$.value;
  }
}

const hostSignalStates = new WeakMap<object, MermaidHostSignalState>();

/**
 * Lazily returns the reactive signal store bound to a Mermaid host instance.
 * Using a WeakMap keeps prototype-based unit test harnesses (`Object.create`) working
 * without requiring custom-element constructor execution.
 */
export function getMermaidHostSignalState(
  host: object,
): MermaidHostSignalState {
  let state = hostSignalStates.get(host);
  if (!state) {
    state = new MermaidHostSignalState();
    hostSignalStates.set(host, state);
  }
  return state;
}
