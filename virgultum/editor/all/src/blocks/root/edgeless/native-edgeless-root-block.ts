// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { mountPresentationBackground } from "@virgultum/canvas/blocks";
import { effect, untracked } from "@preact/signals-core";
import {
  type SurfaceBlockModel,
  NativeBlockComponent,
  NativeBlockProjection,
} from "@virgultum/canvas-runtime/surface";
import type { RootBlockModel } from "@virgultum/core/models";
import type { UIEventHandler } from "@virgultum/core/runtime";
import {
  type GfxViewportElement,
  GfxControllerIdentifier,
} from "@virgultum/core/runtime/gfx";
import {
  FontLoaderService,
  ViewportElementProvider,
} from "@virgultum/core/services";
import { hasTextControlEventTarget } from "@virgultum/core/utils";

import {
  canvasRootCss,
  EdgelessRootController,
} from "./edgeless-root-block.js";
import type { EdgelessRootService } from "./edgeless-root-service.js";

const styledRoots = new WeakSet<Node>();
export class EdgelessRootBlockComponent extends NativeBlockComponent<
  RootBlockModel,
  EdgelessRootService
> {
  private controller?: EdgelessRootController;
  private projection?: NativeBlockProjection;

  backgroundElm!: HTMLDivElement;
  gfxViewportElm!: GfxViewportElement;
  overlayElm!: HTMLDivElement;
  mountElm!: HTMLDivElement;

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }
  get surface() {
    return this.gfxViewportElm?.querySelector("myoxus-surface") ?? null;
  }
  get surfaceBlockModel() {
    return this.model.children.find(
      (child) => child.flavour === "myoxus:surface",
    ) as SurfaceBlockModel;
  }
  get viewportElement() {
    return this.std.get(ViewportElementProvider).viewportElement;
  }
  get fontLoader() {
    return this.std.get(FontLoaderService);
  }
  get keyboardManager() {
    return this.controller?.keyboardManager ?? null;
  }
  override get updateComplete() {
    return this.waitForViews(this.projection?.nodes ?? []);
  }

  override bindHotKey(
    keymap: Record<string, UIEventHandler>,
    options?: { global?: boolean; flavour?: boolean },
  ) {
    const handlers = Object.fromEntries(
      Object.entries(keymap).map(([key, handler]) => [
        key,
        key.length === 1 && key >= "A" && key <= "z"
          ? (context: Parameters<UIEventHandler>[0]) => {
              if (!hasTextControlEventTarget(context.get("keyboardState").raw))
                handler(context);
            }
          : handler,
      ]),
    );
    return super.bindHotKey(handlers, options);
  }

  connectedCallback() {
    if (!this.connectBlock()) return;
    const { model } = this;
    const projection = new NativeBlockProjection(this.host);
    this.projection = projection;

    const root = this.getRootNode();
    const styleRoot =
      root instanceof ShadowRoot ? root : this.ownerDocument.head;
    if (!styledRoots.has(styleRoot)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent = canvasRootCss;
      styleRoot.append(style);
      styledRoots.add(styleRoot);
    }

    if (this.viewType === "hidden") return;
    if (this.isVersionMismatch) {
      const warning = this.ownerDocument.createElement("dl");
      warning.className = "version-mismatch-warning";
      warning.contentEditable = "false";
      const title = this.ownerDocument.createElement("h4");
      title.textContent = "Block Version Mismatched";
      warning.append(title);
      this.replaceChildren(warning);
      return;
    }

    const showCanvas = this.viewType === "display";
    if (showCanvas) {
      this.backgroundElm = this.ownerDocument.createElement("div");
      this.backgroundElm.className = "edgeless-background edgeless-container";
      this.gfxViewportElm = this.ownerDocument.createElement(
        "gfx-viewport",
      ) as GfxViewportElement;
      this.gfxViewportElm.maxConcurrentRenders = 6;
      this.gfxViewportElm.gfx = this.gfx;
      this.backgroundElm.append(this.gfxViewportElm);
      this.mountElm = this.ownerDocument.createElement("div");
      this.mountElm.className = "edgeless-mount-point";
      this.overlayElm = this.ownerDocument.createElement("div");
      this.overlayElm.className = "widgets-container";

      this.controller = new EdgelessRootController(this);
      this.controller.connect();
      this.replaceChildren(this.backgroundElm, this.mountElm, this.overlayElm);
    }

    this.disposables.add(
      effect(() => {
        const children = showCanvas
          ? [...model.children, ...(this.surfaceBlockModel?.children ?? [])]
          : model.children;
        untracked(() =>
          projection.sync(children, showCanvas ? this.gfxViewportElm : this),
        );
      }),
    );
    if (showCanvas) {
      this.mountBlockWidgets(this.overlayElm);
      const background = mountPresentationBackground(this.overlayElm, this.std);
      if (background) this.disposables.add(background);
      this.controller?.mount();
    }
  }

  override requestUpdate() {
    if (!this.isConnected || !this.gfxViewportElm) return;
    this.projection?.sync(
      [...this.model.children, ...(this.surfaceBlockModel?.children ?? [])],
      this.gfxViewportElm,
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.controller?.dispose();
    this.controller = undefined;
    this.projection?.dispose();
    this.projection = undefined;
    this.replaceChildren();
  }
}
