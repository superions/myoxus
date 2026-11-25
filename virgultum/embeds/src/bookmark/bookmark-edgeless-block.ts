import { signal } from "@preact/signals-core";
import { toNativeGfxBlockComponent } from "@virgultum/canvas-runtime/surface";
import { BookmarkBlockSchema } from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import { BookmarkBlockComponent } from "./bookmark-block.js";

export class BookmarkEdgelessBlockComponent extends toNativeGfxBlockComponent(
  BookmarkBlockComponent,
) {
  override showEditorSelection = false;
  override blockDraggable = false;

  private readonly _gfxSelectionTick$ = signal(0);

  constructor() {
    super();
    this.blockContainerStyles$.value = { height: "100%" };
  }

  override getRenderingRect() {
    const elementBound = this.model.elementBound;
    const style = this.model.props.style$.value;

    return {
      x: elementBound.x,
      y: elementBound.y,
      w: EMBED_CARD_WIDTH[style],
      h: EMBED_CARD_HEIGHT[style],
      zIndex: this.toZIndex(),
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.model) return;
    this.disposables.add(
      this.gfx.selection.slots.updated.subscribe(() => {
        this._gfxSelectionTick$.value++;
      }),
    );
  }

  override syncGfxLayout() {
    void this._gfxSelectionTick$.value;
    const style = this.model.props.style$.value;
    const width = EMBED_CARD_WIDTH[style];
    const height = EMBED_CARD_HEIGHT[style];
    const bound = this.model.elementBound;
    const scaleX = bound.w / width;
    const scaleY = bound.h / height;
    const isSelected = this.gfx.selection.has(this.model.id);

    this.containerStyle$.value = {
      width: "100%",
      height: "100%",
      transform: `scale(${scaleX}, ${scaleY})`,
      transformOrigin: "0 0",
      pointerEvents: isSelected ? "auto" : "none",
    };
  }
}

export const BookmarkBlockInteraction = GfxViewInteractionExtension(
  BookmarkBlockSchema.model.flavour,
  {
    resizeConstraint: {
      lockRatio: true,
    },
    handleRotate: () => {
      return {
        beforeRotate(context) {
          context.set({
            rotatable: false,
          });
        },
      };
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-bookmark": BookmarkEdgelessBlockComponent;
  }
}
