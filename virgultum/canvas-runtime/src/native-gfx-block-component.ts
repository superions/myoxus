// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, effect, signal } from "@preact/signals-core";

import {
  type BlockService,
  type GfxBlockComponent,
  GfxElementSymbol,
  SurfaceSelection,
  bindGfxBlockView,
  gfxBlockRenderingRect,
  gfxBlockTransform,
  moveGfxBlock,
  NativeBlockComponent,
} from "@virgultum/core/runtime";
import {
  type BoxSelectionContext,
  type DragMoveContext,
  GfxControllerIdentifier,
  type GfxBlockElementModel,
} from "@virgultum/core/runtime/gfx";
import { requestThrottledConnectedFrame } from "@virgultum/core/utils";

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

type NativeBlockCtor<
  Model extends GfxBlockElementModel = GfxBlockElementModel,
  Service extends BlockService = BlockService,
> = abstract new (...args: any[]) => NativeBlockComponent<Model, Service>;

/** Mix surface positioning, transform and drag semantics onto a native Page block class. */
export function toNativeGfxBlockComponent<
  Model extends GfxBlockElementModel,
  Service extends BlockService,
  B extends NativeBlockCtor<Model, Service>,
>(CustomBlock: B) {
  abstract class NativeGfxMixin extends (CustomBlock as unknown as abstract new (
    ...args: any[]
  ) => NativeBlockComponent<Model, Service> & {
    connectedCallback(): void;
  }) {
    [GfxElementSymbol] = true;
    readonly transformState$ = signal<"idle" | "active">("active");

    override readonly selected$ = computed(
      () =>
        this.std?.selection.value.some(
          (selection) =>
            selection.blockId === this.model?.id &&
            selection.is(SurfaceSelection),
        ) ?? false,
    );

    get gfx() {
      return this.std.get(GfxControllerIdentifier);
    }

    protected syncGfxLayout() {}

    protected applyGfxRect() {
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
      this.syncGfxLayout();
    }

    override connectedCallback() {
      super.connectedCallback();
      if (!this.model) return;
      bindGfxBlockView(this);
      this.disposables.add(effect(() => this.applyGfxRect()));
    }

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

  return NativeGfxMixin as unknown as B & {
    new (...args: any[]): InstanceType<B> &
      GfxBlockComponent<Model, Service> & {
        syncGfxLayout(): void;
        applyGfxRect(): void;
        connectedCallback(): void;
      };
  };
}
