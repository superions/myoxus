import {
  Bound,
  type IBound,
  type IVec,
  type PointLocation,
  type SerializedXYWH,
} from "@virgultum/global/gfx";
import {
  type BaseElementProps,
  field,
  GfxLocalElementModel,
  GfxPrimitiveElementModel,
  local,
  type PointTestOptions,
  prop,
} from "@virgultum/std/gfx";
import * as Y from "yjs";

import {
  DEFAULT_ROUGHNESS,
  FontFamily,
  FontStyle,
  FontWeight,
  ShapeStyle,
  ShapeTextFontSize,
  ShapeType,
  StrokeStyle,
  TextAlign,
  TextResizing,
  type TextStyleProps,
  TextVerticalAlign,
} from "../../consts/index.js";
import { type Color, DefaultTheme } from "../../themes/index.js";
import { shapeMethods } from "./api/index.js";

/** Derived, measured label content. Source owners supply wrapped runs; the shape
 * renderer paints them without changing text, geometry or document history. */
export type ShapeLabelProjection = Readonly<{
  runs: readonly Readonly<{ text: string; bold: boolean; italic: boolean }>[];
  box: Readonly<{ x: number; y: number; width: number; height: number }>;
  lineHeight: number;
  icon?: Readonly<{
    paths: readonly string[];
    viewBox: readonly [number, number, number, number];
    x: number;
    y: number;
    size: number;
    strokeWidth: number;
  }>;
}>;

export type ShapeProps = BaseElementProps & {
  shapeType: ShapeType;
  mermaidContour?: readonly IVec[];
  labelProjection?: ShapeLabelProjection | null;
  radius: number;
  filled: boolean;
  innerCircleFilled?: boolean;
  fillColor: Color;
  strokeWidth: number;
  strokeColor: Color;
  strokeStyle: StrokeStyle;
  shapeStyle: ShapeStyle;
  // https://github.com/rough-stuff/rough/wiki#roughness
  roughness?: number;

  text?: Y.Text;
  textDecoration?: "none" | "underline";
  textHorizontalAlign?: TextAlign;
  textVerticalAlign?: TextVerticalAlign;
  textResizing?: TextResizing;
  maxWidth?: false | number;
} & Partial<TextStyleProps>;

export const SHAPE_TEXT_PADDING = 20;
export const SHAPE_TEXT_VERTICAL_PADDING = 10;
const MERMAID_FLOWCHART_SUBGRAPH_ROLE = "mermaid-flowchart-subgraph";

/** The same technical rectangle owns the renderer glyph and both viewport hit paths. */
export function getMermaidSubgraphCollapseBound(element: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly yMap?: { get: (key: string) => unknown };
}): IBound | null {
  if (element.yMap?.get("mermaidSubgraphCollapsible") !== true) return null;
  const raw = Number(element.yMap.get("mermaidSubgraphCollapseControlSize"));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const size = Math.min(raw, element.w, element.h);
  return { x: element.x + element.w - size, y: element.y, w: size, h: size };
}
/** World-space chevron points share the control's renderer/hit geometry. */
export function getMermaidSubgraphCollapsePoints(
  element: Parameters<typeof getMermaidSubgraphCollapseBound>[0],
): readonly IVec[] {
  const bound = getMermaidSubgraphCollapseBound(element);
  if (!bound) return [];
  const x = bound.x + bound.w / 2,
    y = bound.y + bound.h / 2,
    r = bound.w / 6;
  return element.yMap?.get("mermaidSubgraphCollapsed") === true
    ? [
        [x - r / 2, y - r],
        [x + r / 2, y],
        [x - r / 2, y + r],
      ]
    : [
        [x - r, y - r / 2],
        [x, y + r / 2],
        [x + r, y - r / 2],
      ];
}

