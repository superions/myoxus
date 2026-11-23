// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { signal, untracked } from "@preact/signals-core";
import {
  NativeGfxBlockComponent,
  NativeBlockProjection,
} from "@virgultum/canvas-runtime/surface";
import type { EdgelessTextBlockModel } from "@virgultum/core/models";

import { EdgelessTextController, edgelessTextCss } from "./edgeless-text-block";

const styledRoots = new WeakSet<Node>();

export class EdgelessTextBlockComponent extends NativeGfxBlockComponent<EdgelessTextBlockModel> {
  readonly textContainer = this.ownerDocument.createElement("div");
  private readonly content = this.ownerDocument.createElement("div");
  readonly childrenContainer = this.ownerDocument.createElement("div");
  readonly editing = signal(false);
  private readonly controller = new EdgelessTextController(this);
  private projection?: NativeBlockProjection;

  connectedCallback() {
    if (!this.connectBlock()) return;
    const root = this.getRootNode();
    const styleRoot =
      root instanceof ShadowRoot ? root : this.ownerDocument.head;
    if (!styledRoots.has(styleRoot)) {
      const style = this.ownerDocument.createElement("style");
      style.textContent = edgelessTextCss;
      styleRoot.append(style);
      styledRoots.add(styleRoot);
    }

    this.textContainer.className = "edgeless-text-block-container";
    this.childrenContainer.className = "myoxus-block-children-container";
    this.content.replaceChildren(this.childrenContainer);
    this.textContainer.replaceChildren(this.content);
    this.replaceChildren(this.textContainer);
    this.projection = new NativeBlockProjection(this.host);
    this.controller.connect();
    this.controller.mount();
    this.bindGfx();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.projection?.dispose();
    this.projection = undefined;
    this.replaceChildren();
  }

  override getCSSTransform() {
    return this.controller.getCSSTransform();
  }

  override getRenderingRect() {
    return this.controller.getRenderingRect();
  }

  checkWidthOverflow(width: number) {
    return this.controller.checkWidthOverflow(width);
  }

  tryFocusEnd() {
    this.controller.tryFocusEnd();
  }

  protected override renderGfxView() {
    const editing = this.editing.value;
    const viewStyle = this.controller.getLayoutStyle();
    const textStyle = this.controller.getTextStyle();
    const children = this.model.children;
    this.contentEditable = String(editing && !this.store.readonly$.value);
    this.textContainer.dataset.maxWidth = String(this.model.props.hasMaxWidth);
    Object.assign(this.textContainer.style, viewStyle);
    this.content.style.pointerEvents = editing ? "auto" : "none";
    this.content.style.userSelect = editing ? "auto" : "none";
    for (const [key, value] of Object.entries(textStyle))
      this.childrenContainer.style.setProperty(key, value);
    untracked(() => this.projection?.sync(children, this.childrenContainer));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-text": EdgelessTextBlockComponent;
  }
}
