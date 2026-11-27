// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal } from "@preact/signals-core";
import type { NoteBlockComponent } from "@virgultum/embeds/blocks";
import {
  EdgelessLegacySlotIdentifier,
  isNoteBlock,
} from "@virgultum/canvas-runtime/surface";
import { EDGELESS_BLOCK_CHILD_PADDING } from "@virgultum/core/consts";
import {
  DEFAULT_NOTE_HEIGHT,
  type NoteBlockModel,
} from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import {
  deserializeXYWH,
  Point,
  serializeXYWH,
} from "@virgultum/core/primitives/gfx";
import type { BlockComponent } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
  TelemetryProvider,
  type EditorNoteSlicerControls,
} from "@virgultum/core/services";
import { getRectByBlockComponent } from "@virgultum/core/utils";

import type { EdgelessSelectedRectWidget } from "../edgeless-selected-rect/native-selection-overlay";

export const NOTE_SLICER_WIDGET = "note-slicer";

const DIVIDING_LINE_OFFSET = 4;
const NEW_NOTE_GAP = 40;

const noteSlicerCss = `
  note-slicer {
    display: flex;
  }

  .note-slicer-button {
    position: absolute;
    z-index: var(--myoxus-z-index-popover);
  }

  .note-slicer-dividing-line-container {
    display: flex;
    align-items: center;
    position: absolute;
    left: 0;
    top: 0;
    height: 4px;
    cursor: pointer;
  }

  .note-slicer-dividing-line {
    display: block;
    height: 1px;
    width: 100%;
    z-index: var(--myoxus-z-index-popover);
    background-image: linear-gradient(
      to right,
      var(--myoxus-black-10) 50%,
      transparent 50%
    );
    background-size: 4px 100%;
  }

  .note-slicer-dividing-line-container.active .note-slicer-dividing-line {
    background-image: linear-gradient(
      to right,
      var(--myoxus-black-60) 50%,
      transparent 50%
    );
    animation: myoxus-note-slicer-slide 0.3s linear infinite;
  }

  @keyframes myoxus-note-slicer-slide {
    0% {
      background-position: 0 0;
    }
    100% {
      background-position: -4px 0;
    }
  }
`;

/**
 * Pure-TypeScript AGPL signal controller for Edgeless Note slicing.
 * Mounts onto a plain `<note-slicer>` host element in the root overlay and
 * pushes reactive state to `EditorChromeHost.mountNoteSlicer`.
 */
