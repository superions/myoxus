import { Bound, clamp } from "@virgultum/editor/global/gfx";
import { NativeGfxBlockComponent } from "@virgultum/editor/blocks/surface";
import { Peekable } from "@virgultum/editor/components/peek";
import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";

import { mountStoredAIChat } from "./ai-chat-block";
import { AIChatBlockSchema, type AIChatBlockModel } from "./model";

@Peekable({
  enableOn: () => !BUILD_CONFIG.isMobileEdition,
})
export class EdgelessAIChatBlockComponent extends NativeGfxBlockComponent<AIChatBlockModel> {
  private readonly card = document.createElement("div");

  connectedCallback() {
    if (!this.connectBlock()) return;
    this.card.className = "edgeless-ai-chat";
    this.append(this.card);
    this.disposables.add(() => this.card.remove());
    this.bindGfx();
    mountStoredAIChat(this, this.card);
  }

  protected override renderGfxView() {
    const bound = Bound.deserialize(this.model.props.xywh$.value);
    const scale = this.model.props.scale$.value;
    Object.assign(this.card.style, {
      width: `${bound.w / scale}px`,
      height: `${bound.h / scale}px`,
      borderRadius: "var(--mantine-radius-lg)",
      transformOrigin: "0 0",
      boxShadow: "var(--mantine-shadow-sm)",
      border:
        "calc(var(--mantine-scale) * 1px) solid var(--myoxus-border-color)",
      transform: `scale(${scale})`,
    });
  }
}

export const EdgelessAIChatBlockInteraction =
  GfxViewInteractionExtension<EdgelessAIChatBlockComponent>(
    AIChatBlockSchema.model.flavour,
    {
      resizeConstraint: {
        minWidth: 260,
        minHeight: 160,
        maxWidth: 320,
        maxHeight: 300,
      },

      handleRotate() {
        return {
          beforeRotate(context) {
            context.set({
              rotatable: false,
            });
          },
        };
      },

      handleResize({ model }) {
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

            // update scale if resize is proportional
            if (lockRatio) {
              scale = newBound.w / originalRealWidth;
            }

            let newRealWidth = clamp(newBound.w / scale, minWidth, maxWidth);
            let newRealHeight = clamp(newBound.h / scale, minHeight, maxHeight);

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
    },
  );

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-edgeless-ai-chat": EdgelessAIChatBlockComponent;
  }
}
