import { Bound, clamp } from "@virgultum/editor/global/gfx";
import { toGfxBlockComponent } from "@virgultum/editor/std";
import { GfxViewInteractionExtension } from "@virgultum/std/gfx";
import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";

import { AIChatBlockComponent } from "./ai-chat-block";
import { AIChatBlockSchema } from "./model";

export class EdgelessAIChatBlockComponent extends toGfxBlockComponent(
  AIChatBlockComponent,
) {
  override renderGfxBlock() {
    const bound = Bound.deserialize(this.model.props.xywh$.value);
    const scale = this.model.props.scale$.value;
    const width = bound.w / scale;
    const height = bound.h / scale;
    // Bound-derived width, height and scale are renderer geometry. Visual
    // chrome still comes from the global Myoxus theme tokens.
    const style = {
      width: `${width}px`,
      height: `${height}px`,
      borderRadius: "var(--mantine-radius-lg)",
      transformOrigin: "0 0",
      boxShadow: "var(--mantine-shadow-sm)",
      border:
        "calc(var(--mantine-scale) * 1px) solid var(--myoxus-border-color)",
      transform: `scale(${scale})`,
    };

    return html`
      <div class="edgeless-ai-chat" style=${styleMap(style)}>
        ${this.renderPageContent()}
      </div>
    `;
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
