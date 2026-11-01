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

export type LatexProps = {
  latex: string;
  comments?: Record<string, boolean>;
} & GfxCommonBlockProps;

export const LatexBlockSchema = defineBlockSchema({
  flavour: "myoxus:latex",
  props: (): LatexProps => ({
    xywh: "[0,0,16,16]",
    index: "a0",
    lockedBySelf: false,
    scale: 1,
    rotate: 0,
    latex: "",
    comments: undefined,
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:footnote-definition",
      "myoxus:note",
      "myoxus:edgeless-text",
      "myoxus:paragraph",
      "myoxus:list",
    ],
  },
  toModel: () => {
    return new LatexBlockModel();
  },
});

export const LatexBlockSchemaExtension = BlockSchemaExtension(LatexBlockSchema);

export class LatexBlockModel
  extends GfxCompatible<LatexProps>(BlockModel)
  implements GfxElementGeometry {}
