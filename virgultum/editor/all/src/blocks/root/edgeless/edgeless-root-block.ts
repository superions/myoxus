import { effect } from "@preact/signals-core";
import {
  EDGELESS_TOOLBAR_WIDGET,
  mountCanvasDraggingArea,
  NOTE_SLICER_WIDGET,
} from "@virgultum/canvas/widgets";
import { NoteConfigExtension } from "@virgultum/embeds/blocks";
import {
  DefaultTool,
  getBgGridGap,
  wheelCanvas,
} from "@virgultum/canvas-runtime/surface";
import { PanTool } from "@virgultum/canvas-runtime/tools";
import { Bound, Point, Vec } from "@virgultum/core/primitives/gfx";
import { NoteBlockModel } from "@virgultum/core/models";
import {
  EditorSettingProvider,
  EditPropsStore,
  ThemeProvider,
} from "@virgultum/core/services";
import {
  matchModels,
  requestConnectedFrame,
  requestThrottledConnectedFrame,
} from "@virgultum/core/utils";
import {
  type GfxBlockComponent,
  SurfaceSelection,
} from "@virgultum/core/runtime";
import { GfxBlockElementModel } from "@virgultum/core/runtime/gfx";

import { mountCanvasZoom } from "../../../widgets/edgeless-zoom-toolbar/mount-zoom";
import { EdgelessPageKeyboardManager } from "./edgeless-keyboard.js";
import { isCanvasElement } from "./utils/query.js";

import type { EdgelessRootBlockComponent } from "./native-edgeless-root-block.js";

export { EdgelessRootBlockComponent } from "./native-edgeless-root-block.js";

export const canvasRootCss = `
  myoxus-edgeless-root {
    -webkit-user-select: none;
    user-select: none;
    display: block;
    height: 100%;
    min-height: 100%;
    touch-action: none;
    width: 100%;
  }

  .widgets-container {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    contain: size layout;
    height: 100%;
    width: 100%;
    z-index: var(--myoxus-z-index-popover, 10000);
  }

  .widgets-container > * {
    pointer-events: auto;
  }

  /*
   * The toolbar widget spans the viewport, while only its visible controls
   * are interactive. Preserve that widget-owned hit-test contract here;
   * otherwise the transparent host intercepts pointers meant for active
   * canvas blocks underneath it.
   */
  .widgets-container > edgeless-toolbar-widget {
    pointer-events: none;
  }

  .edgeless-background {
    height: 100%;
    background-color: var(--myoxus-background-primary-color);
    background-image: radial-gradient(
      var(--myoxus-edgeless-grid-color) 1px,
      var(--myoxus-background-primary-color) 1px
    );
  }

  .edgeless-container {
    color: var(--myoxus-text-primary-color);
    position: relative;
  }

  @media print {
    .selected {
      background-color: transparent !important;
    }
  }
`;

export class EdgelessRootController {
  private readonly _refreshLayerViewport = requestThrottledConnectedFrame(
    () => {
      if (!this.root.isConnected) return;
      const { zoom, translateX, translateY } = this.gfx.viewport;
      const gap = getBgGridGap(zoom);

      if (this.root.backgroundElm) {
        this.root.backgroundElm.style.setProperty(
          "background-position",
          `${translateX}px ${translateY}px`,
        );
        this.root.backgroundElm.style.setProperty(
          "background-size",
          `${gap}px ${gap}px`,
        );
      }
    },
  );

  private _resizeObserver: ResizeObserver | null = null;
  private _resizeFrame = 0;

  keyboardManager: EdgelessPageKeyboardManager | null = null;

  constructor(private readonly root: EdgelessRootBlockComponent) {}

  private get gfx() {
    return this.root.gfx;
  }

  private get std() {
    return this.root.std;
  }

  private get _disposables() {
    return this.root.disposables;
  }

  private _initFontLoader() {
    this.root.fontLoader.ready
      .then(() => {
        this.root.surface?.refresh();
      })
      .catch(console.error);
  }

  private _initLayerUpdateEffect() {
    const updateLayers = requestThrottledConnectedFrame(() => {
      const blocks = Array.from(
        this.root.gfxViewportElm
          .children as HTMLCollectionOf<GfxBlockComponent>,
      );

      blocks.forEach((block: GfxBlockComponent) => {
        block.updateZIndex?.();
      });
    });

    this._disposables.add(
      this.gfx.layer.slots.layerUpdated.subscribe(() => updateLayers()),
    );
  }

