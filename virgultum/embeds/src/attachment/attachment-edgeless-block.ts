import {
  EdgelessLegacySlotIdentifier,
  toNativeGfxBlockComponent,
} from "@virgultum/canvas-runtime/surface";
import {
  AttachmentBlockSchema,
  AttachmentBlockStyles,
} from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import { AttachmentBlockComponent } from "./attachment-block.js";

export class AttachmentEdgelessBlockComponent extends toNativeGfxBlockComponent(
  AttachmentBlockComponent,
) {
  override blockDraggable = false;

  get slots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  override onClick(_: MouseEvent) {
    return;
  }

  override syncGfxLayout() {
    const { style$ } = this.model.props;
    const cardStyle = style$.value ?? AttachmentBlockStyles[1];
    const width = EMBED_CARD_WIDTH[cardStyle];
    const height = EMBED_CARD_HEIGHT[cardStyle];
    const bound = this.model.elementBound;
    const scaleX = bound.w / width;
    const scaleY = bound.h / height;

    this.containerStyle$.value = {
      width: `${width}px`,
      height: `${height}px`,
      transform: `scale(${scaleX}, ${scaleY})`,
      transformOrigin: "0 0",
      overflow: "hidden",
    };
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-attachment": AttachmentEdgelessBlockComponent;
  }
}

export const AttachmentBlockInteraction = GfxViewInteractionExtension(
  AttachmentBlockSchema.model.flavour,
  {
    resizeConstraint: {
      lockRatio: true,
    },
    handleRotate: () => {
      return {
        beforeRotate: (context) => {
          context.set({
            rotatable: false,
          });
        },
      };
    },
  },
);
