// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeGfxBlockComponent } from "@virgultum/canvas-runtime/surface";
import type { FrameBlockModel } from "@virgultum/core/models";
import type { BoxSelectionContext } from "@virgultum/core/runtime/gfx";

import {
  FrameTitleIdentifier,
  mountFrameTitle,
} from "../../widgets/frame-title/mount-frame-title";

import {
  frameRenderingRect,
  frameBodyStyle,
  frameBoxSelection,
} from "./frame-block";

export class FrameBlockComponent extends NativeGfxBlockComponent<FrameBlockModel> {
  private readonly body = this.ownerDocument.createElement("div");
  private outlineVisible = true;

  set showBorder(visible: boolean) {
    this.outlineVisible = visible;
    if (this.isConnected) this.renderGfxView();
  }

  connectedCallback() {
    if (!this.connectBlock()) return;
    this.body.className = "myoxus-frame-container";
    Object.assign(this.body.style, {
      width: "100%",
      height: "100%",
      borderRadius: "2px",
      pointerEvents: "none",
    });
    this.replaceChildren(this.body);
    if (this.std.getOptional(FrameTitleIdentifier))
      mountFrameTitle(this.body, this.model, this.std);
    this.mountBlockWidgets(this);
    this.bindGfx(true);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.body.replaceChildren();
    this.replaceChildren();
  }

  // The viewport places frames at their actual view-space size.
  override getCSSTransform() {
    return "";
  }

  override getRenderingRect() {
    return frameRenderingRect(this);
  }

  override onBoxSelected(context: BoxSelectionContext) {
    return frameBoxSelection(this, context);
  }

  protected override renderGfxView() {
    // The frame itself stays transparent to pointer hit testing. Its title
    // takes events independently, including when another block covers it.
    void this.transformState$.value;
    this.style.pointerEvents = "none";
    Object.assign(this.body.style, frameBodyStyle(this, this.outlineVisible));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-frame": FrameBlockComponent;
  }
}
