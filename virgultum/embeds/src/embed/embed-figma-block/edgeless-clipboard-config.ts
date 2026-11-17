import { EdgelessClipboardConfig } from "@virgultum/canvas-runtime/surface";
import { type BlockSnapshot } from "@virgultum/core/store";

export class EdgelessClipboardEmbedFigmaConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-figma";

  override createBlock(figmaEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;
    const { xywh, style, url, caption, title, description } = figmaEmbed.props;

    const embedFigmaId = this.crud.addBlock(
      "myoxus:embed-figma",
      {
        xywh,
        style,
        url,
        caption,
        title,
        description,
      },
      this.surface.model.id,
    );
    return embedFigmaId;
  }
}
