import type { IBound } from "@virgultum/core/primitives/gfx";
import type {
  GfxLocalElementModel,
  GfxPrimitiveElementModel,
} from "@virgultum/core/runtime/gfx";

import type { RoughCanvas } from "../../utils/rough/canvas.js";
import type { CanvasRenderer } from "../canvas-renderer.js";

export type ElementRenderer<
  T extends GfxPrimitiveElementModel | GfxLocalElementModel =
    GfxPrimitiveElementModel,
> = (
  model: T,
  ctx: CanvasRenderingContext2D,
  matrix: DOMMatrix,
  renderer: CanvasRenderer,
  rc: RoughCanvas,
  viewportBound: IBound,
) => void;

export const elementRendererExtensions = [];
