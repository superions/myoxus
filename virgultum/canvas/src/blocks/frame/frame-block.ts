import { cssVar } from "@myoxus/theme";
import { Bound } from "@virgultum/core/primitives/gfx";
import { DefaultTheme } from "@virgultum/core/models";
import type { BoxSelectionContext } from "@virgultum/core/runtime/gfx";
import { ThemeProvider } from "@virgultum/core/services";
import { OverlayIdentifier } from "@virgultum/canvas-runtime/surface";
import { FrameBlockSchema, isTransparent } from "@virgultum/core/models";
import {
  getTopElements,
  GfxViewInteractionExtension,
} from "@virgultum/core/runtime/gfx";

import type { FrameBlockComponent } from "./native-frame-block";

export { FrameBlockComponent } from "./native-frame-block";

import {
  EdgelessFrameManagerIdentifier,
  type FrameOverlay,
} from "./frame-manager";

export function frameRenderingRect(view: FrameBlockComponent) {
  const { translateX, translateY, zoom } = view.gfx.viewport;
  const { xywh, rotate } = view.model;
  const bound = Bound.deserialize(xywh);
  return {
    x: bound.x * zoom + translateX,
    y: bound.y * zoom + translateY,
    w: bound.w * zoom,
    h: bound.h * zoom,
    rotate,
    zIndex: view.toZIndex(),
  };
}

export function frameBoxSelection(
  view: FrameBlockComponent,
  { box }: BoxSelectionContext,
) {
  const bound = new Bound(box.x, box.y, box.w, box.h);
  return (
    view.model.childElements.length === 0 ||
    bound.contains(view.model.elementBound)
  );
}

export function frameBodyStyle(view: FrameBlockComponent, showBorder: boolean) {
  const { model, std, gfx } = view;
  const backgroundColor = std
    .get(ThemeProvider)
    .generateColorProperty(model.props.background, DefaultTheme.transparent);
  const isNavigator = gfx.tool.currentToolName$.value === "frameNavigator";
  return {
    zIndex: String(gfx.layer.getZIndex(model)),
    backgroundColor,
    border:
      isNavigator || !showBorder
        ? "none"
        : `1px solid ${cssVar("borderColor")}`,
  };
}

export const FrameBlockInteraction =
  GfxViewInteractionExtension<FrameBlockComponent>(
    FrameBlockSchema.model.flavour,
    {
      handleResize: (context) => {
        const { model, std } = context;

        return {
          onResizeStart(context): void {
            context.default(context);
            model.stash("childElementIds");
          },

          onResizeMove(context): void {
            const { newBound } = context;
            const frameManager = std.getOptional(
              EdgelessFrameManagerIdentifier,
            );
            const overlay = std.getOptional(
              OverlayIdentifier("frame"),
            ) as FrameOverlay;

            model.xywh = newBound.serialize();

            if (!frameManager) {
              return;
            }

            const oldChildren = frameManager.getChildElementsInFrame(model);

            const newChildren = getTopElements(
              frameManager.getElementsInFrameBound(model),
            ).concat(
              oldChildren.filter((oldChild) => {
                return model.intersectsBound(oldChild.elementBound);
              }),
            );

            frameManager.removeAllChildrenFromFrame(model);
            frameManager.addElementsToFrame(model, newChildren);

            overlay?.highlight(model, true, false);
          },
          onResizeEnd(context): void {
            context.default(context);
            model.pop("childElementIds");
          },
        };
      },
      handleRotate: () => {
        return {
          beforeRotate(context): void {
            context.set({
              rotatable: false,
            });
          },
        };
      },
      handleSelection: () => {
        return {
          selectable(context) {
            const { model } = context;

            const onTitle =
              model.externalBound?.containsPoint([
                context.position.x,
                context.position.y,
              ]) ?? false;

            return (
              context.default(context) &&
              (model.isLocked() ||
                !isTransparent(model.props.background) ||
                onTitle)
            );
          },
          onSelect(context) {
            return context.default(context);
          },
        };
      },
    },
  );