function includesMermaidSubgraphChrome(
  element: ShapeElementModel,
  x: number,
  y: number,
  options: PointTestOptions,
) {
  const bound = Bound.deserialize(element.xywh);
  const threshold = Math.max(
    6,
    (options.hitThreshold ?? 8) / (options.zoom ?? 1),
  );
  const measuredHeader = Number(
    element.yMap.get("mermaidSubgraphHeaderHeight"),
  );
  const headerHeight =
    measuredHeader > 0
      ? Math.min(bound.h, measuredHeader)
      : Math.min(48, Math.max(28, bound.h * 0.14));
  const insideX = x >= bound.x && x <= bound.x + bound.w;
  const insideY = y >= bound.y && y <= bound.y + bound.h;
  if (!insideX || !insideY) return false;
  if (element.yMap.get("mermaidSubgraphCollapsible") === true) return true;

  const onBorder =
    x <= bound.x + threshold ||
    x >= bound.x + bound.w - threshold ||
    y <= bound.y + threshold ||
    y >= bound.y + bound.h - threshold;
  const inHeader = y <= bound.y + headerHeight;
  return onBorder || inHeader;
}

export class ShapeElementModel extends GfxPrimitiveElementModel<ShapeProps> {
  /**
   * The bound of the text content.
   */
  textBound: IBound | null = null;

  get type() {
    return "shape";
  }

  static propsToY(props: ShapeProps) {
    if (typeof props.text === "string") {
      const text = new Y.Text();
      text.insert(0, props.text);
      props.text = text;
    }

    return props;
  }

  override containsBound(bounds: Bound) {
    return shapeMethods[this.shapeType].containsBound(bounds, this);
  }

  override getLineIntersections(start: IVec, end: IVec) {
    return shapeMethods[this.shapeType].getLineIntersections(start, end, this);
  }

  override getNearestPoint(point: IVec): IVec {
    return shapeMethods[this.shapeType].getNearestPoint(point, this) as IVec;
  }

  override getRelativePointLocation(point: IVec): PointLocation {
    return shapeMethods[this.shapeType].getRelativePointLocation(point, this);
  }

  override includesPoint(x: number, y: number, options: PointTestOptions) {
    const role = String(
      (
        this as unknown as { yMap?: { get?: (key: string) => unknown } }
      ).yMap?.get?.("mermaidRole") ?? "",
    );
    if (role === MERMAID_FLOWCHART_SUBGRAPH_ROLE) {
      return includesMermaidSubgraphChrome(this, x, y, options);
    }

    return shapeMethods[this.shapeType].includesPoint.call(this, x, y, {
      ...options,
      ignoreTransparent: options.ignoreTransparent ?? true,
    });
  }

  @field(DefaultTheme.shapeTextColor)
  accessor color!: Color;

  @field()
  accessor fillColor: Color = DefaultTheme.shapeFillColor;

  @field()
  accessor filled: boolean = false;

  /** The shared double-circle primitive may paint a filled inner disc. */
  @field()
  accessor innerCircleFilled: boolean = false;

  @field(FontFamily.Inter as string)
  accessor fontFamily!: string;

  @field(ShapeTextFontSize.MEDIUM)
  accessor fontSize!: number;

  /** Semantic underline, consumed by the native canvas text renderer. */
  @field("none" as "none" | "underline")
  accessor textDecoration!: "none" | "underline";

  @field(FontStyle.Normal as FontStyle)
  accessor fontStyle!: FontStyle;

  @field(FontWeight.Regular as FontWeight)
  accessor fontWeight!: FontWeight;

  @field(false as false | number)
  accessor maxWidth: false | number = false;

  @field([SHAPE_TEXT_VERTICAL_PADDING, SHAPE_TEXT_PADDING])
  accessor padding: [number, number] = [
    SHAPE_TEXT_VERTICAL_PADDING,
    SHAPE_TEXT_PADDING,
  ];

  @field()
  accessor radius: number = 0;

  @field(0)
  accessor rotate: number = 0;

  @field(DEFAULT_ROUGHNESS)
  accessor roughness: number = DEFAULT_ROUGHNESS;

