// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect, signal } from "@preact/signals-core";
import {
  EdgelessCRUDIdentifier,
  EdgelessLegacySlotIdentifier,
  isNoteBlock,
} from "@virgultum/canvas-runtime/surface";
import {
  FrameBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
  SurfaceRefBlockModel,
} from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { Bound } from "@virgultum/core/primitives/gfx";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  FeatureFlagService,
  type EditorAutoConnectControls,
} from "@virgultum/core/services";
import { matchModels } from "@virgultum/core/utils";

const PAGE_VISIBLE_INDEX_LABEL_HEIGHT = 24;
const INDEX_LABEL_OFFSET = 16;

type AutoConnectElement = NoteBlockModel | FrameBlockModel;

function isAutoConnectElement(element: unknown): element is AutoConnectElement {
  return (
    element instanceof NoteBlockModel || element instanceof FrameBlockModel
  );
}

function fanPositions(gap: number, count: number, iconWidth: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      [0, 10 + (index - (count - 1) / 2) * (gap + iconWidth)] as const,
  );
}

/**
 * Pure-TypeScript AGPL signal controller for Edgeless page-visibility index
 * badges and Previous/Next navigation, replacing `EdgelessAutoConnectWidget`.
 */
export function mountAutoConnect(
  edgeless: BlockComponent,
  overlay: HTMLElement,
): () => void {
  const chrome = edgeless.std.getOptional(EditorChromeHostIdentifier);
  if (!chrome?.mountAutoConnect) return () => {};

  const { std, store } = edgeless;
  const gfx = std.get(GfxControllerIdentifier);
  const crud = std.get(EdgelessCRUDIdentifier);
  const slots = std.get(EdgelessLegacySlotIdentifier);
  const disposables = new DisposableGroup();

  const anchor = overlay.ownerDocument.createElement("div");
  anchor.dataset.canvasAutoConnect = "";
  Object.assign(anchor.style, {
    position: "absolute",
    top: "0",
    left: "0",
    zIndex: "1",
  });
  overlay.append(anchor);

  const state$ = signal<EditorAutoConnectControls | null>(null);
  let show = false;
  let dragging = false;
  let activeIndex = -1;
  let expandedId: string | null = null;
  let edgelessOnlyNotes = new Set<NoteBlockModel>();
  let pageVisibleMap = new Map<AutoConnectElement, number>();

  const isEnabled = () =>
    store.get(FeatureFlagService).getFlag("enable_advanced_block_visibility");

  const collectPageVisibleElements = () => {
    const root = store.root;
    if (!root) {
      edgelessOnlyNotes = new Set();
      pageVisibleMap = new Map();
      return;
    }
    const visible = new Map<AutoConnectElement, number>();
    const edgelessOnly = new Set<NoteBlockModel>();
    const notes = root.children.filter((child) =>
      matchModels(child, [NoteBlockModel]),
    );

    for (const note of notes) {
      if (isNoteBlock(note)) {
        if (note.props.displayMode$.value === NoteDisplayMode.EdgelessOnly) {
          edgelessOnly.add(note);
        } else if (
          note.props.displayMode$.value === NoteDisplayMode.DocAndEdgeless
        ) {
          visible.set(note, 1);
        }
      }

      for (const child of note.children) {
        if (matchModels(child, [SurfaceRefBlockModel])) {
          const reference = crud.getElementById(child.props.reference);
          if (!isAutoConnectElement(reference)) continue;
          visible.set(reference, (visible.get(reference) ?? 0) + 1);
        }
      }
    }

    edgelessOnlyNotes = edgelessOnly;
    pageVisibleMap = visible;
  };

  const navigate = (direction: -1 | 1) => {
    if (!isEnabled()) return;
    collectPageVisibleElements();
    const elements = [...pageVisibleMap.keys()];
    const next = activeIndex + direction;
    const element = elements[next];
    if (activeIndex < 0 || !element) return;
    activeIndex = next;
    const bound = Bound.deserialize(element.xywh);
    gfx.selection.set({ elements: [element.id], editing: false });
    gfx.viewport.setViewportByBound(bound, [80, 80, 80, 80], true);
    syncState();
  };

  const syncState = () => {
    if (!show || dragging || !isEnabled()) {
      state$.value = null;
      return;
    }
    collectPageVisibleElements();
    const elements = [...pageVisibleMap.keys()];
    let sequence = 0;

    const visibleGroups = elements.map((element, elementIdx) => {
      const bound = Bound.deserialize(element.xywh);
      const [left, top] = gfx.viewport.toViewCoord(bound.center[0], bound.maxY);
      const count = pageVisibleMap.get(element) ?? 0;
      const positions = fanPositions(
        expandedId === element.id ? 5 : 24 / Math.max(count, 1) - 24,
        count,
        PAGE_VISIBLE_INDEX_LABEL_HEIGHT,
      );
      const items = positions.map(([posY, posX]) => {
        const displayIndex = ++sequence;
        return {
          index: displayIndex,
          offsetX: posX - 10,
          offsetY: posY,
          active: activeIndex === elementIdx,
          toggle: () => {
            if (!isEnabled()) return;
            collectPageVisibleElements();
            const currentIdx = [...pageVisibleMap.keys()].findIndex(
              (entry) => entry.id === element.id,
            );
            activeIndex = activeIndex === currentIdx ? -1 : currentIdx;
            syncState();
          },
        };
      });

      return {
        id: element.id,
        left,
        top: top + INDEX_LABEL_OFFSET,
        onHoverChange: (hovered: boolean) => {
          const nextExpanded = hovered
            ? element.id
            : expandedId === element.id
              ? null
              : expandedId;
          if (nextExpanded !== expandedId) {
            expandedId = nextExpanded;
            syncState();
          }
        },
        items,
      };
    });

    const hiddenNotes = [...edgelessOnlyNotes].map((note) => {
      const bound = Bound.deserialize(note.xywh);
      const [left, top] = gfx.viewport.toViewCoord(bound.center[0], bound.maxY);
      return {
        id: note.id,
        left,
        top: top + INDEX_LABEL_OFFSET,
      };
    });

    const current = elements[activeIndex];
    let navigator: EditorAutoConnectControls["navigator"] = null;
    if (current) {
      const bound = Bound.deserialize(current.xywh);
      const [left, top] = gfx.viewport.toViewCoord(bound.center[0], bound.maxY);
      navigator = {
        left,
        top: top + INDEX_LABEL_OFFSET,
        previous: activeIndex > 0,
        next: activeIndex < elements.length - 1,
        navigate,
      };
    }

    state$.value = {
      visibleGroups,
      hiddenNotes,
      navigator,
    };
  };

  const refreshVisibility = () => {
    const selected = gfx.selection.selectedElements;
    const references = store.getBlocksByFlavour("myoxus:surface-ref");
    show =
      selected.length === 1 &&
      !gfx.selection.editing &&
      (isNoteBlock(selected[0]) ||
        references.some(
          (ref) =>
            (ref.model as SurfaceRefBlockModel).props.reference ===
            selected[0].id,
        ));
    if (!show) activeIndex = -1;
    syncState();
  };

  disposables.add(chrome.mountAutoConnect(anchor, state$));
  disposables.add(gfx.selection.slots.updated.subscribe(refreshVisibility));
  disposables.add(
    store.slots.blockUpdated.subscribe(() => {
      refreshVisibility();
    }),
  );

  const surface = gfx.surface;
  if (surface) {
    disposables.add(
      surface.elementUpdated.subscribe((payload) => {
        if (
          payload.props["xywh"] &&
          store
            .getBlocksByFlavour("myoxus:surface-ref")
            .some(
              (ref) =>
                (ref.model as SurfaceRefBlockModel).props.reference ===
                payload.id,
            )
        ) {
          syncState();
        }
      }),
    );
  }

  disposables.add(
    effect(() => {
      if (!isEnabled()) activeIndex = -1;
      syncState();
    }),
  );

  const startDrag = () => {
    dragging = true;
    syncState();
  };
  const endDrag = () => {
    dragging = false;
    syncState();
  };

  disposables.add(gfx.viewport.viewportUpdated.subscribe(() => syncState()));
  disposables.add(std.event.add("dragStart", startDrag));
  disposables.add(std.event.add("dragEnd", endDrag));
  disposables.add(slots.elementResizeStart.subscribe(startDrag));
  disposables.add(slots.elementResizeEnd.subscribe(endDrag));

  refreshVisibility();

  return () => {
    state$.value = null;
    disposables.dispose();
    anchor.remove();
  };
}
