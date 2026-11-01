import { effect } from "@preact/signals-core";
import { NoteConfigExtension } from "@virgultum/block-note";
import {
  DefaultTool,
  getBgGridGap,
  normalizeWheelDeltaY,
  type SurfaceBlockComponent,
  type SurfaceBlockModel,
} from "@virgultum/block-surface";
import { PanTool } from "@virgultum/gfx-pointer";
import { IS_WINDOWS } from "@virgultum/global/env";
import { Bound, Point, Vec } from "@virgultum/global/gfx";
import { NoteBlockModel, type RootBlockModel } from "@virgultum/model";
import {
  EditorSettingProvider,
  EditPropsStore,
  FontLoaderService,
  ThemeProvider,
  ViewportElementProvider,
} from "@virgultum/shared/services";
import {
  hasTextControlEventTarget,
  isTouchPadPinchEvent,
  matchModels,
  requestConnectedFrame,
  requestThrottledConnectedFrame,
} from "@virgultum/shared/utils";
import {
  BlockComponent,
  type GfxBlockComponent,
  SurfaceSelection,
  type UIEventHandler,
} from "@virgultum/std";
import {
  GfxBlockElementModel,
  GfxControllerIdentifier,
  type GfxViewportElement,
} from "@virgultum/std/gfx";
import { css, html } from "lit";
import { query } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";

import { EdgelessPageKeyboardManager } from "./edgeless-keyboard.js";
import type { EdgelessRootService } from "./edgeless-root-service.js";
import { isCanvasElement } from "./utils/query.js";

export class EdgelessRootBlockComponent extends BlockComponent<
  RootBlockModel,
  EdgelessRootService
