import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardEmbedIframeConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-iframe";

  override createBlock(embedIframe: BlockSnapshot): string | null {
    if (!this.surface) return null;
    const {
      xywh,
      caption,
      url,
      title,
      description,
      iframeUrl,
      scale,
      width,
      height,
    } = embedIframe.props;

    return this.crud.addBlock(
      "myoxus:embed-iframe",
      {
        url,
        iframeUrl,
        xywh,
        caption,
        title,
        description,
        scale,
        width,
        height,
      },
      this.surface.model.id,
    );
  }
}
