import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/store";

export const DividerBlockSchema = defineBlockSchema({
  flavour: "myoxus:divider",
  metadata: {
    version: 1,
    role: "content",
    children: [],
  },
  toModel: () => new DividerBlockModel(),
});

type Props = {
  text: string;
};

export class DividerBlockModel extends BlockModel<Props> {}

export const DividerBlockSchemaExtension =
  BlockSchemaExtension(DividerBlockSchema);
