import { EdgelessFrameManager } from "@virgultum/canvas/blocks";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { Bound } from "@virgultum/core/primitives/gfx";
import { SignalWatcher, WithDisposable } from "@virgultum/core/primitives/lit";
import type { FrameBlockModel } from "@virgultum/core/models";
import {
  DocModeProvider,
  EditPropsStore,
  EditorChromeHostIdentifier,
} from "@virgultum/core/services";
import { type EditorHost, ShadowlessElement } from "@virgultum/core/runtime";
import {
  generateKeyBetweenV2,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import type { Store } from "@virgultum/core/store";
import { nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

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

export class FramePanelBody extends SignalWatcher(
  WithDisposable(ShadowlessElement),
) {
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
      this._selected.length === 0
    ) {
      return;
    }

    this._selected = [];
    this._gfx.selection.set({
      elements: this._selected,
      editing: false,
    });
  };

  private _docDisposables: DisposableGroup | null = null;

  private _frameElementHeight = 0;

  private _frameItems: FrameListItem[] = [];

  private _indicatorTranslateY = 0;

  private _lastEdgelessRootId = "";

  private get _gfx() {
    return this.editorHost.std.get(GfxControllerIdentifier);
  }

  private readonly _selectFrame = (e: SelectEvent) => {
    const { selected, id, multiselect } = e.detail;

    if (!selected) {
      // de-select frame
      this._selected = this._selected.filter((frameId) => frameId !== id);
    } else if (multiselect) {
      this._selected = [...this._selected, id];
    } else {
      this._selected = [id];
    }

    this._gfx.selection.set({
      elements: this._selected,
      editing: false,
    });
  };

  private readonly _updateFrameItems = () => {
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
    if (!this._selected.length || !this.frameListContainer) return;

    this._dragging = true;

    const framesMap = this._frameItems.reduce((map, frame) => {
      map.set(frame.frame.id, {
        ...frame,
      });
      return map;
    }, new Map<string, FrameListItem>());
    const selected = this._selected.slice();

    const draggedFramesInfo = selected.map((id) => {
      const frame = framesMap.get(id) as FrameListItem;

      return {
        frame: frame.frame,
        element: this.renderRoot.querySelector(
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
        this._dragging = false;
        this.insertIndex = undefined;

        if (insertIdx === undefined || this._frameItems.length <= 1) return;
        this._reorderFrames(selected, framesMap, insertIdx);
      },
      onDragMove: (idx, indicatorTranslateY) => {
        this.insertIndex = idx;
        this._indicatorTranslateY = indicatorTranslateY ?? 0;
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

  private _renderNavigator() {
    const host = this.editorHost.std.getOptional(EditorChromeHostIdentifier);
    if (!host) return nothing;
    const selected = new Set(this._selected);
    return host.renderFrameNavigator({
      emptyLabel: this.labels.emptyPlaceholder,
      setList: (element) => {
        this.frameListContainer = element;
      },
      indicatorY:
        this.insertIndex === undefined ? undefined : this._indicatorTranslateY,
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
            ? this._dragging
              ? "placeholder"
              : "selected"
            : "none";
          // Stable listeners are deduplicated when React updates the same card ref.
          card.addEventListener("select", this._selectFrame as EventListener);
          card.addEventListener("fitview", this._fitToElement as EventListener);
          card.addEventListener("drag", this._drag as EventListener);
        },
      })),
    });
  }

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
    if (this._dragging) return;

    if (!this.frames.length) {
      this._selected = [];
      this._frameItems = [];
      return;
    }

    const frameItems: FramePanelBody["_frameItems"] = [];
    const oldSelectedSet = new Set(this._selected);
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
    this._selected = newSelected;
    this.requestUpdate();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._updateFrameItems();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._clearDocDisposables();
  }

  override firstUpdated() {
    const disposables = this.disposables;
    disposables.addFromEvent(this, "click", this._clickBlank);
  }

  override render() {
    this._updateFrameItems();
    return this._renderNavigator();
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has("editorHost") && this.editorHost) {
      this._setDocDisposables(this.editorHost.store);
      // after switch to edgeless mode, should update the selection
      if (this.editorHost.store.id === this._lastEdgelessRootId) {
        this._gfx.selection.set({
          elements: this._selected,
          editing: false,
        });
      } else {
        this._selected = this._selected.length ? [] : this._selected;
      }
      this._lastEdgelessRootId = this.editorHost.store.id;
    }
  }

  @state()
  private accessor _dragging = false;

  // Store the ids of the selected frames
  @state()
  private accessor _selected: string[] = [];

  @property({ attribute: false })
  accessor domHost!: Document | HTMLElement;

  @property({ attribute: false })
  accessor editorHost!: EditorHost;

  @property({ attribute: false })
  accessor fitPadding!: number[];

  @property({ attribute: false })
  accessor labels: FramePanelLabels = defaultFramePanelLabels;

  frameListContainer: HTMLElement | null = null;

  @property({ attribute: false })
  accessor insertIndex: number | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_FRAME_PANEL_BODY]: FramePanelBody;
  }
}
