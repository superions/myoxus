import {
  EdgelessLegacySlotIdentifier,
  toNativeGfxBlockComponent,
} from "@virgultum/canvas-runtime/surface";
import { Bound, clamp } from "@virgultum/core/primitives/gfx";
import { EmbedIframeBlockSchema } from "@virgultum/core/models";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import { EmbedIframeBlockComponent } from "./embed-iframe-block";

export class EmbedEdgelessIframeBlockComponent extends toNativeGfxBlockComponent(
  EmbedIframeBlockComponent,
) {
  override showEditorSelection = false;
  override blockDraggable = false;

  constructor() {
    super();
    this.blockContainerStyles$.value = {
      margin: "0",
      backgroundColor: "transparent",
    };
  }

  get edgelessSlots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  protected override wrapContentHost(container: HTMLElement): HTMLElement {
    const wrapper = this.ownerDocument.createElement("div");
    wrapper.className = "edgeless-embed-iframe-block";
    container.replaceChildren(wrapper);
    this._edgelessWrapper = wrapper;
    return wrapper;
  }

  override connectedCallback() {
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
    const wrapper = this._edgelessWrapper;
    if (!wrapper) return;
    const bound = Bound.deserialize(this.model.props.xywh$.value);
    const scale = this.model.props.scale$.value;
    const width = bound.w / scale;
    const height = bound.h / scale;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    wrapper.style.transformOrigin = "0 0";
    wrapper.style.transform = `scale(${scale})`;
  }
}

export const EmbedIframeInteraction =
  GfxViewInteractionExtension<EmbedEdgelessIframeBlockComponent>(
    EmbedIframeBlockSchema.model.flavour,
    {
      resizeConstraint: {
        minWidth: 218,
        minHeight: 44,
        maxWidth: 3400,
        maxHeight: 2200,
      },

      handleResize: (context) => {
        const { model } = context;
        const initialScale = model.props.scale$.peek();

        return {
          onResizeStart(context) {
            context.default(context);
            model.stash("scale");
          },
          onResizeMove(context) {
            const { newBound, originalBound, lockRatio, constraint } = context;
            const { minWidth, maxWidth, minHeight, maxHeight } = constraint;

            let scale = initialScale;
            const originalRealWidth = originalBound.w / scale;

            if (lockRatio) {
              scale = newBound.w / originalRealWidth;
            }

            const newRealWidth = clamp(newBound.w / scale, minWidth, maxWidth);
            const newRealHeight = clamp(
              newBound.h / scale,
              minHeight,
              maxHeight,
            );

            newBound.w = newRealWidth * scale;
            newBound.h = newRealHeight * scale;

            model.props.xywh = newBound.serialize();
            if (scale !== initialScale) {
              model.props.scale = scale;
            }
          },
          onResizeEnd(context) {
            context.default(context);
            model.pop("scale");
          },
        };
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
