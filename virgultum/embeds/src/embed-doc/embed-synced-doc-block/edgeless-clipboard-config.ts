import { EdgelessClipboardConfig } from "@virgultum/canvas-runtime/surface";
import { ReferenceInfoSchema } from "@virgultum/core/models";
import { type BlockSnapshot } from "@virgultum/core/store";

export class EdgelessClipboardEmbedSyncedDocConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-synced-doc";

  override createBlock(syncedDocEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;

    const { xywh, style, caption, scale, pageId, params } =
      syncedDocEmbed.props;
    const referenceInfo = ReferenceInfoSchema.parse({ pageId, params });

    return this.crud.addBlock(
      "myoxus:embed-synced-doc",
      {
        xywh,
        style,
        caption,
        scale,
        ...referenceInfo,
      },
      this.surface.model.id,
    );
  }
}
