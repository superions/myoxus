import { cssVar } from "@myoxus/theme";
import { signal } from "@preact/signals-core";
import { type FrameOverlay } from "../../blocks/frame/index";
import {
  EdgelessLegacySlotIdentifier,
  SurfaceBlockComponent,
  OverlayIdentifier,
} from "@virgultum/canvas-runtime/surface";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { deserializeXYWH } from "@virgultum/core/primitives/gfx";
import { ConnectorElementModel } from "@virgultum/core/models";
import type { SelectedRect } from "@virgultum/core/types";
import {
  getSelectedRect,
  requestThrottledConnectedFrame,
} from "@virgultum/core/utils";
import type { BlockStdScope } from "@virgultum/core/runtime";
import {
  type CursorType,
  GfxControllerIdentifier,
  type GfxModel,
  InteractivityIdentifier,
  type ResizeHandle,
} from "@virgultum/core/runtime/gfx";

import { CanvasResizeHandles } from "./canvas-resize-handles.js";
import { generateCursorUrl, getRotatedResizeCursor } from "./utils.js";

export const EDGELESS_SELECTED_RECT_WIDGET = "edgeless-selected-rect";

export const canvasSelectionCss = `
    :host {
      display: block;
      user-select: none;
      contain: size layout;
      position: absolute;
      top: 0;
      left: 0;
      z-index: 1;
    }

    .myoxus-edgeless-selected-rect {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: center center;
      border-radius: 0;
      pointer-events: none;
      box-sizing: border-box;
      z-index: 1;
      border-color: var(--myoxus-blue);
      border-width: 2px;
      border-style: solid;
      transform: translate(0, 0) rotate(0);
    }

    .myoxus-edgeless-selected-rect[data-locked="true"] {
      border-color: ${cssVar("textDisableColor")};
    }

    .myoxus-edgeless-selected-rect[data-width-limit="true"]
      .handle[aria-label="right"]::after,
    .myoxus-edgeless-selected-rect[data-height-limit="true"]
      .handle[aria-label="bottom"]::after {
      content: "";
      position: absolute;
      background: var(--myoxus-error-color);
      filter: drop-shadow(-6px 0px 12px rgba(235, 67, 53, 0.35));
    }

    .myoxus-edgeless-selected-rect[data-width-limit="true"]
      .handle[aria-label="right"]::after {
      top: 0;
      left: 1.5px;
      width: 2px;
      height: 100%;
    }

    .myoxus-edgeless-selected-rect[data-height-limit="true"]
      .handle[aria-label="bottom"]::after {
      top: 1.5px;
      left: 0;
      width: 100%;
      height: 2px;
    }

    .myoxus-edgeless-selected-rect .handle {
      position: absolute;
      user-select: none;
      outline: none;
      pointer-events: auto;

      /**
       * Fix: pointerEvent stops firing after a short time.
       * When a gesture is started, the browser intersects the touch-action values of the touched element and its ancestors,
       * up to the one that implements the gesture (in other words, the first containing scrolling element)
       * https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
       */
      touch-action: none;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label^="top-"],
    .myoxus-edgeless-selected-rect .handle[aria-label^="bottom-"] {
      width: 18px;
      height: 18px;
      box-sizing: border-box;
      z-index: 10;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label^="top-"] .resize,
    .myoxus-edgeless-selected-rect .handle[aria-label^="bottom-"] .resize {
      position: absolute;
      width: 12px;
      height: 12px;
      box-sizing: border-box;
      border-radius: 50%;
      border: 2px var(--myoxus-blue) solid;
      background: white;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label^="top-"] .rotate,
    .myoxus-edgeless-selected-rect .handle[aria-label^="bottom-"] .rotate {
      position: absolute;
      width: 12px;
      height: 12px;
      box-sizing: border-box;
      background: transparent;
    }

    /* -18 + 6.5 */
    .myoxus-edgeless-selected-rect .handle[aria-label="top-left"] {
      left: -12px;
      top: -12px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top-left"] .resize {
      right: 0;
      bottom: 0;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top-left"] .rotate {
      right: 6px;
      bottom: 6px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top-right"] {
      top: -12px;
      right: -12px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top-right"] .resize {
      left: 0;
      bottom: 0;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top-right"] .rotate {
      left: 6px;
      bottom: 6px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-right"] {
      right: -12px;
      bottom: -12px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-right"] .resize {
      left: 0;
      top: 0;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-right"] .rotate {
      left: 6px;
      top: 6px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-left"] {
      bottom: -12px;
      left: -12px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-left"] .resize {
      right: 0;
      top: 0;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom-left"] .rotate {
      right: 6px;
      top: 6px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top"],
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"],
    .myoxus-edgeless-selected-rect .handle[aria-label="left"],
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] {
      border: 0;
      background: transparent;
      border-color: var("--myoxus-blue");
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="left"],
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] {
      top: 0;
      bottom: 0;
      height: 100%;
      width: 6px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top"],
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] {
      left: 0;
      right: 0;
      width: 100%;
      height: 6px;
    }

    /* calc(-1px - (6px - 1px) / 2) = -3.5px */
    .myoxus-edgeless-selected-rect .handle[aria-label="left"] {
      left: -3.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] {
      right: -3.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top"] {
      top: -3.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] {
      bottom: -3.5px;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top"] .resize,
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] .resize,
    .myoxus-edgeless-selected-rect .handle[aria-label="left"] .resize,
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] .resize {
      width: 100%;
      height: 100%;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top"] .resize:after,
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] .resize:after,
    .myoxus-edgeless-selected-rect .handle[aria-label="left"] .resize:after,
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] .resize:after {
      position: absolute;
      width: 7px;
      height: 7px;
      box-sizing: border-box;
      border-radius: 6px;
      z-index: 10;
      content: "";
      background: white;
    }

    .myoxus-edgeless-selected-rect
      .handle[aria-label="top"]
      .transparent-handle:after,
    .myoxus-edgeless-selected-rect
      .handle[aria-label="bottom"]
      .transparent-handle:after,
    .myoxus-edgeless-selected-rect
      .handle[aria-label="left"]
      .transparent-handle:after,
    .myoxus-edgeless-selected-rect
      .handle[aria-label="right"]
      .transparent-handle:after {
      opacity: 0;
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="left"] .resize:after,
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] .resize:after {
      top: calc(50% - 6px);
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="top"] .resize:after,
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] .resize:after {
      left: calc(50% - 6px);
    }

    .myoxus-edgeless-selected-rect .handle[aria-label="left"] .resize:after {
      left: -0.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="right"] .resize:after {
      right: -0.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="top"] .resize:after {
      top: -0.5px;
    }
    .myoxus-edgeless-selected-rect .handle[aria-label="bottom"] .resize:after {
      bottom: -0.5px;
    }

    .myoxus-edgeless-selected-rect .handle .resize::before {
      content: "";
      display: none;
      position: absolute;
      width: 20px;
      height: 20px;
      background-image: url("data:image/svg+xml,%3Csvg width='26' height='26' viewBox='0 0 26 26' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M23 3H19C10.1634 3 3 10.1634 3 19V23' stroke='black' stroke-opacity='0.3' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
    }
    .myoxus-edgeless-selected-rect[data-mode="scale"]
      .handle[aria-label="top-left"]
      .resize:hover::before,
    .myoxus-edgeless-selected-rect[data-scale-direction="top-left"][data-scale-percent]
      .handle[aria-label="top-left"]
      .resize::before {
      display: block;
      top: 0px;
      left: 0px;
      transform: translate(-100%, -100%);
    }
    .myoxus-edgeless-selected-rect[data-mode="scale"]
      .handle[aria-label="top-right"]
      .resize:hover::before,
    .myoxus-edgeless-selected-rect[data-scale-direction="top-right"][data-scale-percent]
      .handle[aria-label="top-right"]
      .resize::before {
      display: block;
      top: 0px;
      right: 0px;
      transform: translate(100%, -100%) rotate(90deg);
    }
    .myoxus-edgeless-selected-rect[data-mode="scale"]
      .handle[aria-label="bottom-right"]
      .resize:hover::before,
    .myoxus-edgeless-selected-rect[data-scale-direction="bottom-right"][data-scale-percent]
      .handle[aria-label="bottom-right"]
      .resize::before {
      display: block;
      bottom: 0px;
      right: 0px;
      transform: translate(100%, 100%) rotate(180deg);
    }
    .myoxus-edgeless-selected-rect[data-mode="scale"]
      .handle[aria-label="bottom-left"]
      .resize:hover::before,
    .myoxus-edgeless-selected-rect[data-scale-direction="bottom-left"][data-scale-percent]
      .handle[aria-label="bottom-left"]
      .resize::before {
      display: block;
      bottom: 0px;
      left: 0px;
      transform: translate(-100%, 100%) rotate(-90deg);
    }

    .myoxus-edgeless-selected-rect::after {
      content: attr(data-scale-percent);
      display: none;
      position: absolute;
      color: var(--myoxus-icon-color);
      font-feature-settings:
        "clig" off,
        "liga" off;
      font-family: var(--myoxus-font-family);
      font-size: 12px;
      font-style: normal;
      font-weight: 400;
      line-height: 24px;
    }
    .myoxus-edgeless-selected-rect[data-scale-direction="top-left"]::after {
      display: block;
      top: -20px;
      left: -20px;
      transform: translate(-100%, -100%);
    }
    .myoxus-edgeless-selected-rect[data-scale-direction="top-right"]::after {
      display: block;
      top: -20px;
      right: -20px;
      transform: translate(100%, -100%);
    }
    .myoxus-edgeless-selected-rect[data-scale-direction="bottom-right"]::after {
      display: block;
      bottom: -20px;
      right: -20px;
      transform: translate(100%, 100%);
    }
    .myoxus-edgeless-selected-rect[data-scale-direction="bottom-left"]::after {
      display: block;
      bottom: -20px;
      left: -20px;
      transform: translate(-100%, 100%);
    }
  `;

