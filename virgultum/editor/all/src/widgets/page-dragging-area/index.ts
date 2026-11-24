import type { RootBlockModel } from "@virgultum/core/models";
import { ViewportElementProvider } from "@virgultum/core/services";
import { autoScroll, getScrollContainer } from "@virgultum/core/utils";
import {
  type BlockComponent,
  BlockSelection,
  type PointerEventState,
  NativeEditorWidget,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import {
  type BlockInfo,
  getSelectingBlockPaths,
  isDragArea,
  type Rect,
} from "./utils";

export const MYOXUS_PAGE_DRAGGING_AREA_WIDGET =
  "myoxus-page-dragging-area-widget";

export class MyoxusPageDraggingAreaWidget extends NativeEditorWidget<RootBlockModel> {
  static excludeFlavours: string[] = ["myoxus:note", "myoxus:surface"];

  private _dragging = false;

  private _initialContainerOffset: {
    x: number;
    y: number;
  } = {
    x: 0,
    y: 0,
  };

  private _initialScrollOffset: {
    top: number;
    left: number;
  } = {
    top: 0,
    left: 0,
  };

  private _lastPointerState: PointerEventState | null = null;

  private _rafID = 0;

  private readonly _updateDraggingArea = (
    state: PointerEventState,
    shouldAutoScroll: boolean,
  ) => {
    const { x, y } = state;
    const { x: startX, y: startY } = state.start;

    const { left: initScrollX, top: initScrollY } = this._initialScrollOffset;
    if (!this._viewport) {
      return;
    }
    const { scrollLeft, scrollTop, scrollWidth, scrollHeight } = this._viewport;

    const { x: initConX, y: initConY } = this._initialContainerOffset;
    const { x: conX, y: conY } = state.containerOffset;

    const { left: viewportLeft, top: viewportTop } = this._viewport;
    let left = Math.min(
      startX + initScrollX + initConX - viewportLeft,
      x + scrollLeft + conX - viewportLeft,
    );
    let right = Math.max(
      startX + initScrollX + initConX - viewportLeft,
      x + scrollLeft + conX - viewportLeft,
    );
    let top = Math.min(
      startY + initScrollY + initConY - viewportTop,
      y + scrollTop + conY - viewportTop,
    );
    let bottom = Math.max(
      startY + initScrollY + initConY - viewportTop,
      y + scrollTop + conY - viewportTop,
    );

    left = Math.max(left, conX - viewportLeft);
    right = Math.min(right, scrollWidth);
    top = Math.max(top, conY - viewportTop);
    bottom = Math.min(bottom, scrollHeight);

    const userRect = {
      left,
      top,
      width: right - left,
      height: bottom - top,
    };
    this.paint(userRect);
    this._selectBlocksByRect({
      left: userRect.left + viewportLeft,
      top: userRect.top + viewportTop,
      width: userRect.width,
      height: userRect.height,
    });
    this._lastPointerState = state;

    if (shouldAutoScroll && this.scrollContainer) {
      const rect = this.scrollContainer.getBoundingClientRect();
      const result = autoScroll(this.scrollContainer, state.raw.y - rect.top);
      if (!result) {
        this._clearRaf();
        return;
      }
    }
  };

  private get _allBlocksWithRect(): BlockInfo[] {
    if (!this._viewport) {
      return [];
    }
    const { scrollLeft, scrollTop } = this._viewport;

    const getAllNodeFromTree = (): BlockComponent[] => {
      const blocks: BlockComponent[] = [];
      this.host.view.walkThrough((view) => {
        if (
          view.model.role !== "root" &&
          !MyoxusPageDraggingAreaWidget.excludeFlavours.includes(
            view.model.flavour,
          )
        ) {
          blocks.push(view);
        }
        return;
      });
      return blocks;
    };

    const elements = getAllNodeFromTree();

    return elements.map((element) => {
      const bounding = element.getBoundingClientRect();
      return {
        element,
        rect: {
          left: bounding.left + scrollLeft,
          top: bounding.top + scrollTop,
          width: bounding.width,
          height: bounding.height,
        },
      };
    });
  }

  private get _viewport() {
    return this.std.get(ViewportElementProvider).viewport;
  }

  private get scrollContainer() {
    if (!this.block) {
      return null;
    }
    return getScrollContainer(this.block);
  }

  private _clearRaf() {
    if (this._rafID) {
      cancelAnimationFrame(this._rafID);
      this._rafID = 0;
    }
  }

  private _selectBlocksByRect(userRect: Rect) {
    const selections = getSelectingBlockPaths(
      this._allBlocksWithRect,
      userRect,
    ).map((blockPath) => {
      return this.host.selection.create(BlockSelection, {
        blockId: blockPath,
      });
    });

    this.host.selection.setGroup("note", selections);
  }

  override connectedCallback() {
    super.connectedCallback();

    this.handleEvent(
      "dragStart",
      (ctx) => {
        const state = ctx.get("pointerState");
        const { button } = state.raw;
        if (button !== 0) return;
        if (!isDragArea(state)) return;
        if (!this._viewport) return;

        this._dragging = true;
        const { scrollLeft, scrollTop } = this._viewport;
        this._initialScrollOffset = {
          left: scrollLeft,
          top: scrollTop,
        };
        this._initialContainerOffset = {
          x: state.containerOffset.x,
          y: state.containerOffset.y,
        };

        return true;
      },
      { global: true },
    );

    this.handleEvent(
      "dragMove",
      (ctx) => {
        this._clearRaf();
        if (!this._dragging) {
          return;
        }

        const state = ctx.get("pointerState");
        // TODO(@L-Sun) support drag area for touch device
        if (state.raw.pointerType === "touch") return;

        ctx.get("defaultState").event.preventDefault();

        this._rafID = requestAnimationFrame(() => {
          this._updateDraggingArea(state, true);
        });

        return true;
      },
      { global: true },
    );

    this.handleEvent(
      "dragEnd",
      () => {
        this._clearRaf();
        this._dragging = false;
        this.mark.remove();
        this._initialScrollOffset = {
          top: 0,
          left: 0,
        };
        this._initialContainerOffset = {
          x: 0,
          y: 0,
        };
        this._lastPointerState = null;
      },
      {
        global: true,
      },
    );

    this.handleEvent(
      "pointerMove",
      (ctx) => {
        if (this._dragging) {
          const state = ctx.get("pointerState");
          state.raw.preventDefault();
        }
      },
      {
        global: true,
      },
    );
    this.disposables.addFromEvent(this.scrollContainer, "scroll", () => {
      if (!this._dragging || !this._lastPointerState) return;

      const state = this._lastPointerState;
      this._rafID = requestAnimationFrame(() => {
        this._updateDraggingArea(state, false);
      });
    });
  }

  private readonly mark = this.ownerDocument.createElement("div");

  private paint(rect: Rect) {
    const { style } = this.mark;
    if (!this.mark.isConnected) {
      this.mark.className = "myoxus-page-dragging-area";
      Object.assign(style, {
        position: "absolute",
        background: "var(--myoxus-hover-color)",
        zIndex: "1",
        pointerEvents: "none",
      });
      (this.shadowRoot ?? this.attachShadow({ mode: "open" })).append(
        this.mark,
      );
    }
    Object.assign(style, {
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
  }

  override disconnectedCallback() {
    this._clearRaf();
    this._dragging = false;
    this._lastPointerState = null;
    this.mark.remove();
    super.disconnectedCallback();
  }
}

export const pageDraggingAreaWidget = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_PAGE_DRAGGING_AREA_WIDGET,
  MYOXUS_PAGE_DRAGGING_AREA_WIDGET,
);

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_PAGE_DRAGGING_AREA_WIDGET]: MyoxusPageDraggingAreaWidget;
  }
}
