import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text,
} from "@virgultum/store";

import type { TextAlign } from "../../consts";
import type {
  BlockMeta,
  TemplateRepeatBinding,
  TextProtection,
} from "../../utils/types";

export type ParagraphType =
  "text" | "quote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

export type ParagraphPresentation = "eyebrow";

export type ParagraphProps = {
  type: ParagraphType;
  presentation?: ParagraphPresentation;
  textAlign?: TextAlign;
  text: Text;
  textProtection?: TextProtection;
  collapsed: boolean;
  comments?: Record<string, boolean>;
  repeat?: TemplateRepeatBinding;
  /** Document-scoped Markdown provenance, independent of this block's native ID. */
  markdownAnchor?: string;
} & BlockMeta;

export const ParagraphBlockSchema = defineBlockSchema({
  flavour: "myoxus:paragraph",
  props: (internal): ParagraphProps => ({
    type: "text",
    presentation: undefined,
    text: internal.Text(),
    textProtection: undefined,
    textAlign: undefined,
    collapsed: false,
    comments: undefined,
    repeat: undefined,
    markdownAnchor: undefined,
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
      "myoxus:database",
      "myoxus:paragraph",
      "myoxus:list",
      "myoxus:edgeless-text",
      "myoxus:callout",
      "myoxus:transcription",
    ],
  },
  toModel: () => new ParagraphBlockModel(),
});

export const ParagraphBlockSchemaExtension =
  BlockSchemaExtension(ParagraphBlockSchema);

export class ParagraphBlockModel extends BlockModel<ParagraphProps> {
  override isEmpty(): boolean {
    return this.props.text$.value.length === 0 && this.children.length === 0;
  }
}