export function mountNoteSlicer(
  edgeless: BlockComponent,
  overlay: HTMLElement,
): () => void {
  const chrome = edgeless.std.getOptional(EditorChromeHostIdentifier);
  if (!chrome?.mountNoteSlicer) return () => {};

  const { std, store, host } = edgeless;
  const gfx = std.get(GfxControllerIdentifier);
  const slots = std.get(EdgelessLegacySlotIdentifier);
  const disposables = new DisposableGroup();
  let noteDisposables: DisposableGroup | null = null;

  const doc = overlay.ownerDocument;
  const container = doc.createElement(NOTE_SLICER_WIDGET);
  const style = doc.createElement("style");
  style.textContent = noteSlicerCss;
  const mountTarget = doc.createElement("div");
  mountTarget.style.display = "contents";
  container.append(style, mountTarget);
  overlay.append(container);

  const state$ = signal<EditorNoteSlicerControls | null>(null);
  let anchorNote: NoteBlockModel | null = null;
  let enabled = false;
  let hidden = false;
  let resizing = false;
  let activeIndex = 0;
  let linePositions: Point[] = [];
  let noteBlockIds: string[] = [];

  const getSelectedRect = () =>
    host.querySelector<EdgelessSelectedRectWidget>("edgeless-selected-rect");

  const getNoteBlock = () => {
    if (!anchorNote) return null;
    const block = host.view.getBlock(anchorNote.id);
    return block ? (block as NoteBlockComponent) : null;
  };

  const recomputeDividingLines = () => {
    const noteBlock = getNoteBlock();
    if (!anchorNote || !noteBlock) {
      linePositions = [];
      noteBlockIds = [];
      return;
    }
    const zoom = gfx.viewport.zoom;
    const noteRect = noteBlock.getBoundingClientRect();
    const positions: Point[] = [];
    const ids: string[] = [];

    for (let i = 0; i < anchorNote.children.length - 1; i++) {
      const child = anchorNote.children[i];
      const rect = host.view.getBlock(child.id)?.getBoundingClientRect();
      if (rect && rect.bottom > noteRect.top && rect.bottom < noteRect.bottom) {
        const x = rect.x - (gfx.viewport.left ?? 0);
        const y =
          rect.bottom + DIVIDING_LINE_OFFSET * zoom - (gfx.viewport.top ?? 0);
        positions.push(new Point(x, y));
        ids.push(child.id);
      }
    }

    linePositions = positions;
    noteBlockIds = ids;
  };

  const sliceNote = () => {
    if (!anchorNote || !noteBlockIds.length) return;
    const {
      index: originalIndex,
      xywh,
      background,
      displayMode,
    } = anchorNote.props;
    const originalNoteIndex = anchorNote.parent?.children.findIndex(
      (child) => child === anchorNote,
    );
    const { children } = anchorNote;
    const {
      collapse: _collapse,
      collapsedHeight: _collapsedHeight,
      ...restOfEdgeless
    } = anchorNote.props.edgeless;
    const anchorBlockId = noteBlockIds[activeIndex];
    if (!anchorBlockId) return;
    const sliceIndex = children.findIndex(
      (block) => block.id === anchorBlockId,
    );
    const movedBlocks = children.slice(sliceIndex + 1);
    const [x, , width] = deserializeXYWH(xywh);
    const sliceVerticalPos = linePositions[activeIndex].y;
    const newY = gfx.viewport.toModelCoord(x, sliceVerticalPos)[1];
    const newNoteId = store.addBlock(
      "myoxus:note",
      {
        background,
        displayMode,
        xywh: serializeXYWH(x, newY + NEW_NOTE_GAP, width, DEFAULT_NOTE_HEIGHT),
        index: originalIndex + 1,
        edgeless: restOfEdgeless,
      },
      store.root?.id,
      originalNoteIndex ? originalNoteIndex + 1 : undefined,
    );

    store.moveBlocks(
      movedBlocks,
      store.getModelById(newNoteId) as NoteBlockModel,
    );
    activeIndex = 0;
    gfx.selection.set({
      elements: [newNoteId],
      editing: false,
    });
    std.getOptional(TelemetryProvider)?.track("SplitNote", {
      control: "NoteSlicer",
    });
  };

  const syncState = () => {
    if (store.readonly || hidden || resizing || !anchorNote || !enabled) {
      state$.value = null;
      return;
    }
    recomputeDividingLines();
    const noteBlock = getNoteBlock();
    if (!noteBlock || !linePositions.length) {
      state$.value = null;
      return;
    }

    const zoom = gfx.viewport.zoom;
    const rect = getRectByBlockComponent(noteBlock);
    const lineWidth = rect.width - 2 * EDGELESS_BLOCK_CHILD_PADDING * zoom;
    activeIndex = Math.min(activeIndex, linePositions.length - 1);
    const activePoint = linePositions[activeIndex];
    const i18n = std.getOptional(EditorI18nProvider) ?? undefined;

    state$.value = {
      buttonLeft: activePoint.x - 66 * zoom,
      buttonTop: activePoint.y,
      buttonLabel: resolveEditorMessage(
        editorMessage("com.myoxus.editor.toolbar.slicer", "Slicer"),
        i18n,
      ),
      lineWidth,
      activeIndex,
      lines: linePositions.map((pt) => ({ left: pt.x, top: pt.y })),
      slice: sliceNote,
    };
  };

  const updateAnchorNote = () => {
    const { selectedElements } = gfx.selection;
    const next =
      !gfx.selection.editing &&
      selectedElements.length === 1 &&
      isNoteBlock(selectedElements[0])
        ? selectedElements[0]
        : null;
    if (next === anchorNote) return;
    anchorNote = next;
    noteDisposables?.dispose();
    noteDisposables = next ? new DisposableGroup() : null;
    if (next) {
      noteDisposables?.add(
        next.propsUpdated.subscribe(({ key }) => {
          if (key === "children" || key === "xywh") syncState();
        }),
      );
    }
  };

  const updateActiveIndexFromPointer = (pos: Point) => {
    const curY = pos.y + DIVIDING_LINE_OFFSET * gfx.viewport.zoom;
    let nextIndex = -1;
    for (let i = 0; i < linePositions.length; i++) {
      const currentY = linePositions[i].y;
      const previousY = i > 0 ? linePositions[i - 1].y : 0;
      const midY = (currentY + previousY) / 2;
      if (curY < midY) break;
      nextIndex++;
    }
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex !== activeIndex) {
      activeIndex = nextIndex;
      syncState();
    }
  };

  disposables.add(chrome.mountNoteSlicer(mountTarget, state$));
  disposables.add(store.readonly$.subscribe(() => syncState()));
  disposables.add(
    edgeless.service.uiEventDispatcher.add("wheel", () => {
      hidden = true;
      syncState();
    }),
  );
  disposables.add(
    slots.elementResizeStart.subscribe(() => {
      resizing = true;
      syncState();
    }),
  );
  disposables.add(
    slots.elementResizeEnd.subscribe(() => {
      resizing = false;
      syncState();
    }),
  );
  disposables.add(
    std.event.add("pointerMove", (ctx) => {
      if (hidden) {
        hidden = false;
        syncState();
      }
      const pointerState = ctx.get("pointerState");
      updateActiveIndexFromPointer(new Point(pointerState.x, pointerState.y));
    }),
  );
  disposables.add(
    gfx.viewport.viewportUpdated.subscribe(() => {
      hidden = true;
      syncState();
    }),
  );
  disposables.add(
    gfx.selection.slots.updated.subscribe(() => {
      enabled = false;
      updateAnchorNote();
      syncState();
      const selectedRect = getSelectedRect();
      if (selectedRect) {
        selectedRect.autoCompleteOff = false;
      }
    }),
  );
  disposables.add(
    slots.toggleNoteSlicer.subscribe(() => {
      enabled = !enabled;
      syncState();
      const selectedRect = getSelectedRect();
      if (selectedRect && enabled) {
        selectedRect.autoCompleteOff = true;
      }
    }),
  );

  updateAnchorNote();
  syncState();

  return () => {
    noteDisposables?.dispose();
    noteDisposables = null;
    anchorNote = null;
    state$.value = null;
    disposables.dispose();
    container.remove();
  };
}
