import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";

export type SurfaceRefProps = {
  /** Native element identity; never a document route key. */
  reference: string;
  pageId?: string;
  workspaceId?: string;
  caption: string;
  refFlavour: string;
  comments?: Record<string, boolean>;
};

export const SurfaceRefBlockSchema = defineBlockSchema({
  flavour: "myoxus:surface-ref",
  props: (): SurfaceRefProps => ({
    reference: "",
    pageId: undefined,
    workspaceId: undefined,
    caption: "",
    refFlavour: "",
    comments: undefined,
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: ["myoxus:note", "myoxus:paragraph", "myoxus:list"],
  },
  toModel: () => new SurfaceRefBlockModel(),
});

export const SurfaceRefBlockSchemaExtension = BlockSchemaExtension(
  SurfaceRefBlockSchema,
);

export class SurfaceRefBlockModel extends BlockModel<SurfaceRefProps> {}