export class CanvasSelectionController {
  private readonly resizeHandles: CanvasResizeHandles;
  private readonly _disposables = new DisposableGroup();
  private readonly _revision = signal(0);
  private readonly _allowedHandles = signal<{
    rotatable: boolean;
    resizeHandles: ResizeHandle[];
  } | null>(null);
  private readonly _isHeightLimit = signal(false);
  private readonly _isResizing = signal(false);
  private readonly _isWidthLimit = signal(false);
  private readonly _mode = signal<"resize" | "scale" | "rotate">("resize");
  private readonly _scaleDirection = signal<ResizeHandle | undefined>(
    undefined,
  );
  private readonly _scalePercent = signal<string | undefined>(undefined);
  readonly autoCompleteOff = signal(false);

  constructor(
    private readonly host: HTMLElement,
    private readonly std: BlockStdScope,
  ) {
    this.resizeHandles = new CanvasResizeHandles(host.ownerDocument);
  }

  private get store() {
    return this.std.store;
  }

  dispose() {
    this._disposables.dispose();
    this.resizeHandles.clear();
  }

  private readonly _dragEndCleanup = () => {
    this._isWidthLimit.value = false;
    this._isHeightLimit.value = false;

    this._scalePercent.value = undefined;
    this._scaleDirection.value = undefined;

    this._updateCursor();

    this.frameOverlay.clear();
  };

