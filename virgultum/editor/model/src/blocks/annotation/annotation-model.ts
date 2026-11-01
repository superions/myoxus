// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

import type { BlockMeta } from "../../utils/types";

export type AnnotationProps = { text: Text } & BlockMeta;

/** Document content, not a structural note or a collaborative comment. */
export const AnnotationBlockSchema = defineBlockSchema({
  flavour: "myoxus:annotation",
  props: (internal): AnnotationProps => ({
    text: internal.Text(),
    "meta:createdAt": undefined,
    "meta:createdBy": undefined,
    "meta:updatedAt": undefined,
    "meta:updatedBy": undefined,
  }),
  metadata: {
    version: 1,
    role: "content",
    parent: [
      "myoxus:footnote-definition",
      "myoxus:note",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:callout",
    ],
    children: [],
  },
  toModel: () => new AnnotationBlockModel(),
});

export const AnnotationBlockSchemaExtension = BlockSchemaExtension(
  AnnotationBlockSchema,
);

export class AnnotationBlockModel extends BlockModel<AnnotationProps> {
  override isEmpty(): boolean {
    return this.props.text.length === 0;
  }
}