> {
  static override styles = css`
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

  private readonly _refreshLayerViewport = requestThrottledConnectedFrame(
    () => {
      const { zoom, translateX, translateY } = this.gfx.viewport;
      const gap = getBgGridGap(zoom);

      if (this.backgroundElm) {
        this.backgroundElm.style.setProperty(
          "background-position",
          `${translateX}px ${translateY}px`,
        );
        this.backgroundElm.style.setProperty(
          "background-size",
          `${gap}px ${gap}px`,
        );
      }
    },
    this,
  );

  private _resizeObserver: ResizeObserver | null = null;
  private _resizeFrame = 0;

  keyboardManager: EdgelessPageKeyboardManager | null = null;

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get surfaceBlockModel() {
    return this.model.children.find(
      (child) => child.flavour === "myoxus:surface",
    ) as SurfaceBlockModel;
  }

  get viewportElement(): HTMLElement {
    return this.std.get(ViewportElementProvider).viewportElement;
  }

  get fontLoader() {
    return this.std.get(FontLoaderService);
  }

  private _initFontLoader() {
    this.fontLoader.ready
      .then(() => {
        this.surface.refresh();
      })
      .catch(console.error);
  }

  private _initLayerUpdateEffect() {
    const updateLayers = requestThrottledConnectedFrame(() => {
      const blocks = Array.from(
        this.gfxViewportElm.children as HTMLCollectionOf<GfxBlockComponent>,
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
    this.disposables.add(
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
    this.disposables.add(
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
      }, this);
    };

    this.handleEvent("pointerMove", (e) => {
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
        if (!this.isConnected) return;
        this.gfx.selection.set(this.gfx.selection.surfaceSelections);
        this.gfx.viewport.onResize();
      });
    });

    resizeObserver.observe(this.viewportElement);
    this._resizeObserver = resizeObserver;
  }

  private _initSlotEffects() {
    const { disposables } = this;

    this.disposables.add(
      this.std
        .get(ThemeProvider)
        .theme$.subscribe(() => this.surface.refresh()),
    );

    disposables.add(
      effect(() => {
        this.style.cursor = this.gfx.cursor$.value;
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
        const pageBlock = this.model.children.find(
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

        e.preventDefault();

        const { viewport } = this.gfx;
        if (viewport.locked) return;

        // zoom
        if (isTouchPadPinchEvent(e) || edgelessScrollZoom) {
          const rect = this.getBoundingClientRect();
          // Perform zooming relative to the mouse position
          const [baseX, baseY] = this.gfx.viewport.toModelCoord(
            e.clientX - rect.x,
            e.clientY - rect.y,
          );

          const zoom = normalizeWheelDeltaY(e.deltaY, viewport.zoom);
          viewport.setZoom(zoom, new Point(baseX, baseY), true);
          e.stopPropagation();
        }
        // pan
        else {
          const simulateHorizontalScroll = IS_WINDOWS && e.shiftKey;
          const dx = simulateHorizontalScroll
            ? e.deltaY / viewport.zoom
            : e.deltaX / viewport.zoom;
          const dy = simulateHorizontalScroll ? 0 : e.deltaY / viewport.zoom;

          viewport.applyDeltaCenter(dx, dy);
          viewport.viewportMoved.next([dx, dy]);
          e.stopPropagation();
        }
      }),
    );
  }

  override bindHotKey(
    keymap: Record<string, UIEventHandler>,
    options?: { global?: boolean; flavour?: boolean },
  ): () => void {
    Object.keys(keymap).forEach((key) => {
      if (key.length === 1 && key >= "A" && key <= "z") {
        const handler = keymap[key];

        keymap[key] = (ctx) => {
          if (hasTextControlEventTarget(ctx.get("keyboardState").raw)) {
            return;
          }
          handler(ctx);
        };
      }
    });

    return super.bindHotKey(keymap, options);
  }

  override connectedCallback() {
    super.connectedCallback();

    this._initViewport();

    this.keyboardManager = new EdgelessPageKeyboardManager(this);

    this.handleEvent("selectionChange", () => {
      const surface = this.host.selection.value.find(
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

  override disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this._resizeFrame);
    this._resizeFrame = 0;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    this.keyboardManager = null;
  }

  override firstUpdated() {
    this._initSlotEffects();
    this._initResizeEffect();
    this._initPixelRatioChangeEffect();
    this._initFontLoader();
    this._initRemoteCursor();
    this._initLayerUpdateEffect();

    this._initWheelEvent();
    this._initPanEvent();
    this._initPinchEvent();

    if (this.store.readonly) {
      this.gfx.tool.setTool(PanTool, { panning: true });
    } else {
      this.gfx.tool.setTool(DefaultTool);
    }

    this.gfx.viewport.elementReady.next(this.gfxViewportElm);

    requestConnectedFrame(() => {
      this.requestUpdate();
    }, this);

    this._disposables.add(
      this.gfx.viewport.viewportUpdated.subscribe(() => {
        this._refreshLayerViewport();
      }),
    );

    this._refreshLayerViewport();
  }

  override renderBlock() {
    // An exact-history transaction can remove a Page document's later-added
    // surface before the consuming editor finishes leaving Edgeless.
    const surface = this.model.children.find(
      (child) => child.flavour === "myoxus:surface",
    ) as SurfaceBlockModel | undefined;
    const widgets = repeat(
      Object.entries(this.widgets),
      ([id]) => id,
      ([_, widget]) => widget,
    );

    return html`
      <div class="edgeless-background edgeless-container">
        <gfx-viewport
          .maxConcurrentRenders=${6}
          .viewport=${this.gfx.viewport}
          .getModelsInViewport=${() => {
            const blocks = this.gfx.grid.search(
              this.gfx.viewport.viewportBounds,
              {
                useSet: true,
                filter: ["block"],
              },
            );

            return blocks;
          }}
          .host=${this.host}
        >
          ${this.renderChildren(this.model)}
          ${surface ? this.renderChildren(surface) : null}
        </gfx-viewport>
      </div>

      <!--
        Used to mount component before widgets
        Eg., canvas text editor
      -->
      <div class="edgeless-mount-point"></div>

      <div class="widgets-container">${widgets}</div>
    `;
  }

  @query(".edgeless-background")
  accessor backgroundElm: HTMLDivElement | null = null;

  @query("gfx-viewport")
  accessor gfxViewportElm!: GfxViewportElement;

  @query(".edgeless-mount-point")
  accessor mountElm: HTMLDivElement | null = null;

  @query("myoxus-surface")
  accessor surface!: SurfaceBlockComponent;
}
