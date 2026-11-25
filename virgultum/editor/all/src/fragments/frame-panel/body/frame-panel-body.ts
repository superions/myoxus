import { computed, signal } from "@preact/signals-core";
import { EdgelessFrameManager } from "@virgultum/canvas/blocks";
import type { FrameBlockModel } from "@virgultum/core/models";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import { Bound } from "@virgultum/core/primitives/gfx";
import type { EditorHost } from "@virgultum/core/runtime";
import {
  generateKeyBetweenV2,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import {
  DocModeProvider,
  EditPropsStore,
  type EditorChromeHost,
  EditorChromeHostIdentifier,
  type EditorFrameNavigatorControls,
} from "@virgultum/core/services";
import type { Store } from "@virgultum/core/store";

import type {
  DragEvent,
  FitViewEvent,
  FrameCard,
  SelectEvent,
} from "../card/frame-card.js";
import {
  defaultFramePanelLabels,
  type FramePanelLabels,
} from "../frame-panel.js";
import { startDragging } from "../utils/drag.js";

const compare = EdgelessFrameManager.framePresentationComparator;

type FrameListItem = {
  frame: FrameBlockModel;

  // frame index
  frameIndex: string;

  // card index
  cardIndex: number;
};

export const MYOXUS_FRAME_PANEL_BODY = "myoxus-frame-panel-body";

export class FramePanelBody extends NativeViewElement {
  disposables = new DisposableGroup();

  private readonly _revision$ = signal(0);
  private readonly _dragging$ = signal(false);
  private readonly _selected$ = signal<string[]>([]);
  private readonly _insertIndex$ = signal<number | undefined>(undefined);

  private _domHost!: Document | HTMLElement;
  private _editorHost!: EditorHost;
  private _fitPadding!: number[];
  private _labels: FramePanelLabels = defaultFramePanelLabels;

  private _navigatorHost: HTMLDivElement | null = null;
  private _chromeUnmount: (() => void) | null = null;
  private _mountedChrome: EditorChromeHost | null = null;

  private readonly _clearDocDisposables = () => {
    this._docDisposables?.dispose();
    this._docDisposables = null;
  };

  /**
   * click at blank area to clear selection
   */
  private readonly _clickBlank = (e: MouseEvent) => {
    e.stopPropagation();
    // check if click at frame-card, if not, set this._selected to empty
    if (
      (e.target as HTMLElement).closest("myoxus-frame-card") ||
      this._selected$.peek().length === 0
    ) {
      return;
    }

    this._selected$.value = [];
    this._gfx.selection.set({
      elements: [],
      editing: false,
    });
  };

  private _docDisposables: DisposableGroup | null = null;

  private _frameElementHeight = 0;

  private _frameItems: FrameListItem[] = [];

  private _indicatorTranslateY = 0;

  private _lastEdgelessRootId = "";

  frameListContainer: HTMLElement | null = null;

  get domHost(): Document | HTMLElement {
    return this._domHost;
  }
  set domHost(value: Document | HTMLElement) {
    this._domHost = value;
  }

  get editorHost(): EditorHost {
    return this._editorHost;
  }
  set editorHost(value: EditorHost) {
    const changed = this._editorHost !== value;
    this._editorHost = value;
    if (changed && this.isConnected) {
      this._bindHost();
    }
    this._bump();
  }

  get fitPadding(): number[] {
    return this._fitPadding;
  }
  set fitPadding(value: number[]) {
    this._fitPadding = value;
    this._bump();
  }

  get labels(): FramePanelLabels {
    return this._labels;
  }
  set labels(value: FramePanelLabels) {
    this._labels = value;
    this._bump();
  }

  get insertIndex(): number | undefined {
    return this._insertIndex$.value;
  }
  set insertIndex(value: number | undefined) {
    this._insertIndex$.value = value;
  }

  private get _gfx() {
    return this.editorHost.std.get(GfxControllerIdentifier);
  }

  private _bump() {
    this._revision$.value = this._revision$.peek() + 1;
  }

  requestUpdate() {
    this._bump();
  }

  private readonly _selectFrame = (e: SelectEvent) => {
    const { selected, id, multiselect } = e.detail;
    const current = this._selected$.peek();

    let next: string[];
    if (!selected) {
      // de-select frame
      next = current.filter((frameId) => frameId !== id);
    } else if (multiselect) {
      next = [...current, id];
    } else {
      next = [id];
    }

    this._selected$.value = next;
    this._gfx.selection.set({
      elements: next,
      editing: false,
    });
  };

  private readonly _updateFrameItems = () => {
    if (!this._editorHost) {
      this._frameItems = [];
      return;
    }
    this._frameItems = this.frames.map((frame, idx) => ({
      frame,
      frameIndex: frame.props.presentationIndex ?? frame.props.index,
      cardIndex: idx,
    }));
  };

  get frames() {
    const frames = this.editorHost.store
      .getBlocksByFlavour("myoxus:frame")
      .map((block) => block.model as FrameBlockModel);
    return frames.sort(compare);
  }

  get viewportPadding(): [number, number, number, number] {
    return this.fitPadding
      ? ([0, 0, 0, 0].map((val, idx) =>
          Number.isFinite(this.fitPadding[idx]) ? this.fitPadding[idx] : val,
        ) as [number, number, number, number])
      : [0, 0, 0, 0];
  }

  private readonly _drag = (e: DragEvent) => {
    const selected = this._selected$.peek().slice();
    if (!selected.length || !this.frameListContainer) return;

    this._dragging$.value = true;

    const framesMap = this._frameItems.reduce((map, frame) => {
      map.set(frame.frame.id, {
        ...frame,
      });
      return map;
    }, new Map<string, FrameListItem>());

    const draggedFramesInfo = selected.map((id) => {
      const frame = framesMap.get(id) as FrameListItem;

      return {
        frame: frame.frame,
        element: this.querySelector(
          `[data-frame-id="${frame.frame.id}"]`,
        ) as FrameCard,
        cardIndex: frame.cardIndex,
        frameIndex: frame.frameIndex,
      };
    });
    const width = draggedFramesInfo[0].element.clientWidth;

    this._frameElementHeight = draggedFramesInfo[0].element.offsetHeight;

    startDragging(draggedFramesInfo, {
      width,
      container: this,
      document: this.ownerDocument,
      domHost: this.domHost ?? this.ownerDocument,
      start: {
        x: e.detail.clientX,
        y: e.detail.clientY,
      },
      framePanelBody: this,
      frameListContainer: this.frameListContainer,
      frameElementHeight: this._frameElementHeight,
      onDragEnd: (insertIdx) => {
        this._dragging$.value = false;
        this.insertIndex = undefined;

        if (insertIdx === undefined || this._frameItems.length <= 1) return;
        this._reorderFrames(selected, framesMap, insertIdx);
      },
      onDragMove: (idx, indicatorTranslateY) => {
        this._indicatorTranslateY = indicatorTranslateY ?? 0;
        this.insertIndex = idx;
      },
    });
  };

  private readonly _fitToElement = (e: FitViewEvent) => {
    const { block } = e.detail;
    const bound = Bound.deserialize(block.xywh);
    const docModeProvider = this.editorHost.std.get(DocModeProvider);

    if (docModeProvider.getEditorMode() !== "edgeless") {
      // When click frame card in page mode
      // Should switch to edgeless mode and set viewport to the frame
      const viewport = {
        xywh: block.xywh,
        referenceId: block.id,
        padding: this.viewportPadding as [number, number, number, number],
      };

      this.editorHost.std.get(EditPropsStore).setStorage("viewport", viewport);
      this.editorHost.std.get(DocModeProvider).setEditorMode("edgeless");
    } else {
      this._gfx.viewport.setViewportByBound(bound, this.viewportPadding, true);
    }
  };

  private readonly _controls$ = computed<EditorFrameNavigatorControls | null>(
    () => {
      void this._revision$.value;
      const selectedList = this._selected$.value;
      const dragging = this._dragging$.value;
      const insertIndex = this._insertIndex$.value;
      if (!this._editorHost) return null;

      this._updateFrameItems();
      const selected = new Set(selectedList);

      return {
        emptyLabel: this._labels.emptyPlaceholder,
        setList: (element) => {
          this.frameListContainer = element;
        },
        indicatorY:
          insertIndex === undefined ? undefined : this._indicatorTranslateY,
        items: this._frameItems.map(({ frame, frameIndex, cardIndex }) => ({
          id: frame.id,
          mount: (element) => {
            if (!element) return;
            const card = element as FrameCard;
            card.frame = frame;
            card.std = this.editorHost.std;
            card.cardIndex = cardIndex;
            card.frameIndex = frameIndex;
            card.status = selected.has(frame.id)
              ? dragging
                ? "placeholder"
                : "selected"
              : "none";
            // Stable listeners are deduplicated when React updates the same card ref.
            card.addEventListener("select", this._selectFrame as EventListener);
            card.addEventListener(
              "fitview",
              this._fitToElement as EventListener,
            );
            card.addEventListener("drag", this._drag as EventListener);
          },
        })),
      };
    },
  );

  private _reorderFrames(
    selected: string[],
    framesMap: Map<string, FrameListItem>,
    insertIndex: number,
  ) {
    if (insertIndex >= 0 && insertIndex <= this._frameItems.length) {
      const frames = Array.from(framesMap.values()).map(
        (frameItem) => frameItem.frame,
      );
      const selectedFrames = selected
        .map((id) => framesMap.get(id) as FrameListItem)
        .map((frameItem) => frameItem.frame)
        .sort(compare);

      // update selected frames index
      // make the indexes larger than the frame before and smaller than the frame after
      let before = frames[insertIndex - 1]?.props.presentationIndex || null;
      const after = frames[insertIndex]?.props.presentationIndex || null;
      selectedFrames.forEach((frame) => {
        const newIndex = generateKeyBetweenV2(before, after);
        frame.store.updateBlock(frame, {
          presentationIndex: newIndex,
        });
        before = newIndex;
      });

      this.editorHost.store.captureSync();
      this._updateFrames();
    }
  }

  private _setDocDisposables(doc: Store) {
    this._clearDocDisposables();
    this._docDisposables = new DisposableGroup();
    this._docDisposables.add(
      doc.slots.blockUpdated.subscribe(({ type, flavour }) => {
        if (flavour === "myoxus:frame" && type !== "update") {
          requestAnimationFrame(() => {
            this._updateFrames();
          });
        }
      }),
    );
  }

  private _updateFrames() {
    if (this._dragging$.peek()) return;

    if (!this._editorHost || !this.frames.length) {
      this._selected$.value = [];
      this._frameItems = [];
      this._bump();
      return;
    }

    const frameItems: FramePanelBody["_frameItems"] = [];
    const oldSelectedSet = new Set(this._selected$.peek());
    const newSelected: string[] = [];
    const frames = this.frames.sort(compare);
    frames.forEach((frame, idx) => {
      const frameItem = {
        frame,
        frameIndex: frame.props.presentationIndex ?? frame.props.index,
        cardIndex: idx,
      };

      frameItems.push(frameItem);
      if (oldSelectedSet.has(frame.id)) {
        newSelected.push(frame.id);
      }
    });

    this._frameItems = frameItems;
    this._selected$.value = newSelected;
    this._bump();
  }

  private _bindHost() {
    if (!this._editorHost || !this._navigatorHost) return;
    this._setDocDisposables(this._editorHost.store);

    // after switch to edgeless mode, should update the selection
    if (this._editorHost.store.id === this._lastEdgelessRootId) {
      this._gfx.selection.set({
        elements: this._selected$.peek(),
        editing: false,
      });
    } else if (this._selected$.peek().length) {
      this._selected$.value = [];
    }
    this._lastEdgelessRootId = this._editorHost.store.id;

    const chrome =
      this._editorHost.std.getOptional(EditorChromeHostIdentifier) ?? null;
    if (this._mountedChrome !== chrome) {
      this._chromeUnmount?.();
      this._chromeUnmount = null;
      this._mountedChrome = chrome;
      if (chrome) {
        this._chromeUnmount = chrome.mountFrameNavigator(
          this._navigatorHost,
          this._controls$,
        );
      }
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    if (!this._navigatorHost) {
      this._navigatorHost = this.ownerDocument.createElement("div");
      this._navigatorHost.style.display = "contents";
      this.replaceChildren(this._navigatorHost);
    }
    this.disposables.addFromEvent(this, "click", this._clickBlank);
    this._bindHost();
    this._updateFrameItems();
    this._bump();
  }

  disconnectedCallback() {
    this._chromeUnmount?.();
    this._chromeUnmount = null;
    this._mountedChrome = null;
    this._clearDocDisposables();
    this.disposables.dispose();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL_BODY]: FramePanelBody;
  }
}
