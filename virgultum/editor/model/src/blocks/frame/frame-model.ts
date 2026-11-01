import {
  generateKeyBetweenV2,
  GfxCompatible,
  type GfxCompatibleProps,
} from "@virgultum/std/gfx";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";
import { z } from "zod";

import { type Color, ColorSchema, DefaultTheme } from "../../themes/index.js";
import {
  type GfxGroupChildProps,
  GfxGroupCompatibleBlockModel,
} from "../../utils/index.js";

export type FrameBlockProps = {
  title: Text;
  background: Color;
  presentationIndex?: string;
  comments?: Record<string, boolean>;
} & GfxCompatibleProps &
  GfxGroupChildProps;

export const FrameZodSchema = z
  .object({
    background: ColorSchema,
  })
  .default({
    background: DefaultTheme.transparent,
  });

export const FrameBlockSchema = defineBlockSchema({
  flavour: "myoxus:frame",
  props: (internal): FrameBlockProps => ({
    title: internal.Text(),
    background: "transparent",
    xywh: `[0,0,100,100]`,
    index: "a0",
    childElementIds: Object.create(null),
    presentationIndex: generateKeyBetweenV2(null, null),
    lockedBySelf: false,
    comments: undefined,
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: ["myoxus:surface"],
    children: [],
  },
  toModel: () => {
    return new FrameBlockModel();
  },
});

export const FrameBlockSchemaExtension = BlockSchemaExtension(FrameBlockSchema);

export class FrameBlockModel extends GfxGroupCompatibleBlockModel<FrameBlockProps>(
  GfxCompatible<FrameBlockProps>(BlockModel),
) {}
