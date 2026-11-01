import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

export type RootBlockProps = {
  title: Text;
};

export class RootBlockModel extends BlockModel<RootBlockProps> {
  /**
   * A page is empty if it only contains one empty note and the canvas is empty
   */
  override isEmpty() {
    let numNotes = 0;
    let empty = true;
    for (const child of this.children) {
      empty = empty && child.isEmpty();

      if (child.flavour === "myoxus:note") numNotes++;
      if (numNotes > 1) return false;
    }

    return empty;
  }
}

export const RootBlockSchema = defineBlockSchema({
  flavour: "myoxus:page",
  props: (internal): RootBlockProps => ({
    title: internal.Text(),
  }),
  metadata: {
    version: 2,
    role: "root",
  },
  toModel: () => new RootBlockModel(),
});

export const RootBlockSchemaExtension = BlockSchemaExtension(RootBlockSchema);