  private _initPanEvent() {
    this.root.disposables.add(
      this.std.event.add("pan", (ctx) => {
        const { viewport } = this.gfx;
        if (viewport.locked) return;

        const multiPointersState = ctx.get("multiPointerState");
        const [p1, p2] = multiPointersState.pointers;

        const dx =
          (0.25 * (p1.delta.x + p2.delta.x)) /
          viewport.zoom /
          viewport.viewScale;
        const dy =
          (0.25 * (p1.delta.y + p2.delta.y)) /
          viewport.zoom /
          viewport.viewScale;

        // direction is opposite
        viewport.applyDeltaCenter(-dx, -dy);
      }),
    );
  }

  private _initPinchEvent() {
    this.root.disposables.add(
      this.std.event.add("pinch", (ctx) => {
        const { viewport } = this.gfx;
        if (viewport.locked) return;

        const multiPointersState = ctx.get("multiPointerState");
        const [p1, p2] = multiPointersState.pointers;

        const currentCenter = new Point(
          0.5 * (p1.x + p2.x),
          0.5 * (p1.y + p2.y),
        );

        const lastDistance = Vec.dist(
          [p1.x - p1.delta.x, p1.y - p1.delta.y],
          [p2.x - p2.delta.x, p2.y - p2.delta.y],
        );
        const currentDistance = Vec.dist([p1.x, p1.y], [p2.x, p2.y]);

        const zoom = (currentDistance / lastDistance) * viewport.zoom;

        const [baseX, baseY] = viewport.toModelCoord(
          currentCenter.x,
          currentCenter.y,
        );

        viewport.setZoom(zoom, new Point(baseX, baseY));

        return false;
      }),
    );
  }

  private _initPixelRatioChangeEffect() {
    let media: MediaQueryList;

    const onPixelRatioChange = () => {
      if (media) {
        this.gfx.viewport.onResize();
        media.removeEventListener("change", onPixelRatioChange);
      }

      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onPixelRatioChange);
    };

    onPixelRatioChange();

