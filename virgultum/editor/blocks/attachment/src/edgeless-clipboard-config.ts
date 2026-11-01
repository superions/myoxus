import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardAttachmentConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:attachment";

  override async createBlock(
    attachment: BlockSnapshot,
  ): Promise<string | null> {
    if (!this.surface) return null;

    const { xywh, rotate, sourceId, name, size, type, embed, style } =
      attachment.props;

    if (!(await this.std.workspace.blobSync.get(sourceId as string))) {
      return null;
    }
    const attachmentId = this.crud.addBlock(
      "myoxus:attachment",
      {
        xywh,
        rotate,
        sourceId,
        name,
        size,
        type,
        embed,
        style,
      },
      this.surface.model.id,
    );
    return attachmentId;
  }
}
