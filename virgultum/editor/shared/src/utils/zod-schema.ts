import {
  ColorSchema,
  ConnectorMode,
  DEFAULT_CONNECTOR_MODE,
  DEFAULT_FRONT_ENDPOINT_STYLE,
  DEFAULT_HIGHLIGHTER_LINE_WIDTH,
  DEFAULT_REAR_ENDPOINT_STYLE,
  DEFAULT_ROUGHNESS,
  DefaultTheme,
  EdgelessTextZodSchema,
  FontFamily,
  FontFamilySchema,
  FontStyle,
  FontStyleSchema,
  FontWeight,
  FontWeightSchema,
  FrameZodSchema,
  HIGHLIGHTER_LINE_WIDTHS,
  LineWidth,
  NoteZodSchema,
  PointStyle,
  ShapeStyle,
  StrokeStyle,
  StrokeStyleSchema,
  TextAlign,
  TextAlignSchema,
  TextVerticalAlign,
} from "@virgultum/model";
import {
  z,
  ZodDefault,
  ZodIntersection,
  ZodObject,
  type ZodTypeAny,
  ZodUnion,
} from "zod";

const ConnectorEndpointSchema = z.nativeEnum(PointStyle);
const LineWidthSchema = z.nativeEnum(LineWidth);
const ShapeStyleSchema = z.nativeEnum(ShapeStyle);
const TextVerticalAlignSchema = z.nativeEnum(TextVerticalAlign);
const ConnectorModeSchema = z.nativeEnum(ConnectorMode);
// Preserve the existing personal preference wire values without depending on a family runtime.
const LayoutTypeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const MindmapStyleSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const ConnectorSchema = z
  .object({
    frontEndpointStyle: ConnectorEndpointSchema,
    rearEndpointStyle: ConnectorEndpointSchema,
    stroke: ColorSchema,
    strokeStyle: StrokeStyleSchema,
    strokeWidth: LineWidthSchema,
    rough: z.boolean(),
    mode: ConnectorModeSchema,
    labelStyle: z.object({
      color: ColorSchema,
      fontSize: z.number(),
      fontFamily: FontFamilySchema,
      fontWeight: FontWeightSchema,
      fontStyle: FontStyleSchema,
      textAlign: TextAlignSchema,
    }),
  })
  .default({
    frontEndpointStyle: DEFAULT_FRONT_ENDPOINT_STYLE,
    rearEndpointStyle: DEFAULT_REAR_ENDPOINT_STYLE,
    stroke: DefaultTheme.connectorColor,
    strokeStyle: StrokeStyle.Solid,
    strokeWidth: LineWidth.Two,
    rough: false,
    mode: DEFAULT_CONNECTOR_MODE,
    labelStyle: {
      color: DefaultTheme.black,
      fontSize: 16,
      fontFamily: FontFamily.Inter,
      fontWeight: FontWeight.Regular,
      fontStyle: FontStyle.Normal,
      textAlign: TextAlign.Center,
    },
  });

export const BrushSchema = z
  .object({
    color: ColorSchema,
    lineWidth: LineWidthSchema,
  })
  .default({
    color: DefaultTheme.black,
    lineWidth: LineWidth.Four,
  });

export const HighlighterSchema = z
  .object({
    color: ColorSchema,
    lineWidth: z
      .number()
      .int()
      .refine((value) => HIGHLIGHTER_LINE_WIDTHS.includes(value)),
  })
  .default({
    color: DefaultTheme.hightlighterColor,
    lineWidth: DEFAULT_HIGHLIGHTER_LINE_WIDTH,
  });

const DEFAULT_SHAPE = {
  color: DefaultTheme.shapeTextColor,
  fillColor: DefaultTheme.shapeFillColor,
  strokeColor: DefaultTheme.shapeStrokeColor,
  strokeStyle: StrokeStyle.Solid,
  strokeWidth: LineWidth.Two,
  shapeStyle: ShapeStyle.General,
  filled: true,
  radius: 0,
  fontSize: 20,
  fontFamily: FontFamily.Inter,
  fontWeight: FontWeight.Regular,
  fontStyle: FontStyle.Normal,
  textAlign: TextAlign.Center,
  roughness: DEFAULT_ROUGHNESS,
};

const ShapeObject = {
  color: ColorSchema,
  fillColor: ColorSchema,
  strokeColor: ColorSchema,
  strokeStyle: StrokeStyleSchema,
  strokeWidth: z.number(),
  shapeStyle: ShapeStyleSchema,
  filled: z.boolean(),
  radius: z.number(),
  fontSize: z.number(),
  fontFamily: FontFamilySchema,
  fontWeight: FontWeightSchema,
  fontStyle: FontStyleSchema,
  textAlign: TextAlignSchema,
  textHorizontalAlign: TextAlignSchema.optional(),
  textVerticalAlign: TextVerticalAlignSchema.optional(),
  roughness: z.number(),
};

export const ShapeSchema = z.object(ShapeObject).default(DEFAULT_SHAPE);

export const RoundedShapeSchema = z
  .object(ShapeObject)
  .default({ ...DEFAULT_SHAPE, radius: 0.1 });