    this._disposables.add(() => {
      media?.removeEventListener("change", onPixelRatioChange);
    });
  }

  private _initRemoteCursor() {
    let rafId: number | null = null;

    const setRemoteCursor = (pos: { x: number; y: number }) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestConnectedFrame(() => {
        if (!this.gfx.viewport) return;
        const cursorPosition = this.gfx.viewport.toModelCoord(pos.x, pos.y);
        this.gfx.selection.setCursor({
          x: cursorPosition[0],
          y: cursorPosition[1],
        });
        rafId = null;
      }, this.root);
    };

    this.root.handleEvent("pointerMove", (e) => {
      const pointerEvent = e.get("pointerState");
      setRemoteCursor(pointerEvent);
    });
  }

  private _initResizeEffect() {
    const resizeObserver = new ResizeObserver((_: ResizeObserverEntry[]) => {
      if (this._resizeFrame) return;
      // Selection refresh also repositions floating controls. Keep that layout
      // work outside observer delivery when the sidebar resizes the viewport.
      this._resizeFrame = requestAnimationFrame(() => {
        this._resizeFrame = 0;
        if (!this.root.isConnected) return;
        this.gfx.selection.set(this.gfx.selection.surfaceSelections);
        this.gfx.viewport.onResize();
      });
    });

    resizeObserver.observe(this.root.viewportElement);
    this._resizeObserver = resizeObserver;
  }

  private _initSlotEffects() {
    const { disposables } = this.root;

    this.root.disposables.add(
      this.std
        .get(ThemeProvider)
        .theme$.subscribe(() => this.root.surface?.refresh()),
    );

    disposables.add(
      effect(() => {
        this.root.style.cursor = this.gfx.cursor$.value;
      }),
    );
  }

  private _initViewport() {
    const { std, gfx } = this;

    const run = () => {
      const storedViewport = std.get(EditPropsStore).getStorage("viewport");
      const hasExplicitReferenceViewport = Boolean(
        storedViewport &&
        "xywh" in storedViewport &&
        "referenceId" in storedViewport,
      );
      const hasValidExplicitReferenceViewport = Boolean(
        storedViewport &&
        "xywh" in storedViewport &&
        "referenceId" in storedViewport &&
        storedViewport.referenceId &&
        std.store.getBlock(storedViewport.referenceId)?.model instanceof
          GfxBlockElementModel,
      );
      const applyStoredViewport = () => {
        if (!storedViewport) return false;
        if ("xywh" in storedViewport) {
          const bound = Bound.deserialize(storedViewport.xywh);
          gfx.viewport.setViewportByBound(bound, storedViewport.padding);
        } else {
          const { zoom, centerX, centerY } = storedViewport;
          gfx.viewport.setViewport(zoom, [centerX, centerY]);
        }
        return true;
      };

      if (hasValidExplicitReferenceViewport && applyStoredViewport()) {
        return;
      }

      const animationFn = std.getOptional(
        NoteConfigExtension.identifier,
      )?.pageBlockViewportFitAnimation;
      if (animationFn) {
        const pageBlock = this.root.model.children.find(
          (child): child is NoteBlockModel =>
            matchModels(child, [NoteBlockModel]) && child.isPageBlock(),
        );
        if (pageBlock && animationFn({ std: this.std, note: pageBlock })) {
          return;
        }
      }

      if (!hasExplicitReferenceViewport && applyStoredViewport()) {
        return;
      }

      this.gfx.fitToScreen();
    };

    run();

    this._disposables.add(() => {
      std.get(EditPropsStore).setStorage("viewport", {
        centerX: gfx.viewport.centerX,
        centerY: gfx.viewport.centerY,
        zoom: gfx.viewport.zoom,
      });
    });
  }

  private _initWheelEvent() {
    this._disposables.add(
      this.std.event.add("wheel", (ctx) => {
        const config = this.std.getOptional(EditorSettingProvider)?.setting$;
        const state = ctx.get("defaultState");
        const e = state.event as WheelEvent;
        const edgelessScrollZoom = config?.peek().edgelessScrollZoom ?? false;

        wheelCanvas(
          this.gfx.viewport,
          e,
          this.root.getBoundingClientRect(),
          edgelessScrollZoom,
        );
      }),
    );
  }

  connect() {
    this._initViewport();

    this.keyboardManager = new EdgelessPageKeyboardManager(this.root);

    this.root.handleEvent("selectionChange", () => {
      const surface = this.root.host.selection.value.find(
        (sel): sel is SurfaceSelection => sel.is(SurfaceSelection),
      );
      if (!surface) return;

      const el = this.gfx.getElementById(surface.elements[0]);
      if (isCanvasElement(el)) {
        return true;
      }

      return;
    });
  }

  dispose() {
    cancelAnimationFrame(this._resizeFrame);
    this._resizeFrame = 0;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this.keyboardManager = null;
  }

  mount() {
    this._initSlotEffects();
    this._initResizeEffect();
    this._initPixelRatioChangeEffect();
    this._initFontLoader();
    this._initRemoteCursor();
    this._initLayerUpdateEffect();

    this._initWheelEvent();
    this._initPanEvent();
    this._initPinchEvent();
    const overlay = this.root.overlayElm;
    // Retain the existing stack order when a drag extends under the tool dock.
    const controls = overlay.querySelector(
      `:scope > ${NOTE_SLICER_WIDGET}, :scope > ${EDGELESS_TOOLBAR_WIDGET}`,
    );
    this.root.disposables.add(
      mountCanvasDraggingArea(overlay, this.gfx.tool, controls),
    );

    if (this.root.store.readonly) {
      this.gfx.tool.setTool(PanTool, { panning: true });
    } else {
      this.gfx.tool.setTool(DefaultTool);
    }

    const unmountZoom = mountCanvasZoom(this.std, overlay);
    if (unmountZoom) this.root.disposables.add(unmountZoom);
    this.gfx.viewport.elementReady.next(this.root.gfxViewportElm);

    requestConnectedFrame(() => {
      this.root.requestUpdate();
    }, this.root);

    this._disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        this._refreshLayerViewport();
      }),
    );

    this._refreshLayerViewport();
  }
}
