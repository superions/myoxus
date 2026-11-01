import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
  type Text as StoreText,
} from "@virgultum/store";

export const DEFAULT_BPMN_BLOCK_TITLE = "BPMN Diagram";
/** Values are exact decoded XML; links contain compact parent/supersedes identities, never XML. */
export type BpmnSourceRevisionProps = {
  sourceHeads: Record<string, string>;
  sourceLinks: Record<string, string>;
  selectedHead: string;
};
/** One replaceable derived artifact. Revision and asset identity travel together;
 * neither this descriptor nor its SVG can replace the canonical XML source. */
export type BpmnPreviewArtifact = { revision: string; sourceId: string };

export type BpmnBlockProps = BpmnSourceRevisionProps & {
  title: StoreText;
  caption: string;
  /** Derived preview metadata is correlated to exactly one source head, never canonical content. */
  preview: BpmnPreviewArtifact | null;
  previewErrorRevision: string | null;
  comments?: Record<string, boolean>;
};

export const BpmnBlockSchema = defineBlockSchema({
  flavour: "myoxus:bpmn",
  props: (internal): BpmnBlockProps => ({
    // These records materialize as nested Y.Maps once with block insertion.
    // Source writers append to those same maps; replacing a whole record loses concurrent heads.
    sourceHeads: {},
    sourceLinks: {},
    selectedHead: "",
    title: internal.Text(),
    caption: "",
    preview: null,
    previewErrorRevision: null,
    comments: undefined,
  }),
  metadata: {
    version: 2,
    role: "content",
    parent: ["myoxus:note", "myoxus:paragraph", "myoxus:list"],
    children: [],
  },
  toModel: () => new BpmnBlockModel(),
});

export const BpmnBlockSchemaExtension = BlockSchemaExtension(BpmnBlockSchema);

export class BpmnBlockModel extends BlockModel<BpmnBlockProps> {}