  private readonly _updateCursor = (options?: {
    type: "resize" | "rotate";
    angle: number;
    handle: ResizeHandle;
    flipX?: boolean;
    flipY?: boolean;
    pure?: boolean;
  }) => {
    if (!options) {
      !this._isResizing.value && (this.gfx.cursor$.value = "default");
      return "default";
    }

    const { type, angle, flipX, flipY } = options;
    let cursor: CursorType = "default";
    let handle: ResizeHandle = options.handle;

    if (flipX) {
      handle = (
        handle.includes("left")
          ? handle.replace("left", "right")
          : handle.replace("right", "left")
      ) as ResizeHandle;
    }

    if (flipY) {
      handle = (
        handle.includes("top")
          ? handle.replace("top", "bottom")
          : handle.replace("bottom", "top")
      ) as ResizeHandle;
    }

    if (type === "rotate") {
      cursor = generateCursorUrl(angle, handle);
    } else {
      cursor = getRotatedResizeCursor({
        handle,
        angle,
      });
    }

    if (options.pure !== true) {
      this.gfx.cursor$.value = cursor;
    }

    return cursor;
  };

  private readonly _updateOnElementChange = (
    element: string | { id: string },
  ) => {
    const id = typeof element === "string" ? element : element.id;

    if (this.selection.has(id)) {
      this._updateSelectedRect();
    }
  };