  @field()
  accessor shadow: {
    /**
     * @deprecated Since the shadow blur will reduce the performance of canvas rendering,
     * we already disable the shadow blur rendering by default, so set this field will not take effect.
     * You can enable it by setting the flag `enable_shape_shadow_blur` in the awareness store.
     * https://web.dev/articles/canvas-performance#avoid_shadowblur
     */
    blur: number;
    offsetX: number;
    offsetY: number;
    color: Color;
  } | null = null;

  @field()
  accessor shapeStyle: ShapeStyle = ShapeStyle.General;

  @field()
  accessor shapeType: ShapeType = ShapeType.Rect;

  /** Normalized family-owned contour. Directions remain with their Source owner. */
  @field()
  accessor labelProjection: ShapeLabelProjection | null = null;

  @field()
  accessor mermaidContour: readonly IVec[] = [];

  @field()
  accessor strokeColor: Color = DefaultTheme.shapeStrokeColor;

  @field()
  accessor strokeStyle: StrokeStyle = StrokeStyle.Solid;

  @field()
  accessor strokeWidth: number = 4;

  @field()
  accessor text: Y.Text | undefined = undefined;

  @field(TextAlign.Center as TextAlign)
  accessor textAlign!: TextAlign;

  @local()
  accessor textDisplay: boolean = true;

  @field(TextAlign.Center as TextAlign)
  accessor textHorizontalAlign!: TextAlign;

  @field(TextResizing.AUTO_HEIGHT as TextResizing)
  accessor textResizing: TextResizing = TextResizing.AUTO_HEIGHT;

  @field(TextVerticalAlign.Center as TextVerticalAlign)
  accessor textVerticalAlign!: TextVerticalAlign;

  @field()
  accessor xywh: SerializedXYWH = "[0,0,100,100]";
}

export class LocalShapeElementModel extends GfxLocalElementModel {
  roughness: number = DEFAULT_ROUGHNESS;

  textBound: Bound | null = null;

  textDisplay: boolean = true;

  get type() {
    return "shape";
  }

  @prop()
  accessor color: Color = DefaultTheme.shapeTextColor;

  @prop()
  accessor fillColor: Color = DefaultTheme.shapeFillColor;

  @prop()
  accessor filled: boolean = false;

  @prop()
  accessor innerCircleFilled: boolean = false;

  @prop()
  accessor fontFamily: string = FontFamily.Inter;

  @prop()
  accessor fontSize: number = 16;

  @prop()
  accessor textDecoration: "none" | "underline" = "none";

  @prop()
  accessor fontStyle: FontStyle = FontStyle.Normal;

  @prop()
  accessor fontWeight: FontWeight = FontWeight.Regular;

  @prop()
  accessor padding: [number, number] = [
    SHAPE_TEXT_VERTICAL_PADDING,
    SHAPE_TEXT_PADDING,
  ];

  @prop()
  accessor radius: number = 0;

  @prop()
  accessor shadow: {
    blur: number;
    offsetX: number;
    offsetY: number;
    color: Color;
  } | null = null;

  @prop()
  accessor shapeStyle: ShapeStyle = ShapeStyle.General;

  @prop()
  accessor shapeType: ShapeType = ShapeType.Rect;

  @prop()
  accessor labelProjection: ShapeLabelProjection | null = null;

  @prop()
  accessor mermaidContour: readonly IVec[] = [];

  @prop()
  accessor strokeColor: Color = DefaultTheme.shapeStrokeColor;

  @prop()
  accessor strokeStyle: StrokeStyle = StrokeStyle.Solid;

  @prop()
  accessor strokeWidth: number = 4;

  @prop()
  accessor text: string = "";

  @prop()
  accessor textAlign: TextAlign = TextAlign.Center;

  @prop()
  accessor textVerticalAlign: TextVerticalAlign = TextVerticalAlign.Center;
}
