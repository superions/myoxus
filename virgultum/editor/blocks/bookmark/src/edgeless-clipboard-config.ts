import { EdgelessClipboardConfig } from "@virgultum/block-surface";
import { type BlockSnapshot } from "@virgultum/store";

export class EdgelessClipboardBookmarkConfig extends EdgelessClipboardConfig {
  static override readonly key = "myoxus:bookmark";

  override createBlock(bookmark: BlockSnapshot): string | null {
    if (!this.surface) return null;

    const { xywh, style, url, caption, description, icon, image, title } =
      bookmark.props;

    const bookmarkId = this.crud.addBlock(
      "myoxus:bookmark",
      {
        xywh,
        style,
        url,
        caption,
        description,
        icon,
        image,
        title,
      },
      this.surface.model.id,
    );
    return bookmarkId;
  }
}
