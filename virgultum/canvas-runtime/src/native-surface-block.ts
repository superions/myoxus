// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { Bound } from "@virgultum/core/primitives/gfx";
import {
  editorHostSelector,
  isEditorHost,
  NativeViewElement,
  type BlockStdScope,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import { RANGE_SYNC_EXCLUDE_ATTR } from "@virgultum/core/runtime/inline";

import { ConnectorElementModel } from "./element-model/index.js";
import { SurfaceScene, surfaceSceneCss } from "./surface-block.js";
import type { SurfaceBlockModel } from "./surface-model.js";

const styledRoots = new WeakSet<Node>();

export class SurfaceBlockComponent extends NativeViewElement {
  static isConnector = (value: unknown): value is ConnectorElementModel =>
    value instanceof ConnectorElementModel;

  std!: BlockStdScope;
  model!: SurfaceBlockModel;
  private scene!: SurfaceScene;
  private unbind?: () => void;

  get renderer() {
    return this.scene.renderer;
  }

  get store() {
    return this.std.store;
  }

  refresh = () => this.scene?.refresh();

  // Canvas tools and specialist previews already use this public refresh hook.
  requestUpdate() {
    this.refresh();
  }

  fitToViewport(bound: Bound) {
    this.scene.fitToViewport(bound);
  }

  setLocallyExcludedElementIds(ids: ReadonlySet<string>) {
    this.scene.setLocallyExcludedElementIds(ids);
  }

  connectedCallback() {
    const host = this.closest(editorHostSelector);
    if (!isEditorHost(host)) return;
    const model = host.store.getModelById<SurfaceBlockModel>(
      this.dataset.blockId!,
    );
    if (!model) return;
    this.std = host.std;
    this.model = model;
    this.setAttribute(RANGE_SYNC_EXCLUDE_ATTR, "true");

    const root = this.getRootNode();
    const styleRoot =
      root instanceof ShadowRoot ? root : this.ownerDocument.head;
    if (!styledRoots.has(styleRoot)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent = surfaceSceneCss;
      styleRoot.prepend(style);
      styledRoots.add(styleRoot);
    }

    const canvas = this.ownerDocument.createElement("div");
    canvas.className = "myoxus-edgeless-surface-block-container";
    this.replaceChildren(canvas);
    const scene = new SurfaceScene(this.std, this.model);
    this.scene = scene;
    try {
      scene.mount(canvas);
      this.unbind = this.std
        .get(GfxControllerIdentifier)
        .bindSurfaceComponent(this);
    } catch (error) {
      scene.dispose();
      throw error;
    }
  }

  disconnectedCallback() {
    this.unbind?.();
    this.unbind = undefined;
    this.scene?.dispose();
    this.replaceChildren();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-surface": SurfaceBlockComponent;
  }
}
