import {
  EdgelessLegacySlotIdentifier,
  toNativeGfxBlockComponent,
} from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import type { EmbedProps } from "@virgultum/core/models";
import type { BlockService, GfxBlockComponent } from "@virgultum/core/runtime";
import type { GfxBlockElementModel } from "@virgultum/core/runtime/gfx";

import type { EmbedBlockComponent } from "./embed-block-element.js";

type EmbedBlockCtor<
  Model extends GfxBlockElementModel<EmbedProps>,
  Service extends BlockService,
  WidgetName extends string,
> = abstract new (
  ...args: any[]
) => EmbedBlockComponent<Model, Service, WidgetName>;

type NativeGfxEmbedBase<
  Model extends GfxBlockElementModel<EmbedProps>,
  Service extends BlockService,
  WidgetName extends string,
> = abstract new (...args: any[]) => EmbedBlockComponent<
  Model,
  Service,
  WidgetName
> &
  GfxBlockComponent<Model, Service> & {
    syncGfxLayout(): void;
    connectedCallback(): void;
  };

export function toEdgelessEmbedBlock<
  Model extends GfxBlockElementModel<EmbedProps>,
  Service extends BlockService,
  WidgetName extends string,
  B extends EmbedBlockCtor<Model, Service, WidgetName>,
>(block: B) {
  const GfxBase = toNativeGfxBlockComponent(
    block,
  ) as unknown as NativeGfxEmbedBase<Model, Service, WidgetName>;

  abstract class EdgelessEmbedMixin extends GfxBase {
    override showEditorSelection = false;
    override blockDraggable = false;

    constructor(...args: any[]) {
      super(...args);
      this.blockContainerStyles$.value = undefined;
    }

    get bound(): Bound {
      return Bound.deserialize(this.model.xywh);
    }

    _handleClick(_: MouseEvent): void {
      return;
    }

    get edgelessSlots() {
      return this.std.get(EdgelessLegacySlotIdentifier);
    }

    override connectedCallback(): void {
      super.connectedCallback();
      if (!this.model) return;

      this.disposables.add(
        this.edgelessSlots.elementResizeStart.subscribe(() => {
          this.isResizing$.value = true;
        }),
      );

      this.disposables.add(
        this.edgelessSlots.elementResizeEnd.subscribe(() => {
          this.isResizing$.value = false;
        }),
      );
    }

    override syncGfxLayout() {
      const bound = Bound.deserialize(this.model.props.xywh$.value);

      this.embedContainerStyle$.value = {
        ...this.embedContainerStyle$.peek(),
        width: `${bound.w}px`,
        height: `${bound.h}px`,
      };
      this.blockContainerStyles$.value = {
        width: `${bound.w}px`,
      };
    }
  }

  return EdgelessEmbedMixin as unknown as B & {
    new (...args: any[]): InstanceType<B> &
      GfxBlockComponent<Model, Service> & {
        readonly bound: Bound;
        readonly edgelessSlots: ReturnType<
          EdgelessEmbedMixin["edgelessSlots"] extends infer T ? () => T : never
        >;
        syncGfxLayout(): void;
        connectedCallback(): void;
      };
  };
}
