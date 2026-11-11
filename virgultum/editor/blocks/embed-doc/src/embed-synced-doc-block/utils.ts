import type { BlockComponent } from "@virgultum/std";
import { EmbedEdgelessSyncedDocBlockComponent } from "./embed-edgeless-synced-doc-block.js";

/**
 * This function will return the height of the synced doc block
 */
export function calcSyncedDocFullHeight(block: BlockComponent) {
  if (!(block instanceof EmbedEdgelessSyncedDocBlockComponent)) {
    return 0;
  }
  const headerHeight = block.headerWrapper?.getBoundingClientRect().height ?? 0;
  // When the content is not found, we use a default height to display empty information
  const contentHeight =
    block.contentElement?.getBoundingClientRect().height ?? 200;

  const bottomPadding = 8;

  return (
    (headerHeight + contentHeight + bottomPadding) /
    block.gfx.viewport.zoom /
    (block.model.props.scale ?? 1)
  );
}
