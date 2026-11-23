import { themeToVar } from "@myoxus/theme";
import { parseStringToRgba } from "@virgultum/core/color";
import { Bound } from "@virgultum/core/primitives/gfx";
import {
  ColorScheme,
  type FrameBlockModel,
  isTransparent,
} from "@virgultum/core/models";
import { ThemeProvider } from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/core/runtime";
import type { GfxController } from "@virgultum/core/runtime/gfx";

import { frameTitleStyleVars } from "./styles.js";

export const MYOXUS_FRAME_TITLE = "myoxus-frame-title";

export function frameTitleColors(std: BlockStdScope, model: FrameBlockModel) {
  let backgroundColor = std
    .get(ThemeProvider)
    .getColorValue(model.props.background, undefined, true);
  if (isTransparent(backgroundColor)) {
    backgroundColor = std
      .get(ThemeProvider)
      .getCssVariableColor(themeToVar("noteBackgroundWhite"));
  }

  const { r, g, b, a } = parseStringToRgba(backgroundColor);

  const theme = std.get(ThemeProvider).theme;
  let textColor: string;
  {
    let rPrime, gPrime, bPrime;
    if (theme === ColorScheme.Light) {
      rPrime = 1 - a + a * r;
      gPrime = 1 - a + a * g;
      bPrime = 1 - a + a * b;
    } else {
      rPrime = a * r;
      gPrime = a * g;
      bPrime = a * b;
    }

    // light
    const L = 0.299 * rPrime + 0.587 * gPrime + 0.114 * bPrime;
    textColor = L > 0.5 ? "black" : "white";
  }

  return {
    background: backgroundColor,
    text: textColor,
  };
}

export function layoutFrameTitle(
  element: HTMLElement,
  model: FrameBlockModel,
  zoom: number,
  nestedFrame: boolean,
  colors: ReturnType<typeof frameTitleColors>,
) {
  const bound = Bound.deserialize(model.xywh);

  const { nestedFrameOffset, height } = frameTitleStyleVars;

  const maxWidth = nestedFrame
    ? bound.w * zoom - nestedFrameOffset / zoom
    : bound.w * zoom;
  const hidden = height / zoom >= bound.h;
  const transformOperation = [
    `translate(0%, ${nestedFrame ? 0 : -100}%)`,
    `translate(${nestedFrame ? nestedFrameOffset : 0}px, ${
      nestedFrame ? nestedFrameOffset : -nestedFrameOffset
    }px)`,
  ];

  element.style.setProperty("--bg-color", colors.background);
  element.style.left = "0px";
  element.style.top = "0px";
  element.style.display = hidden ? "none" : "flex";
  element.style.transform = transformOperation.join(" ");
  element.style.maxWidth = `${maxWidth}px`;
  element.style.transformOrigin = nestedFrame ? "top left" : "bottom left";
  element.style.color = colors.text;
}

export function updateFrameTitleHitArea(
  gfx: GfxController,
  model: FrameBlockModel,
  zoom: number,
  nestedFrame: boolean,
  measuredWidth: number,
  measuredHeight: number,
) {
  const { elementBound } = model;
  const width = measuredWidth / zoom;
  const height = measuredHeight / zoom;

  const { nestedFrameOffset } = frameTitleStyleVars;
  const titleBounds =
    width && height
      ? Bound.serialize({
          x: elementBound.x + (nestedFrame ? nestedFrameOffset / zoom : 0),
          y:
            elementBound.y +
            (nestedFrame
              ? nestedFrameOffset / zoom
              : -(height + nestedFrameOffset / zoom)),
          w: width,
          h: height,
        })
      : undefined;
  if (titleBounds === model.externalXYWH) return;
  model.externalXYWH = titleBounds;
  gfx.grid.update(model);
}
