import { BlockSchemaExtension } from "../extension/schema.js";
import { BlockModel, defineBlockSchema } from "../model/index.js";

export const RootBlockSchema = defineBlockSchema({
  flavour: "myoxus:page",
  props: (internal) => ({
    title: internal.Text(),
    count: 0,
    style: {} as Record<string, unknown>,
    items: [] as unknown[],
  }),
  metadata: {
    version: 2,
    role: "root",
  },
});

export const RootBlockSchemaExtension = BlockSchemaExtension(RootBlockSchema);

export class RootBlockModel extends BlockModel<
  ReturnType<(typeof RootBlockSchema)["model"]["props"]>
> {}

export const NoteBlockSchema = defineBlockSchema({
  flavour: "myoxus:note",
  props: () => ({}),
  metadata: {
    version: 1,
    role: "hub",
    parent: ["myoxus:page"],
    children: [
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:code",
      "myoxus:divider",
      "myoxus:database",
      "myoxus:image",
      "myoxus:note-block-*",
      "myoxus:bookmark",
      "myoxus:attachment",
      "myoxus:surface-ref",
      "myoxus:embed-*",
    ],
  },
});

export const NoteBlockSchemaExtension = BlockSchemaExtension(NoteBlockSchema);

export const ParagraphBlockSchema = defineBlockSchema({
  flavour: "myoxus:paragraph",
  props: (internal) => ({
    type: "text",
    text: internal.Text(),
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:note",
      "myoxus:database",
      "myoxus:paragraph",
      "myoxus:list",
    ],
  },
});

export const ParagraphBlockSchemaExtension =
  BlockSchemaExtension(ParagraphBlockSchema);

export const ListBlockSchema = defineBlockSchema({
  flavour: "myoxus:list",
  props: (internal) => ({
    type: "bulleted",
    text: internal.Text(),
    checked: false,
    collapsed: false,
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:note",
      "myoxus:database",
      "myoxus:list",
      "myoxus:paragraph",
    ],
  },
});

export const ListBlockSchemaExtension = BlockSchemaExtension(ListBlockSchema);

export const DividerBlockSchema = defineBlockSchema({
  flavour: "myoxus:divider",
  metadata: {
    version: 1,
    role: "content",
    children: [],
  },
});

export const DividerBlockSchemaExtension =
  BlockSchemaExtension(DividerBlockSchema);