  private readonly _updateHandles = () => {
    const interaction = this._interaction;
    const { store, selection } = this;
    const elements = selection.selectedElements;

    if (interaction && !selection.editing && !store.readonly) {
      const resizeHandles = interaction.getResizeHandlers({
        elements,
      });
      const { rotatable } = interaction.getRotateConfig({
        elements,
      });

      this._allowedHandles.value = {
        rotatable,
        resizeHandles,
      };
    } else {
      this._allowedHandles.value = null;
    }
  };

  private readonly _updateOnSelectionChange = () => {
    this._updateHandles();
    this._updateSelectedRect();
    // Reset the cursor
    this._updateCursor();
  };

  private readonly _selectedRect = signal<SelectedRect>({
    width: 0,
    height: 0,
    left: 0,
    top: 0,
    rotate: 0,
    borderWidth: 0,
    borderStyle: "solid",
  });

  private readonly _updateSelectedRect = requestThrottledConnectedFrame(() => {
    if (!this.host.isConnected) return;
    const { zoom, selection, gfx } = this;

    const elements = selection.selectedElements;
    // in surface
    const rect = getSelectedRect(elements);

    // in viewport
    const [left, top] = gfx.viewport.toViewCoord(rect.left, rect.top);
    const [width, height] = [rect.width * zoom, rect.height * zoom];

    let rotate = 0;
    if (elements.length === 1 && elements[0].rotate) {
      rotate = elements[0].rotate;
    }

    this._selectedRect.value = {
      width,
      height,
      left,
      top,
      rotate,
      borderStyle: "solid",
      borderWidth: 2,
    };
  });

  get frameOverlay() {
    return this.std.get(OverlayIdentifier("frame")) as FrameOverlay;
  }

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get selection() {
    return this.gfx.selection;
  }

  get surface() {
    return this.gfx.surface;
  }

  get zoom() {
    return this.gfx.viewport.zoom;
  }

  private _shouldRenderSelection(elements?: GfxModel[]) {
    elements = elements ?? this.selection.selectedElements;
    // Local previews retain selection identity while hiding committed bodies.
    // Their old bounds must not remain as actionable resize chrome.
    const surface = this.gfx.surfaceComponent;
    return (
      elements.some(
        (element) =>
          !("hidden" in element && element.hidden) &&
          !(
            surface instanceof SurfaceBlockComponent &&
            surface.renderer?.isElementLocallyExcluded(element.id)
          ),
      ) && !this.selection.editing
    );
  }

  bind() {
    const { _disposables, selection, gfx } = this;

    _disposables.add(
      // viewport zooming / scrolling
      gfx.viewport.viewportUpdated.subscribe(this._updateSelectedRect),
    );

    const surface = gfx.surfaceComponent;
    if (surface instanceof SurfaceBlockComponent) {
      _disposables.add(
        surface.renderer.localVisibilityUpdated.subscribe(() => {
          this._revision.value = this._revision.peek() + 1;
        }),
      );
    }

    if (gfx.surface) {
      _disposables.add(
        gfx.surface.elementAdded.subscribe(this._updateOnElementChange),
      );
      _disposables.add(
        gfx.surface.elementRemoved.subscribe(this._updateOnElementChange),
      );
      _disposables.add(
        gfx.surface.elementUpdated.subscribe(this._updateOnElementChange),
      );
    }

    _disposables.add(
      this.store.slots.blockUpdated.subscribe(this._updateOnElementChange),
    );

    _disposables.add(
      selection.slots.updated.subscribe(this._updateOnSelectionChange),
    );

    _disposables.add(
      this._slots.readonlyUpdated.subscribe(() => {
        this._revision.value = this._revision.peek() + 1;
      }),
    );

    _disposables.add(
      this._slots.elementResizeEnd.subscribe(
        () => (this._isResizing.value = false),
      ),
    );

    if (this._interaction) {
      _disposables.add(
        this._interaction.activeInteraction$.subscribe((val) => {
          const pre = this._isResizing.value;
          const newVal = val?.type === "resize" || val?.type === "rotate";

          if (pre === newVal) {
            return;
          }

          this._isResizing.value = newVal;

          if (newVal) {
            this._slots.elementResizeStart.next();
          } else {
            this._slots.elementResizeEnd.next();
          }
        }),
      );
    }
    this._updateOnSelectionChange();
  }

