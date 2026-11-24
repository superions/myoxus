import { computed, type ReadonlySignal, signal } from "@preact/signals-core";
import { EdgelessCRUDIdentifier } from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import type { IVec, Point, Rect } from "@virgultum/core/primitives/gfx";
import type { RootBlockModel } from "@virgultum/core/models";
import { DocModeProvider } from "@virgultum/core/services";
import {
  isInsideEdgelessEditor,
  isInsidePageEditor,
} from "@virgultum/core/utils";
import {
  type BlockComponent,
  NativeEditorWidget,
} from "@virgultum/core/runtime";
import type { GfxModel } from "@virgultum/core/runtime/gfx";
import type { MYOXUS_DRAG_HANDLE_WIDGET } from "./consts.js";
import { RectHelper } from "./helpers/rect-helper.js";
import { SelectionHelper } from "./helpers/selection-helper.js";
import { styles } from "./styles.js";
import { updateDragHandleClassName } from "./utils.js";
import { DragEventWatcher } from "./watchers/drag-event-watcher.js";
import { EdgelessWatcher } from "./watchers/edgeless-watcher.js";
import { HandleEventWatcher } from "./watchers/handle-event-watcher.js";
import { KeyboardEventWatcher } from "./watchers/keyboard-event-watcher.js";
import { PageWatcher } from "./watchers/page-watcher.js";
import { PointerEventWatcher } from "./watchers/pointer-event-watcher.js";

export class MyoxusDragHandleWidget extends NativeEditorWidget<RootBlockModel> {
  readonly dragHandleContainer = this.ownerDocument.createElement("div");
  readonly dragHandleGrabber = this.ownerDocument.createElement("div");
  private readonly hover = this.ownerDocument.createElement("div");
  private active: "block" | "gfx" | null = null;
  private hoverBounds: Pick<
    DOMRect,
    "width" | "height" | "left" | "top"
  > | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const sheet = this.ownerDocument.createElement("style");
    sheet.textContent = styles;
    const wrapper = this.ownerDocument.createElement("div");
    wrapper.className = "myoxus-drag-handle-widget";
    this.dragHandleContainer.className = "myoxus-drag-handle-container";
    this.dragHandleGrabber.className = "myoxus-drag-handle-grabber";
    this.hover.className = "myoxus-drag-hover-rect";
    this.hover.style.display = "none";
    this.dragHandleContainer.append(this.dragHandleGrabber);
    wrapper.append(this.dragHandleContainer, this.hover);
    shadow.append(sheet, wrapper);
  }

  private _anchorModelDisposables: DisposableGroup | null = null;

  /**
   * Used to handle drag behavior
   */
  private readonly _dragEventWatcher = new DragEventWatcher(this);

  private readonly _handleEventWatcher = new HandleEventWatcher(this);

  private readonly _keyboardEventWatcher = new KeyboardEventWatcher(this);

  private readonly _pageWatcher = new PageWatcher(this);

  private readonly _reset = () => {
    this.dragging = false;

    this.isDragHandleHovered = false;

    this.pointerEventWatcher.reset();
  };

  get activeDragHandle() {
    return this.active;
  }
  set activeDragHandle(value: "block" | "gfx" | null) {
    if (this.active === value) return;
    this.active = value;
    this.dragHandleGrabber.classList.toggle("dots", value === "gfx");
    this.dragHandleGrabber.replaceChildren();
    if (value === "gfx") {
      for (let i = 0; i < 6; i++) {
        const dot = this.ownerDocument.createElement("div");
        dot.className = "dot";
        this.dragHandleGrabber.append(dot);
      }
    }
    this.paintHover();
  }

  anchorBlockId = signal<string | null>(null);

  anchorBlockComponent = computed<BlockComponent | null>(() => {
    if (!this.anchorBlockId.value) return null;

    return this.std.view.getBlock(this.anchorBlockId.value);
  });

  anchorEdgelessElement: ReadonlySignal<GfxModel | null> = computed(() => {
    if (!this.anchorBlockId.value) return null;
    if (this.mode === "page") return null;

    const crud = this.std.get(EdgelessCRUDIdentifier);
    const edgelessElement = crud.getElementById(this.anchorBlockId.value);
    return edgelessElement;
  });

  // Single block: drag handle should show on the vertical middle of the first line of element
  center: IVec = [0, 0];

  dragging = false;

  rectHelper = new RectHelper(this);

  draggingAreaRect: ReadonlySignal<Rect | null> = computed(
    this.rectHelper.getDraggingAreaRect,
  );

  lastDragPoint: Point | null = null;

  edgelessWatcher = new EdgelessWatcher(this);

  handleAnchorModelDisposables = () => {
    const block = this.anchorBlockComponent.peek();
    if (!block) return;
    const blockModel = block.model;

    if (this._anchorModelDisposables) {
      this._anchorModelDisposables.dispose();
      this._anchorModelDisposables = null;
    }

    this._anchorModelDisposables = new DisposableGroup();

    this._anchorModelDisposables.add(
      blockModel.deleted.subscribe(() => this.hide()),
    );
  };

  /**
   * @param force Reset the dragging state
   */
  hide = (force = false) => {
    if (this.dragging && !force) return;
    updateDragHandleClassName();

    this.isDragHandleHovered = false;

    this.anchorBlockId.value = null;
    this.dragHoverRect = null;
    this.activeDragHandle = null;

    if (this.dragHandleContainer) {
      this.dragHandleContainer.removeAttribute("style");
      this.dragHandleContainer.style.display = "none";
    }
    if (this.dragHandleGrabber) {
      this.dragHandleGrabber.removeAttribute("style");
    }

    if (force) {
      this._reset();
    }
  };

  isDragHandleHovered = false;

  get isBlockDragHandleVisible() {
    return this.activeDragHandle === "block";
  }

  get isGfxDragHandleVisible() {
    return this.activeDragHandle === "gfx";
  }

  noteScale = signal(1);

  pointerEventWatcher = new PointerEventWatcher(this);

  scale = signal(1);

  scaleInNote = computed(() => this.scale.value * this.noteScale.value);

  selectionHelper = new SelectionHelper(this);

  get dragHandleContainerOffsetParent() {
    return this.dragHandleContainer.parentElement!;
  }

  get mode() {
    return this.std.get(DocModeProvider).getEditorMode();
  }

  get rootComponent() {
    return this.block;
  }

  override connectedCallback() {
    super.connectedCallback();

    this.pointerEventWatcher.watch();
    this._keyboardEventWatcher.watch();
    this._dragEventWatcher.watch();
    this.hide(true);
    this.disposables.addFromEvent(this.host, "pointerleave", () => {
      this.hide();
    });
    this._handleEventWatcher.watch();

    if (isInsidePageEditor(this.host)) {
      this._pageWatcher.watch();
    } else if (isInsideEdgelessEditor(this.host)) {
      this.edgelessWatcher.watch();
    }
  }

  override disconnectedCallback() {
    this.hide(true);
    this._anchorModelDisposables?.dispose();
    super.disconnectedCallback();
  }

  get dragHoverRect() {
    return this.hoverBounds;
  }
  set dragHoverRect(bounds: typeof this.hoverBounds) {
    this.hoverBounds = bounds;
    this.paintHover();
  }

  private paintHover() {
    const { style } = this.hover;
    const rect = this.hoverBounds;
    // Canvas selections supply their own outline.
    if (!rect || this.active !== "block") {
      style.display = "none";
      return;
    }
    Object.assign(style, {
      display: "",
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [MYOXUS_DRAG_HANDLE_WIDGET]: MyoxusDragHandleWidget;
  }
}
