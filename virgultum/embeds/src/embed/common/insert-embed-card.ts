import {
  DefaultTool,
  EdgelessCRUDIdentifier,
  SurfaceBlockComponent,
} from "@virgultum/canvas-runtime/surface";
import { Bound, Vec } from "@virgultum/core/primitives/gfx";
import type { EmbedCardStyle } from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import {
  BlockSelection,
  type BlockStdScope,
  SurfaceSelection,
  TextSelection,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

interface EmbedCardProperties {
  flavour: string;
  targetStyle: EmbedCardStyle;
  props: Record<string, unknown>;
}

export function insertEmbedCard(
  std: BlockStdScope,
  properties: EmbedCardProperties,
) {
  const { host } = std;
  const { flavour, targetStyle, props } = properties;
  const selectionManager = host.selection;

  let blockId: string | undefined;
  const textSelection = selectionManager.find(TextSelection);
  const blockSelection = selectionManager.find(BlockSelection);
  const surfaceSelection = selectionManager.find(SurfaceSelection);
  if (textSelection) {
    blockId = textSelection.blockId;
  } else if (blockSelection) {
    blockId = blockSelection.blockId;
  } else if (surfaceSelection && surfaceSelection.editing) {
    blockId = surfaceSelection.blockId;
  }

  if (blockId) {
    const block = host.view.getBlock(blockId);
    if (!block) return;
    const parent = host.store.getParent(block.model);
    if (!parent) return;
    const index = parent.children.indexOf(block.model);
    const cardId = host.store.addBlock(
      flavour as never,
      props,
      parent,
      index + 1,
    );
    return cardId;
  } else {
    const rootId = std.store.root?.id;
    if (!rootId) return;
    const edgelessRoot = std.view.getBlock(rootId);
    if (!edgelessRoot) return;

    const gfx = std.get(GfxControllerIdentifier);
    const crud = std.get(EdgelessCRUDIdentifier);

    gfx.viewport.smoothZoom(1);
    const surfaceBlock = gfx.surfaceComponent;
    if (!(surfaceBlock instanceof SurfaceBlockComponent)) return;
    const center = Vec.toVec(surfaceBlock.renderer.viewport.center);
    const cardId = crud.addBlock(
      flavour,
      {
        ...props,
        xywh: Bound.fromCenter(
          center,
          EMBED_CARD_WIDTH[targetStyle],
          EMBED_CARD_HEIGHT[targetStyle],
        ).serialize(),
        style: targetStyle,
      },
      surfaceBlock.model,
    );

    gfx.tool.setTool(DefaultTool);
    gfx.selection.set({
      elements: [cardId],
      editing: false,
    });

    return cardId;
  }
}