  private get _interaction() {
    return this.std.getOptional(InteractivityIdentifier);
  }

  private get _slots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  private _getResizeTargets(elements: GfxModel[]) {
    const { selection } = this;

    if (selection.inoperable) {
      this.resizeHandles.clear();
      return [];
    }

    if (
      this._allowedHandles.value &&
      this._interaction &&
      !elements.some((element) => element.isLocked())
    ) {
      const interaction = this._interaction;

      return this.resizeHandles.update(
        this._allowedHandles.value.resizeHandles,
        this._allowedHandles.value.rotatable,
        (e, handle, action) => {
          if (action === "rotate") {
            interaction.handleElementRotate({
              elements,
              event: e,
              onRotateStart: () => {
                this._mode.value = "rotate";
              },
              onRotateUpdate: (payload) => {
                this._updateCursor({
                  type: "rotate",
                  angle: payload.currentAngle,
                  handle,
                });
              },
              onRotateEnd: () => {
                this._mode.value = "resize";
                this._dragEndCleanup();
              },
            });
          } else {
            interaction.handleElementResize({
              elements,
              handle,
              event: e,
              onResizeStart: () => {
                this._mode.value = "resize";
              },
              onResizeUpdate: ({ lockRatio, scaleX, scaleY, exceed }) => {
                if (lockRatio) {
                  this._scaleDirection.value = handle;
                  this._scalePercent.value = `${Math.round(scaleX * 100)}%`;
                  this._mode.value = "scale";
                }

                if (exceed) {
                  this._isWidthLimit.value = exceed.w;
                  this._isHeightLimit.value = exceed.h;
                }

                this._updateCursor({
                  type: "resize",
                  angle: elements.length > 1 ? 0 : (elements[0]?.rotate ?? 0),
                  handle,
                  flipX: scaleX < 0,
                  flipY: scaleY < 0,
                });
              },
              onResizeEnd: () => {
                this._mode.value = "resize";
                this._dragEndCleanup();
              },
            });
          }
        },
        (type, handle) => {
          if (
            ["resize", "rotate"].includes(
              interaction.activeInteraction$.value?.type ?? "",
            )
          ) {
            return "";
          }

          return this._updateCursor({
            type,
            handle,
            angle: elements.length > 1 ? 0 : (elements[0]?.rotate ?? 0),
            pure: true,
          });
        },
      );
    }
    this.resizeHandles.clear();
    return [];
  }

  read() {
    void this._revision.value;
    const rect = this._selectedRect.value;
    const { selection, gfx, store } = this;
    const elements = selection.selectedElements;
    if (!this._shouldRenderSelection(elements)) {
      this.resizeHandles.clear();
      return null;
    }

    const single = elements.length === 1 ? elements[0] : undefined;
    const isConnector = single instanceof ConnectorElementModel;
    const locked = elements.some((element) => element.isLocked());
    const targets = this._getResizeTargets(elements);
    const outlines =
      elements.length > 1 &&
      !elements.some((e) => e instanceof ConnectorElementModel)
        ? elements.map((element) => {
            const [modelX, modelY, w, h] = deserializeXYWH(element.xywh);
            const [x, y] = gfx.viewport.toViewCoord(modelX, modelY);
            return {
              id: element.id,
              style: {
                position: "absolute",
                boxSizing: "border-box",
                left: `${x - rect.left - rect.borderWidth}px`,
                top: `${y - rect.top - rect.borderWidth}px`,
                width: `${w * this.zoom}px`,
                height: `${h * this.zoom}px`,
                transform: `rotate(${element.rotate}deg)`,
                border: "1px solid var(--myoxus-primary-color)",
              },
            };
          })
        : [];
    return {
      rect,
      isConnector,
      connector:
        !selection.inoperable && isConnector && !locked ? single : undefined,
      autoComplete:
        !store.readonly &&
        !selection.inoperable &&
        !this.autoCompleteOff.value &&
        !this._isResizing.value
          ? elements[0]
          : undefined,
      locked,
      targets,
      outlines: selection.inoperable ? [] : outlines,
      mode: this._mode.value,
      scalePercent: this._scalePercent.value,
      scaleDirection: this._scaleDirection.value,
      widthLimit: this._isWidthLimit.value,
      heightLimit: this._isHeightLimit.value,
    };
  }
}
