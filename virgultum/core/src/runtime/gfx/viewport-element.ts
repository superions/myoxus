import { batch } from "@preact/signals-core";
import { DisposableGroup } from "../../primitives/disposable/index.js";
import { requestThrottledConnectedFrame } from "../../utils/event.js";
import { isGfxBlockComponent } from "../view/element/gfx-block-component.js";
import type { GfxController } from "./controller.js";
import { GfxBlockElementModel } from "./model/gfx-block-model.js";

export const gfxViewportStyle = `
    gfx-viewport {
      position: absolute;
      left: 0;
      top: 0;
      contain: size layout style;
      display: block;
      transform: none;
    }

    /* CSS for idle blocks that are hidden but maintain layout */
    gfx-viewport > .block-idle {
      visibility: hidden;
      pointer-events: none;
      will-change: transform;
      contain: size layout style;
    }

    /* CSS for active blocks participating in viewport transformations */
    gfx-viewport > .block-active {
      visibility: visible;
      pointer-events: auto;
    }
  `;

export class GfxViewportRendering {
  private static readonly VIEWPORT_REFRESH_PIXEL_THRESHOLD = 18;
  private static readonly VIEWPORT_REFRESH_MAX_INTERVAL = 120;

  private readonly disposables = new DisposableGroup();

  private readonly _hideOutsideAndNoSelectedBlock = () => {
    const { gfx } = this;
    const currentViewportModels = gfx.grid.search(gfx.viewport.viewportBounds, {
      useSet: true,
      filter: ["block"],
    });
    const currentSelectedModels = this._getSelectedModels();
    const shouldBeVisible = new Set([
      ...currentViewportModels,
      ...currentSelectedModels,
    ]);

    batch(() => {
      // Step 1: Activate all the blocks that should be visible
      shouldBeVisible.forEach((model) => {
        const view = gfx.view.get(model);
        if (!isGfxBlockComponent(view)) return;
        view.transformState$.value = "active";
      });

      // Step 2: Hide all the blocks that should not be visible
      this._lastVisibleModels?.forEach((model) => {
        if (shouldBeVisible.has(model)) return;

        const view = gfx.view.get(model);
        if (!isGfxBlockComponent(view)) return;
        view.transformState$.value = "idle";
      });
    });

    this._lastVisibleModels = shouldBeVisible;
  };

  private _lastVisibleModels?: Set<GfxBlockElementModel>;

  private _lastViewportUpdate?: { zoom: number; center: [number, number] };

  private _lastViewportRefreshTime = 0;

  private _pendingViewportRefreshTimer: ReturnType<
    typeof globalThis.setTimeout
  > | null = null;

  private readonly _pendingChildrenUpdates: (() => void)[] = [];
  private childFrame: number | undefined;
  private disposed = false;

  private readonly _refreshViewport = requestThrottledConnectedFrame(() => {
    if (!this.disposed) this._hideOutsideAndNoSelectedBlock();
  });

  private _clearPendingViewportRefreshTimer() {
    if (this._pendingViewportRefreshTimer !== null) {
      clearTimeout(this._pendingViewportRefreshTimer);
      this._pendingViewportRefreshTimer = null;
    }
  }

  private _scheduleTrailingViewportRefresh() {
    this._clearPendingViewportRefreshTimer();
    this._pendingViewportRefreshTimer = globalThis.setTimeout(() => {
      this._pendingViewportRefreshTimer = null;
      this._lastViewportRefreshTime = performance.now();
      this._refreshViewport();
    }, GfxViewportRendering.VIEWPORT_REFRESH_MAX_INTERVAL);
  }

  private _refreshViewportByViewportUpdate(update: {
    zoom: number;
    center: [number, number];
  }) {
    const now = performance.now();
    const previous = this._lastViewportUpdate;
    this._lastViewportUpdate = {
      zoom: update.zoom,
      center: [update.center[0], update.center[1]],
    };

    if (!previous) {
      this._lastViewportRefreshTime = now;
      this._refreshViewport();
      return;
    }

    const zoomChanged = Math.abs(previous.zoom - update.zoom) > 0.0001;
    const centerMovedInPixel = Math.hypot(
      (update.center[0] - previous.center[0]) * update.zoom,
      (update.center[1] - previous.center[1]) * update.zoom,
    );
    const timeoutReached =
      now - this._lastViewportRefreshTime >=
      GfxViewportRendering.VIEWPORT_REFRESH_MAX_INTERVAL;

    if (
      zoomChanged ||
      centerMovedInPixel >=
        GfxViewportRendering.VIEWPORT_REFRESH_PIXEL_THRESHOLD ||
      timeoutReached
    ) {
      this._clearPendingViewportRefreshTimer();
      this._lastViewportRefreshTime = now;
      this._refreshViewport();
      return;
    }

    this._scheduleTrailingViewportRefresh();
  }

  constructor(
    private readonly gfx: GfxController,
    private readonly maxConcurrentRenders: () => number,
  ) {
    this._hideOutsideAndNoSelectedBlock();
    this.disposables.add(
      gfx.viewport.viewportUpdated.subscribe((update) =>
        this._refreshViewportByViewportUpdate(update),
      ),
    );
    this.disposables.add(
      gfx.viewport.sizeUpdated.subscribe(() => {
        this._clearPendingViewportRefreshTimer();
        this._lastViewportRefreshTime = performance.now();
        this._refreshViewport();
      }),
    );
  }

  private readonly updateChildren = () => {
    this.childFrame = undefined;
    const ready = this._pendingChildrenUpdates.splice(
      0,
      this.maxConcurrentRenders(),
    );
    for (const resolve of ready) resolve();
    if (this._pendingChildrenUpdates.length)
      this.childFrame = requestAnimationFrame(this.updateChildren);
  };

  readonly scheduleUpdateChildren = () => {
    if (this.disposed) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this._pendingChildrenUpdates.push(resolve);
    this.childFrame ??= requestAnimationFrame(this.updateChildren);
    return promise;
  };

  dispose() {
    this.disposed = true;
    this._clearPendingViewportRefreshTimer();
    this.disposables.dispose();
    if (this.childFrame !== undefined) cancelAnimationFrame(this.childFrame);
    // Child render promises can outlive their viewport during a mode switch.
    for (const resolve of this._pendingChildrenUpdates.splice(0)) resolve();
  }

  private _getSelectedModels(): Set<GfxBlockElementModel> {
    const { gfx } = this;
    return new Set(
      gfx.selection.surfaceSelections
        .flatMap(({ elements }) => elements)
        .map((id) => gfx.getElementById(id))
        .filter((e) => e instanceof GfxBlockElementModel),
    );
  }

  setBlockVisibility(blockIds: readonly string[], state: "active" | "idle") {
    batch(() => {
      for (const id of blockIds) {
        const view = this.gfx.view.get(id);
        if (isGfxBlockComponent(view)) view.transformState$.value = state;
      }
    });
  }
}
