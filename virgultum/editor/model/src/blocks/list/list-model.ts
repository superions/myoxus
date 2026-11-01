import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

import type { TextAlign } from "../../consts";
import type { BlockMeta, TemplateRepeatBinding } from "../../utils/types";

// `toggle` type has been deprecated, do not use it
export type ListType = "bulleted" | "numbered" | "todo" | "toggle";

export type ListProps = {
  type: ListType;
  text: Text;
  textAlign?: TextAlign;
  checked: boolean;
  collapsed: boolean;
  order: number | null;
  comments?: Record<string, boolean>;
  repeat?: TemplateRepeatBinding;
  /** Document-scoped Markdown provenance, independent of this block's native ID. */
  markdownAnchor?: string;
} & BlockMeta;

export const ListBlockSchema = defineBlockSchema({
  flavour: "myoxus:list",
  props: (internal) =>
    ({
      type: "bulleted",
      text: internal.Text(),
      textAlign: undefined,
      checked: false,
      collapsed: false,

      // number type only for numbered list
      order: null,
      comments: undefined,
      repeat: undefined,
      markdownAnchor: undefined,
      "meta:createdAt": undefined,
      "meta:createdBy": undefined,
      "meta:updatedAt": undefined,
      "meta:updatedBy": undefined,
    }) as ListProps,
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:footnote-definition",
      "myoxus:note",
      "myoxus:database",
      "myoxus:list",
      "myoxus:paragraph",
      "myoxus:edgeless-text",
      "myoxus:callout",
    ],
  },
  toModel: () => new ListBlockModel(),
});

export const ListBlockSchemaExtension = BlockSchemaExtension(ListBlockSchema);

export class ListBlockModel extends BlockModel<ListProps> {}
