import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { Bound } from "@virgultum/core/primitives/gfx";
import type { Color } from "@virgultum/core/models";
import { FeatureFlagService, ThemeProvider } from "@virgultum/core/services";
import {
  type BlockStdScope,
  type EditorHost,
  SurfaceSelection,
} from "@virgultum/core/runtime";
import {
  GfxControllerIdentifier,
  type Viewport,
} from "@virgultum/core/runtime/gfx";
import type { Subject } from "rxjs";

import { CanvasRenderer } from "./renderer/canvas-renderer.js";
import { ElementRendererIdentifier } from "./extensions/element-renderer";
import type { ElementRenderer } from "./renderer/elements";
import { DomRenderer } from "./renderer/dom-renderer.js";
import { DomElementRendererIdentifier } from "./renderer/dom-elements";
import { OverlayIdentifier } from "./renderer/overlay.js";
import type { SurfaceBlockModel } from "./surface-model.js";

export interface SurfaceContext {
  viewport: Viewport;
  host: EditorHost;
  selection: {
    selectedIds: string[];
    slots: {
      updated: Subject<SurfaceSelection[]>;
    };
  };
}

export const surfaceSceneCss = `
  .myoxus-edgeless-surface-block-container {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .myoxus-edgeless-surface-block-container canvas {
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    position: absolute;
    z-index: 1;
    pointer-events: none;
  }

  edgeless-block-portal-container {
    position: relative;
    box-sizing: border-box;
    overflow: hidden;
    display: block;
    height: 100%;
    font-family: var(--myoxus-font-family);
    font-size: var(--myoxus-font-base);
    line-height: var(--myoxus-line-height);
    color: var(--myoxus-text-primary-color);
    font-weight: 400;
  }

  .myoxus-block-children-container.edgeless {
    padding-left: 0;
    position: relative;
    overflow: hidden;
    height: 100%;
    /**
     * Fix: pointerEvent stops firing after a short time.
     * When a gesture is started, the browser intersects the touch-action values of the touched element and its ancestors,
     * up to the one that implements the gesture (in other words, the first containing scrolling element)
     * https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
     */
    touch-action: none;
    background-color: var(--myoxus-background-primary-color);
    background-image: radial-gradient(
      var(--myoxus-edgeless-grid-color) 1px,
      var(--myoxus-background-primary-color) 1px
    );
    z-index: 0;
  }

  .myoxus-edgeless-block-child {
    position: absolute;
    transform-origin: center;
    box-sizing: border-box;
    border: 2px solid var(--myoxus-white-10);
    border-radius: 8px;
    box-shadow: var(--myoxus-shadow-3);
    pointer-events: all;
  }
`;

export class SurfaceScene {
  private readonly _disposables = new DisposableGroup();

  constructor(
    readonly std: BlockStdScope,
    readonly model: SurfaceBlockModel,
  ) {}

  private _cachedViewport = new Bound();

  private _lastTime = 0;

  private readonly _locallyExcludedElementIds = new Set<string>();

  private _renderer!: CanvasRenderer | DomRenderer;

  fitToViewport = (bound: Bound) => {
    const { viewport } = this.gfx;
    bound = bound.expand(30);
    if (Date.now() - this._lastTime > 200)
      this._cachedViewport = viewport.viewportBounds;
    this._lastTime = Date.now();

    if (this._cachedViewport.contains(bound)) return;

    this._cachedViewport = this._cachedViewport.unite(bound);
    viewport.setViewportByBound(this._cachedViewport, [0, 0, 0, 0], true);
  };

  refresh = () => {
    this._renderer?.refresh();
  };

  setLocallyExcludedElementIds = (ids: ReadonlySet<string>) => {
    if (
      ids.size === this._locallyExcludedElementIds.size &&
      [...ids].every((id) => this._locallyExcludedElementIds.has(id))
    ) {
      return;
    }
    this._locallyExcludedElementIds.clear();
    ids.forEach((id) => this._locallyExcludedElementIds.add(id));
    // Embedded projections remain in the shared store, but invisible children
    // must not intercept root-surface pointer or marquee selection.
    this.gfx.grid.setLocallyExcludedElementIds(this._locallyExcludedElementIds);
    const selection = this.gfx.selection;
    const visibleSelection = selection.selectedIds.filter((id) => !ids.has(id));
    if (visibleSelection.length !== selection.selectedIds.length) {
      selection.set({ elements: visibleSelection, editing: false });
    }
    this._renderer?.setLocallyExcludedElementIds(
      this._locallyExcludedElementIds,
    );
  };

  private get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  get renderer() {
    return this._renderer;
  }

  private _initOverlays() {
    this.std.provider.getAll(OverlayIdentifier).forEach((overlay) => {
      this._renderer.addOverlay(overlay);
    });

    this._disposables.add(() => {
      this.std.provider.getAll(OverlayIdentifier).forEach((overlay) => {
        this._renderer.removeOverlay(overlay);
      });
    });
  }

  private _initRenderer() {
    const gfx = this.gfx;
    const themeService = this.std.get(ThemeProvider);
    const featureFlagService = this.std.get(FeatureFlagService);
    const useDOMRenderer = featureFlagService.getFlag("enable_dom_renderer");

    const rendererOptions = {
      turboEnabled: () => featureFlagService.getFlag("enable_turbo_renderer"),
      viewport: gfx.viewport,
      layerManager: gfx.layer,
      gridManager: gfx.grid,
      provider: {
        generateColorProperty: (color: Color, fallback?: Color) =>
          themeService.generateColorProperty(
            color,
            fallback,
            themeService.edgelessTheme,
          ),
        getColorValue: (color: Color, fallback?: Color, real?: boolean) =>
          themeService.getColorValue(
            color,
            fallback,
            real,
            themeService.edgelessTheme,
          ),
        getColorScheme: () => themeService.edgelessTheme,
        getPropertyValue: (property: string) =>
          themeService.getCssVariableColor(
            property,
            themeService.edgelessTheme,
          ),
        selectedElements: () => gfx.selection.selectedIds,
      },
      surfaceModel: this.model,
    };

    if (useDOMRenderer) {
      this._renderer = new DomRenderer({
        ...rendererOptions,
        resolvePainter: (type) =>
          this.std.getOptional(DomElementRendererIdentifier(type)),
        watchSelection: (change) =>
          this.std.selection
            .filter$(SurfaceSelection)
            .subscribe((selections) =>
              change(selections.flatMap((s) => s.elements)),
            ),
      });
      this._disposables.add(() => this._renderer.dispose());
    } else {
      this._renderer = new CanvasRenderer({
        ...rendererOptions,
        resolvePainter: (type) =>
          this.std.getOptional<ElementRenderer>(
            ElementRendererIdentifier(type),
          ),
        enableStackingCanvas: true,
        onStackingCanvasCreated(canvas) {
          canvas.className = "indexable-canvas";
        },
      });

      this._disposables.add(() => {
        this._renderer.dispose();
      });
    }

    if (this._locallyExcludedElementIds.size > 0) {
      this._renderer.setLocallyExcludedElementIds(
        this._locallyExcludedElementIds,
      );
    }

    this._disposables.add(
      gfx.selection.slots.updated.subscribe(() => {
        this._renderer.refresh();
      }),
    );
  }

  mount(container: HTMLElement) {
    this._initRenderer();
    this._initOverlays();
    this._disposables.add(
      this.std.get(ThemeProvider).theme$.subscribe(this.refresh),
    );
    this._renderer.attach(container);
  }

  dispose() {
    this._disposables.dispose();
  }
}
