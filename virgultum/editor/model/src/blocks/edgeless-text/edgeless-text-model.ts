import {
  type GfxCommonBlockProps,
  GfxCompatible,
  type GfxElementGeometry,
} from "@virgultum/std/gfx";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";
import { z } from "zod";

import {
  FontFamily,
  FontFamilySchema,
  FontStyle,
  FontStyleSchema,
  FontWeight,
  FontWeightSchema,
  TextAlign,
  TextAlignSchema,
  type TextStyleProps,
} from "../../consts/index";
import { ColorSchema } from "../../themes/color";
import { DefaultTheme } from "../../themes/default";

type EdgelessTextProps = {
  hasMaxWidth: boolean;
  comments?: Record<string, boolean>;
} & Omit<TextStyleProps, "fontSize"> &
  GfxCommonBlockProps;

export const EdgelessTextZodSchema = z
  .object({
    color: ColorSchema,
    fontFamily: FontFamilySchema,
    fontStyle: FontStyleSchema,
    fontWeight: FontWeightSchema,
    textAlign: TextAlignSchema,
  })
  .prefault({
    color: DefaultTheme.textColor,
    fontFamily: FontFamily.Inter,
    fontStyle: FontStyle.Normal,
    fontWeight: FontWeight.Regular,
    textAlign: TextAlign.Left,
  });

export const EdgelessTextBlockSchema = defineBlockSchema({
  flavour: "myoxus:edgeless-text",
  props: (): EdgelessTextProps => ({
    xywh: "[0,0,16,16]",
    index: "a0",
    lockedBySelf: false,
    scale: 1,
    rotate: 0,
    hasMaxWidth: false,
    comments: undefined,
    ...EdgelessTextZodSchema.parse(undefined),
  }),
  metadata: {
    version: 1,
    role: "hub",
    parent: ["myoxus:surface"],
    children: [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:code",
      "myoxus:image",
      "myoxus:bookmark",
      "myoxus:attachment",
      "myoxus:embed-!(synced-doc)",
      "myoxus:latex",
    ],
  },
  toModel: () => new EdgelessTextBlockModel(),
});

export const EdgelessTextBlockSchemaExtension = BlockSchemaExtension(
  EdgelessTextBlockSchema,
);

export class EdgelessTextBlockModel
  extends GfxCompatible<EdgelessTextProps>(BlockModel)
  implements GfxElementGeometry
{
  get color() {
    return this.props.color;
  }

  set color(color: EdgelessTextProps["color"]) {
    this.props.color = color;
  }
}
