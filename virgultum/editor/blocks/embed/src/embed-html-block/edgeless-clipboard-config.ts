import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardEmbedHtmlConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:embed-html";

  override createBlock(htmlEmbed: BlockSnapshot): string | null {
    if (!this.surface) return null;
    const { xywh, style, caption, html, design } = htmlEmbed.props;

    const embedHtmlId = this.crud.addBlock(
      "myoxus:embed-html",
      {
        xywh,
        style,
        caption,
        html,
        design,
      },
      this.surface.model.id,
    );
    return embedHtmlId;
  }
}
