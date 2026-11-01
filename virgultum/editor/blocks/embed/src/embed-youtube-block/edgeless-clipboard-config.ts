import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardEmbedYoutubeConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-youtube";

  override createBlock(youtubeEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;
    const {
      xywh,
      style,
      url,
      caption,
      videoId,
      image,
      title,
      description,
      creator,
      creatorUrl,
      creatorImage,
    } = youtubeEmbed.props;

    const embedYoutubeId = this.crud.addBlock(
      "myoxus:embed-youtube",
      {
        xywh,
        style,
        url,
        caption,
        videoId,
        image,
        title,
        description,
        creator,
        creatorUrl,
        creatorImage,
      },
      this.surface.model.id,
    );
    return embedYoutubeId;
  }
}