export const TextSchema = z
  .object({
    color: ColorSchema,
    fontSize: z.number(),
    fontFamily: FontFamilySchema,
    fontWeight: FontWeightSchema,
    fontStyle: FontStyleSchema,
    textAlign: TextAlignSchema,
  })
  .default({
    color: DefaultTheme.textColor,
    fontSize: 24,
    fontFamily: FontFamily.Inter,
    fontWeight: FontWeight.Regular,
    fontStyle: FontStyle.Normal,
    textAlign: TextAlign.Left,
  });

export const MindmapSchema = z
  .object({
    layoutType: LayoutTypeSchema,
    style: MindmapStyleSchema,
  })
  .default({
    layoutType: 0,
    style: 1,
  });

export const NodePropsSchema = z.object({
  connector: ConnectorSchema,
  brush: BrushSchema,
  highlighter: HighlighterSchema,
  text: TextSchema,
  mindmap: MindmapSchema,
  "myoxus:edgeless-text": EdgelessTextZodSchema,
  "myoxus:note": NoteZodSchema,
  "myoxus:frame": FrameZodSchema,
  // shapes
  "shape:diamond": ShapeSchema,
  "shape:ellipse": ShapeSchema,
  "shape:rect": ShapeSchema,
  "shape:triangle": ShapeSchema,
  "shape:roundedRect": RoundedShapeSchema,
  // Mermaid flowchart shapes
  "shape:mermaid-asymmetric": ShapeSchema,
  "shape:mermaid-bang": ShapeSchema,
  "shape:mermaid-bolt": ShapeSchema,
  "shape:mermaid-bow-rect": ShapeSchema,
  "shape:mermaid-brace": ShapeSchema,
  "shape:mermaid-brace-r": ShapeSchema,
  "shape:mermaid-braces": ShapeSchema,
  "shape:mermaid-cloud": ShapeSchema,
  "shape:mermaid-cherry-pick": ShapeSchema,
  "shape:mermaid-cross-circ": ShapeSchema,
  "shape:mermaid-curv-trap": ShapeSchema,
  "shape:mermaid-cylinder": ShapeSchema,
  "shape:mermaid-datastore": ShapeSchema,
  "shape:mermaid-delay": ShapeSchema,
  "shape:mermaid-div-rect": ShapeSchema,
  "shape:mermaid-doc": ShapeSchema,
  "shape:mermaid-docs": ShapeSchema,
  "shape:mermaid-double-circle": ShapeSchema,
  "shape:mermaid-f-circ": ShapeSchema,
  "shape:mermaid-flag": ShapeSchema,
  "shape:mermaid-flip-tri": ShapeSchema,
  "shape:mermaid-fork": ShapeSchema,
  "shape:mermaid-block-arrow": ShapeSchema,
  "shape:mermaid-fr-circ": ShapeSchema,
  "shape:mermaid-fr-rect": ShapeSchema,
  "shape:mermaid-h-cyl": ShapeSchema,
  "shape:mermaid-person": ShapeSchema,
  "shape:mermaid-hexagon": ShapeSchema,
  "shape:mermaid-hourglass": ShapeSchema,
  "shape:mermaid-lean-l": ShapeSchema,
  "shape:mermaid-lean-r": ShapeSchema,
  "shape:mermaid-lin-cyl": ShapeSchema,
  "shape:mermaid-lin-doc": ShapeSchema,
  "shape:mermaid-lin-rect": ShapeSchema,
  "shape:mermaid-notch-pent": ShapeSchema,
  "shape:mermaid-notch-rect": ShapeSchema,
  "shape:mermaid-odd": ShapeSchema,
  "shape:mermaid-sl-rect": ShapeSchema,
  "shape:mermaid-sm-circ": ShapeSchema,
  "shape:mermaid-st-rect": ShapeSchema,
  "shape:mermaid-stadium": ShapeSchema,
  "shape:mermaid-subroutine": ShapeSchema,
  "shape:mermaid-tag-doc": ShapeSchema,
  "shape:mermaid-tag-rect": ShapeSchema,
  "shape:mermaid-text": ShapeSchema,
  "shape:mermaid-trap-b": ShapeSchema,
  "shape:mermaid-trap-t": ShapeSchema,
  "shape:mermaid-win-pane": ShapeSchema,
});

export type NodeProps = z.infer<typeof NodePropsSchema>;

export function makeDeepOptional(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof ZodDefault) {
    return makeDeepOptional(schema._def.innerType);
  }
  if (schema instanceof ZodObject) {
    const shape = schema.shape;
    const deepOptionalShape = Object.fromEntries(
      Object.entries(shape).map(([key, value]) => {
        return [key, makeDeepOptional(value as ZodTypeAny)];
      }),
    );
    return z.object(deepOptionalShape).optional();
  } else if (schema instanceof ZodUnion) {
    return schema.or(z.undefined());
  } else if (schema instanceof ZodIntersection) {
    return z.intersection(
      makeDeepOptional(schema._def.left),
      makeDeepOptional(schema._def.right),
    );
  } else {
    return schema.optional();
  }
}
