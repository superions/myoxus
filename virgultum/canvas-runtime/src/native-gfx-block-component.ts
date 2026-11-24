// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { effect, signal } from "@preact/signals-core";

import {
  type GfxBlockComponent,
  GfxElementSymbol,
  bindGfxBlockView,
  gfxBlockRenderingRect,
  gfxBlockTransform,
  moveGfxBlock,
} from "@virgultum/core/runtime";
import {
  type BoxSelectionContext,
  type DragMoveContext,
  GfxControllerIdentifier,
  type GfxBlockElementModel,
} from "@virgultum/core/runtime/gfx";
import { requestThrottledConnectedFrame } from "@virgultum/core/utils";
import { NativeBlockComponent } from "@virgultum/core/runtime";

export abstract class NativeGfxBlockComponent<
  Model extends GfxBlockElementModel,
>
  extends NativeBlockComponent<Model>
  implements GfxBlockComponent<Model>
{
  [GfxElementSymbol] = true;
  readonly transformState$ = signal<"idle" | "active">("active");

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  protected bindGfx(viewSpaceSizing = false) {
    bindGfxBlockView(this);
    this.disposables.add(effect(() => this.requestUpdate()));
    this.disposables.add(
      this.model.propsUpdated.subscribe(
        requestThrottledConnectedFrame(() => this.requestUpdate(), this),
      ),
    );
    if (viewSpaceSizing) {
      this.disposables.add(
        this.gfx.viewport.viewportUpdated.subscribe(() => this.requestUpdate()),
      );
    }
  }

  override requestUpdate() {
    const rect = this.getRenderingRect();
    const length = (value: number | string | undefined) =>
      typeof value === "number" ? `${value}px` : (value ?? "");
    Object.assign(this.style, {
      left: length(rect.x),
      top: length(rect.y),
      width: length(rect.w),
      height: length(rect.h),
      zIndex: rect.zIndex,
    });
    this.renderGfxView();
  }

  protected abstract renderGfxView(): void;

  getCSSTransform() {
    return gfxBlockTransform(this);
  }
  getRenderingRect(): ReturnType<GfxBlockComponent["getRenderingRect"]> {
    return gfxBlockRenderingRect(this);
  }
  toZIndex() {
    return this.gfx.layer.getZIndex(this.model).toString();
  }
  updateZIndex() {
    this.style.zIndex = this.toZIndex();
  }
  onDragStart() {
    this.model.stash("xywh");
  }
  onDragEnd() {
    this.model.pop("xywh");
  }
  onDragMove(context: DragMoveContext) {
    moveGfxBlock(this.model, context);
  }
  onBoxSelected(_context: BoxSelectionContext): boolean | void {}
}
