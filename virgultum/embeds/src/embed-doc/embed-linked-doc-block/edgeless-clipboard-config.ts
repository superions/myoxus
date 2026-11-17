import { EdgelessClipboardConfig } from "@virgultum/canvas-runtime/surface";
import { ReferenceInfoSchema } from "@virgultum/core/models";
import { type BlockSnapshot } from "@virgultum/core/store";

export class EdgelessClipboardEmbedLinkedDocConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-linked-doc";

  override createBlock(linkedDocEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;

    const { xywh, style, caption, pageId, params, title, description } =
      linkedDocEmbed.props;
    const referenceInfo = ReferenceInfoSchema.parse({
      pageId,
      params,
      title,
      description,
    });

    return this.crud.addBlock(
      "myoxus:embed-linked-doc",
      {
        xywh,
        style,
        caption,
        ...referenceInfo,
      },
      this.surface.model.id,
    );
  }
}
