import {
  EdgelessCRUDIdentifier,
  getBgGridGap,
  type SurfaceBlockComponent,
  type SurfaceBlockModel,
} from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import {
  EditorSettingProvider,
  FontLoaderService,
  ThemeProvider,
  ViewportElementProvider,
} from "@virgultum/core/services";
import { requestThrottledConnectedFrame } from "@virgultum/core/utils";
import {
  NativeContainerBlock,
  type GfxBlockComponent,
  SurfaceSelection,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type GfxViewportElement,
} from "@virgultum/core/runtime/gfx";
import { isCanvasElement } from "../edgeless/utils/query";

export class EdgelessRootPreviewBlockComponent extends NativeContainerBlock<RootBlockModel> {
  protected readonly blockStyles = `
    myoxus-edgeless-root-preview {
      pointer-events: none;
      -webkit-user-select: none;
      user-select: none;
      display: block;
      height: 100%;
      min-height: 100%;
      width: 100%;
    }

    myoxus-edgeless-root-preview .widgets-container {
      position: absolute;
      left: 0;
      top: 0;
      contain: size layout;
      z-index: 1;
      height: 100%;
    }

    myoxus-edgeless-root-preview .edgeless-background {
      height: 100%;
      background-color: var(--myoxus-background-primary-color);
      background-image: radial-gradient(
        var(--myoxus-edgeless-grid-color) 1px,
        var(--myoxus-background-primary-color) 1px
      );
    }

    @media print {
      .selected {
        background-color: transparent !important;
      }
    }
  `;

  private get _viewport() {
    return this._gfx.viewport;
  }

  private readonly _refreshLayerViewport = requestThrottledConnectedFrame(
    () => {
      const { zoom, translateX, translateY } = this._viewport;
      const gap = getBgGridGap(zoom);

      if (this.background) {
        this.background.style.backgroundPosition = `${translateX}px ${translateY}px`;
        this.background.style.backgroundSize = `${gap}px ${gap}px`;
      }
    },
    this,
  );

  private background?: HTMLElement;
  gfxViewportElm!: GfxViewportElement;

  get surface() {
    return this.gfxViewportElm?.querySelector<SurfaceBlockComponent>(
      "myoxus-surface",
    );
  }

  private get _gfx() {
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

  private _initFontLoader() {
    this.std
      .get(FontLoaderService)
      .ready.then(() => {
        if (this.isConnected) this.surface?.refresh();
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
    }, this);

    this.disposables.add(
      this._gfx.layer.slots.layerUpdated.subscribe(() => updateLayers()),
    );
  }

  private _initPixelRatioChangeEffect() {
    let media: MediaQueryList;

    const onPixelRatioChange = () => {
      if (media) {
        this._gfx.viewport.onResize();
        media.removeEventListener("change", onPixelRatioChange);
      }

      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onPixelRatioChange);
    };

    onPixelRatioChange();

    this.disposables.add(() => {
      media?.removeEventListener("change", onPixelRatioChange);
    });
  }

  private _initResizeEffect() {
    const resizeObserver = new ResizeObserver((_: ResizeObserverEntry[]) => {
      this._gfx.selection.set(this._gfx.selection.surfaceSelections);
      this._gfx.viewport.onResize();
    });

    try {
      resizeObserver.observe(this.viewportElement);
      this.disposables.add(() => resizeObserver.disconnect());
    } catch {
      // viewport is not ready
      console.error("Viewport is not ready");
    }
  }

  private _initSlotEffects() {
    this.disposables.add(
      this.std
        .get(ThemeProvider)
        .theme$.subscribe(() => this.surface?.refresh()),
    );
  }

  private get _disableScheduleUpdate() {
    const editorSetting = this.std.getOptional(EditorSettingProvider)?.setting$;

    return editorSetting?.peek().edgelessDisableScheduleUpdate ?? false;
  }

  private get _crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  protected override afterProjection() {
    this.handleEvent("selectionChange", () => {
      const surface = this.host.selection.value.find(
        (sel): sel is SurfaceSelection => sel.is(SurfaceSelection),
      );
      if (!surface) return;

      const el = this._crud.getElementById(surface.elements[0]);
      if (isCanvasElement(el)) {
        return true;
      }

      return;
    });
    this._initSlotEffects();
    this._initResizeEffect();
    this._initPixelRatioChangeEffect();
    this._initFontLoader();
    this._initLayerUpdateEffect();

    this.disposables.add(
      this._gfx.viewport.viewportUpdated.subscribe(() => {
        this._refreshLayerViewport();
      }),
    );

    this._refreshLayerViewport();
  }

  protected override projectedModels() {
    return [
      ...this.model.children,
      ...(this.surfaceBlockModel?.children ?? []),
    ];
  }

  protected override mountBody() {
    const background = this.ownerDocument.createElement("div");
    background.className = "edgeless-background edgeless-container";
    this.background = background;
    const viewport = this.ownerDocument.createElement(
      "gfx-viewport",
    ) as GfxViewportElement;
    viewport.enableChildrenSchedule = !this._disableScheduleUpdate;
    viewport.gfx = this._gfx;
    this.gfxViewportElm = viewport;
    background.append(viewport);
    this.replaceChildren(background);
    return viewport;
  }
}
