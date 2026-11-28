// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { GfxViewInteractionExtension } from "@virgultum/core/runtime/gfx";
import { NativeGfxBlockComponent } from "@virgultum/editor/blocks/surface";
import { Peekable } from "@virgultum/editor/components/peek";
import { Bound, clamp } from "@virgultum/editor/global/gfx";

import { mountStoredAIChat } from "./ai-chat-block";
import { type AIChatBlockModel, AIChatBlockSchema } from "./model";

@Peekable({
  enableOn: () => !BUILD_CONFIG.isMobileEdition,
})
export class EdgelessAIChatBlockComponent extends NativeGfxBlockComponent<AIChatBlockModel> {
  private readonly frame = document.createElement("div");

  connectedCallback(): void {
    if (!this.connectBlock()) return;
    this.frame.className = "edgeless-ai-chat";
    this.append(this.frame);
    this.disposables.add(() => this.frame.remove());
    this.bindGfx();
    mountStoredAIChat(this, this.frame);
  }

  protected override renderGfxView(): void {
    const bound = Bound.deserialize(this.model.props.xywh$.value);
    const scale = this.model.props.scale$.value;
    Object.assign(this.frame.style, {
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
            context.set({ rotatable: false });
          },
        };
      },
      handleResize({ model }) {
        const startScale = model.props.scale$.peek();

        return {
          onResizeStart(context) {
            context.default(context);
            model.stash("scale");
          },
          onResizeMove(context) {
            const { newBound, originalBound, lockRatio, constraint } = context;
            const baseWidth = originalBound.w / startScale;
            const nextScale = lockRatio ? newBound.w / baseWidth : startScale;

            const clampedWidth = clamp(
              newBound.w / nextScale,
              constraint.minWidth,
              constraint.maxWidth,
            );
            const clampedHeight = clamp(
              newBound.h / nextScale,
              constraint.minHeight,
              constraint.maxHeight,
            );

            newBound.w = clampedWidth * nextScale;
            newBound.h = clampedHeight * nextScale;
            model.props.xywh = newBound.serialize();
            if (nextScale !== startScale) {
              model.props.scale = nextScale;
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
