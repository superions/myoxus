// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "../../../store/index";

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
  /** A draft is relative to its opening body: never replace a newer peer edit. */
  applyBody(body: string, expected: string) {
    const text = this.props.text;
    if (
      this.store.readonly ||
      this.store.getModelById(this.id) !== this ||
      text.toString() !== expected
    )
      return false;
    if (body !== expected) {
      this.store.captureSync();
      text.replace(0, text.length, body, {});
      this.store.captureSync();
    }
    return true;
  }
  override isEmpty(): boolean {
    return this.props.text.length === 0;
  }
}
