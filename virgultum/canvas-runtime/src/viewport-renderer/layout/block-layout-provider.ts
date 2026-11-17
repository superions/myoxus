import { createIdentifier } from "@virgultum/core/primitives/di";
import type { EditorHost } from "@virgultum/core/runtime";
import type { ViewportRecord } from "@virgultum/core/runtime/gfx";
import { type BlockModel, Extension } from "@virgultum/core/store";

import type { BlockLayout, Rect } from "../types";

export abstract class BlockLayoutHandlerExtension<
  T extends BlockLayout = BlockLayout,
> extends Extension {
  abstract readonly blockType: string;

  abstract queryLayout(
    model: BlockModel,
    host: EditorHost,
    viewportRecord: ViewportRecord,
  ): T | null;

  abstract calculateBound(layout: T): {
    rect: Rect;
    subRects: Rect[];
  };
}

export const BlockLayoutHandlersIdentifier =
  createIdentifier<BlockLayoutHandlerExtension>(
    "BlockLayoutHandlersIdentifier",
  );
