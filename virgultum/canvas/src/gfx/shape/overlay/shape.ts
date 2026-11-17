import type { Options, RoughCanvas } from "@virgultum/canvas-runtime/surface";
import type { XYWH } from "@virgultum/core/primitives/gfx";
import type { ShapeStyle } from "@virgultum/core/models";

export abstract class Shape {
  options: Options;

  shapeStyle: ShapeStyle;

  type: string;

  xywh: XYWH;

  constructor(
    xywh: XYWH,
    type: string,
    options: Options,
    shapeStyle: ShapeStyle,
  ) {
    this.xywh = xywh;
    this.type = type;
    this.options = options;
    this.shapeStyle = shapeStyle;
  }

  abstract draw(ctx: CanvasRenderingContext2D, rc: RoughCanvas): void;
}
